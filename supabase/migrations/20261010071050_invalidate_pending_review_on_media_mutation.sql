-- =============================================================================
-- Migration 37: Invalidate Pending Review On Media Mutation
-- =============================================================================
-- Purpose:
-- Ensure that any review-visible media mutation on a listing while it is in
-- 'pending_review' status increments listings.revision in the same transaction,
-- invalidating prior moderator review contexts (causing moderate_listing_reviewed
-- to reject stale reviews with PT409: MODERATION_REVIEW_CONFLICT).
--
-- Reconciliations & Coordination:
-- 1. Reorder Ownership & Privileged Write Coverage:
--    Migration 6 created trg_listing_media_after_reorder on public.listing_media.
--    In Migration 33, direct display_order updates were revoked from authenticated,
--    making app_security.impl_seller_reorder_listing_media authoritative for sellers.
--    However, service_role retains direct table UPDATE privileges.
--    PostgreSQL does not permit an UPDATE OF column list when REFERENCING transition tables.
--    Therefore, trg_listing_media_after_reorder is replaced with an AFTER UPDATE statement-level trigger:
--    trg_listing_media_reorder_statement.
--    This fires AFTER UPDATE ON public.listing_media REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
--    FOR EACH STATEMENT, filters inside the trigger function for rows whose display_order actually changed
--    on ready media, sorts the distinct affected listing IDs deterministically, and invokes
--    trigger_listing_media_rereview(listing_id) for each affected listing.
--    The seller RPC impl_seller_reorder_listing_media performs the atomic UPDATE and relies on
--    this statement trigger for re-review invalidation, eliminating redundant manual bumps.
--
-- 2. Single Deletion-Invalidation Owner:
--    To eliminate duplicate invalidation without custom configuration settings, session flags,
--    or caller-controlled bypass markers:
--    - The historical AFTER DELETE trigger (trg_listing_media_after_delete) is DROPPED.
--    - A BEFORE DELETE row-level trigger is established: trg_listing_media_before_delete.
--      When OLD.processing_status = 'ready', it invokes trigger_listing_media_rereview(OLD.listing_id).
--      This structural invalidation owner runs BEFORE the media row is deleted and BEFORE the foreign
--      key fk_listings_cover_photo sets cover_photo_id to NULL.
--      For active/reserved/paused listings, this pre-delete trigger immediately transitions the listing
--      to 'pending_review' and increments revision by 1. For pending_review listings, it increments revision by 1.
--    - In app_security.impl_seller_delete_listing_media:
--      The RPC does NOT manually increment revision.
--      It identifies the fallback cover photo (if the deleted photo was the cover photo),
--      executes the DELETE statement (which fires the BEFORE DELETE invalidation trigger once),
--      and subsequently updates cover_photo_id to the fallback photo if one exists.
--      Because the listing is ALREADY in 'pending_review' (established by the pre-delete trigger),
--      the post-delete cover update does NOT fire a material-edit status transition or revision bump.
--    - Direct privileged DELETE statements from service_role on ready media are also automatically
--      and cleanly invalidated by the same BEFORE DELETE trigger.
--
-- 3. Lock Order Normalization:
--    Finalizer (impl_record_media_processing_result) acquires parent listing lock
--    BEFORE mutating media row, matching seller mutation lock order (parent -> media).
-- =============================================================================

