-- Migration: 20261122100000_idv_digilocker_required_gate.sql
-- FairSwap IDV: the mandatory identity gate requires a CURRENT signed DigiLocker OIDC v2 badge.
-- Forward-only and additive. Depends on 20261117090000_idv_digilocker_direct_v1.sql (gate helper, triggers, switch) and
-- 20261119200000_idv_digilocker_oidc_v2_badge.sql (app_security.has_digilocker_badge). Neither historical file is modified.
-- Only app_security.enforce_verified_actor(uuid, boolean) is replaced: the generic/legacy predicate
-- app_security.is_identity_verified is swapped for the strict app_security.has_digilocker_badge (active account, live
-- verified projection not revoked/expired, linked non-fraud-blocked binding with evidence_method 'oidc_v2_signed_id_token').
-- Signature, volatility, SECURITY DEFINER, empty search_path, NULL-owner rules, staff/service/system-write exceptions,
-- error text IDENTITY_VERIFICATION_REQUIRED and SQLSTATE 42501 are unchanged. Triggers are untouched.
-- public.app_system_settings.identity_verification_required is NOT modified here: it stays as configured
-- (default 'false'); while it is 'false' this migration changes no runtime behaviour.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 0. Preconditions: abort (nothing applied) unless the V1 gate and the V2 signed-provenance predicate are present.
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('app_security.has_digilocker_badge(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') IS NULL
     OR pg_catalog.to_regprocedure('app_security.identity_gate_enabled()') IS NULL
     OR pg_catalog.to_regprocedure('app_security.idv_request_role()') IS NULL
     OR pg_catalog.to_regprocedure('app_security.identity_gate_system_write()') IS NULL
     OR pg_catalog.to_regprocedure('app_security.is_active_staff_aal2(public.staff_role_enum)') IS NULL
     OR pg_catalog.to_regclass('app_security.idv_digilocker_bindings') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                    WHERE attrelid = pg_catalog.to_regclass('app_security.idv_digilocker_bindings')
                      AND attname = 'evidence_method' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'IDV_DIGILOCKER_REQUIRED_PREREQUISITE_MISSING';
  END IF;
END $$;

-- 1. Gate helper. Identical to 20261117090000 except the final predicate.
-- p_any_caller = true  (INSERTs): the row owner must hold the signed DigiLocker badge whoever performs the write,
--                         including service-role or SECURITY DEFINER paths acting on a user's behalf (no bypass).
-- p_any_caller = false (UPDATEs): enforced when the caller IS the owner, so moderation, media-processing
--                         workers and system status changes keep working.
-- A NULL owner is never treated as a verified actor:
--   INSERT with NULL owner -> allowed only for a direct database session or an explicit system write; any API
--                             caller (anon, authenticated, service_role, unknown) is refused.
--   UPDATE of a NULL-owner (historical) row -> refused for an end user; staff (moderator AAL2+), service-role
--                             and database sessions keep working, so historical rows and moderation are preserved.
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

commit;
