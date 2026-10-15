-- Migration 14: 20260914000014_create_privacy_fulfillment_and_fk_safety.sql
-- Foreign Key Safety for Auth Deletion, Account Deletion Orchestration, and Data Export

-- =============================================================================
-- 1. Historical Foreign Key Safety Adjustments for auth.admin.deleteUser()
-- =============================================================================

-- A. Listings: seller_id set null on delete (retains historical listing without cascade)
ALTER TABLE public.listings ALTER COLUMN seller_id DROP NOT NULL;
ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_seller_id_fkey;
ALTER TABLE public.listings ADD CONSTRAINT listings_seller_id_fkey
  FOREIGN KEY (seller_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- B. Listings: removed_by set null on delete
ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_removed_by_fkey;
ALTER TABLE public.listings ADD CONSTRAINT listings_removed_by_fkey
  FOREIGN KEY (removed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- C. Listing Status Transitions: actor_id set null on delete & relax check constraint
ALTER TABLE public.listing_status_transitions DROP CONSTRAINT IF EXISTS listing_status_transitions_actor_id_fkey;
ALTER TABLE public.listing_status_transitions ADD CONSTRAINT listing_status_transitions_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.listing_status_transitions DROP CONSTRAINT IF EXISTS chk_transition_system_actor;
ALTER TABLE public.listing_status_transitions ADD CONSTRAINT chk_transition_system_actor
  CHECK ((actor_kind = 'system' AND actor_id IS NULL) OR (actor_kind IN ('seller', 'moderator')));

-- D. Listing Media: uploader_id set null on delete
ALTER TABLE public.listing_media ALTER COLUMN uploader_id DROP NOT NULL;
ALTER TABLE public.listing_media DROP CONSTRAINT IF EXISTS listing_media_uploader_id_fkey;
ALTER TABLE public.listing_media ADD CONSTRAINT listing_media_uploader_id_fkey
  FOREIGN KEY (uploader_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- E. Staff Roles: assigned_by set null on delete
ALTER TABLE public.staff_roles DROP CONSTRAINT IF EXISTS staff_roles_assigned_by_fkey;
ALTER TABLE public.staff_roles ADD CONSTRAINT staff_roles_assigned_by_fkey
  FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- F. Privacy Requests: resolved_by set null on delete
ALTER TABLE public.privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_resolved_by_fkey;
ALTER TABLE public.privacy_requests ADD CONSTRAINT privacy_requests_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- G. Privacy Requests: user_id set null on delete (preserves compliance record)
ALTER TABLE public.privacy_requests ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_user_id_fkey;
ALTER TABLE public.privacy_requests ADD CONSTRAINT privacy_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- =============================================================================
-- 2. Server-Side Account Deletion Orchestration RPCs
-- =============================================================================

-- A. Phase 1: Begin Account Deletion (Atomic DB Anonymization)
CREATE OR REPLACE FUNCTION app_security.impl_begin_account_deletion(
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_req record;
  v_target_user_id uuid;
BEGIN
  v_caller_id := auth.uid();
  -- Require active administrator with AAL2 OR service_role (auth.uid() IS NULL in service context)
  IF v_caller_id IS NOT NULL AND NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator with AAL2';
  END IF;

  SELECT * INTO v_req
  FROM public.privacy_requests
  WHERE id = p_request_id AND request_type = 'delete_account';

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Delete account privacy request not found';
  END IF;

  IF v_req.status NOT IN ('pending', 'in_progress') THEN
    RAISE EXCEPTION 'Privacy request is already resolved or rejected';
  END IF;

  v_target_user_id := v_req.user_id;
  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'Target user already removed';
  END IF;

  -- 1. Mark request in_progress
  UPDATE public.privacy_requests
  SET status = 'in_progress'
  WHERE id = p_request_id;

  -- 2. Transition user account into deletion_pending
  UPDATE public.user_accounts
  SET account_status = 'deletion_pending',
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = v_target_user_id;

  -- 3. Anonymize profile
  UPDATE public.profiles
  SET display_name = 'Deleted User',
      avatar_url = NULL,
      bio = NULL,
      city = NULL,
      state = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_target_user_id;

  -- 4. Transition user's active/paused/draft listings to removed
  UPDATE public.listings
  SET status = 'removed',
      removal_reason = 'Account deleted by user',
      removed_by = v_caller_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE seller_id = v_target_user_id AND status NOT IN ('sold', 'removed');

  -- 5. Purge ephemeral personal data
  DELETE FROM public.favourites WHERE user_id = v_target_user_id;
  DELETE FROM public.user_blocks WHERE blocker_id = v_target_user_id OR blocked_id = v_target_user_id;
  DELETE FROM public.notifications WHERE user_id = v_target_user_id;

  -- 6. Log audit event
  PERFORM app_security.log_audit_event(
    'privacy.deletion_begun',
    'privacy_requests',
    p_request_id,
    jsonb_build_object('target_user_id', v_target_user_id, 'orchestrator', v_caller_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_target_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_begin_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_begin_account_deletion(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_begin_account_deletion(
  request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_begin_account_deletion(request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_begin_account_deletion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_begin_account_deletion(uuid) TO authenticated, service_role;

-- B. Phase 4: Finalize Account Deletion
CREATE OR REPLACE FUNCTION app_security.impl_finalize_account_deletion(
  p_request_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_req record;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NOT NULL AND NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator with AAL2';
  END IF;

  SELECT * INTO v_req
  FROM public.privacy_requests
  WHERE id = p_request_id;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Privacy request not found';
  END IF;

  -- Mark privacy request resolved
  UPDATE public.privacy_requests
  SET status = 'resolved',
      resolved_at = pg_catalog.clock_timestamp(),
      resolved_by = v_caller_id,
      resolution_notes = 'Account deletion successfully completed and Auth identity deleted.'
  WHERE id = p_request_id;

  -- If user_accounts row still exists, ensure status is marked deleted
  IF v_req.user_id IS NOT NULL THEN
    UPDATE public.user_accounts
    SET account_status = 'deleted',
        updated_at = pg_catalog.clock_timestamp()
    WHERE user_id = v_req.user_id;
  END IF;

  -- Log audit event
  PERFORM app_security.log_audit_event(
    'privacy.deletion_finalized',
    'privacy_requests',
    p_request_id,
    jsonb_build_object('target_user_id', v_req.user_id, 'orchestrator', v_caller_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_finalize_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_finalize_account_deletion(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_finalize_account_deletion(
  request_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_finalize_account_deletion(request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_finalize_account_deletion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_account_deletion(uuid) TO authenticated, service_role;

-- =============================================================================
-- 3. Privacy Data Export Fulfillment RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION app_security.impl_fulfill_data_export(
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_req record;
  v_target_user_id uuid;
  v_profile jsonb;
  v_account jsonb;
  v_listings jsonb;
  v_favourites jsonb;
  v_reports jsonb;
  v_support_tickets jsonb;
  v_sent_messages jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_req
  FROM public.privacy_requests
  WHERE id = p_request_id AND request_type = 'export_data';

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Export privacy request not found';
  END IF;

  -- Caller must be owner OR active administrator with AAL2
  IF v_req.user_id <> v_caller_id AND NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'Forbidden: not authorized to export this data';
  END IF;

  v_target_user_id := v_req.user_id;

  -- 1. Profile Data
  SELECT to_jsonb(p) INTO v_profile
  FROM (
    SELECT id, display_name, bio, city, state, created_at, updated_at
    FROM public.profiles
    WHERE id = v_target_user_id
  ) p;

  -- 2. Account Metadata
  SELECT to_jsonb(ua) INTO v_account
  FROM (
    SELECT user_id, terms_accepted_at, terms_version, privacy_policy_version, notification_preferences, created_at
    FROM public.user_accounts
    WHERE user_id = v_target_user_id
  ) ua;

  -- 3. Listings Data
  SELECT COALESCE(jsonb_agg(l), '[]'::jsonb) INTO v_listings
  FROM (
    SELECT id, title, description, condition, price_type, price_paise, status, category_attributes, created_at, published_at
    FROM public.listings
    WHERE seller_id = v_target_user_id
    ORDER BY created_at DESC
  ) l;

  -- 4. Favourites Data
  SELECT COALESCE(jsonb_agg(f), '[]'::jsonb) INTO v_favourites
  FROM (
    SELECT listing_id, created_at
    FROM public.favourites
    WHERE user_id = v_target_user_id
    ORDER BY created_at DESC
  ) f;

  -- 5. User Submitted Reports
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_reports
  FROM (
    SELECT id, target_type, target_id, reason, details, status, created_at, resolved_at
    FROM public.reports
    WHERE reporter_id = v_target_user_id
    ORDER BY created_at DESC
  ) r;

  -- 6. User Support Tickets & Non-Internal Messages
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_support_tickets
  FROM (
    SELECT st.id, st.category, st.subject, st.status, st.created_at,
      (
        SELECT COALESCE(jsonb_agg(m), '[]'::jsonb)
        FROM (
          SELECT id, sender_id, content, created_at
          FROM public.support_messages sm
          WHERE sm.ticket_id = st.id AND sm.is_internal_note = false
          ORDER BY sm.created_at ASC
        ) m
      ) AS messages
    FROM public.support_tickets st
    WHERE st.user_id = v_target_user_id
    ORDER BY st.created_at DESC
  ) t;

  -- 7. User Sent Messages (Counterparty details strictly redacted)
  SELECT COALESCE(jsonb_agg(m), '[]'::jsonb) INTO v_sent_messages
  FROM (
    SELECT id, conversation_id, content, created_at
    FROM public.messages
    WHERE sender_id = v_target_user_id
    ORDER BY created_at DESC
  ) m;

  -- Update request to resolved
  UPDATE public.privacy_requests
  SET status = 'resolved',
      resolved_at = pg_catalog.clock_timestamp(),
      resolved_by = v_caller_id,
      resolution_notes = 'Data export generated and delivered.'
  WHERE id = p_request_id;

  -- Log audit event
  PERFORM app_security.log_audit_event(
    'privacy.export_fulfilled',
    'privacy_requests',
    p_request_id,
    jsonb_build_object('target_user_id', v_target_user_id, 'downloader', v_caller_id)
  );

  RETURN jsonb_build_object(
    'export_id', p_request_id,
    'generated_at', pg_catalog.clock_timestamp(),
    'profile', v_profile,
    'account', v_account,
    'listings', v_listings,
    'favourites', v_favourites,
    'reports', v_reports,
    'support_tickets', v_support_tickets,
    'sent_messages', v_sent_messages
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_fulfill_data_export(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_fulfill_data_export(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_fulfill_data_export(
  request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_fulfill_data_export(request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_fulfill_data_export(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_fulfill_data_export(uuid) TO authenticated, service_role;
