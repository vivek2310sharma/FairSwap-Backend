-- MOD-03A Vault dispatch authorization. Local disposable pgTAP only.
-- A test-only secret is created inside the rollback transaction.
BEGIN;
SELECT plan(11);

SELECT has_function('public', 'verify_moderation_worker_secret', ARRAY['text'], 'service-only public verification wrapper exists');
SELECT has_function('app_security', 'impl_verify_moderation_worker_secret', ARRAY['text'], 'private Vault comparator exists');
SELECT function_privs_are('public', 'verify_moderation_worker_secret', ARRAY['text'], 'anon', ARRAY[]::text[], 'anon cannot call verification wrapper');
SELECT function_privs_are('public', 'verify_moderation_worker_secret', ARRAY['text'], 'authenticated', ARRAY[]::text[], 'authenticated cannot call verification wrapper');
SELECT function_privs_are('public', 'verify_moderation_worker_secret', ARRAY['text'], 'service_role', ARRAY['EXECUTE'], 'worker service role may call wrapper');
SELECT function_privs_are('app_security', 'impl_verify_moderation_worker_secret', ARRAY['text'], 'anon', ARRAY[]::text[], 'anon cannot call private helper');
SELECT function_privs_are('app_security', 'impl_verify_moderation_worker_secret', ARRAY['text'], 'authenticated', ARRAY[]::text[], 'authenticated cannot call private helper');
SELECT function_privs_are('app_security', 'impl_verify_moderation_worker_secret', ARRAY['text'], 'service_role', ARRAY['EXECUTE'], 'service role can call private helper');
SELECT is(public.verify_moderation_worker_secret('invalid'), false, 'malformed token fails closed');

DO $fixture$
BEGIN
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name='moderation_worker_secret') THEN
    RAISE EXCEPTION 'pgTAP fixture requires a disposable database without production Vault values';
  END IF;
  PERFORM vault.create_secret(repeat('a', 64), 'moderation_worker_secret', 'pgTAP only, transaction rolls back');
END;
$fixture$;

SELECT is(public.verify_moderation_worker_secret(repeat('a', 64)), true, 'matching private Vault token is accepted');
SELECT is(public.verify_moderation_worker_secret(repeat('b', 64)), false, 'incorrect private Vault token is refused');
SELECT * FROM finish();
ROLLBACK;
