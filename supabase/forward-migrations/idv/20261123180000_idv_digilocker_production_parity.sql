-- Migration: 20261123180000_idv_digilocker_production_parity.sql
-- Forward-only Production/Test parity from DigiLocker signed OIDC V2.
-- Production does not have Test-only migration versions 20261122100000, 20261123120000,
-- or 20261123150000; this single reviewed version installs their final EFFECTIVE
-- enforcement and requested-Aadhaar signed-identity rules without copying Test-only ledger history.
-- Test already has these definitions: this replaces them with the same final definitions.
-- Activates identity_verification_required in this same transaction, ONLY after the
-- protected pipeline confirms deployed Web and Edge runtime readiness. Test is already ON.
-- Historical signed/legacy identity links are NOT upgraded automatically. Fraud holds preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $preflight$
BEGIN
 IF pg_catalog.to_regprocedure('app_security.has_digilocker_badge(uuid)') IS NULL
    OR pg_catalog.to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') IS NULL
    OR pg_catalog.to_regprocedure('app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)') IS NULL
    OR pg_catalog.to_regprocedure('public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)') IS NULL
    OR pg_catalog.to_regclass('app_security.idv_digilocker_bindings') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'app_security.idv_digilocker_bindings'::regclass
        AND conname = 'chk_idv_dl_evidence_method') THEN
    RAISE EXCEPTION 'IDV_DIGILOCKER_PRODUCTION_PARITY_PREREQUISITE_MISSING';
 END IF;
END;
$preflight$;

-- Authoritative seller/buyer write gate. Preserve all staff/system and NULL-owner rules.
CREATE OR REPLACE FUNCTION app_security.enforce_verified_actor(p_actor uuid, p_any_caller boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid uuid;
BEGIN
  IF NOT app_security.identity_gate_enabled() THEN
    RETURN;
  END IF;
  v_uid := auth.uid();
  IF p_actor IS NULL THEN
    IF coalesce(p_any_caller, false) THEN
      IF app_security.idv_request_role() IS NULL OR app_security.identity_gate_system_write() THEN
        RETURN;
      END IF;
      RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF v_uid IS NOT NULL AND NOT app_security.is_active_staff_aal2('moderator') THEN
      RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  IF NOT coalesce(p_any_caller, false) AND (v_uid IS NULL OR v_uid <> p_actor) THEN
    RETURN;
  END IF;
  -- Strict: current signed DigiLocker OIDC v2 binding only. Generic/legacy verification is not sufficient.
  IF NOT app_security.has_digilocker_badge(p_actor) THEN
    RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
END;
$$;
-- Grants restated exactly as 20261117090000 left them (CREATE OR REPLACE already preserves them).
REVOKE ALL ON FUNCTION app_security.enforce_verified_actor(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.enforce_verified_actor(uuid, boolean) TO service_role;

-- Signed DigiLocker identity + acr=aadhaar requested from provider. Never trust an
-- unsigned callback, raw token payload or a query parameter as badge proof.
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

-- Final atomic activation: no unverified user can post, contact sellers or message.
-- Protected release must check Web/Edge readiness BEFORE applying this migration.
UPDATE public.app_system_settings
   SET setting_value = 'true', updated_at = pg_catalog.clock_timestamp()
 WHERE setting_key = 'identity_verification_required';
DO $gate$
BEGIN
  IF NOT app_security.identity_gate_enabled() THEN
    RAISE EXCEPTION 'IDV_DIGILOCKER_PRODUCTION_GATE_NOT_ACTIVATED';
  END IF;
END
$gate$;

COMMIT;
