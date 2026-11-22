-- Migration: 20261119200000_idv_digilocker_oidc_v2_badge.sql
-- FairSwap IDV: "Verified with DigiLocker" badge provenance for signed DigiLocker OIDC (v2).
-- Forward-only and additive. Depends on 20261026183000_idv_digilocker_foundation.sql (hosted under each environment's
-- own foundation version) and 20261117090000_idv_digilocker_direct_v1.sql. Neither historical file is modified.
-- Policy: the badge is issued only after a signature-verified DigiLocker ID token yields a digilockerid whose keyed HMAC
-- fingerprint is bound to exactly one FairSwap account. No Aadhaar ACR/KYC, PAN or document data is required or stored.
-- Stores no raw id, token or claim. identity_verification_required is NOT changed (stays as configured, default 'false').
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 1. Binding provenance. Existing (unsigned account-link) rows are labelled legacy and never project the badge.
ALTER TABLE app_security.idv_digilocker_bindings
  ADD COLUMN IF NOT EXISTS evidence_method text NOT NULL DEFAULT 'legacy_account_link',
  ADD COLUMN IF NOT EXISTS evidence_verified_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'app_security.idv_digilocker_bindings'::regclass AND conname = 'chk_idv_dl_evidence_method') THEN
    ALTER TABLE app_security.idv_digilocker_bindings ADD CONSTRAINT chk_idv_dl_evidence_method
      CHECK (evidence_method IN ('legacy_account_link', 'oidc_v2_signed_id_token')
             AND ((evidence_method = 'oidc_v2_signed_id_token') = (evidence_verified_at IS NOT NULL)));
  END IF;
END $$;

-- 2. Authoritative badge predicate: active account, live verified projection, linked binding with signed-OIDC provenance.
--    Fraud blocks, admin revocation and consent withdrawal already revoke the projection and/or the binding status.
CREATE OR REPLACE FUNCTION app_security.has_digilocker_badge(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL
    AND app_security.get_account_status(p_user_id) = 'active'
    AND EXISTS (
      SELECT 1 FROM public.user_identity_verifications v
      WHERE v.user_id = p_user_id
        AND v.verification_status = 'verified'
        AND v.badge_issued = true
        AND v.revoked_at IS NULL
        AND (v.valid_until IS NULL OR v.valid_until > pg_catalog.clock_timestamp())
    )
    AND EXISTS (
      SELECT 1 FROM app_security.idv_digilocker_bindings b
      WHERE b.user_id = p_user_id
        AND b.provider = 'digilocker_meripehchaan'
        AND b.identity_status = 'linked'
        AND b.evidence_method = 'oidc_v2_signed_id_token'
    );
$$;
REVOKE ALL ON FUNCTION app_security.has_digilocker_badge(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.has_digilocker_badge(uuid) TO service_role;

-- 3. Start: unchanged except that "already verified" now means holding the signed-OIDC badge, so an account with only a
--    legacy (unsigned) link can re-verify and be upgraded. Signature, grants and all other checks are unchanged.
CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_start_attempt(
  p_user_id uuid, p_state_hash text, p_ttl_seconds integer,
  p_consent_purpose text, p_consent_acknowledged boolean, p_policy_version text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_id uuid; v_recent integer; v_blocked boolean;
BEGIN
  IF p_user_id IS NULL OR p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_REQUEST');
  END IF;
  IF p_consent_acknowledged IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('success', false, 'error', 'CONSENT_REQUIRED');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_user_id::text));

  IF app_security.get_account_status(p_user_id) IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_NOT_ELIGIBLE');
  END IF;
  IF app_security.has_digilocker_badge(p_user_id) THEN
    RETURN jsonb_build_object('success', true, 'already_verified', true);
  END IF;
  SELECT EXISTS (SELECT 1 FROM app_security.idv_digilocker_bindings
                 WHERE user_id = p_user_id AND identity_status = 'fraud_blocked') INTO v_blocked;
  IF v_blocked THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERIFICATION_UNAVAILABLE');
  END IF;

  SELECT count(*) INTO v_recent FROM app_security.idv_digilocker_attempts
  WHERE user_id = p_user_id AND created_at > pg_catalog.clock_timestamp() - interval '1 hour';
  IF v_recent >= 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'RATE_LIMIT_EXCEEDED');
  END IF;

  UPDATE app_security.idv_digilocker_attempts SET status = 'cancelled'
  WHERE user_id = p_user_id AND status = 'pending';

  INSERT INTO app_security.idv_digilocker_attempts (user_id, state_hash, expires_at, consent_purpose, consent_policy_version)
  VALUES (p_user_id, p_state_hash,
          pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 600), 900))),
          p_consent_purpose, p_policy_version)
  RETURNING id INTO v_id;

  PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_attempt_started', p_user_id, 'user',
    jsonb_build_object('policy_version', p_policy_version));
  RETURN jsonb_build_object('success', true, 'attempt_id', v_id);
