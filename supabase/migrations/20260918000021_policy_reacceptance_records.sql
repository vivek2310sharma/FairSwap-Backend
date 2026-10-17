-- Migration 21: 20260918000021_policy_reacceptance_records.sql
-- FairSwap Public Beta Historical Pilot Policy Re-acceptance, Append-Only Evidence, and Guardrails

-- =============================================================================
-- 1. Create public.policy_acceptance_records
-- =============================================================================
-- Append-only audit table recording subsequent policy re-acceptances without mutating
-- immutable historical pilot rows in public.user_accounts.
-- Consistent with FairSwap privacy model (Option A), foreign key cascades when the auth identity
-- is deleted, but records are completely immutable while the account exists.

CREATE TABLE IF NOT EXISTS public.policy_acceptance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  privacy_policy_version text NOT NULL,
  acceptable_use_version text NOT NULL,
  minimum_age_confirmed smallint NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT chk_par_terms_version CHECK (terms_version = '2026-09-18'),
  CONSTRAINT chk_par_privacy_version CHECK (privacy_policy_version = '2026-09-18'),
  CONSTRAINT chk_par_acceptable_use_version CHECK (acceptable_use_version = '2026-09-18'),
  CONSTRAINT chk_par_min_age CHECK (minimum_age_confirmed = 18),
  CONSTRAINT uq_policy_acceptance_records_bundle UNIQUE (
    user_id,
    terms_version,
    privacy_policy_version,
    acceptable_use_version,
    minimum_age_confirmed
  )
);

CREATE INDEX IF NOT EXISTS idx_policy_acceptance_records_user_id
  ON public.policy_acceptance_records(user_id);

-- =============================================================================
-- 2. Security, RLS & Access Grants
-- =============================================================================
-- Normal users do not query this table directly; access is via trusted RPCs.
-- Direct table access is revoked from PUBLIC, anon, and authenticated.
-- RLS is enabled and forced for defense-in-depth.

ALTER TABLE public.policy_acceptance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_acceptance_records FORCE ROW LEVEL SECURITY;
ALTER TABLE public.favourites FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.policy_acceptance_records FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.policy_acceptance_records TO service_role;

DROP POLICY IF EXISTS policy_acceptance_records_select_policy ON public.policy_acceptance_records;
CREATE POLICY policy_acceptance_records_select_policy ON public.policy_acceptance_records
FOR SELECT TO service_role USING (true);

-- =============================================================================
-- 3. Immutability Triggers
-- =============================================================================
-- Policy acceptance records are strictly append-only.
-- Direct UPDATE is unconditionally rejected.
-- Direct DELETE is rejected (pg_trigger_depth() = 1), but ON DELETE CASCADE from auth.users is permitted.

CREATE OR REPLACE FUNCTION public.enforce_policy_acceptance_records_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'policy_acceptance_records rows are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'policy_acceptance_records rows are immutable; direct deletion is prohibited';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_policy_acceptance_records_no_update ON public.policy_acceptance_records;
CREATE TRIGGER trg_policy_acceptance_records_no_update
BEFORE UPDATE ON public.policy_acceptance_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_policy_acceptance_records_immutability();

DROP TRIGGER IF EXISTS trg_policy_acceptance_records_no_delete ON public.policy_acceptance_records;
CREATE TRIGGER trg_policy_acceptance_records_no_delete
BEFORE DELETE ON public.policy_acceptance_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_policy_acceptance_records_immutability();

-- =============================================================================
-- 4. Helper: has_current_policy_acceptance
-- =============================================================================
-- Returns true if user either has original current baseline in user_accounts (new Public Beta signups)
-- OR has recorded a re-acceptance in policy_acceptance_records (existing pilot users).
-- Hardened against arbitrary user-id status probing: authenticated callers may only query auth.uid().

