BEGIN;
SELECT plan(34);

-- 1. Verify email_outbox table exists in public schema
SELECT has_table('public', 'email_outbox', 'Table public.email_outbox exists');

-- 2. Verify custom enums exist
SELECT has_type('public', 'email_outbox_event_type', 'Enum email_outbox_event_type exists');
SELECT has_type('public', 'email_outbox_status', 'Enum email_outbox_status exists');

-- 3. Verify RLS is enabled on email_outbox
SELECT results_eq(
  $$ SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'email_outbox' AND c.relrowsecurity = true $$,
  $$ VALUES (1) $$,
  'RLS is enabled on public.email_outbox'
);

-- 4. Verify table privileges: anon and authenticated have NO SELECT/INSERT/UPDATE/DELETE access
SELECT table_privs_are('public', 'email_outbox', 'anon', ARRAY[]::text[], 'anon has no privileges on public.email_outbox');
SELECT table_privs_are('public', 'email_outbox', 'authenticated', ARRAY[]::text[], 'authenticated has no privileges on public.email_outbox');

-- 5. Verify private app_security implementation functions exist and are SECURITY DEFINER
SELECT has_function('app_security', 'impl_claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'app_security.impl_claim_email_outbox_batch exists');
SELECT has_function('app_security', 'impl_claim_email_outbox_job_by_id', ARRAY['uuid', 'uuid', 'integer'], 'app_security.impl_claim_email_outbox_job_by_id exists');
SELECT has_function('app_security', 'impl_complete_email_outbox_job', ARRAY['uuid', 'uuid', 'text'], 'app_security.impl_complete_email_outbox_job exists');
SELECT has_function('app_security', 'impl_fail_email_outbox_job', ARRAY['uuid', 'uuid', 'text', 'integer', 'text', 'boolean', 'integer', 'integer'], 'app_security.impl_fail_email_outbox_job exists');

SELECT is_definer('app_security', 'impl_claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'app_security.impl_claim_email_outbox_batch is SECURITY DEFINER');
SELECT is_definer('app_security', 'impl_claim_email_outbox_job_by_id', ARRAY['uuid', 'uuid', 'integer'], 'app_security.impl_claim_email_outbox_job_by_id is SECURITY DEFINER');
SELECT is_definer('app_security', 'impl_complete_email_outbox_job', ARRAY['uuid', 'uuid', 'text'], 'app_security.impl_complete_email_outbox_job is SECURITY DEFINER');
SELECT is_definer('app_security', 'impl_fail_email_outbox_job', ARRAY['uuid', 'uuid', 'text', 'integer', 'text', 'boolean', 'integer', 'integer'], 'app_security.impl_fail_email_outbox_job is SECURITY DEFINER');

-- 6. Verify public RPC wrapper functions exist and are SECURITY INVOKER (NOT definer)
SELECT has_function('public', 'claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'public.claim_email_outbox_batch exists');
SELECT has_function('public', 'claim_email_outbox_job_by_id', ARRAY['uuid', 'uuid', 'integer'], 'public.claim_email_outbox_job_by_id exists');
SELECT has_function('public', 'complete_email_outbox_job', ARRAY['uuid', 'uuid', 'text'], 'public.complete_email_outbox_job exists');
SELECT has_function('public', 'fail_email_outbox_job', ARRAY['uuid', 'uuid', 'text', 'integer', 'text', 'boolean', 'integer', 'integer'], 'public.fail_email_outbox_job exists');

SELECT isnt_definer('public', 'claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'public.claim_email_outbox_batch is NOT SECURITY DEFINER (SECURITY INVOKER)');
SELECT isnt_definer('public', 'claim_email_outbox_job_by_id', ARRAY['uuid', 'uuid', 'integer'], 'public.claim_email_outbox_job_by_id is NOT SECURITY DEFINER (SECURITY INVOKER)');
SELECT isnt_definer('public', 'complete_email_outbox_job', ARRAY['uuid', 'uuid', 'text'], 'public.complete_email_outbox_job is NOT SECURITY DEFINER (SECURITY INVOKER)');
SELECT isnt_definer('public', 'fail_email_outbox_job', ARRAY['uuid', 'uuid', 'text', 'integer', 'text', 'boolean', 'integer', 'integer'], 'public.fail_email_outbox_job is NOT SECURITY DEFINER (SECURITY INVOKER)');

-- 7. Verify routine ACLs: private implementations cannot be executed by anon or authenticated
SELECT function_privs_are('app_security', 'impl_claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'anon', ARRAY[]::text[], 'anon cannot execute app_security.impl_claim_email_outbox_batch');
SELECT function_privs_are('app_security', 'impl_claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'authenticated', ARRAY[]::text[], 'authenticated cannot execute app_security.impl_claim_email_outbox_batch');
SELECT function_privs_are('app_security', 'impl_claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'service_role', ARRAY['EXECUTE']::text[], 'service_role can execute app_security.impl_claim_email_outbox_batch');

-- 8. Verify routine ACLs: public RPC wrappers cannot be executed by anon or authenticated
SELECT function_privs_are('public', 'claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'anon', ARRAY[]::text[], 'anon cannot execute public.claim_email_outbox_batch');
SELECT function_privs_are('public', 'claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'authenticated', ARRAY[]::text[], 'authenticated cannot execute public.claim_email_outbox_batch');
SELECT function_privs_are('public', 'claim_email_outbox_batch', ARRAY['integer', 'uuid', 'integer'], 'service_role', ARRAY['EXECUTE']::text[], 'service_role can execute public.claim_email_outbox_batch');

SELECT function_privs_are('public', 'claim_email_outbox_job_by_id', ARRAY['uuid', 'uuid', 'integer'], 'anon', ARRAY[]::text[], 'anon cannot execute public.claim_email_outbox_job_by_id');
SELECT function_privs_are('public', 'complete_email_outbox_job', ARRAY['uuid', 'uuid', 'text'], 'anon', ARRAY[]::text[], 'anon cannot execute public.complete_email_outbox_job');
SELECT function_privs_are('public', 'fail_email_outbox_job', ARRAY['uuid', 'uuid', 'text', 'integer', 'text', 'boolean', 'integer', 'integer'], 'anon', ARRAY[]::text[], 'anon cannot execute public.fail_email_outbox_job');

-- 9. Verify unique idempotency constraint exists
SELECT has_constraint('public', 'email_outbox', 'uq_email_outbox_transition_event_recipient', 'Unique constraint uq_email_outbox_transition_event_recipient exists');

SELECT * FROM finish();
ROLLBACK;
