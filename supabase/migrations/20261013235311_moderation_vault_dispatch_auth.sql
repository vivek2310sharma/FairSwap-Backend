-- FairSwap MOD-03A: keep dispatch secret only in Supabase Vault.
-- The Edge worker verifies a candidate token via this service-role-only RPC.
-- No secret bytes are returned to a caller; no anon/authenticated invocation.

CREATE OR REPLACE FUNCTION app_security.impl_verify_moderation_worker_secret(
  p_candidate text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $verify$
DECLARE
  v_expected text;
BEGIN
  -- Dispatch credentials must be randomly generated 32-byte lowercase hex.
  IF p_candidate IS NULL
     OR pg_catalog.length(p_candidate) <> 64
     OR p_candidate !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  SELECT decrypted_secret INTO v_expected
  FROM vault.decrypted_secrets
  WHERE name = 'moderation_worker_secret'
  LIMIT 1;

  RETURN v_expected IS NOT NULL
     AND pg_catalog.length(v_expected) = 64
     AND p_candidate = v_expected;
END;
$verify$;

REVOKE ALL ON FUNCTION app_security.impl_verify_moderation_worker_secret(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_verify_moderation_worker_secret(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.verify_moderation_worker_secret(
  p_candidate text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $verify$
  SELECT app_security.impl_verify_moderation_worker_secret(p_candidate);
$verify$;

REVOKE ALL ON FUNCTION public.verify_moderation_worker_secret(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_moderation_worker_secret(text)
  TO service_role;
