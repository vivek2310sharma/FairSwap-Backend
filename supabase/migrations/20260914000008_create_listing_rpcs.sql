-- Migration 8: 20260914000008_create_listing_rpcs.sql
-- Two-Layer RPC Architecture for Listings, Moderation, Media Processing, Expiry, and Categories

-- =============================================================================
-- 1. Helper: is_listing_publicly_visible (for future 1.4 discovery primitive)
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.is_listing_publicly_visible(p_listing_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.listings l
    JOIN public.user_accounts ua ON ua.user_id = l.seller_id
    WHERE l.id = p_listing_id
      AND l.status = 'active'
      AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
      AND ua.account_status = 'active'
  );
$$;

REVOKE ALL ON FUNCTION app_security.is_listing_publicly_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.is_listing_publicly_visible(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_listing_publicly_visible(listing_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app_security.is_listing_publicly_visible(listing_id);
$$;

REVOKE ALL ON FUNCTION public.is_listing_publicly_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_listing_publicly_visible(uuid) TO anon, authenticated, service_role;

-- =============================================================================
-- 2. Seller RPC: submit listing
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.impl_seller_submit_listing(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_listing record;
  v_media_count integer;
  v_unready_media_count integer;
  v_attr record;
  v_cover_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) != 'active' THEN
    RAISE EXCEPTION 'account is not active';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'listing not found';
  END IF;

  IF v_listing.seller_id != v_caller_id THEN
    RAISE EXCEPTION 'caller does not own this listing';
  END IF;

  IF v_listing.status NOT IN ('draft', 'rejected') THEN
    RAISE EXCEPTION 'listing status % cannot be submitted for review', v_listing.status;
  END IF;

  -- Validate required fields
  IF length(trim(v_listing.title)) < 3 THEN
    RAISE EXCEPTION 'title must be at least 3 characters';
  END IF;

  IF v_listing.description IS NULL OR length(trim(v_listing.description)) < 10 THEN
    RAISE EXCEPTION 'description must be at least 10 characters';
  END IF;

  IF v_listing.category_id IS NULL THEN
    RAISE EXCEPTION 'category is required';
  END IF;

  IF v_listing.city_id IS NULL THEN
    RAISE EXCEPTION 'city is required';
  END IF;

  IF v_listing.condition IS NULL THEN
    RAISE EXCEPTION 'condition is required';
  END IF;

  IF v_listing.price_type IS NULL THEN
    RAISE EXCEPTION 'price type is required';
  END IF;

  IF v_listing.price_type != 'free' AND (v_listing.price_paise IS NULL OR v_listing.price_paise <= 0) THEN
    RAISE EXCEPTION 'price in paise is required for non-free listings';
  END IF;

  -- Validate required category attributes
  FOR v_attr IN (
    SELECT name, label
    FROM public.category_attributes
    WHERE category_id = v_listing.category_id AND is_required = true
  ) LOOP
    IF NOT (v_listing.category_attributes ? v_attr.name) OR
       v_listing.category_attributes->>v_attr.name IS NULL OR
       length(trim(v_listing.category_attributes->>v_attr.name)) = 0 THEN
      RAISE EXCEPTION 'required attribute % (%) is missing', v_attr.label, v_attr.name;
    END IF;
  END LOOP;

  -- Validate media: at least 1 ready photo, no failed/processing required
  SELECT count(*) INTO v_media_count
  FROM public.listing_media
  WHERE listing_id = p_listing_id AND processing_status = 'ready';

  IF v_media_count < 1 THEN
    RAISE EXCEPTION 'listing must have at least one photo with processing_status = ready';
  END IF;

  -- Auto-assign cover photo if not set
  v_cover_id := v_listing.cover_photo_id;
  IF v_cover_id IS NULL THEN
    SELECT id INTO v_cover_id
    FROM public.listing_media
    WHERE listing_id = p_listing_id AND processing_status = 'ready'
    ORDER BY display_order ASC, created_at ASC
    LIMIT 1;
  END IF;

  -- Update listing status to pending_review
  UPDATE public.listings
  SET status = 'pending_review'::public.listing_status_enum,
      cover_photo_id = v_cover_id,
      submitted_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_listing_id;

  -- Audit log
  PERFORM app_security.log_audit_event(
    'listing.submitted',
    'listings',
    p_listing_id,
    jsonb_build_object('revision', v_listing.revision)
  );

  RETURN jsonb_build_object('success', true, 'status', 'pending_review');
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_submit_listing(listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_seller_submit_listing(listing_id);
END;
$$;

REVOKE ALL ON FUNCTION public.seller_submit_listing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seller_submit_listing(uuid) TO authenticated;

-- =============================================================================
-- 3. Seller RPC: transition listing (pause, resume, reserve, unreserve, sold, renew)
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.impl_seller_transition_listing(
  p_listing_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_listing record;
  v_new_status public.listing_status_enum;
  v_renewal_limit constant integer := 3;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) != 'active' THEN
    RAISE EXCEPTION 'account is not active';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'listing not found';
  END IF;

  IF v_listing.seller_id != v_caller_id THEN
    RAISE EXCEPTION 'caller does not own this listing';
  END IF;

  CASE p_action
    WHEN 'pause' THEN
      IF v_listing.status != 'active' THEN
        RAISE EXCEPTION 'only active listings can be paused (current: %)', v_listing.status;
      END IF;
      v_new_status := 'paused'::public.listing_status_enum;

      UPDATE public.listings
      SET status = v_new_status,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.paused',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision)
      );

    WHEN 'resume' THEN
      IF v_listing.status != 'paused' THEN
        RAISE EXCEPTION 'only paused listings can be resumed (current: %)', v_listing.status;
      END IF;
      -- Validate it has been published previously and not expired
      IF v_listing.published_at IS NULL THEN
        RAISE EXCEPTION 'unapproved listing cannot be resumed';
      END IF;
      IF v_listing.expires_at IS NOT NULL AND v_listing.expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION 'expired listing cannot be resumed directly';
      END IF;
      v_new_status := 'active'::public.listing_status_enum;

      UPDATE public.listings
      SET status = v_new_status,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.resumed',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision)
      );

    WHEN 'reserve' THEN
      IF v_listing.status != 'active' THEN
        RAISE EXCEPTION 'only active listings can be reserved (current: %)', v_listing.status;
      END IF;
      v_new_status := 'reserved'::public.listing_status_enum;

      UPDATE public.listings
      SET status = v_new_status,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.reserved',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision)
      );

    WHEN 'unreserve' THEN
      IF v_listing.status != 'reserved' THEN
        RAISE EXCEPTION 'only reserved listings can be unreserved (current: %)', v_listing.status;
      END IF;
      v_new_status := 'active'::public.listing_status_enum;

      UPDATE public.listings
      SET status = v_new_status,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.unreserved',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision)
      );

    WHEN 'mark_sold' THEN
      IF v_listing.status NOT IN ('active', 'reserved', 'paused') THEN
        RAISE EXCEPTION 'listing in status % cannot be marked sold', v_listing.status;
      END IF;
      v_new_status := 'sold'::public.listing_status_enum;

      UPDATE public.listings
      SET status = v_new_status,
          sold_at = pg_catalog.clock_timestamp(),
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.sold',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision)
      );

    WHEN 'renew' THEN
      IF v_listing.status != 'expired' THEN
        RAISE EXCEPTION 'only expired listings can be renewed (current: %)', v_listing.status;
      END IF;
      IF v_listing.renewal_count >= v_renewal_limit THEN
        RAISE EXCEPTION 'renewal limit of % reached', v_renewal_limit;
      END IF;
      v_new_status := 'pending_review'::public.listing_status_enum;

      UPDATE public.listings
      SET status = v_new_status,
          renewal_count = v_listing.renewal_count + 1,
          submitted_at = pg_catalog.clock_timestamp(),
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.renewed',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision, 'renewal_count', v_listing.renewal_count + 1)
      );

    ELSE
      RAISE EXCEPTION 'invalid transition action: %', p_action;
  END CASE;

  RETURN jsonb_build_object('success', true, 'new_status', v_new_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_transition_listing(listing_id uuid, action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_seller_transition_listing(listing_id, action);
END;
$$;

REVOKE ALL ON FUNCTION public.seller_transition_listing(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seller_transition_listing(uuid, text) TO authenticated;

-- =============================================================================
-- 4. Moderator RPC: approve, reject, remove
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.impl_moderate_listing(
  p_listing_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_listing record;
  v_unready_media_count integer;
  v_media_count integer;
  v_cover_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'listing not found';
  END IF;

  -- Self-approval denied
  IF v_listing.seller_id = v_caller_id THEN
    RAISE EXCEPTION 'moderator cannot review their own listing';
  END IF;

  -- Require moderator role and AAL2
  IF NOT (app_security.is_active_staff_aal2('moderator') OR app_security.is_active_staff_aal2('administrator')) THEN
    RAISE EXCEPTION 'caller is not an active moderator with AAL2 MFA';
  END IF;

  CASE p_action
    WHEN 'approve' THEN
      IF v_listing.status != 'pending_review' THEN
        RAISE EXCEPTION 'only listings in pending_review can be approved (current: %)', v_listing.status;
      END IF;

      -- Check all media is ready
      SELECT count(*) INTO v_media_count
      FROM public.listing_media
      WHERE listing_id = p_listing_id;

      IF v_media_count < 1 THEN
        RAISE EXCEPTION 'listing must have at least one photo to be approved';
      END IF;

      SELECT count(*) INTO v_unready_media_count
      FROM public.listing_media
      WHERE listing_id = p_listing_id AND processing_status != 'ready';

      IF v_unready_media_count > 0 THEN
        RAISE EXCEPTION 'all photos must have processing_status = ready before approval';
      END IF;

      -- Ensure cover photo is set
      v_cover_id := v_listing.cover_photo_id;
      IF v_cover_id IS NULL THEN
        SELECT id INTO v_cover_id
        FROM public.listing_media
        WHERE listing_id = p_listing_id AND processing_status = 'ready'
        ORDER BY display_order ASC, created_at ASC
        LIMIT 1;
      END IF;

      UPDATE public.listings
      SET status = 'active'::public.listing_status_enum,
          published_at = pg_catalog.clock_timestamp(),
          expires_at = pg_catalog.clock_timestamp() + INTERVAL '30 days',
          rejection_reason = NULL,
          cover_photo_id = v_cover_id,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.approved',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision)
      );

      RETURN jsonb_build_object('success', true, 'status', 'active');

    WHEN 'reject' THEN
      IF v_listing.status != 'pending_review' THEN
        RAISE EXCEPTION 'only listings in pending_review can be rejected (current: %)', v_listing.status;
      END IF;

      IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'rejection reason is required';
      END IF;

      UPDATE public.listings
      SET status = 'rejected'::public.listing_status_enum,
          rejection_reason = trim(p_reason),
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.rejected',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision, 'reason', trim(p_reason))
      );

      RETURN jsonb_build_object('success', true, 'status', 'rejected');

    WHEN 'remove' THEN
      IF v_listing.status NOT IN ('active', 'reserved', 'paused', 'pending_review') THEN
        RAISE EXCEPTION 'listing in status % cannot be removed', v_listing.status;
      END IF;

      IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'removal reason is required';
      END IF;

      UPDATE public.listings
      SET status = 'removed'::public.listing_status_enum,
          removal_reason = trim(p_reason),
          removed_by = v_caller_id,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_listing_id;

      PERFORM app_security.log_audit_event(
        'listing.removed',
        'listings',
        p_listing_id,
        jsonb_build_object('revision', v_listing.revision, 'reason', trim(p_reason))
      );

      RETURN jsonb_build_object('success', true, 'status', 'removed');

    ELSE
      RAISE EXCEPTION 'invalid moderation action: %', p_action;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.moderate_listing(listing_id uuid, action text, reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_moderate_listing(listing_id, action, reason);
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_listing(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.moderate_listing(uuid, text, text) TO authenticated;

-- =============================================================================
-- 5. Service-Role-Only RPC: record_media_processing_result
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
  v_media record;
BEGIN
  SELECT * INTO v_media
  FROM public.listing_media
  WHERE id = p_media_id
  FOR UPDATE;

  IF v_media.id IS NULL THEN
    RAISE EXCEPTION 'media record % not found', p_media_id;
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

CREATE OR REPLACE FUNCTION public.record_media_processing_result(
  media_id uuid,
  paths jsonb,
  dimensions jsonb,
  status text,
  error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_record_media_processing_result(media_id, paths, dimensions, status, error);
END;
$$;

-- Explicitly grant only to service_role; revoke from PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.record_media_processing_result(uuid, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_media_processing_result(uuid, jsonb, jsonb, text, text) TO service_role;

-- =============================================================================
-- 6. Service-Role-Only RPC: expire_listing
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.impl_expire_listing(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_listing record;
BEGIN
  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'listing % not found', p_listing_id;
  END IF;

  IF v_listing.status NOT IN ('active', 'reserved', 'paused') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'listing is not active/reserved/paused');
  END IF;

  IF v_listing.expires_at IS NOT NULL AND v_listing.expires_at > pg_catalog.clock_timestamp() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'listing has not expired yet');
  END IF;

  -- Set system actor context so trigger records system transition
  PERFORM set_config('app.is_system_transition', 'true', true);

  UPDATE public.listings
  SET status = 'expired'::public.listing_status_enum,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_listing_id;

  PERFORM app_security.log_audit_event(
    'listing.expired',
    'listings',
    p_listing_id,
    jsonb_build_object('revision', v_listing.revision, 'actor_kind', 'system')
  );

  RETURN jsonb_build_object('success', true, 'status', 'expired');
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_listing(listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_expire_listing(listing_id);
END;
$$;

-- Explicitly grant only to service_role; revoke from PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.expire_listing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_listing(uuid) TO service_role;

-- =============================================================================
-- 7. Service-Role-Only RPC: delete_listing_media_internal
-- =============================================================================
-- Binding Amendment 3: Server-mediated deletion helper
CREATE OR REPLACE FUNCTION app_security.impl_delete_listing_media(
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
  v_listing record;
  v_media record;
  v_new_cover_id uuid := NULL;
BEGIN
  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'listing % not found', p_listing_id;
  END IF;

  SELECT * INTO v_media
  FROM public.listing_media
  WHERE id = p_media_id AND listing_id = p_listing_id
  FOR UPDATE;

  IF v_media.id IS NULL THEN
    RAISE EXCEPTION 'media % not found on listing %', p_media_id, p_listing_id;
  END IF;

  -- If this was cover photo, choose another ready media or set NULL
  IF v_listing.cover_photo_id = p_media_id THEN
    SELECT id INTO v_new_cover_id
    FROM public.listing_media
    WHERE listing_id = p_listing_id AND id != p_media_id AND processing_status = 'ready'
    ORDER BY display_order ASC, created_at ASC
    LIMIT 1;

    UPDATE public.listings
    SET cover_photo_id = v_new_cover_id,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;
  END IF;

  -- Delete media row (triggers AFTER DELETE which re-reviews if active/reserved/paused)
  DELETE FROM public.listing_media
  WHERE id = p_media_id;

  PERFORM app_security.log_audit_event(
    'media.deleted',
    'listing_media',
    p_media_id,
    jsonb_build_object('listing_id', p_listing_id)
  );

  RETURN jsonb_build_object('success', true, 'deleted_media_id', p_media_id, 'new_cover_id', v_new_cover_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_listing_media_internal(listing_id uuid, media_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_delete_listing_media(listing_id, media_id);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_listing_media_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_listing_media_internal(uuid, uuid) TO service_role;

-- =============================================================================
-- 8. Admin RPCs: Category & Location Management
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.impl_manage_category(
  p_action text,
  p_category_id uuid DEFAULT NULL,
  p_slug text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_icon text DEFAULT NULL,
  p_sort_order integer DEFAULT 0,
  p_is_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT (app_security.is_active_staff_aal2('administrator') OR app_security.is_active_staff_aal2('content_editor')) THEN
    RAISE EXCEPTION 'caller must be active administrator or content_editor with AAL2 MFA';
  END IF;

  CASE p_action
    WHEN 'create' THEN
      INSERT INTO public.categories (slug, name, description, icon, sort_order, is_active)
      VALUES (p_slug, p_name, p_description, p_icon, p_sort_order, p_is_active)
      RETURNING id INTO v_id;

      PERFORM app_security.log_audit_event(
        'category.created',
        'categories',
        v_id,
        jsonb_build_object('slug', p_slug, 'name', p_name)
      );

      RETURN jsonb_build_object('success', true, 'category_id', v_id);

    WHEN 'update' THEN
      UPDATE public.categories
      SET name = COALESCE(p_name, name),
          description = COALESCE(p_description, description),
          icon = COALESCE(p_icon, icon),
          sort_order = COALESCE(p_sort_order, sort_order),
          is_active = COALESCE(p_is_active, is_active),
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = p_category_id;

      PERFORM app_security.log_audit_event(
        'category.updated',
        'categories',
        p_category_id,
        jsonb_build_object('name', p_name, 'is_active', p_is_active)
      );

      RETURN jsonb_build_object('success', true, 'category_id', p_category_id);

    ELSE
      RAISE EXCEPTION 'invalid category action: %', p_action;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_manage_category(
  action text,
  category_id uuid DEFAULT NULL,
  slug text DEFAULT NULL,
  name text DEFAULT NULL,
  description text DEFAULT NULL,
  icon text DEFAULT NULL,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_manage_category(
    action, category_id, slug, name, description, icon, sort_order, is_active
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_manage_category(text, uuid, text, text, text, text, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_manage_category(text, uuid, text, text, text, text, integer, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION app_security.impl_manage_location(
  p_action text,
  p_city_id uuid DEFAULT NULL,
  p_locality_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_slug text DEFAULT NULL,
  p_is_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'caller must be active administrator with AAL2 MFA';
  END IF;

  CASE p_action
    WHEN 'create_city' THEN
      INSERT INTO public.cities (name, state, slug, is_active)
      VALUES (p_name, p_state, p_slug, p_is_active)
      RETURNING id INTO v_id;

      PERFORM app_security.log_audit_event(
        'city.created',
        'cities',
        v_id,
        jsonb_build_object('name', p_name, 'state', p_state, 'slug', p_slug)
      );

      RETURN jsonb_build_object('success', true, 'city_id', v_id);

    WHEN 'update_city' THEN
      UPDATE public.cities
      SET name = COALESCE(p_name, name),
          state = COALESCE(p_state, state),
          is_active = COALESCE(p_is_active, is_active)
      WHERE id = p_city_id;

      PERFORM app_security.log_audit_event(
        'city.updated',
        'cities',
        p_city_id,
        jsonb_build_object('name', p_name, 'is_active', p_is_active)
      );

      RETURN jsonb_build_object('success', true, 'city_id', p_city_id);

    WHEN 'create_locality' THEN
      INSERT INTO public.localities (city_id, name, slug, is_active)
      VALUES (p_city_id, p_name, p_slug, p_is_active)
      RETURNING id INTO v_id;

      PERFORM app_security.log_audit_event(
        'locality.created',
        'localities',
        v_id,
        jsonb_build_object('city_id', p_city_id, 'name', p_name, 'slug', p_slug)
      );

      RETURN jsonb_build_object('success', true, 'locality_id', v_id);

    WHEN 'update_locality' THEN
      UPDATE public.localities
      SET name = COALESCE(p_name, name),
          is_active = COALESCE(p_is_active, is_active)
      WHERE id = p_locality_id;

      PERFORM app_security.log_audit_event(
        'locality.updated',
        'localities',
        p_locality_id,
        jsonb_build_object('name', p_name, 'is_active', p_is_active)
      );

      RETURN jsonb_build_object('success', true, 'locality_id', p_locality_id);

    ELSE
      RAISE EXCEPTION 'invalid location action: %', p_action;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_manage_location(
  action text,
  city_id uuid DEFAULT NULL,
  locality_id uuid DEFAULT NULL,
  name text DEFAULT NULL,
  state text DEFAULT NULL,
  slug text DEFAULT NULL,
  is_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_manage_location(
    action, city_id, locality_id, name, state, slug, is_active
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_manage_location(text, uuid, uuid, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_manage_location(text, uuid, uuid, text, text, text, boolean) TO authenticated;