-- =============================================================================
-- 1. Helper: app_security.trigger_listing_media_rereview
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.trigger_listing_media_rereview(p_listing_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.listing_status_enum;
  v_revision integer;
BEGIN
  SELECT status, revision INTO v_status, v_revision
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_status IN ('active', 'reserved', 'paused') THEN
    UPDATE public.listings
    SET status = 'pending_review'::public.listing_status_enum,
        revision = v_revision + 1,
        submitted_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  ELSIF v_status = 'pending_review'::public.listing_status_enum THEN
    UPDATE public.listings
    SET revision = v_revision + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_security.trigger_listing_media_rereview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.trigger_listing_media_rereview(uuid) TO service_role;

-- =============================================================================
-- 2. Service-Role-Only RPC: app_security.impl_record_media_processing_result
-- Lock parent listing before mutating media row to prevent deadlock with seller RPCs.
-- Revalidate media row existence and parent listing link after locking parent.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.impl_record_media_processing_result(
  p_media_id uuid,
  p_paths jsonb,
  p_dimensions jsonb,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_listing_id uuid;
  v_media record;
BEGIN
  -- Preliminary non-locking lookup to identify parent listing
  SELECT listing_id INTO v_listing_id
  FROM public.listing_media
  WHERE id = p_media_id;

  IF v_listing_id IS NULL THEN
    RAISE EXCEPTION 'media record % not found', p_media_id;
  END IF;

  -- 1. Lock parent listing row first (normalizing lock order with seller RPCs)
  PERFORM 1
  FROM public.listings
  WHERE id = v_listing_id
  FOR UPDATE;

  -- 2. Lock and revalidate media row
  SELECT * INTO v_media
  FROM public.listing_media
  WHERE id = p_media_id
  FOR UPDATE;

  IF v_media.id IS NULL OR v_media.listing_id != v_listing_id THEN
    RAISE EXCEPTION 'media record % not found or reassociated', p_media_id;
  END IF;

  IF p_status = 'ready' THEN
    UPDATE public.listing_media
    SET original_storage_path = p_paths->>'original',
        thumbnail_storage_path = p_paths->>'thumbnail',
        medium_storage_path = p_paths->>'medium',
        large_storage_path = p_paths->>'large',
        width = (p_dimensions->>'width')::integer,
        height = (p_dimensions->>'height')::integer,
        processing_status = 'ready'::public.media_processing_status_enum,
        processing_error = NULL
    WHERE id = p_media_id;

    PERFORM app_security.log_audit_event(
      'media.processing_completed',
      'listing_media',
      p_media_id,
      jsonb_build_object('listing_id', v_media.listing_id)
    );

  ELSIF p_status = 'failed' THEN
    UPDATE public.listing_media
    SET processing_status = 'failed'::public.media_processing_status_enum,
        processing_error = p_error
    WHERE id = p_media_id;

    PERFORM app_security.log_audit_event(
      'media.processing_failed',
      'listing_media',
      p_media_id,
      jsonb_build_object('listing_id', v_media.listing_id, 'error', p_error)
    );

  ELSIF p_status = 'processing' THEN
    UPDATE public.listing_media
    SET original_storage_path = COALESCE(p_paths->>'original', original_storage_path),
        processing_status = 'processing'::public.media_processing_status_enum
    WHERE id = p_media_id;
  ELSE
    RAISE EXCEPTION 'invalid media status: %', p_status;
  END IF;

  RETURN jsonb_build_object('success', true, 'media_id', p_media_id, 'status', p_status);
END;
$$;

-- =============================================================================
-- 3. Reorder Invalidation Ownership & Privileged Direct-Write Protection
-- Replaces row-level trg_listing_media_after_reorder with statement-level trigger.
-- Fires ONCE per UPDATE statement on public.listing_media.
-- Filters transition tables for actual display_order changes on ready media,
-- sorts distinct listing IDs deterministically, and triggers rereview once per listing.
-- =============================================================================
DROP TRIGGER IF EXISTS trg_listing_media_after_reorder ON public.listing_media;
DROP FUNCTION IF EXISTS public.handle_listing_media_after_reorder();

CREATE OR REPLACE FUNCTION public.handle_listing_media_reorder_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lid uuid;
BEGIN
  -- Find distinct parent listings whose ready media actually changed display_order
  -- Process distinct listing IDs in deterministic ascending order
  FOR v_lid IN
    SELECT DISTINCT n.listing_id
    FROM new_table n
    JOIN old_table o ON n.id = o.id
    WHERE n.display_order IS DISTINCT FROM o.display_order
      AND n.processing_status = 'ready'::public.media_processing_status_enum
    ORDER BY n.listing_id ASC
  LOOP
    PERFORM app_security.trigger_listing_media_rereview(v_lid);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_listing_media_reorder_statement
AFTER UPDATE ON public.listing_media
REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.handle_listing_media_reorder_statement();

-- =============================================================================
-- 4. Seller Reorder RPC: app_security.impl_seller_reorder_listing_media
-- Performs atomic collision-free display_order updates.
-- Reorder invalidation is handled by trg_listing_media_reorder_statement,
-- so this RPC does NOT perform a duplicate manual revision increment.
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

  -- 8. Lock all media rows for this listing deterministically (ordered by id)
  PERFORM 1
  FROM public.listing_media
  WHERE listing_id = p_listing_id
  ORDER BY id
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
  -- This UPDATE fires trg_listing_media_reorder_statement ONCE for the statement,
  -- which invokes app_security.trigger_listing_media_rereview(p_listing_id).
  UPDATE public.listing_media m
  SET display_order = pos.new_order
  FROM (
    SELECT unnest(p_media_ids) AS id, generate_subscripts(p_media_ids, 1) - 1 AS new_order
  ) pos
  WHERE m.id = pos.id AND m.listing_id = p_listing_id;

  -- 12. Audit log for actual structural changes
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

-- =============================================================================
-- 5. Seller Set Cover Photo RPC: app_security.impl_seller_set_listing_cover_photo
-- Advances revision when listing is pending_review and cover photo actually changes.
-- Protects no-op reselection (same cover photo returns early without increment).
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

  -- 7. Idempotent no-op check: if cover photo is already p_media_id, return early
  IF v_listing.cover_photo_id IS NOT DISTINCT FROM p_media_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'changed', false,
      'cover_photo_id', p_media_id
    );
  END IF;

  -- 8. Update cover_photo_id
  -- If active, reserved, or paused, trg_listings_before_update transitions to pending_review and increments revision.
  -- If in pending_review, trg_listings_before_update does NOT increment revision, so we explicitly increment revision.
  IF v_listing.status = 'pending_review'::public.listing_status_enum THEN
    UPDATE public.listings
    SET cover_photo_id = p_media_id,
        revision = v_listing.revision + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  ELSE
    UPDATE public.listings
    SET cover_photo_id = p_media_id,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  END IF;

  -- 9. Audit log
  PERFORM app_security.log_audit_event(
    'listing.cover_photo_updated',
    'listings',
    p_listing_id,
    jsonb_build_object('cover_photo_id', p_media_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'changed', true,
    'cover_photo_id', p_media_id
  );
END;
$$;

-- =============================================================================
-- 6. Single Deletion-Invalidation Owner: BEFORE DELETE Trigger & Seller RPC
-- Replaces after_delete trigger with a BEFORE DELETE row-level trigger on listing_media.
-- When a ready photo is deleted, this trigger runs BEFORE deletion and BEFORE FK cover-clearing,
-- invalidating active/reserved/paused/pending_review listings cleanly.
-- The seller RPC does not manually increment revision; it updates the fallback cover AFTER
-- the deletion has occurred and the listing is already in pending_review.
-- =============================================================================
DROP TRIGGER IF EXISTS trg_listing_media_after_delete ON public.listing_media;
DROP FUNCTION IF EXISTS public.handle_listing_media_after_delete();

CREATE OR REPLACE FUNCTION public.handle_listing_media_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.processing_status = 'ready'::public.media_processing_status_enum THEN
    PERFORM app_security.trigger_listing_media_rereview(OLD.listing_id);

    -- Clear only this row's current-cover reference while the row still exists.
    -- The helper above has already performed the intended invalidation.
    UPDATE public.listings
    SET cover_photo_id = NULL
    WHERE id = OLD.listing_id
      AND cover_photo_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_listing_media_before_delete ON public.listing_media;
CREATE TRIGGER trg_listing_media_before_delete
BEFORE DELETE ON public.listing_media
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_media_before_delete();

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
  v_is_cover boolean := false;
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

  v_is_cover := (v_listing.cover_photo_id = p_media_id);

  -- 7. If deleted media was the cover photo, identify canonical next READY photo before deletion
  IF v_is_cover THEN
    SELECT id INTO v_new_cover_id
    FROM public.listing_media
    WHERE listing_id = p_listing_id
      AND id != p_media_id
      AND processing_status = 'ready'::public.media_processing_status_enum
    ORDER BY display_order ASC, created_at ASC
    LIMIT 1;
  ELSE
    v_new_cover_id := v_listing.cover_photo_id;
  END IF;

  -- 8. Delete the media row
  -- If v_media was ready, trg_listing_media_before_delete fires trigger_listing_media_rereview(p_listing_id)
  -- BEFORE the row is deleted and before the FK clears cover_photo_id.
  -- This transitions active/reserved/paused listings to pending_review (+1 revision) or bumps revision (+1)
  -- if already in pending_review.
  DELETE FROM public.listing_media
  WHERE id = p_media_id AND listing_id = p_listing_id;

  -- 9. If deleted media was the cover photo and a fallback photo exists, assign it.
  -- Because the listing is now in pending_review, trg_listings_before_update does NOT bump revision.
  IF v_is_cover AND v_new_cover_id IS NOT NULL THEN
    UPDATE public.listings
    SET cover_photo_id = v_new_cover_id,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  END IF;

  -- 10. Audit log
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