END;
$$;

-- 4. Legacy unsigned account linking can no longer bind or issue anything. Signature and grants are preserved so an
--    older Edge deployment fails closed instead of erroring.
CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_complete(
  p_attempt_id uuid, p_user_id uuid, p_id_fingerprint text, p_key_version text,
  p_legacy_fingerprints text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'LEGACY_LINK_DISABLED'
  WHERE id = p_attempt_id AND user_id = p_user_id AND status IN ('pending', 'consumed');
  RETURN jsonb_build_object('success', false, 'error', 'LEGACY_LINK_DISABLED');
END;
$$;

-- 5. Signed-OIDC atomic link. Same serialisation, revocation, fraud-block and duplicate rules as V1, plus provenance.
CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_complete_v2(
  p_attempt_id uuid, p_user_id uuid, p_id_fingerprint text, p_key_version text,
  p_legacy_fingerprints text[], p_evidence_method text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_a RECORD; v_b RECORD; v_own RECORD; v_last_event text; v_now timestamptz := pg_catalog.clock_timestamp();
  v_all text[]; v_fp text;
BEGIN
  IF p_evidence_method IS DISTINCT FROM 'oidc_v2_signed_id_token' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_IDENTITY_EVIDENCE');
  END IF;
  IF p_attempt_id IS NULL OR p_user_id IS NULL OR p_id_fingerprint IS NULL OR p_id_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_key_version IS NULL OR p_key_version !~ '^v[0-9]{1,3}$'
     OR coalesce(pg_catalog.array_length(p_legacy_fingerprints, 1), 0) > 8 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_IDENTITY_EVIDENCE');
  END IF;
  v_all := ARRAY[p_id_fingerprint] || coalesce(p_legacy_fingerprints, '{}'::text[]);
  FOREACH v_fp IN ARRAY v_all LOOP
    IF v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'INVALID_IDENTITY_EVIDENCE');
    END IF;
  END LOOP;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_user_id::text));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_dl_fp_' || p_id_fingerprint));

  IF app_security.get_account_status(p_user_id) IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_NOT_ELIGIBLE');
  END IF;
  SELECT * INTO v_a FROM app_security.idv_digilocker_attempts WHERE id = p_attempt_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND');
  END IF;
  IF v_a.status = 'completed' THEN
    RETURN jsonb_build_object('success', true, 'already_verified', true);
  END IF;
  IF v_a.status <> 'consumed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ATTEMPT_STATE');
  END IF;

  -- Admin revocation of this account must not be undone by self-service relinking.
  SELECT event_type INTO v_last_event FROM app_security.idv_audit_events
  WHERE user_id = p_user_id AND event_type IN ('admin_revocation', 'verification_completed', 'digilocker_linked')
  ORDER BY created_at DESC, id DESC LIMIT 1;
  IF v_last_event = 'admin_revocation' THEN
    UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'REVOKED' WHERE id = p_attempt_id;
    RETURN jsonb_build_object('success', false, 'error', 'VERIFICATION_UNAVAILABLE');
  END IF;

  DELETE FROM app_security.idv_digilocker_bindings
  WHERE provider = 'digilocker_meripehchaan' AND id_fingerprint = ANY (v_all)
    AND user_id IS NULL AND identity_status <> 'fraud_blocked';

  IF EXISTS (SELECT 1 FROM app_security.idv_digilocker_bindings
             WHERE provider = 'digilocker_meripehchaan' AND id_fingerprint = ANY (v_all) AND identity_status = 'fraud_blocked')
     OR EXISTS (SELECT 1 FROM app_security.idv_digilocker_bindings
                WHERE user_id = p_user_id AND identity_status = 'fraud_blocked') THEN
    UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'IDENTITY_BLOCKED' WHERE id = p_attempt_id;
    PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_link_rejected', p_user_id, 'system',
      jsonb_build_object('reason', 'blocked_identity'));
    RETURN jsonb_build_object('success', false, 'error', 'VERIFICATION_UNAVAILABLE');
  END IF;

  SELECT * INTO v_b FROM app_security.idv_digilocker_bindings
  WHERE provider = 'digilocker_meripehchaan' AND id_fingerprint = ANY (v_all)
  ORDER BY (user_id IS DISTINCT FROM p_user_id) DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_b.user_id IS DISTINCT FROM p_user_id THEN
      UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'IDENTITY_ALREADY_LINKED' WHERE id = p_attempt_id;
      PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_link_rejected', p_user_id, 'system',
        jsonb_build_object('reason', 'already_linked'));
      RETURN jsonb_build_object('success', false, 'error', 'IDENTITY_ALREADY_LINKED', 'recovery', true);
    END IF;
    -- Same user, same identity (retry or legacy upgrade): refresh consent, record signed provenance, re-key.
    UPDATE app_security.idv_digilocker_bindings
    SET id_fingerprint = p_id_fingerprint, fingerprint_key_version = p_key_version,
        attempt_id = p_attempt_id, consent_timestamp = v_a.consent_timestamp, consent_purpose = v_a.consent_purpose,
        consent_policy_version = v_a.consent_policy_version, linked_at = v_now, updated_at = v_now,
        evidence_method = 'oidc_v2_signed_id_token', evidence_verified_at = v_now
    WHERE id = v_b.id;
  ELSE
    SELECT * INTO v_own FROM app_security.idv_digilocker_bindings WHERE user_id = p_user_id FOR UPDATE;
    IF FOUND THEN
      UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'ACCOUNT_LINKED_TO_OTHER_IDENTITY' WHERE id = p_attempt_id;
      RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_LINKED_TO_OTHER_IDENTITY');
    END IF;
    INSERT INTO app_security.idv_digilocker_bindings (user_id, id_fingerprint, fingerprint_key_version, attempt_id,
      consent_timestamp, consent_purpose, consent_policy_version, linked_at, evidence_method, evidence_verified_at)
    VALUES (p_user_id, p_id_fingerprint, p_key_version, p_attempt_id,
      v_a.consent_timestamp, v_a.consent_purpose, v_a.consent_policy_version, v_now, 'oidc_v2_signed_id_token', v_now);
  END IF;

  UPDATE app_security.idv_digilocker_attempts SET status = 'completed', completed_at = v_now WHERE id = p_attempt_id;

  INSERT INTO public.user_identity_verifications (user_id, verification_status, badge_issued, verified_at, valid_until, revoked_at, updated_at)
  VALUES (p_user_id, 'verified', true, v_now, NULL, NULL, v_now)
  ON CONFLICT (user_id) DO UPDATE SET verification_status = 'verified', badge_issued = true,
    verified_at = EXCLUDED.verified_at, valid_until = NULL, revoked_at = NULL, updated_at = v_now;

  PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_linked', p_user_id, 'system',
    jsonb_build_object('provider', 'digilocker_meripehchaan', 'key_version', p_key_version,
                       'evidence_method', 'oidc_v2_signed_id_token'));
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'error', 'IDENTITY_ALREADY_LINKED', 'recovery', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.server_idv_dl_complete_v2(p_attempt_id uuid, p_user_id uuid, p_id_fingerprint text,
  p_key_version text, p_legacy_fingerprints text[], p_evidence_method text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_idv_dl_complete_v2(p_attempt_id, p_user_id, p_id_fingerprint, p_key_version,
    p_legacy_fingerprints, p_evidence_method);
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) TO service_role;