CREATE OR REPLACE FUNCTION app_security.has_current_policy_acceptance(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- Caller authorization check:
  -- If invoked in an authenticated user session, only allow inspecting auth.uid()
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: cannot inspect policy acceptance for another user';
  END IF;

  -- 1. Check if user_accounts already holds current Public Beta baseline
  IF EXISTS (
    SELECT 1 FROM public.user_accounts
    WHERE user_id = p_user_id
      AND terms_version = '2026-09-18'
      AND privacy_policy_version = '2026-09-18'
      AND acceptable_use_version = '2026-09-18'
      AND minimum_age_confirmed >= 18
      AND age_confirmed_at IS NOT NULL
  ) THEN
    RETURN true;
  END IF;

  -- 2. Check if append-only policy_acceptance_records holds current Public Beta baseline
  IF EXISTS (
    SELECT 1 FROM public.policy_acceptance_records
    WHERE user_id = p_user_id
      AND terms_version = '2026-09-18'
      AND privacy_policy_version = '2026-09-18'
      AND acceptable_use_version = '2026-09-18'
      AND minimum_age_confirmed = 18
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION app_security.has_current_policy_acceptance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.has_current_policy_acceptance(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.has_current_policy_acceptance()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN app_security.has_current_policy_acceptance(auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.has_current_policy_acceptance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_current_policy_acceptance() TO authenticated, service_role;

-- =============================================================================
-- 5. RPC: record_policy_reacceptance
-- =============================================================================
-- Server-controlled policy re-acceptance recording.
-- Caller asserts boolean consent and age confirmation.
-- Policy versions ('2026-09-18'), minimum age (18), and timestamps are database-owned.
-- Concurrency-safe & idempotent: atomic insert with ON CONFLICT DO NOTHING RETURNING.
-- Duplicate / repeated calls return existing acceptance without error or duplicate rows/audit logs.

CREATE OR REPLACE FUNCTION app_security.impl_record_policy_reacceptance(
  p_terms_and_privacy_accepted boolean,
  p_age_confirmed boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_account_rec record;
  v_existing record;
  v_record_id uuid;
  v_accepted_at timestamptz;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_terms_and_privacy_accepted IS NOT TRUE THEN
    RAISE EXCEPTION 'Terms, Acceptable Use, and Privacy acceptance is required';
  END IF;

  IF p_age_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'Age confirmation (18+) is required';
  END IF;

  -- Ensure user account exists
  IF NOT EXISTS (SELECT 1 FROM public.user_accounts WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'User account not found';
  END IF;

  -- Fast path 1: already recorded in policy_acceptance_records
  SELECT id, accepted_at INTO v_existing
  FROM public.policy_acceptance_records
  WHERE user_id = v_caller_id
    AND terms_version = '2026-09-18'
    AND privacy_policy_version = '2026-09-18'
    AND acceptable_use_version = '2026-09-18'
    AND minimum_age_confirmed = 18;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_recorded', true,
      'record_id', v_existing.id,
      'accepted_at', v_existing.accepted_at
    );
  END IF;

  -- Fast path 2: already current in user_accounts (e.g. new signup)
  -- Return authoritative original timestamp from user_accounts
  SELECT terms_accepted_at, age_confirmed_at INTO v_account_rec
  FROM public.user_accounts
  WHERE user_id = v_caller_id
    AND terms_version = '2026-09-18'
    AND privacy_policy_version = '2026-09-18'
    AND acceptable_use_version = '2026-09-18'
    AND minimum_age_confirmed >= 18
    AND age_confirmed_at IS NOT NULL;

  IF v_account_rec IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_recorded', true,
      'record_id', NULL,
      'accepted_at', COALESCE(v_account_rec.terms_accepted_at, v_account_rec.age_confirmed_at)
    );
  END IF;

  -- Insert new immutable acceptance record using authoritative server constants and DB clock
  -- Race-safe: ON CONFLICT DO NOTHING RETURNING id, accepted_at
  INSERT INTO public.policy_acceptance_records (
    user_id,
    terms_version,
    privacy_policy_version,
    acceptable_use_version,
    minimum_age_confirmed
  ) VALUES (
    v_caller_id,
    '2026-09-18',
    '2026-09-18',
    '2026-09-18',
    18
  )
  ON CONFLICT (user_id, terms_version, privacy_policy_version, acceptable_use_version, minimum_age_confirmed)
  DO NOTHING
  RETURNING id, accepted_at INTO v_record_id, v_accepted_at;

  IF v_record_id IS NOT NULL THEN
    -- Won the insert race: exactly one audit event with actual inserted id
    PERFORM app_security.log_audit_event(
      'policy.reaccepted',
      'policy_acceptance_records',
      v_record_id,
      jsonb_build_object(
        'user_id', v_caller_id,
        'terms_version', '2026-09-18',
        'privacy_policy_version', '2026-09-18',
        'acceptable_use_version', '2026-09-18',
        'minimum_age_confirmed', 18
      )
    );

    RETURN jsonb_build_object(
      'success', true,
      'already_recorded', false,
      'record_id', v_record_id,
      'accepted_at', v_accepted_at
    );
  ELSE
    -- Lost the race: another concurrent call inserted the record.
    SELECT id, accepted_at INTO v_existing
    FROM public.policy_acceptance_records
    WHERE user_id = v_caller_id
      AND terms_version = '2026-09-18'
      AND privacy_policy_version = '2026-09-18'
      AND acceptable_use_version = '2026-09-18'
      AND minimum_age_confirmed = 18;

    RETURN jsonb_build_object(
      'success', true,
      'already_recorded', true,
      'record_id', v_existing.id,
      'accepted_at', v_existing.accepted_at
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_record_policy_reacceptance(boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_record_policy_reacceptance(boolean, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_policy_reacceptance(
  terms_and_privacy_accepted boolean,
  age_confirmed boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_record_policy_reacceptance(terms_and_privacy_accepted, age_confirmed);
END;
$$;

REVOKE ALL ON FUNCTION public.record_policy_reacceptance(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_policy_reacceptance(boolean, boolean) TO authenticated, service_role;

-- =============================================================================
-- 6. Direct-API Mutation Safeguards
-- =============================================================================

-- Ensure is_listing_publicly_visible is plpgsql SECURITY DEFINER to prevent SQL function inlining
CREATE OR REPLACE FUNCTION app_security.is_listing_publicly_visible(p_listing_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_visible boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.listings l
    JOIN public.user_accounts ua ON ua.user_id = l.seller_id
    WHERE l.id = p_listing_id
      AND l.status = 'active'
      AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
      AND ua.account_status = 'active'
  ) INTO v_visible;
  RETURN v_visible;
END;
$$;

REVOKE ALL ON FUNCTION app_security.is_listing_publicly_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.is_listing_publicly_visible(uuid) TO anon, authenticated, service_role;

-- A. Favourites: require current policy acceptance in insert and delete policies
DROP POLICY IF EXISTS favourites_insert_policy ON public.favourites;
CREATE POLICY favourites_insert_policy ON public.favourites
FOR INSERT WITH CHECK (
  user_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
  AND app_security.has_current_policy_acceptance(auth.uid())
  AND app_security.is_listing_publicly_visible(listing_id)
);

DROP POLICY IF EXISTS favourites_delete_policy ON public.favourites;
CREATE POLICY favourites_delete_policy ON public.favourites
FOR DELETE USING (
  user_id = auth.uid()
  AND app_security.has_current_policy_acceptance(auth.uid())
);

-- B. Messaging: require current policy acceptance in send_message
CREATE OR REPLACE FUNCTION app_security.impl_send_message(
  p_conversation_id uuid,
  p_content text,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_conv record;
  v_listing record;
  v_recipient_id uuid;
  v_sender_name text;
  v_clean_content text;
  v_existing_msg record;
  v_new_msg record;
  v_recent_msg_count integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted: messaging requires active account';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  -- Validate content
  v_clean_content := trim(p_content);
  IF length(v_clean_content) < 1 OR length(v_clean_content) > 2000 THEN
    RAISE EXCEPTION 'Message length must be between 1 and 2000 characters';
  END IF;

  IF length(p_client_request_id) < 8 OR length(p_client_request_id) > 64 THEN
    RAISE EXCEPTION 'Invalid client_request_id';
  END IF;

  -- Verify conversation exists and caller is participant
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  IF v_conv.buyer_id <> v_caller_id AND v_conv.seller_id <> v_caller_id THEN
    RAISE EXCEPTION 'Forbidden: not a participant in this conversation';
  END IF;

  -- Determine recipient
  IF v_conv.buyer_id = v_caller_id THEN
    v_recipient_id := v_conv.seller_id;
  ELSE
    v_recipient_id := v_conv.buyer_id;
  END IF;

  -- Check listing status policy:
  -- Allowed: active, reserved, sold, paused
  -- Prohibited: removed, rejected
  SELECT status INTO v_listing
  FROM public.listings
  WHERE id = v_conv.listing_id;

  IF v_listing IS NULL OR v_listing.status IN ('removed', 'rejected') THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: This conversation is closed due to listing moderation';
  END IF;

  -- Check bidirectional block
  IF v_recipient_id IS NOT NULL AND app_security.is_blocked_bidirectional(v_caller_id, v_recipient_id) THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: Unable to send message to this recipient';
  END IF;

  -- Check recipient account status
  IF v_recipient_id IS NOT NULL AND app_security.get_account_status(v_recipient_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: Counterparty account is no longer active';
  END IF;

  -- Check Idempotency: replay existing message if client_request_id matches
  SELECT * INTO v_existing_msg
  FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND sender_id = v_caller_id
    AND client_request_id = p_client_request_id;

  IF v_existing_msg IS NOT NULL THEN
    RETURN jsonb_build_object(
      'id', v_existing_msg.id,
      'conversation_id', v_existing_msg.conversation_id,
      'sender_id', v_existing_msg.sender_id,
      'content', v_existing_msg.content,
      'created_at', v_existing_msg.created_at,
      'is_duplicate', true
    );
  END IF;

  -- Acquire transaction-scoped advisory lock for message rate limit
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('msg_quota_' || v_caller_id::text));

  -- Check rolling quota: max 60 messages per rolling 1 hour
  SELECT count(*) INTO v_recent_msg_count
  FROM public.messages
  WHERE sender_id = v_caller_id
    AND created_at > (pg_catalog.clock_timestamp() - interval '1 hour');

  IF v_recent_msg_count >= 60 THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: Message quota exceeded. Maximum 60 messages per hour';
  END IF;

  -- Insert message
  INSERT INTO public.messages (
    conversation_id,
    sender_id,
    client_request_id,
    content,
    created_at
  ) VALUES (
    p_conversation_id,
    v_caller_id,
    p_client_request_id,
    v_clean_content,
    pg_catalog.clock_timestamp()
  ) RETURNING * INTO v_new_msg;

  -- Update conversation last_message_at
  UPDATE public.conversations
  SET last_message_at = v_new_msg.created_at,
      updated_at = v_new_msg.created_at
  WHERE id = p_conversation_id;

  -- Mark read for sender
  INSERT INTO public.conversation_read_states (
    conversation_id,
    user_id,
    last_read_message_id,
    last_read_at
  ) VALUES (
    p_conversation_id,
    v_caller_id,
    v_new_msg.id,
    v_new_msg.created_at
  )
  ON CONFLICT (conversation_id, user_id) DO UPDATE
  SET last_read_message_id = EXCLUDED.last_read_message_id,
      last_read_at = EXCLUDED.last_read_at;

  -- Notify recipient if recipient exists
  IF v_recipient_id IS NOT NULL THEN
    SELECT display_name INTO v_sender_name
    FROM public.profiles
    WHERE id = v_caller_id;

    PERFORM app_security.create_notification(
      v_recipient_id,
      'new_message',
      'New message from ' || COALESCE(v_sender_name, 'a buyer/seller'),
      CASE
        WHEN length(v_clean_content) > 80 THEN substring(v_clean_content from 1 for 77) || '...'
        ELSE v_clean_content
      END,
      '/account/messages/' || p_conversation_id::text
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_new_msg.id,
    'conversation_id', v_new_msg.conversation_id,
    'sender_id', v_new_msg.sender_id,
    'content', v_new_msg.content,
    'created_at', v_new_msg.created_at,
    'is_duplicate', false
  );
END;
$$;

-- C. Messaging: require current policy acceptance in start_conversation
CREATE OR REPLACE FUNCTION app_security.impl_start_conversation(
  p_listing_id uuid,
  p_content text,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_listing record;
  v_seller_id uuid;
  v_existing_conv record;
  v_new_conv record;
  v_recent_conv_count integer;
  v_msg_result jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  -- Validate listing exists and is publicly visible
  IF NOT app_security.is_listing_publicly_visible(p_listing_id) THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE: New inquiries require an active, approved listing';
  END IF;

  SELECT seller_id INTO v_seller_id
  FROM public.listings
  WHERE id = p_listing_id;

  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Listing has no valid seller';
  END IF;

  IF v_seller_id = v_caller_id THEN
    RAISE EXCEPTION 'Self-chat is prohibited: You cannot contact your own listing';
  END IF;

  -- Check bidirectional block
  IF app_security.is_blocked_bidirectional(v_caller_id, v_seller_id) THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: Unable to contact this seller';
  END IF;

  -- Acquire transaction-scoped advisory lock for conversation creation
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('conv_' || p_listing_id::text || '_' || v_caller_id::text)
  );

  -- Check if conversation already exists between this buyer and listing
  SELECT * INTO v_existing_conv
  FROM public.conversations
  WHERE listing_id = p_listing_id AND buyer_id = v_caller_id;

  IF v_existing_conv IS NOT NULL THEN
    -- Conversation exists, send message into it
    v_msg_result := app_security.impl_send_message(
      v_existing_conv.id,
      p_content,
      p_client_request_id
    );

    RETURN jsonb_build_object(
      'conversation_id', v_existing_conv.id,
      'is_new_conversation', false,
      'message', v_msg_result
    );
  END IF;

  -- Rate limit on new conversations: max 10 per rolling 1 hour
  SELECT count(*) INTO v_recent_conv_count
  FROM public.conversations
  WHERE buyer_id = v_caller_id
    AND created_at > (pg_catalog.clock_timestamp() - interval '1 hour');

  IF v_recent_conv_count >= 10 THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: Maximum 10 new conversations per hour';
  END IF;

  -- Insert new conversation
  INSERT INTO public.conversations (
    listing_id,
    buyer_id,
    seller_id,
    last_message_at,
    created_at,
    updated_at
  ) VALUES (
    p_listing_id,
    v_caller_id,
    v_seller_id,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ) RETURNING * INTO v_new_conv;

  -- Send initial message
  v_msg_result := app_security.impl_send_message(
    v_new_conv.id,
    p_content,
    p_client_request_id
  );

  RETURN jsonb_build_object(
    'conversation_id', v_new_conv.id,
    'is_new_conversation', true,
    'message', v_msg_result
  );
END;
$$;

-- D. Safety / Blocking: require current policy acceptance in block_user
CREATE OR REPLACE FUNCTION app_security.impl_block_user(
  p_blocked_user_id uuid,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  IF v_caller_id = p_blocked_user_id THEN
    RAISE EXCEPTION 'Cannot block yourself';
  END IF;

  -- Verify target user exists
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_blocked_user_id) THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;

  INSERT INTO public.user_blocks (
    blocker_id,
    blocked_id,
    reason,
    created_at
  ) VALUES (
    v_caller_id,
    p_blocked_user_id,
    p_reason,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (blocker_id, blocked_id) DO UPDATE
  SET reason = EXCLUDED.reason;

  PERFORM app_security.log_audit_event(
    'abuse.user_blocked',
    'user_blocks',
    p_blocked_user_id,
    jsonb_build_object('blocker_id', v_caller_id, 'blocked_id', p_blocked_user_id)
  );
END;
$$;

-- E. Safety / Unblocking: require current policy acceptance in unblock_user
CREATE OR REPLACE FUNCTION app_security.impl_unblock_user(
  p_blocked_user_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  DELETE FROM public.user_blocks
  WHERE blocker_id = v_caller_id AND blocked_id = p_blocked_user_id;
END;
$$;

-- F. Messaging: require current policy acceptance in mark_conversation_read
CREATE OR REPLACE FUNCTION app_security.impl_mark_conversation_read(
  p_conversation_id uuid,
  p_message_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_conv record;
  v_target_msg record;
  v_current_read record;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  -- Verify participant
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  IF v_conv.buyer_id <> v_caller_id AND v_conv.seller_id <> v_caller_id THEN
    RAISE EXCEPTION 'Forbidden: not a participant';
  END IF;

  -- Verify message belongs to this conversation
  SELECT id, created_at INTO v_target_msg
  FROM public.messages
  WHERE id = p_message_id AND conversation_id = p_conversation_id;

  IF v_target_msg IS NULL THEN
    RAISE EXCEPTION 'Message does not belong to this conversation';
  END IF;

  -- Monotonic check: get current read marker
  SELECT m.created_at, m.id INTO v_current_read
  FROM public.conversation_read_states crs
  JOIN public.messages m ON m.id = crs.last_read_message_id
  WHERE crs.conversation_id = p_conversation_id AND crs.user_id = v_caller_id;

  IF v_current_read IS NOT NULL THEN
    -- If candidate message is older or equal, do not regress pointer
    IF (v_target_msg.created_at, v_target_msg.id) <= (v_current_read.created_at, v_current_read.id) THEN
      RETURN;
    END IF;
  END IF;

  -- Update or insert read marker
  INSERT INTO public.conversation_read_states (
    conversation_id,
    user_id,
    last_read_message_id,
    last_read_at
  ) VALUES (
    p_conversation_id,
    v_caller_id,
    p_message_id,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (conversation_id, user_id) DO UPDATE
  SET last_read_message_id = EXCLUDED.last_read_message_id,
      last_read_at = EXCLUDED.last_read_at;
END;
$$;

-- G. Listings & Media Mutation Safeguards
DROP POLICY IF EXISTS listings_insert_policy ON public.listings;
CREATE POLICY listings_insert_policy ON public.listings
FOR INSERT WITH CHECK (
  seller_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
  AND app_security.has_current_policy_acceptance(auth.uid())
);

DROP POLICY IF EXISTS listings_update_policy ON public.listings;
CREATE POLICY listings_update_policy ON public.listings
FOR UPDATE USING (
  seller_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
  AND status IN ('draft', 'active', 'reserved', 'paused', 'rejected')
  AND app_security.has_current_policy_acceptance(auth.uid())
) WITH CHECK (
  seller_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
  AND app_security.has_current_policy_acceptance(auth.uid())
);

DROP POLICY IF EXISTS listing_media_insert_policy ON public.listing_media;
CREATE POLICY listing_media_insert_policy ON public.listing_media
FOR INSERT WITH CHECK (
  uploader_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND app_security.get_account_status(auth.uid()) = 'active'
      AND app_security.has_current_policy_acceptance(auth.uid())
  )
);

DROP POLICY IF EXISTS listing_media_update_policy ON public.listing_media;
CREATE POLICY listing_media_update_policy ON public.listing_media
FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND app_security.get_account_status(auth.uid()) = 'active'
      AND app_security.has_current_policy_acceptance(auth.uid())
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND app_security.get_account_status(auth.uid()) = 'active'
      AND app_security.has_current_policy_acceptance(auth.uid())
  )
);

-- Seller listing submission RPC: require current policy acceptance
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

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
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

  -- Validate media: at least 1 ready photo
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

-- Seller listing transition RPC: require current policy acceptance
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

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
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

-- H. Profile & Account Settings Mutation Safeguards
DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy ON public.profiles
FOR UPDATE USING (
  (id = auth.uid())
  AND (app_security.get_account_status(auth.uid()) = 'active')
  AND app_security.has_current_policy_acceptance(auth.uid())
) WITH CHECK (
  (id = auth.uid())
  AND (app_security.get_account_status(auth.uid()) = 'active')
  AND app_security.has_current_policy_acceptance(auth.uid())
);

DROP POLICY IF EXISTS user_accounts_update_policy ON public.user_accounts;
CREATE POLICY user_accounts_update_policy ON public.user_accounts
FOR UPDATE USING (
  (user_id = auth.uid())
  AND (account_status = 'active')
  AND app_security.has_current_policy_acceptance(auth.uid())
) WITH CHECK (
  (user_id = auth.uid())
  AND (account_status = 'active')
  AND app_security.has_current_policy_acceptance(auth.uid())
);

-- I. In-App Notifications Mutation Safeguards
CREATE OR REPLACE FUNCTION app_security.impl_mark_notification_read(p_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  UPDATE public.notifications
  SET read_at = pg_catalog.clock_timestamp()
  WHERE id = p_id AND user_id = v_caller_id AND read_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_security.impl_mark_all_notifications_read()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  UPDATE public.notifications
  SET read_at = pg_catalog.clock_timestamp()
  WHERE user_id = v_caller_id AND read_at IS NULL;
END;
$$;

-- =============================================================================
-- 7. Privacy Data Export Update
-- =============================================================================
-- Include historical policy re-acceptance records in privacy export payload

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
  v_policy_acceptances jsonb;
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

  -- 2. Account Metadata with acceptance audit fields
  SELECT to_jsonb(ua) INTO v_account
  FROM (
    SELECT user_id, terms_accepted_at, terms_version, privacy_policy_version,
           acceptable_use_version, age_confirmed_at, minimum_age_confirmed,
           notification_preferences, created_at
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

  -- 8. Historical Policy Re-acceptance Records
  SELECT COALESCE(jsonb_agg(par), '[]'::jsonb) INTO v_policy_acceptances
  FROM (
    SELECT id, terms_version, privacy_policy_version, acceptable_use_version, minimum_age_confirmed, accepted_at
    FROM public.policy_acceptance_records
    WHERE user_id = v_target_user_id
    ORDER BY accepted_at ASC
  ) par;

  -- Update request status to resolved
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
    'sent_messages', v_sent_messages,
    'policy_acceptances', v_policy_acceptances
  );
END;
$$;
