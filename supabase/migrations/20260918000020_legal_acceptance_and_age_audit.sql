-- Migration 20: 20260918000020_legal_acceptance_and_age_audit.sql
-- FairSwap Public Beta Legal Acceptance, Age Confirmation Audit, and Immutability Safeguards

-- 1. Add nullable acceptance fields to public.user_accounts (backward-compatible for existing pilot users)
ALTER TABLE public.user_accounts
  ADD COLUMN IF NOT EXISTS acceptable_use_version text,
  ADD COLUMN IF NOT EXISTS age_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS minimum_age_confirmed smallint;

-- 2. Add check constraint protecting minimum age threshold when age confirmation exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_accounts_minimum_age'
  ) THEN
    ALTER TABLE public.user_accounts
      ADD CONSTRAINT chk_user_accounts_minimum_age
      CHECK (
        (age_confirmed_at IS NULL AND minimum_age_confirmed IS NULL) OR
        (age_confirmed_at IS NOT NULL AND minimum_age_confirmed >= 18)
      );
  END IF;
END $$;

-- 3. Update user_accounts immutability enforcement trigger
CREATE OR REPLACE FUNCTION public.enforce_user_accounts_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_accounts user_id is immutable';
  END IF;
  IF NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at THEN
    RAISE EXCEPTION 'terms_accepted_at is immutable';
  END IF;
  IF NEW.terms_version IS DISTINCT FROM OLD.terms_version THEN
    RAISE EXCEPTION 'terms_version is immutable';
  END IF;
  IF NEW.privacy_policy_version IS DISTINCT FROM OLD.privacy_policy_version THEN
    RAISE EXCEPTION 'privacy_policy_version is immutable';
  END IF;
  IF NEW.acceptable_use_version IS DISTINCT FROM OLD.acceptable_use_version THEN
    RAISE EXCEPTION 'acceptable_use_version is immutable';
  END IF;
  IF NEW.age_confirmed_at IS DISTINCT FROM OLD.age_confirmed_at THEN
    RAISE EXCEPTION 'age_confirmed_at is immutable';
  END IF;
  IF NEW.minimum_age_confirmed IS DISTINCT FROM OLD.minimum_age_confirmed THEN
    RAISE EXCEPTION 'minimum_age_confirmed is immutable';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at is immutable';
  END IF;
  NEW.updated_at = pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

-- 4. Update auth provisioning trigger handle_new_user()
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_display_name text;
  v_terms_accepted text;
  v_terms_version text;
  v_privacy_version text;
  v_acceptable_use_version text;
  v_age_confirmed text;
  v_min_age smallint;
  v_is_valid_consent boolean;
BEGIN
  v_display_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), ''),
    split_part(NEW.email, '@', 1)
  );
  v_terms_accepted := NEW.raw_user_meta_data->>'terms_accepted';
  v_terms_version := NULLIF(TRIM(NEW.raw_user_meta_data->>'terms_version'), '');
  v_privacy_version := NULLIF(TRIM(NEW.raw_user_meta_data->>'privacy_policy_version'), '');
  v_acceptable_use_version := NULLIF(TRIM(NEW.raw_user_meta_data->>'acceptable_use_version'), '');
  v_age_confirmed := NEW.raw_user_meta_data->>'age_confirmed';

  -- Never trust client-supplied minimum_age_confirmed.
  -- Derive the threshold strictly from server/database-controlled logic.
  IF COALESCE(v_age_confirmed, 'false') = 'true' THEN
    v_min_age := 18;
  ELSE
    v_min_age := NULL;
  END IF;

  -- Strictly validate that the exact current policy versions are accepted
  -- and 18+ confirmation is supplied.
  v_is_valid_consent := (
    COALESCE(v_terms_accepted, 'false') = 'true' AND
    v_terms_version = '2026-09-18' AND
    v_privacy_version = '2026-09-18' AND
    v_acceptable_use_version = '2026-09-18' AND
    COALESCE(v_age_confirmed, 'false') = 'true' AND
    v_min_age = 18
  );

  IF v_is_valid_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'Registration rejected: mandatory Terms acceptance, Privacy acknowledgement, Acceptable Use acceptance, and 18+ age confirmation are required with current policy versions.';
  END IF;

  -- Create public profile
  INSERT INTO public.profiles (
    id, display_name, avatar_url, bio, city, state, created_at, updated_at
  ) VALUES (
    NEW.id, v_display_name, NULL, NULL, NULL, NULL, NEW.created_at, NEW.created_at
  );

  -- Create private user account with validated consent
  INSERT INTO public.user_accounts (
    user_id,
    account_status,
    terms_accepted_at,
    terms_version,
    privacy_policy_version,
    acceptable_use_version,
    age_confirmed_at,
    minimum_age_confirmed,
    notification_preferences,
    optional_contact_preferences,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    'active',
    NEW.created_at,
    '2026-09-18',
    '2026-09-18',
    '2026-09-18',
    NEW.created_at,
    18,
    '{"email_notifications": true}'::jsonb,
    '{}'::jsonb,
    NEW.created_at,
    NEW.created_at
  );

  RETURN NEW;
END;
$$;

-- 4. Update app_security.impl_fulfill_data_export(p_request_id uuid) to include full acceptance metadata
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
    'sent_messages', v_sent_messages
  );
END;
$$;