-- 6. Public badge projection: only the subset of requested user ids that hold the signed-OIDC badge. No fingerprint,
--    binding, timestamp or status detail is returned. Bounded input; rows only for real requested ids.
CREATE OR REPLACE FUNCTION public.get_digilocker_badges(p_user_ids uuid[])
RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_ids IS NULL OR coalesce(pg_catalog.cardinality(p_user_ids), 0) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_user_ids) > 100 THEN
    RAISE EXCEPTION 'TOO_MANY_USER_IDS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT DISTINCT u.id FROM pg_catalog.unnest(p_user_ids) AS u(id)
    WHERE u.id IS NOT NULL AND app_security.has_digilocker_badge(u.id);
END;
$$;
REVOKE ALL ON FUNCTION public.get_digilocker_badges(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_digilocker_badges(uuid[]) TO anon, authenticated, service_role;

-- 7. Owner access summary (UX only). Additive key; existing keys and grants unchanged.
CREATE OR REPLACE FUNCTION public.get_my_marketplace_access()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN auth.uid() IS NULL THEN NULL ELSE jsonb_build_object(
    'identity_verified', app_security.is_identity_verified(auth.uid()),
    'verification_required', app_security.identity_gate_enabled(),
    'digilocker_verified', app_security.has_digilocker_badge(auth.uid())
  ) END;
$$;
REVOKE ALL ON FUNCTION public.get_my_marketplace_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_marketplace_access() TO authenticated, service_role;

commit;
