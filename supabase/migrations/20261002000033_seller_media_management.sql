-- =============================================================================
-- Migration 33: Native Seller Media Management & Atomic Operations
-- =============================================================================
-- Description:
-- 1. Tightens listing_media RLS INSERT/UPDATE to require seller ownership,
--    active account status, current policy acceptance, and mutable status
--    ('draft', 'rejected', 'active', 'reserved', 'paused', 'pending_review').
-- 2. Concurrency-safe photo limit (max 8) with parent listing row locking.
-- 3. Corrects upload lifecycle: inserts in 'uploading' status do NOT trigger
--    re-review. Only successful transition to 'ready' triggers re-review.
-- 4. Corrects delete lifecycle: deleting 'ready' photos triggers re-review;
--    deleting failed/uploading/processing photos is cleanup and does NOT trigger re-review.
-- 5. Transactional seller media reorder RPC (public.seller_reorder_listing_media)
--    with ready-only complete membership validation.
-- 6. Transactional seller cover photo RPC (public.seller_set_listing_cover_photo).
-- 7. Transactional seller media delete RPC (public.seller_delete_listing_media)
--    with idempotent absence handling and automatic cover photo fallback.
-- 8. Revokes authenticated direct UPDATE on listing_media(display_order)
--    and listings(cover_photo_id) to make the atomic RPCs authoritative.
-- =============================================================================

-- =============================================================================
-- 1. Tighten listing_media RLS Policy Status Enforcement
-- =============================================================================

DROP POLICY IF EXISTS "listing_media_authenticated_insert" ON public.listing_media;
DROP POLICY IF EXISTS listing_media_insert_policy ON public.listing_media;
CREATE POLICY "listing_media_authenticated_insert"
ON public.listing_media
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND l.status IN ('draft', 'rejected', 'active', 'reserved', 'paused', 'pending_review')
      AND app_security.get_account_status(auth.uid()) = 'active'
      AND app_security.has_current_policy_acceptance(auth.uid())
  )
);

DROP POLICY IF EXISTS "listing_media_authenticated_update" ON public.listing_media;
DROP POLICY IF EXISTS listing_media_update_policy ON public.listing_media;
CREATE POLICY "listing_media_authenticated_update"
ON public.listing_media
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND l.status IN ('draft', 'rejected', 'active', 'reserved', 'paused', 'pending_review')
      AND app_security.get_account_status(auth.uid()) = 'active'
      AND app_security.has_current_policy_acceptance(auth.uid())
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND l.status IN ('draft', 'rejected', 'active', 'reserved', 'paused', 'pending_review')
      AND app_security.get_account_status(auth.uid()) = 'active'
      AND app_security.has_current_policy_acceptance(auth.uid())
  )
);

-- =============================================================================
-- 2. Concurrency-Safe Photo Limit & Serialization Trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_listing_media_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid;
  v_count integer;
  v_max_order integer;
BEGIN
  -- 1. Lock the parent listing row for update to serialize concurrent uploads
  SELECT seller_id INTO v_seller_id
  FROM public.listings
  WHERE id = NEW.listing_id
  FOR UPDATE;

  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND: Listing not found';
  END IF;

  -- Verify ownership
  IF auth.uid() IS NOT NULL AND auth.uid() != v_seller_id THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND: Caller does not own this listing';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    NEW.uploader_id := auth.uid();
  ELSIF NEW.uploader_id IS NULL THEN
    NEW.uploader_id := v_seller_id;
  END IF;

  -- 2. Enforce serialized photo count limit (max 8)
  SELECT count(*) INTO v_count
  FROM public.listing_media
  WHERE listing_id = NEW.listing_id;

  IF v_count >= 8 THEN
    RAISE EXCEPTION 'PHOTO_LIMIT_REACHED: Maximum 8 photos per listing exceeded';
  END IF;

  -- 3. Default display_order to next available if 0 or default
  IF NEW.display_order = 0 THEN
    SELECT COALESCE(max(display_order) + 1, 0) INTO v_max_order
    FROM public.listing_media
    WHERE listing_id = NEW.listing_id;
    NEW.display_order := v_max_order;
  END IF;

  NEW.processing_status := 'uploading'::public.media_processing_status_enum;
  NEW.created_at := pg_catalog.clock_timestamp();

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 3. Re-Review Lifecycle Triggers: Ready-Only State Transitions
-- =============================================================================

