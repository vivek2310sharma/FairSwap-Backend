-- Disposable local PG15 only. Prove the V2 foundation is private and disabled.
BEGIN;
SELECT plan(38);

SELECT has_schema('app_moderation_v2', 'separate private V2 schema exists');
SELECT has_table('app_moderation_v2', 'policy_registry', 'policy registry exists');
SELECT has_table('app_moderation_v2', 'requests', 'disjoint V2 request table exists');

SELECT ok(NOT has_schema_privilege('anon', 'app_moderation_v2', 'USAGE'),
  'anonymous role has no V2 schema usage');
SELECT ok(NOT has_schema_privilege('authenticated', 'app_moderation_v2', 'USAGE'),
  'signed-in clients have no V2 schema usage');
SELECT ok(has_schema_privilege('service_role', 'app_moderation_v2', 'USAGE'),
  'service role alone may access private schema');

SELECT ok((SELECT relrowsecurity FROM pg_catalog.pg_class
  WHERE oid = 'app_moderation_v2.policy_registry'::regclass),
  'policy registry has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_catalog.pg_class
  WHERE oid = 'app_moderation_v2.requests'::regclass),
  'V2 requests have RLS enabled');
SELECT is((SELECT count(*)::integer FROM pg_catalog.pg_policies
  WHERE schemaname = 'app_moderation_v2'), 0,
  'no broad V2 client RLS policies');

SELECT ok(NOT has_table_privilege('anon', 'app_moderation_v2.policy_registry', 'SELECT'),
  'anonymous cannot read V2 policy registry');
SELECT ok(NOT has_table_privilege('authenticated', 'app_moderation_v2.policy_registry', 'SELECT'),
  'authenticated cannot read V2 policy registry');
SELECT ok(has_table_privilege('service_role', 'app_moderation_v2.policy_registry', 'SELECT'),
  'worker may read approved policy rows');
SELECT ok(NOT has_table_privilege('service_role', 'app_moderation_v2.policy_registry', 'UPDATE'),
  'worker cannot approve policy by table UPDATE');
SELECT ok(NOT has_table_privilege('service_role', 'app_moderation_v2.policy_registry', 'INSERT'),
  'worker cannot invent approved policy');

SELECT ok(NOT has_table_privilege('anon', 'app_moderation_v2.requests', 'SELECT'),
  'anonymous cannot read V2 queue');
SELECT ok(NOT has_table_privilege('authenticated', 'app_moderation_v2.requests', 'SELECT'),
  'authenticated cannot read V2 queue');
SELECT ok(NOT has_table_privilege('anon', 'app_moderation_v2.requests', 'INSERT'),
  'anonymous cannot enqueue V2');
SELECT ok(NOT has_table_privilege('authenticated', 'app_moderation_v2.requests', 'UPDATE'),
  'signed-in client cannot alter V2 request lifecycle');
SELECT ok(has_table_privilege('service_role', 'app_moderation_v2.requests', 'SELECT'),
  'service role has queue read permission');
SELECT ok(has_table_privilege('service_role', 'app_moderation_v2.requests', 'INSERT'),
  'service role has future queue insertion permission');

SELECT is((SELECT setting_value FROM public.app_system_settings
  WHERE setting_key = 'moderation_v2_enabled'), 'false',
  'V2 distinct kill switch is present and false');
SELECT is((SELECT setting_value FROM public.app_system_settings
  WHERE setting_key = 'moderation_v2_mode'), 'disabled',
  'V2 execution mode is disabled');
SELECT is((SELECT setting_value FROM public.app_system_settings
  WHERE setting_key = 'moderation_automation_enabled'), 'false',
  'original V1 switch is not enabled in disposable baseline');

SELECT is((SELECT count(*)::integer FROM app_moderation_v2.policy_registry), 1,
  'exactly one V2 policy is seeded');
SELECT is((SELECT policy_version FROM app_moderation_v2.policy_registry),
  'fairswap_moderation_v2.0.0', 'V2 registry pins approved policy identifier');
SELECT is((SELECT protocol_version FROM app_moderation_v2.policy_registry),
  2::smallint, 'V2 protocol is separately versioned');
SELECT is((SELECT contract_version FROM app_moderation_v2.policy_registry),
  '2.0.0', 'shared contract version is pinned');
SELECT is((SELECT provider_model FROM app_moderation_v2.policy_registry),
  'omni-moderation-2024-09-26', 'provider model is pinned');
SELECT is((SELECT seal_recipe FROM app_moderation_v2.policy_registry),
  'seal_v1', 'sealing recipe is pinned');
SELECT is((SELECT approved_evaluator_build FROM app_moderation_v2.policy_registry),
  NULL::text, 'no evaluator build has been approved');
SELECT is((SELECT is_approved FROM app_moderation_v2.policy_registry),
  false, 'policy is not approved for enforce');
SELECT is((SELECT count(*)::integer FROM app_moderation_v2.requests),
  0, 'no V2 jobs auto-created by the foundation');

SELECT ok(EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'app_moderation_v2' AND tablename = 'requests'
      AND indexname = 'uq_v2_enforce_active_listing'
  ), 'active enforce request has a unique listing guard');
SELECT ok(EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'app_moderation_v2' AND tablename = 'requests'
      AND indexname = 'idx_v2_requests_due'
  ), 'queue has an indexed due work selector');
SELECT ok(EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'uq_v2_request_generation'
      AND conrelid = 'app_moderation_v2.requests'::regclass
  ), 'generation/revision/listing uniqueness enforced');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_moderation_v2'
  ), 'foundation deliberately has no callable V2 functions');

-- Validate grants under the real roles, without exposing content or IDs.
SET LOCAL ROLE anon;
DO $v2_denial$
BEGIN
  BEGIN
    PERFORM 1 FROM app_moderation_v2.requests;
    RAISE EXCEPTION 'anon unexpectedly accessed V2 request table';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$v2_denial$;
RESET ROLE;
SELECT pass('anon role is denied by the database, not just by the UI');

SET LOCAL ROLE authenticated;
DO $v2_denial$
BEGIN
  BEGIN
    PERFORM 1 FROM app_moderation_v2.policy_registry;
    RAISE EXCEPTION 'authenticated unexpectedly accessed V2 registry';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$v2_denial$;
RESET ROLE;
SELECT pass('authenticated role cannot read private V2 policy');

SELECT * FROM finish();
ROLLBACK;
