-- Migration: 20261123150000_idv_digilocker_acr_request_only.sql
-- FairSwap IDV: signed DigiLocker identity with acr=aadhaar requested from the provider; no signed acr response claim required.
-- Forward-only. Depends on 20261123120000_idv_digilocker_aadhaar_acr.sql. No historical file is modified.
-- Evidence model: new evidence_method 'oidc_v2_signed_id_requested_aadhaar' records signed identity and an acr=aadhaar
-- authorization request (the provider, not the token, enforces the ACR request). Existing 'oidc_v2_signed_id_token', prior signed-acr evidence and 'legacy_account_link'
-- rows are kept untouched as history but no longer satisfy app_security.has_digilocker_badge, so they lose the badge (and the
-- mandatory-gate pass) until a new successful verification. Nothing is upgraded automatically.
-- Stores no raw id, token, claim, Aadhaar or name/DOB. identity_verification_required is NOT changed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('app_security.has_digilocker_badge(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)') IS NULL
     OR pg_catalog.to_regprocedure('public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = 'app_security.idv_digilocker_bindings'::regclass AND conname = 'chk_idv_dl_evidence_method') THEN
    RAISE EXCEPTION 'IDV_DIGILOCKER_REQUEST_PREREQUISITE_MISSING';
  END IF;
END $$;

-- 1. Allow the new evidence value; every signed value still requires evidence_verified_at, legacy never has it.
ALTER TABLE app_security.idv_digilocker_bindings DROP CONSTRAINT chk_idv_dl_evidence_method;
ALTER TABLE app_security.idv_digilocker_bindings ADD CONSTRAINT chk_idv_dl_evidence_method
  CHECK (evidence_method IN ('legacy_account_link', 'oidc_v2_signed_id_token', 'oidc_v2_signed_aadhaar_acr', 'oidc_v2_signed_id_requested_aadhaar')
         AND ((evidence_method <> 'legacy_account_link') = (evidence_verified_at IS NOT NULL)));

-- 2. Authoritative badge predicate: signed identity plus requested provider Aadhaar context (or historical signed ACR).
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
        AND b.evidence_method IN ('oidc_v2_signed_aadhaar_acr', 'oidc_v2_signed_id_requested_aadhaar')
    );
$$;
REVOKE ALL ON FUNCTION app_security.has_digilocker_badge(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.has_digilocker_badge(uuid) TO service_role;

-- 3. Atomic link: same fraud/consent/binding controls but the new required evidence is request-only ACR with signed identity.
--    The previous signed-ACR label remains historical; older Edge functions cannot issue new badges after this migration.
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
  IF p_evidence_method IS DISTINCT FROM 'oidc_v2_signed_id_requested_aadhaar' THEN
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
    -- Same user, same identity (retry or legacy upgrade): refresh consent, record signed DigiLocker provenance with requested ACR, re-key.
    UPDATE app_security.idv_digilocker_bindings
    SET id_fingerprint = p_id_fingerprint, fingerprint_key_version = p_key_version,
        attempt_id = p_attempt_id, consent_timestamp = v_a.consent_timestamp, consent_purpose = v_a.consent_purpose,
        consent_policy_version = v_a.consent_policy_version, linked_at = v_now, updated_at = v_now,
        evidence_method = 'oidc_v2_signed_id_requested_aadhaar', evidence_verified_at = v_now
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
      v_a.consent_timestamp, v_a.consent_purpose, v_a.consent_policy_version, v_now, 'oidc_v2_signed_id_requested_aadhaar', v_now);
  END IF;

  UPDATE app_security.idv_digilocker_attempts SET status = 'completed', completed_at = v_now WHERE id = p_attempt_id;

  INSERT INTO public.user_identity_verifications (user_id, verification_status, badge_issued, verified_at, valid_until, revoked_at, updated_at)
  VALUES (p_user_id, 'verified', true, v_now, NULL, NULL, v_now)
  ON CONFLICT (user_id) DO UPDATE SET verification_status = 'verified', badge_issued = true,
    verified_at = EXCLUDED.verified_at, valid_until = NULL, revoked_at = NULL, updated_at = v_now;

  PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_linked', p_user_id, 'system',
    jsonb_build_object('provider', 'digilocker_meripehchaan', 'key_version', p_key_version,
                       'evidence_method', 'oidc_v2_signed_id_requested_aadhaar'));
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'error', 'IDENTITY_ALREADY_LINKED', 'recovery', true);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_complete_v2(uuid, uuid, text, text, text[], text) TO service_role;

commit;
