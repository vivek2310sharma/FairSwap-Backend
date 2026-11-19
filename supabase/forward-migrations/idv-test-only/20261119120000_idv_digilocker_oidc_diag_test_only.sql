-- Migration: 20261119120000_idv_digilocker_oidc_diag_test_only.sql
-- FairSwapTest (wpppxlnbzqynvhpeuavd) ONLY. NEVER apply to Production. Not part of any release manifest.
-- DigiLocker OIDC v2 diagnostic: single-use, user-bound, short-lived state for allowlisted testers.
-- Stores ONLY sha256(state), the tester's user id and timestamps. No tokens, codes, provider ids, Aadhaar/PAN or responses.
-- Writes nothing to identity bindings, verification badges or v1 attempts.
-- Forward-only and additive. Depends on app_security (baseline) and auth.users.
-- Operator guard: run inside one transaction after
--   set local fairswap.diag_target_project_ref = 'wpppxlnbzqynvhpeuavd';
-- Rollback (Test only): DROP FUNCTION public.server_idv_dl_diag_start(uuid,text,integer), public.server_idv_dl_diag_consume(uuid,text),
--   app_security.impl_idv_dl_diag_start(uuid,text,integer), app_security.impl_idv_dl_diag_consume(uuid,text);
--   DROP TABLE app_security.idv_digilocker_diag_states;
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

DO $$
BEGIN
  IF pg_catalog.current_setting('fairswap.diag_target_project_ref', true) IS DISTINCT FROM 'wpppxlnbzqynvhpeuavd' THEN
    RAISE EXCEPTION 'Test-only migration: target must be explicitly confirmed as FairSwapTest';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS app_security.idv_digilocker_diag_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_idv_dl_diag_states_user_created ON app_security.idv_digilocker_diag_states(user_id, created_at DESC);
REVOKE ALL ON app_security.idv_digilocker_diag_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_security.idv_digilocker_diag_states TO service_role;
ALTER TABLE app_security.idv_digilocker_diag_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security.idv_digilocker_diag_states FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_diag_start(p_user_id uuid, p_state_hash text, p_ttl_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL OR p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$'
     OR p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 600 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_REQUEST');
  END IF;
  -- Keep the table tiny: rows older than one day carry no diagnostic value.
  DELETE FROM app_security.idv_digilocker_diag_states
  WHERE created_at < pg_catalog.clock_timestamp() - interval '1 day';
  IF (SELECT count(*) FROM app_security.idv_digilocker_diag_states
      WHERE user_id = p_user_id AND created_at > pg_catalog.clock_timestamp() - interval '1 hour') >= 20 THEN
    RETURN jsonb_build_object('success', false, 'error', 'RATE_LIMIT_EXCEEDED');
  END IF;
  INSERT INTO app_security.idv_digilocker_diag_states (state_hash, user_id, expires_at)
  VALUES (p_state_hash, p_user_id, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_ttl_seconds));
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'error', 'INVALID_REQUEST');
END;
$$;

CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_diag_consume(p_user_id uuid, p_state_hash text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_s RECORD;
BEGIN
  IF p_user_id IS NULL OR p_state_hash IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND');
  END IF;
  SELECT * INTO v_s FROM app_security.idv_digilocker_diag_states WHERE state_hash = p_state_hash FOR UPDATE;
  IF NOT FOUND OR v_s.user_id <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND');
  END IF;
  IF v_s.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'STATE_ALREADY_USED');
  END IF;
  UPDATE app_security.idv_digilocker_diag_states SET consumed_at = pg_catalog.clock_timestamp()
  WHERE state_hash = p_state_hash;
  IF v_s.expires_at < pg_catalog.clock_timestamp() THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_EXPIRED');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.server_idv_dl_diag_start(p_user_id uuid, p_state_hash text, p_ttl_seconds integer)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_idv_dl_diag_start(p_user_id, p_state_hash, p_ttl_seconds);
$$;
CREATE OR REPLACE FUNCTION public.server_idv_dl_diag_consume(p_user_id uuid, p_state_hash text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_idv_dl_diag_consume(p_user_id, p_state_hash);
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_dl_diag_start(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_security.impl_idv_dl_diag_consume(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_idv_dl_diag_start(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_idv_dl_diag_consume(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_diag_start(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_diag_consume(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_diag_start(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_diag_consume(uuid, text) TO service_role;

commit;