-- Drop historical after_insert trigger so initial 'uploading' status does NOT trigger re-review
DROP TRIGGER IF EXISTS trg_listing_media_after_insert ON public.listing_media;

-- Trigger re-review only when processing_status becomes 'ready'
CREATE OR REPLACE FUNCTION public.handle_listing_media_after_processing_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.processing_status IS DISTINCT FROM NEW.processing_status
     AND NEW.processing_status = 'ready'::public.media_processing_status_enum THEN
    PERFORM app_security.trigger_listing_media_rereview(NEW.listing_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_listing_media_after_processing_update ON public.listing_media;
CREATE TRIGGER trg_listing_media_after_processing_update
AFTER UPDATE OF processing_status ON public.listing_media
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_media_after_processing_update();

-- Trigger re-review on delete ONLY if deleted media was 'ready' (cleanup of failed/uploading does not re-review)
CREATE OR REPLACE FUNCTION public.handle_listing_media_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.processing_status = 'ready'::public.media_processing_status_enum THEN
    PERFORM app_security.trigger_listing_media_rereview(OLD.listing_id);
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_listing_media_after_delete ON public.listing_media;
CREATE TRIGGER trg_listing_media_after_delete
AFTER DELETE ON public.listing_media
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_media_after_delete();

-- =============================================================================
-- 4. Transactional Seller Media Reorder RPC (Ready-Only Membership)
-- =============================================================================

CREATE OR REPLACE FUNCTION app_security.impl_seller_reorder_listing_media(
  p_listing_id uuid,
  p_media_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_listing record;
  v_current_ids uuid[];
  v_requested_count integer;
  v_existing_count integer;
BEGIN
  -- 1. Authentication check
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: Authentication required';
  END IF;

  -- 2. Account status check
  IF app_security.get_account_status(v_uid) != 'active' THEN
    RAISE EXCEPTION 'ACCOUNT_RESTRICTED: Account is not active';
  END IF;

  -- 3. Policy acceptance check
  IF NOT app_security.has_current_policy_acceptance(v_uid) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Policy acceptance required';
  END IF;

  -- 4. Lock and verify listing existence and ownership
  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL OR v_listing.seller_id != v_uid THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND: Listing not found';
  END IF;

  -- 5. Mutable listing status check
  IF v_listing.status NOT IN ('draft', 'rejected', 'active', 'reserved', 'paused', 'pending_review') THEN
    RAISE EXCEPTION 'LISTING_MEDIA_NOT_EDITABLE: Media cannot be reordered in status %', v_listing.status;
  END IF;

  -- 6. Validate input array bounds
  v_requested_count := coalesce(cardinality(p_media_ids), 0);
  IF v_requested_count < 1 THEN
    RAISE EXCEPTION 'INVALID_MEDIA_REQUEST: Media IDs array cannot be empty';
  END IF;

  IF v_requested_count > 8 THEN
    RAISE EXCEPTION 'PHOTO_LIMIT_REACHED: Maximum 8 photos allowed per listing';
  END IF;

  -- 7. Validate uniqueness in requested array
  IF (SELECT count(DISTINCT id) FROM unnest(p_media_ids) AS id) != v_requested_count THEN
    RAISE EXCEPTION 'INVALID_MEDIA_REQUEST: Duplicate media IDs provided in reorder list';
  END IF;

  -- 8. Lock all media rows for this listing and ensure NO unready media exists
  PERFORM 1
  FROM public.listing_media
  WHERE listing_id = p_listing_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.listing_media
    WHERE listing_id = p_listing_id
      AND processing_status != 'ready'::public.media_processing_status_enum
  ) THEN
    RAISE EXCEPTION 'INVALID_MEDIA_REQUEST: Photos can only be reordered after all uploads are ready.';
  END IF;

  SELECT array_agg(id ORDER BY display_order ASC, created_at ASC)
  INTO v_current_ids
  FROM public.listing_media
  WHERE listing_id = p_listing_id
    AND processing_status = 'ready'::public.media_processing_status_enum;

  v_existing_count := coalesce(cardinality(v_current_ids), 0);

  -- 9. Complete membership check: exact match of READY items required
  IF v_requested_count != v_existing_count THEN
    RAISE EXCEPTION 'INVALID_MEDIA_REQUEST: Complete membership required. Expected % ready photos, got %', v_existing_count, v_requested_count;
  END IF;

  -- Ensure every requested ID is in v_current_ids
  IF NOT (p_media_ids <@ v_current_ids AND v_current_ids <@ p_media_ids) THEN
    RAISE EXCEPTION 'INVALID_MEDIA_REQUEST: Reorder list does not match persisted ready media set';
  END IF;

  -- 10. Idempotent no-op check: if submitted order is identical to current order,
  -- return early with changed=false BEFORE updating rows, triggering re-review, or writing audit log
  IF v_current_ids = p_media_ids THEN
    RETURN jsonb_build_object(
      'success', true,
      'changed', false,
      'count', v_requested_count
    );
  END IF;

  -- 11. Perform atomic reorder collision-safely
  UPDATE public.listing_media m
  SET display_order = pos.new_order
  FROM (
    SELECT unnest(p_media_ids) AS id, generate_subscripts(p_media_ids, 1) - 1 AS new_order
  ) pos
  WHERE m.id = pos.id AND m.listing_id = p_listing_id;

  -- 12. Listing re-review lifecycle:
  -- If active, reserved, or paused, transition to pending_review and increment revision once.
  -- If already pending_review, do not fabricate another transition.
  IF v_listing.status IN ('active', 'reserved', 'paused') THEN
    UPDATE public.listings
    SET status = 'pending_review'::public.listing_status_enum,
        revision = v_listing.revision + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  END IF;

  -- 13. Audit log for actual structural changes
  PERFORM app_security.log_audit_event(
    'media.reordered',
    'listings',
    p_listing_id,
    jsonb_build_object('media_ids', p_media_ids)
  );

  RETURN jsonb_build_object(
    'success', true,
    'changed', true,
    'count', v_requested_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_reorder_listing_media(
  listing_id uuid,
  media_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_seller_reorder_listing_media(listing_id, media_ids);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_seller_reorder_listing_media(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_seller_reorder_listing_media(uuid, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_reorder_listing_media(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_reorder_listing_media(uuid, uuid[]) TO authenticated, service_role;

-- =============================================================================
-- 5. Transactional Seller Cover Photo Selection RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION app_security.impl_seller_set_listing_cover_photo(
  p_listing_id uuid,
  p_media_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_listing record;
  v_media record;
BEGIN
  -- 1. Authentication check
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: Authentication required';
  END IF;

  -- 2. Account status check
  IF app_security.get_account_status(v_uid) != 'active' THEN
    RAISE EXCEPTION 'ACCOUNT_RESTRICTED: Account is not active';
  END IF;

  -- 3. Policy acceptance check
  IF NOT app_security.has_current_policy_acceptance(v_uid) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Policy acceptance required';
  END IF;

  -- 4. Lock and verify listing existence and ownership
  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL OR v_listing.seller_id != v_uid THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND: Listing not found';
  END IF;

  -- 5. Mutable listing status check
  IF v_listing.status NOT IN ('draft', 'rejected', 'active', 'reserved', 'paused', 'pending_review') THEN
    RAISE EXCEPTION 'LISTING_MEDIA_NOT_EDITABLE: Cover photo cannot be set in status %', v_listing.status;
  END IF;

  -- 6. Lock and verify media existence on this listing and ready status
  SELECT * INTO v_media
  FROM public.listing_media
  WHERE id = p_media_id AND listing_id = p_listing_id
  FOR UPDATE;

  IF v_media.id IS NULL THEN
    RAISE EXCEPTION 'MEDIA_NOT_FOUND: Media % not found on listing %', p_media_id, p_listing_id;
  END IF;

  IF v_media.processing_status != 'ready'::public.media_processing_status_enum THEN
    RAISE EXCEPTION 'COVER_UPDATE_FAILED: Media is not ready (status: %)', v_media.processing_status;
  END IF;

  -- 7. Update cover_photo_id
  UPDATE public.listings
  SET cover_photo_id = p_media_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_listing_id;

  -- 8. Audit log
  PERFORM app_security.log_audit_event(
    'listing.cover_photo_updated',
    'listings',
    p_listing_id,
    jsonb_build_object('cover_photo_id', p_media_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'cover_photo_id', p_media_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_set_listing_cover_photo(
  listing_id uuid,
  media_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_seller_set_listing_cover_photo(listing_id, media_id);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_seller_set_listing_cover_photo(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_seller_set_listing_cover_photo(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_set_listing_cover_photo(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_set_listing_cover_photo(uuid, uuid) TO authenticated, service_role;

-- =============================================================================
-- 6. Transactional Seller Media Delete RPC (Idempotent Absence Handling)
-- =============================================================================

CREATE OR REPLACE FUNCTION app_security.impl_seller_delete_listing_media(
  p_listing_id uuid,
  p_media_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_listing record;
  v_media record;
  v_new_cover_id uuid := null;
BEGIN
  -- 1. Authentication check
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: Authentication required';
  END IF;

  -- 2. Account status check
  IF app_security.get_account_status(v_uid) != 'active' THEN
    RAISE EXCEPTION 'ACCOUNT_RESTRICTED: Account is not active';
  END IF;

  -- 3. Policy acceptance check
  IF NOT app_security.has_current_policy_acceptance(v_uid) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Policy acceptance required';
  END IF;

  -- 4. Lock and verify listing existence and ownership
  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL OR v_listing.seller_id != v_uid THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND: Listing not found';
  END IF;

  -- 5. Mutable listing status check
  IF v_listing.status NOT IN ('draft', 'rejected', 'active', 'reserved', 'paused', 'pending_review') THEN
    RAISE EXCEPTION 'LISTING_MEDIA_NOT_EDITABLE: Media cannot be deleted in status %', v_listing.status;
  END IF;

  -- 6. Lock and verify media existence on this listing
  SELECT * INTO v_media
  FROM public.listing_media
  WHERE id = p_media_id AND listing_id = p_listing_id
  FOR UPDATE;

  -- Idempotent absence: if media row is already gone, return success with deleted=false
  IF v_media.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'deleted', false,
      'deleted_media_id', null,
      'new_cover_id', v_listing.cover_photo_id
    );
  END IF;

  -- 7. If deleted media was the cover photo, select canonical next READY photo
  IF v_listing.cover_photo_id = p_media_id THEN
    SELECT id INTO v_new_cover_id
    FROM public.listing_media
    WHERE listing_id = p_listing_id
      AND id != p_media_id
      AND processing_status = 'ready'::public.media_processing_status_enum
    ORDER BY display_order ASC, created_at ASC
    LIMIT 1;

    UPDATE public.listings
    SET cover_photo_id = v_new_cover_id,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  ELSE
    v_new_cover_id := v_listing.cover_photo_id;
  END IF;

  -- 8. Delete the media row
  -- Deleting a 'ready' photo triggers trg_listing_media_after_delete (which triggers re-review).
  -- Deleting a failed/uploading/processing photo does NOT trigger re-review.
  DELETE FROM public.listing_media
  WHERE id = p_media_id AND listing_id = p_listing_id;

  -- 9. Audit log
  PERFORM app_security.log_audit_event(
    'media.deleted',
    'listings',
    p_listing_id,
    jsonb_build_object('media_id', p_media_id, 'new_cover_id', v_new_cover_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'deleted', true,
    'deleted_media_id', p_media_id,
    'new_cover_id', v_new_cover_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_delete_listing_media(
  listing_id uuid,
  media_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_seller_delete_listing_media(listing_id, media_id);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_seller_delete_listing_media(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_seller_delete_listing_media(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_delete_listing_media(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_delete_listing_media(uuid, uuid) TO authenticated, service_role;

-- =============================================================================
-- 7. Revoke Authenticated Direct Mutation Grants (RPCs Authoritative)
-- =============================================================================

-- Revoke direct display_order updates: reorder must use public.seller_reorder_listing_media
REVOKE UPDATE (display_order) ON public.listing_media FROM authenticated;

-- Revoke direct cover_photo_id updates: cover changes must use public.seller_set_listing_cover_photo
REVOKE UPDATE (cover_photo_id) ON public.listings FROM authenticated;
