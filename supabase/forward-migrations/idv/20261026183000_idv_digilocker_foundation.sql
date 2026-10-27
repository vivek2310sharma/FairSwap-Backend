-- Migration: 20261026183000_idv_digilocker_foundation.sql
-- FairSwap IDV-V1: DigiLocker Verification Foundation (Forward-only)
-- Adds private attempt tracking, verification records, audit events, and minimal public badge projection.
-- Strictly additive. Preserves 58 historical migrations and Production's 52 applied ledger.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 1. Create Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'idv_status_enum') THEN
    CREATE TYPE public.idv_status_enum AS ENUM (
      'not_started',
      'pending',
      'in_progress',
      'verified',
      'failed',
      'cancelled',
      'expired',
      'revoked'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'idv_evidence_category_enum') THEN
    CREATE TYPE public.idv_evidence_category_enum AS ENUM (
      'aadhaar_kyc',
      'driving_licence',
      'pan_card',
      'other_gov_doc'
    );
  END IF;
END $$;

-- 2. Minimal Public Badge Projection Table
-- Controlled entirely by server-side SECURITY DEFINER functions; never client-written.
-- Staff revocation reasons are strictly excluded from this publicly readable table.
CREATE TABLE IF NOT EXISTS public.user_identity_verifications (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  verification_status public.idv_status_enum NOT NULL DEFAULT 'not_started',
  badge_issued boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  valid_until timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON public.user_identity_verifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_identity_verifications TO anon, authenticated, service_role;

ALTER TABLE public.user_identity_verifications ENABLE ROW LEVEL SECURITY;

-- Anyone can see valid badges or public verification state; badge eligibility strictly requires:
-- active badge, not expired, and active user account.
DROP POLICY IF EXISTS user_identity_verifications_read_policy ON public.user_identity_verifications;
CREATE POLICY user_identity_verifications_read_policy ON public.user_identity_verifications
FOR SELECT USING (
  (
    badge_issued = true
    AND verification_status = 'verified'
    AND (valid_until IS NULL OR valid_until > clock_timestamp())
    AND app_security.get_account_status(user_id) = 'active'
  )
  OR auth.uid() = user_id
  OR app_security.is_active_staff_aal2('moderator')
);

-- 3. Private Schema Tables under app_security (Not exposed via PostgREST)

-- 3A. Verification Attempts (Bounded lifecycle, single-use state, rate limit & replay guard)
CREATE TABLE IF NOT EXISTS app_security.idv_verification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_state text NOT NULL UNIQUE, -- Single-use cryptographic nonce
  provider_request_id text, -- Setu DigiLocker request ID (opaque)
  provider_session_url text, -- Consent redirect URL
  evidence_category public.idv_evidence_category_enum NOT NULL,
  status public.idv_status_enum NOT NULL DEFAULT 'pending',
  attempt_expires_at timestamptz NOT NULL,
  consent_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
  consent_purpose text NOT NULL DEFAULT 'FairSwap India Peer-to-Peer Identity Verification V1',
  completed_at timestamptz,
  failure_reason text,
  provider_raw_status text,
  token_revoked_at timestamptz,
  token_revocation_failed boolean NOT NULL DEFAULT false,
  token_revocation_error text,
  token_revocation_retry_count integer NOT NULL DEFAULT 0,
  revocation_pending boolean NOT NULL DEFAULT false,
  next_retry_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  consent_policy_version text NOT NULL DEFAULT 'v1.0',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_idv_attempts_user_created ON app_security.idv_verification_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idv_attempts_state ON app_security.idv_verification_attempts(request_state);
CREATE INDEX IF NOT EXISTS idx_idv_attempts_provider_req ON app_security.idv_verification_attempts(provider_request_id);
CREATE INDEX IF NOT EXISTS idx_idv_attempts_revocation_queue ON app_security.idv_verification_attempts(revocation_pending, next_retry_at) WHERE revocation_pending = true;

REVOKE ALL ON app_security.idv_verification_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON app_security.idv_verification_attempts TO service_role;
ALTER TABLE app_security.idv_verification_attempts ENABLE ROW LEVEL SECURITY;

-- 3B. Private Identity Records (No direct document/PII storage, only non-sensitive hashes/categories)
CREATE TABLE IF NOT EXISTS app_security.idv_identity_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES app_security.idv_verification_attempts(id),
  evidence_category public.idv_evidence_category_enum NOT NULL,
  issuer_authority text NOT NULL,
  document_reference_hash text NOT NULL, -- Keyed HMAC token of opaque provider reference; never stores raw numbers or unsalted SHA-256
  consent_timestamp timestamptz NOT NULL,
  consent_purpose text NOT NULL,
  consent_policy_version text NOT NULL DEFAULT 'v1.0',
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  is_withdrawn boolean NOT NULL DEFAULT false,
  withdrawn_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON app_security.idv_identity_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON app_security.idv_identity_records TO service_role;
ALTER TABLE app_security.idv_identity_records ENABLE ROW LEVEL SECURITY;

-- 3C. Append-only Security Audit Events
CREATE TABLE IF NOT EXISTS app_security.idv_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES app_security.idv_verification_attempts(id),
  event_type text NOT NULL,
  actor_id uuid NOT NULL,
  actor_role text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON app_security.idv_audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON app_security.idv_audit_events TO service_role;
ALTER TABLE app_security.idv_audit_events ENABLE ROW LEVEL SECURITY;

-- 4. Server-Side Stored Procedures / RPCs

-- 4A. Helper: record IDV audit event
CREATE OR REPLACE FUNCTION app_security.impl_record_idv_audit_event(
  p_user_id uuid,
  p_attempt_id uuid,
  p_event_type text,
  p_actor_id uuid,
  p_actor_role text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO app_security.idv_audit_events (
    user_id, attempt_id, event_type, actor_id, actor_role, metadata, created_at
  ) VALUES (
    p_user_id, p_attempt_id, p_event_type, p_actor_id, p_actor_role, coalesce(p_metadata, '{}'::jsonb), pg_catalog.clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_record_idv_audit_event(uuid, uuid, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_record_idv_audit_event(uuid, uuid, text, uuid, text, jsonb) TO service_role;

-- 4B. Start an IDV attempt (binds user, enforces rate limit & active account)
CREATE OR REPLACE FUNCTION app_security.impl_idv_start_attempt(
  p_user_id uuid,
  p_request_state text,
  p_ttl_seconds integer DEFAULT 900,
  p_consent_purpose text DEFAULT 'FairSwap India Peer-to-Peer Identity Verification V1',
  p_consent_acknowledged boolean DEFAULT false,
  p_policy_version text DEFAULT 'v1.0',
  p_evidence_category text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_status public.account_status_enum;
  v_recent_attempts integer;
  v_active_attempt_id uuid;
  v_ttl integer := coalesce(p_ttl_seconds, 900);
  v_purpose text := coalesce(trim(p_consent_purpose), 'FairSwap India Peer-to-Peer Identity Verification V1');
  v_version text := coalesce(trim(p_policy_version), 'v1.0');
  v_category public.idv_evidence_category_enum;
BEGIN
  IF p_user_id IS NULL OR p_request_state IS NULL OR length(trim(p_request_state)) < 16 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PARAMETERS');
  END IF;

  -- Require explicit evidence category; implicit default is strictly disallowed
  IF p_evidence_category IS NULL OR length(trim(p_evidence_category)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'EVIDENCE_CATEGORY_REQUIRED');
  END IF;

  -- Validate evidence category
  BEGIN
    v_category := trim(p_evidence_category)::public.idv_evidence_category_enum;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_EVIDENCE_CATEGORY');
  END;

  -- Mandatory affirmative consent acknowledgement check
  IF p_consent_acknowledged IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'CONSENT_REQUIRED');
  END IF;

  -- Bounded TTL: min 300s, max 1800s
  IF v_ttl < 300 THEN v_ttl := 300; END IF;
  IF v_ttl > 1800 THEN v_ttl := 1800; END IF;

  -- Transaction-scoped advisory lock per user to eliminate concurrent start, complete, withdraw, and revoke races
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_user_id::text));

  -- 1. Check user account status
  SELECT account_status INTO v_account_status
  FROM public.user_accounts
  WHERE user_id = p_user_id;

  IF v_account_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_NOT_ELIGIBLE');
  END IF;

  -- 2. Check rate limit: maximum 5 attempts in last 24 hours
  SELECT count(*) INTO v_recent_attempts
  FROM app_security.idv_verification_attempts
  WHERE user_id = p_user_id
    AND created_at > (pg_catalog.clock_timestamp() - interval '24 hours');

  IF v_recent_attempts >= 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'RATE_LIMIT_EXCEEDED');
  END IF;

  -- 3. Check for unresolved active attempt within valid TTL
  SELECT id INTO v_active_attempt_id
  FROM app_security.idv_verification_attempts
  WHERE user_id = p_user_id
    AND status IN ('pending', 'in_progress')
    AND attempt_expires_at > pg_catalog.clock_timestamp()
  LIMIT 1;

  IF v_active_attempt_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACTIVE_ATTEMPT_EXISTS', 'attempt_id', v_active_attempt_id);
  END IF;

  -- 4. Create new attempt row with explicit, point-in-time consent capture bound to evidence category
  INSERT INTO app_security.idv_verification_attempts (
    user_id,
    request_state,
    evidence_category,
    status,
    attempt_expires_at,
    consent_timestamp,
    consent_purpose,
    consent_policy_version,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_request_state,
    v_category,
    'pending',
    pg_catalog.clock_timestamp() + (v_ttl || ' seconds')::interval,
    pg_catalog.clock_timestamp(),
    v_purpose,
    v_version,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  RETURNING id INTO v_active_attempt_id;

  PERFORM app_security.impl_record_idv_audit_event(
    p_user_id,
    v_active_attempt_id,
    'attempt_started',
    p_user_id,
    'user',
    jsonb_build_object('ttl_seconds', v_ttl, 'consent_purpose', v_purpose, 'consent_policy_version', v_version, 'evidence_category', v_category)
  );

  RETURN jsonb_build_object(
    'success', true,
    'attempt_id', v_active_attempt_id,
    'expires_at', (pg_catalog.clock_timestamp() + (v_ttl || ' seconds')::interval)
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_start_attempt(uuid, text, integer, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_start_attempt(uuid, text, integer, text, boolean, text, text) TO service_role;

-- 4C. Update Attempt Provider Reference
CREATE OR REPLACE FUNCTION app_security.impl_idv_attach_provider_session(
  p_attempt_id uuid,
  p_provider_request_id text,
  p_provider_session_url text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE app_security.idv_verification_attempts
  SET provider_request_id = p_provider_request_id,
      provider_session_url = p_provider_session_url,
      status = 'in_progress',
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_attempt_id
    AND status = 'pending'
    AND attempt_expires_at > pg_catalog.clock_timestamp();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND_OR_EXPIRED');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_attach_provider_session(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_attach_provider_session(uuid, text, text) TO service_role;

-- 4D. Complete Verification (Atomically validates and issues badge)
-- Never relies solely on status=authenticated or client response; requires validated document hash & category
CREATE OR REPLACE FUNCTION app_security.impl_idv_complete_verification(
  p_attempt_id uuid,
  p_user_id uuid,
  p_evidence_category public.idv_evidence_category_enum,
  p_issuer_authority text,
  p_document_reference_hash text,
  p_valid_until timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt RECORD;
  v_account_status public.account_status_enum;
  v_existing_record RECORD;
  v_effective_valid_until timestamptz;
BEGIN
  IF p_attempt_id IS NULL OR p_user_id IS NULL OR p_evidence_category IS NULL 
     OR p_document_reference_hash IS NULL OR length(trim(p_document_reference_hash)) < 32 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_VERIFICATION_EVIDENCE');
  END IF;

  -- Transaction-scoped advisory lock per user to eliminate concurrent completion races
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_user_id::text));

  -- 1. Check account eligibility: user must remain active
  SELECT account_status INTO v_account_status
  FROM public.user_accounts
  WHERE user_id = p_user_id;

  IF v_account_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_NOT_ELIGIBLE');
  END IF;

  -- 2. Row lock and verify attempt lifecycle
  SELECT * INTO v_attempt
  FROM app_security.idv_verification_attempts
  WHERE id = p_attempt_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND');
  END IF;

  -- 3. Check existing identity record: revoked or withdrawn verification must NEVER be reactivated by an old attempt
  SELECT is_withdrawn, withdrawn_at, revoked_at INTO v_existing_record
  FROM app_security.idv_identity_records
  WHERE user_id = p_user_id;

  IF FOUND THEN
    -- If user previously withdrew consent, re-verification requires a fresh, explicit consent via a NEW attempt started AFTER withdrawal
    IF v_existing_record.is_withdrawn = true THEN
      IF v_existing_record.withdrawn_at IS NOT NULL AND v_attempt.consent_timestamp <= v_existing_record.withdrawn_at THEN
        RETURN jsonb_build_object('success', false, 'error', 'CONSENT_WITHDRAWN_REACTIVATION_FORBIDDEN');
      END IF;
    END IF;
    -- If admin revoked verification (and it wasn't merely user consent withdrawal), reactivation by standard user flow is strictly forbidden
    IF v_existing_record.revoked_at IS NOT NULL AND v_existing_record.is_withdrawn = false THEN
      RETURN jsonb_build_object('success', false, 'error', 'REVOKED_VERIFICATION_REACTIVATION_FORBIDDEN');
    END IF;
  END IF;

  -- Attempt must not already be consumed or completed
  IF v_attempt.status = 'verified' THEN
    RETURN jsonb_build_object('success', true, 'message', 'ALREADY_VERIFIED');
  END IF;

  -- Attempt must be strictly in_progress
  IF v_attempt.status IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ATTEMPT_LIFECYCLE_STATE', 'status', v_attempt.status);
  END IF;

  -- Attempt must not have expired
  IF v_attempt.attempt_expires_at < pg_catalog.clock_timestamp() THEN
    UPDATE app_security.idv_verification_attempts
    SET status = 'expired', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_attempt_id;

    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_EXPIRED');
  END IF;

  -- Provider session must be bound
  IF v_attempt.provider_request_id IS NULL OR length(trim(v_attempt.provider_request_id)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROVIDER_REQUEST_NOT_BOUND');
  END IF;

  -- Enforce that completion uses the exact same category stored on the original consented attempt
  IF v_attempt.evidence_category IS DISTINCT FROM p_evidence_category THEN
    RETURN jsonb_build_object('success', false, 'error', 'CATEGORY_CONSENT_MISMATCH', 'attempt_category', v_attempt.evidence_category, 'provided_category', p_evidence_category);
  END IF;

  -- 4. Apply explicit badge validity/renewal policy: default to 1 year bounded validity; never indefinite
  v_effective_valid_until := coalesce(p_valid_until, pg_catalog.clock_timestamp() + interval '1 year');

  -- Atomically record private record preserving authentic consent timestamp from attempt start
  INSERT INTO app_security.idv_identity_records (
    user_id,
    attempt_id,
    evidence_category,
    issuer_authority,
    document_reference_hash,
    consent_timestamp,
    consent_purpose,
    consent_policy_version,
    verified_at,
    valid_until,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_attempt_id,
    p_evidence_category,
    coalesce(p_issuer_authority, 'DigiLocker'),
    p_document_reference_hash,
    v_attempt.consent_timestamp,
    v_attempt.consent_purpose,
    v_attempt.consent_policy_version,
    pg_catalog.clock_timestamp(),
    v_effective_valid_until,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    attempt_id = EXCLUDED.attempt_id,
    evidence_category = EXCLUDED.evidence_category,
    issuer_authority = EXCLUDED.issuer_authority,
    document_reference_hash = EXCLUDED.document_reference_hash,
    consent_timestamp = EXCLUDED.consent_timestamp,
    consent_purpose = EXCLUDED.consent_purpose,
    consent_policy_version = EXCLUDED.consent_policy_version,
    verified_at = EXCLUDED.verified_at,
    valid_until = EXCLUDED.valid_until,
    is_withdrawn = false,
    withdrawn_at = NULL,
    revoked_at = NULL,
    revocation_reason = NULL,
    updated_at = pg_catalog.clock_timestamp();

  -- Update attempt state
  UPDATE app_security.idv_verification_attempts
  SET status = 'verified',
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_attempt_id;

  -- Project into minimal public badge table (strictly non-sensitive, no revocation reasons)
  INSERT INTO public.user_identity_verifications (
    user_id,
    verification_status,
    badge_issued,
    verified_at,
    valid_until,
    revoked_at,
    updated_at
  ) VALUES (
    p_user_id,
    'verified',
    true,
    pg_catalog.clock_timestamp(),
    v_effective_valid_until,
    NULL,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    verification_status = 'verified',
    badge_issued = true,
    verified_at = EXCLUDED.verified_at,
    valid_until = EXCLUDED.valid_until,
    revoked_at = NULL,
    updated_at = pg_catalog.clock_timestamp();

  -- Durably queue temporary provider OAuth token revocation in the queue
  -- The revocation worker will asynchronously and exclusively execute provider revocation
  IF v_attempt.provider_request_id IS NOT NULL AND length(trim(v_attempt.provider_request_id)) > 0 THEN
    UPDATE app_security.idv_verification_attempts
    SET revocation_pending = true,
        next_retry_at = coalesce(next_retry_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_attempt_id;
  END IF;

  PERFORM app_security.impl_record_idv_audit_event(
    p_user_id,
    p_attempt_id,
    'verification_completed',
    p_user_id,
    'system',
    jsonb_build_object('category', p_evidence_category)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_complete_verification(uuid, uuid, public.idv_evidence_category_enum, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_complete_verification(uuid, uuid, public.idv_evidence_category_enum, text, text, timestamptz) TO service_role;

-- 4E. User Consent Withdrawal (Revokes badge & marks record withdrawn)
CREATE OR REPLACE FUNCTION app_security.impl_idv_withdraw_consent(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_provider_req_ids text[];
  v_attempts jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_USER_ID');
  END IF;

  -- Transaction-scoped advisory lock per user to eliminate concurrent races
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_user_id::text));

  -- Durably queue token revocation in the same transaction for all attempts with outstanding provider tokens
  UPDATE app_security.idv_verification_attempts
  SET revocation_pending = true,
      next_retry_at = coalesce(next_retry_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_user_id
    AND provider_request_id IS NOT NULL
    AND token_revoked_at IS NULL;

  -- Collect attempts that need provider token revocation
  SELECT
    coalesce(array_agg(provider_request_id), ARRAY[]::text[]),
    coalesce(jsonb_agg(jsonb_build_object('attempt_id', id, 'provider_request_id', provider_request_id)), '[]'::jsonb)
  INTO v_provider_req_ids, v_attempts
  FROM app_security.idv_verification_attempts
  WHERE user_id = p_user_id
    AND provider_request_id IS NOT NULL
    AND token_revoked_at IS NULL;

  -- Invalidate any pending or in_progress attempts for this user so old attempts cannot be used
  UPDATE app_security.idv_verification_attempts
  SET status = 'cancelled',
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_user_id
    AND status IN ('pending', 'in_progress');

  UPDATE app_security.idv_identity_records
  SET is_withdrawn = true,
      withdrawn_at = pg_catalog.clock_timestamp(),
      revoked_at = pg_catalog.clock_timestamp(),
      revocation_reason = 'User withdrawn consent',
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_user_id;

  UPDATE public.user_identity_verifications
  SET verification_status = 'revoked',
      badge_issued = false,
      revoked_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_user_id;

  PERFORM app_security.impl_record_idv_audit_event(
    p_user_id,
    NULL,
    'consent_withdrawn',
    p_user_id,
    'user',
    jsonb_build_object('reason', 'user_request')
  );

  RETURN jsonb_build_object(
    'success', true,
    'provider_request_ids', coalesce(v_provider_req_ids, ARRAY[]::text[]),
    'attempts', coalesce(v_attempts, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_withdraw_consent(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_withdraw_consent(uuid) TO service_role;

-- 4F. Admin Revocation (Strictly restricted to Administrator with AAL2; mandatory reason)
CREATE OR REPLACE FUNCTION app_security.impl_admin_revoke_verification(
  p_target_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_id uuid;
BEGIN
  IF NOT app_security.is_active_staff_aal2('administrator') THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN_ADMIN_AAL2_REQUIRED');
  END IF;

  v_admin_id := auth.uid();

  IF p_target_user_id IS NULL OR p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'MANDATORY_REASON_REQUIRED');
  END IF;

  -- Admin cannot self-revoke/modify own badge through this flow
  IF p_target_user_id = v_admin_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'CANNOT_SELF_REVOKE');
  END IF;

  -- Transaction-scoped advisory lock per user to eliminate concurrent races
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_target_user_id::text));

  -- Durably queue token revocation in the same transaction for all attempts with outstanding provider tokens
  UPDATE app_security.idv_verification_attempts
  SET revocation_pending = true,
      next_retry_at = coalesce(next_retry_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_target_user_id
    AND provider_request_id IS NOT NULL
    AND token_revoked_at IS NULL;

  -- Invalidate any pending or in_progress attempts for this target user so old attempts cannot be used
  UPDATE app_security.idv_verification_attempts
  SET status = 'cancelled',
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_target_user_id
    AND status IN ('pending', 'in_progress');

  -- Store reason privately in app_security.idv_identity_records
  UPDATE app_security.idv_identity_records
  SET revoked_at = pg_catalog.clock_timestamp(),
      revocation_reason = trim(p_reason),
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_target_user_id;

  UPDATE public.user_identity_verifications
  SET verification_status = 'revoked',
      badge_issued = false,
      revoked_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_target_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERIFICATION_RECORD_NOT_FOUND');
  END IF;

  PERFORM app_security.impl_record_idv_audit_event(
    p_target_user_id,
    NULL,
    'admin_revocation',
    v_admin_id,
    'administrator',
    jsonb_build_object('reason', trim(p_reason))
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_admin_revoke_verification(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_admin_revoke_verification(uuid, text) TO authenticated, service_role;

-- Public wrapper for admin revocation
-- Uses SECURITY DEFINER with search_path = '' so that authenticated staff execution can properly invoke the private implementation.
CREATE OR REPLACE FUNCTION public.admin_revoke_verification(
  p_target_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_admin_revoke_verification(p_target_user_id, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_verification(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_verification(uuid, text) TO authenticated, service_role;

-- 4G. Public Invoker RPC for user verification status (Owner-scoped)
-- Safely exposes status and non-sensitive timestamps.
-- Internal administrative revocation reasons are strictly excluded and never returned.
CREATE OR REPLACE FUNCTION public.get_my_identity_verification()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row RECORD;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.user_identity_verifications
  WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'not_started',
      'badge_issued', false
    );
  END IF;

  -- Check if validity has expired
  IF v_row.valid_until IS NOT NULL AND v_row.valid_until <= pg_catalog.clock_timestamp() THEN
    RETURN jsonb_build_object(
      'status', 'expired',
      'badge_issued', false,
      'verified_at', v_row.verified_at,
      'valid_until', v_row.valid_until,
      'revoked_at', v_row.revoked_at
    );
  END IF;

  RETURN jsonb_build_object(
    'status', v_row.verification_status,
    'badge_issued', v_row.badge_issued,
    'verified_at', v_row.verified_at,
    'valid_until', v_row.valid_until,
    'revoked_at', v_row.revoked_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_identity_verification() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_identity_verification() TO authenticated, service_role;

-- 4H. Server-Only RPC Wrappers for PostgREST Edge Functions (Service Role only)
-- PostgREST exposes schema 'public', not 'app_security'. Edge functions call these wrappers.

CREATE OR REPLACE FUNCTION public.server_idv_start_attempt(
  p_user_id uuid,
  p_request_state text,
  p_ttl_seconds integer DEFAULT 900,
  p_consent_purpose text DEFAULT 'FairSwap India Peer-to-Peer Identity Verification V1',
  p_consent_acknowledged boolean DEFAULT false,
  p_policy_version text DEFAULT 'v1.0',
  p_evidence_category text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_idv_start_attempt(
    p_user_id,
    p_request_state,
    p_ttl_seconds,
    p_consent_purpose,
    p_consent_acknowledged,
    p_policy_version,
    p_evidence_category
  );
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_start_attempt(uuid, text, integer, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_start_attempt(uuid, text, integer, text, boolean, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_attach_provider_session(
  p_attempt_id uuid,
  p_provider_request_id text,
  p_provider_session_url text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_idv_attach_provider_session(p_attempt_id, p_provider_request_id, p_provider_session_url);
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_attach_provider_session(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_attach_provider_session(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_complete_verification(
  p_attempt_id uuid,
  p_user_id uuid,
  p_evidence_category text,
  p_issuer_authority text,
  p_document_reference_hash text,
  p_valid_until timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_idv_complete_verification(
    p_attempt_id,
    p_user_id,
    p_evidence_category::public.idv_evidence_category_enum,
    p_issuer_authority,
    p_document_reference_hash,
    p_valid_until
  );
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_complete_verification(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_complete_verification(uuid, uuid, text, text, text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_withdraw_consent(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_idv_withdraw_consent(p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_withdraw_consent(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_withdraw_consent(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_get_attempt_for_completion(
  p_attempt_id uuid,
  p_user_id uuid,
  p_request_state text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- If attempt_id is provided, look up by attempt_id and user_id
  IF p_attempt_id IS NOT NULL THEN
    SELECT id, user_id, request_state, provider_request_id, evidence_category, status, attempt_expires_at, consent_timestamp, consent_purpose
    INTO v_row
    FROM app_security.idv_verification_attempts
    WHERE id = p_attempt_id AND user_id = p_user_id;
  -- If attempt_id was lost (e.g. across full-page redirect), securely resolve by user_id and single-use state nonce
  ELSIF p_request_state IS NOT NULL AND length(trim(p_request_state)) >= 16 THEN
    SELECT id, user_id, request_state, provider_request_id, evidence_category, status, attempt_expires_at, consent_timestamp, consent_purpose
    INTO v_row
    FROM app_security.idv_verification_attempts
    WHERE user_id = p_user_id
      AND request_state = trim(p_request_state)
      AND status = 'in_progress'
      AND attempt_expires_at > pg_catalog.clock_timestamp()
    ORDER BY created_at DESC
    LIMIT 1;
  ELSE
    RETURN NULL;
  END IF;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'user_id', v_row.user_id,
    'request_state', v_row.request_state,
    'provider_request_id', v_row.provider_request_id,
    'evidence_category', v_row.evidence_category,
    'status', v_row.status,
    'attempt_expires_at', v_row.attempt_expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_get_attempt_for_completion(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_get_attempt_for_completion(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_get_latest_attempt(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT id, user_id, status, provider_request_id, attempt_expires_at, created_at
  INTO v_row
  FROM app_security.idv_verification_attempts
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'user_id', v_row.user_id,
    'status', v_row.status,
    'provider_request_id', v_row.provider_request_id,
    'attempt_expires_at', v_row.attempt_expires_at,
    'created_at', v_row.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_get_latest_attempt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_get_latest_attempt(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_record_token_revoked(
  p_attempt_id uuid,
  p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_attempt_id IS NULL OR p_lease_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PARAMETERS_OR_LEASE_TOKEN_REQUIRED');
  END IF;

  UPDATE app_security.idv_verification_attempts
  SET token_revoked_at = pg_catalog.clock_timestamp(),
      token_revocation_failed = false,
      token_revocation_error = NULL,
      revocation_pending = false,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_attempt_id
    AND lease_token = p_lease_token
    AND lease_expires_at >= pg_catalog.clock_timestamp()
    AND revocation_pending = true
  RETURNING user_id INTO v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND_OR_LEASE_EXPIRED');
  END IF;

  PERFORM app_security.impl_record_idv_audit_event(
    v_user_id,
    p_attempt_id,
    'token_revoked',
    coalesce(auth.uid(), v_user_id),
    'system',
    jsonb_build_object('status', 'success')
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_record_token_revoked(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_record_token_revoked(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_record_token_revocation_failed(
  p_attempt_id uuid,
  p_error text,
  p_lease_token uuid,
  p_consume_retry boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_new_count integer;
  v_sanitized_error text := substr(coalesce(trim(p_error), 'Unknown provider revocation error'), 1, 500);
  v_delay_seconds integer;
BEGIN
  IF p_attempt_id IS NULL OR p_lease_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PARAMETERS_OR_LEASE_TOKEN_REQUIRED');
  END IF;

  IF p_consume_retry IS TRUE THEN
    UPDATE app_security.idv_verification_attempts
    SET token_revocation_failed = true,
        token_revocation_error = v_sanitized_error,
        token_revocation_retry_count = token_revocation_retry_count + 1,
        lease_token = NULL,
        lease_expires_at = NULL,
        -- Exponential backoff: Attempt 1: 30s, Attempt 2: 120s, Attempt 3: 480s
        next_retry_at = pg_catalog.clock_timestamp() + ((30 * (4 ^ token_revocation_retry_count)) || ' seconds')::interval,
        revocation_pending = (token_revocation_retry_count + 1 < 3),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_attempt_id
      AND lease_token = p_lease_token
      AND lease_expires_at >= pg_catalog.clock_timestamp()
      AND revocation_pending = true
    RETURNING user_id, token_revocation_retry_count INTO v_user_id, v_new_count;
  ELSE
    -- Missing provider credentials: do NOT increment retry count; retain pending revocation with safe 5m cooldown
    UPDATE app_security.idv_verification_attempts
    SET token_revocation_failed = true,
        token_revocation_error = v_sanitized_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_retry_at = pg_catalog.clock_timestamp() + interval '5 minutes',
        revocation_pending = true,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_attempt_id
      AND lease_token = p_lease_token
      AND lease_expires_at >= pg_catalog.clock_timestamp()
      AND revocation_pending = true
    RETURNING user_id, token_revocation_retry_count INTO v_user_id, v_new_count;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND_OR_LEASE_EXPIRED');
  END IF;

  PERFORM app_security.impl_record_idv_audit_event(
    v_user_id,
    p_attempt_id,
    'token_revocation_failed',
    coalesce(auth.uid(), v_user_id),
    'system',
    jsonb_build_object(
      'retry_count', v_new_count,
      'retry_exhausted', (v_new_count >= 3),
      'consumed_quota', p_consume_retry,
      'error', v_sanitized_error
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'retry_count', v_new_count,
    'retry_exhausted', (v_new_count >= 3)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_record_token_revocation_failed(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_record_token_revocation_failed(uuid, text, uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.server_idv_get_pending_revocation_retries(
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := coalesce(p_limit, 10);
  v_attempts jsonb;
BEGIN
  IF v_limit < 1 THEN v_limit := 1; END IF;
  IF v_limit > 50 THEN v_limit := 50; END IF;

  SELECT coalesce(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'attempt_id', sub.id,
          'provider_request_id', sub.provider_request_id,
          'retry_count', sub.token_revocation_retry_count,
          'last_error', sub.token_revocation_error
        )
      )
      FROM (
        SELECT id, provider_request_id, token_revocation_retry_count, token_revocation_error
        FROM app_security.idv_verification_attempts
        WHERE revocation_pending = true
          AND token_revoked_at IS NULL
          AND provider_request_id IS NOT NULL
          AND token_revocation_retry_count < 3
          AND (next_retry_at IS NULL OR next_retry_at <= pg_catalog.clock_timestamp())
          AND (lease_expires_at IS NULL OR lease_expires_at < pg_catalog.clock_timestamp())
        ORDER BY coalesce(next_retry_at, created_at) ASC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  )
  INTO v_attempts;

  RETURN jsonb_build_object('success', true, 'pending_retries', v_attempts);
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_get_pending_revocation_retries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_get_pending_revocation_retries(integer) TO service_role;

-- 5D. Durable atomic worker claiming with unique lease token & crash recovery
CREATE OR REPLACE FUNCTION public.server_idv_claim_revocation_retries(
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := coalesce(p_limit, 10);
  v_lease_sec integer := coalesce(p_lease_seconds, 60);
  v_lease_token uuid := gen_random_uuid();
  v_lease_expires timestamptz;
  v_claimed jsonb;
BEGIN
  IF v_limit < 1 THEN v_limit := 1; END IF;
  IF v_limit > 50 THEN v_limit := 50; END IF;
  IF v_lease_sec < 15 THEN v_lease_sec := 15; END IF;
  IF v_lease_sec > 600 THEN v_lease_sec := 600; END IF;

  v_lease_expires := pg_catalog.clock_timestamp() + (v_lease_sec || ' seconds')::interval;

  WITH claimable AS (
    SELECT id
    FROM app_security.idv_verification_attempts
    WHERE revocation_pending = true
      AND token_revoked_at IS NULL
      AND provider_request_id IS NOT NULL
      AND token_revocation_retry_count < 3
      AND (next_retry_at IS NULL OR next_retry_at <= pg_catalog.clock_timestamp())
      AND (lease_expires_at IS NULL OR lease_expires_at < pg_catalog.clock_timestamp())
    ORDER BY coalesce(next_retry_at, created_at) ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE app_security.idv_verification_attempts a
    SET lease_token = v_lease_token,
        lease_expires_at = v_lease_expires,
        updated_at = pg_catalog.clock_timestamp()
    FROM claimable
    WHERE a.id = claimable.id
    RETURNING a.id, a.provider_request_id, a.token_revocation_retry_count, a.token_revocation_error
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'attempt_id', id,
        'provider_request_id', provider_request_id,
        'retry_count', token_revocation_retry_count,
        'last_error', token_revocation_error,
        'lease_token', v_lease_token
      )
    ),
    '[]'::jsonb
  )
  INTO v_claimed
  FROM updated;

  RETURN jsonb_build_object(
    'success', true,
    'lease_token', v_lease_token,
    'claimed_retries', v_claimed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.server_idv_claim_revocation_retries(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_claim_revocation_retries(integer, integer) TO service_role;

-- 5E. Scheduled Batch Runner for Revocation Retries & Stale Lease Recovery
-- Follows existing Backend worker conventions (e.g. invoke_email_outbox_retry_batch)
CREATE OR REPLACE FUNCTION app_security.invoke_idv_revocation_retry_batch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'idv_revocation_worker_url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'idv_worker_secret'
    LIMIT 1;

    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_url,
        body := '{}'::jsonb,
        params := '{}'::jsonb,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-idv-worker-secret', v_secret
        ),
        timeout_milliseconds := 10000
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'IDV revocation retry batch invocation failed: %', SQLERRM;
  END;
END;
$$;

REVOKE ALL ON FUNCTION app_security.invoke_idv_revocation_retry_batch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.invoke_idv_revocation_retry_batch() TO postgres, service_role;

-- 5F. Operational Scheduler Activation Helper (Explicit Post-Deployment Activation Step)
-- The migration creates the additive database foundation; operational activation of the scheduler
-- requires verifying pg_cron, pg_net, and the presence of Vault secrets.
CREATE OR REPLACE FUNCTION app_security.idv_activate_revocation_scheduler()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
  v_job_id bigint;
BEGIN
  -- 1. Verify pg_cron is installed
  IF to_regclass('cron.job') IS NULL OR to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: pg_cron extension is not available in database';
  END IF;

  -- 2. Verify pg_net is installed with the canonical 5-argument signature:
  -- net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)
  IF to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: pg_net extension is not available or net.http_post(text,jsonb,jsonb,jsonb,integer) signature is missing';
  END IF;

  -- 3. Verify required Vault secrets exist
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'idv_revocation_worker_url'
  LIMIT 1;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'idv_worker_secret'
  LIMIT 1;

  IF v_url IS NULL OR length(trim(v_url)) = 0 THEN
    RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: vault secret "idv_revocation_worker_url" is missing or empty';
  END IF;

  IF v_secret IS NULL OR length(trim(v_secret)) = 0 THEN
    RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: vault secret "idv_worker_secret" is missing or empty';
  END IF;

  -- Validate Vault worker URL matches canonical project Edge Function origin pattern:
  -- Must strictly match configured project: FairSwapTest (wpppxlnbzqynvhpeuavd) or FairSwapProd (kriuhwppxgxsyyrbjsau)
  IF NOT (v_url ~* '^https://(wpppxlnbzqynvhpeuavd|kriuhwppxgxsyyrbjsau)\.supabase\.co/functions/v1/idv-revocation-worker$') THEN
    RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: vault secret "idv_revocation_worker_url" is not a valid Supabase project worker endpoint: %', v_url;
  END IF;

  -- Validate against trusted environment-specific configuration: activation must fail closed if missing or mismatched
  DECLARE
    v_expected_project text;
  BEGIN
    SELECT decrypted_secret INTO v_expected_project
    FROM vault.decrypted_secrets
    WHERE name = 'app_project_ref'
    LIMIT 1;

    IF v_expected_project IS NULL OR length(trim(v_expected_project)) = 0 THEN
      v_expected_project := NULLIF(pg_catalog.current_setting('app.supabase_project_ref', true), '');
    END IF;

    IF v_expected_project IS NULL OR length(trim(v_expected_project)) = 0 THEN
      RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: trusted project reference configuration missing (must set vault secret "app_project_ref" or session setting "app.supabase_project_ref")';
    END IF;

    IF trim(v_expected_project) NOT IN ('wpppxlnbzqynvhpeuavd', 'kriuhwppxgxsyyrbjsau') THEN
      RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: unapproved configured project reference "%"', v_expected_project;
    END IF;

    IF v_url !~ ('^https://' || trim(v_expected_project) || '\.supabase\.co/functions/v1/idv-revocation-worker$') THEN
      RAISE EXCEPTION 'IDV_ACTIVATION_FAILED: cross-project scheduler activation forbidden: worker URL does not match configured project "%": %', v_expected_project, v_url;
    END IF;
  END;

  -- 4. Register or update the cron job
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-idv-revocation-retries') THEN
    PERFORM cron.unschedule('process-idv-revocation-retries');
  END IF;

  v_job_id := cron.schedule(
    'process-idv-revocation-retries',
    '*/5 * * * *',
    'SELECT app_security.invoke_idv_revocation_retry_batch();'
  );

  RETURN jsonb_build_object(
    'success', true,
    'job_name', 'process-idv-revocation-retries',
    'schedule', '*/5 * * * *',
    'job_id', v_job_id
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.idv_activate_revocation_scheduler() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.idv_activate_revocation_scheduler() TO postgres, service_role;

commit;
