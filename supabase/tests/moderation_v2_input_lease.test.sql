BEGIN;
SELECT plan(22);

-- 1. Tables exist
SELECT has_table('app_moderation_v2', 'input_admission_slots', 'input_admission_slots exists');
SELECT has_table('app_moderation_v2', 'input_claims', 'input_claims exists');
SELECT has_table('app_moderation_v2', 'input_results', 'input_results exists');

-- 2. RLS enabled on all three tables
SELECT results_eq(
  'SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ''app_moderation_v2'' AND c.relname IN (''input_admission_slots'', ''input_claims'', ''input_results'') AND c.relrowsecurity',
  ARRAY[3],
  'RLS enabled on all 3 tables'
);

-- 3. Client roles denied
SELECT table_privs_are('app_moderation_v2', 'input_admission_slots', 'anon', ARRAY[]::text[], 'anon denied on slots');
SELECT table_privs_are('app_moderation_v2', 'input_claims', 'anon', ARRAY[]::text[], 'anon denied on claims');
SELECT table_privs_are('app_moderation_v2', 'input_results', 'anon', ARRAY[]::text[], 'anon denied on results');
SELECT table_privs_are('app_moderation_v2', 'input_admission_slots', 'authenticated', ARRAY[]::text[], 'authenticated denied on slots');
SELECT table_privs_are('app_moderation_v2', 'input_claims', 'authenticated', ARRAY[]::text[], 'authenticated denied on claims');
SELECT table_privs_are('app_moderation_v2', 'input_results', 'authenticated', ARRAY[]::text[], 'authenticated denied on results');

-- 4. Public wrappers exist and deny client roles
SELECT has_function('public', 'claim_moderation_v2_input', ARRAY['text','text','integer']);
SELECT has_function('public', 'heartbeat_moderation_v2_input', ARRAY['text','uuid','uuid','text','integer']);
SELECT has_function('public', 'finalize_moderation_v2_input', ARRAY['text','uuid','uuid','text','jsonb']);

SELECT function_privs_are('public', 'claim_moderation_v2_input', ARRAY['text','text','integer'], 'anon', ARRAY[]::text[], 'anon denied public claim wrapper');
SELECT function_privs_are('public', 'heartbeat_moderation_v2_input', ARRAY['text','uuid','uuid','text','integer'], 'anon', ARRAY[]::text[], 'anon denied public heartbeat wrapper');
SELECT function_privs_are('public', 'finalize_moderation_v2_input', ARRAY['text','uuid','uuid','text','jsonb'], 'anon', ARRAY[]::text[], 'anon denied public finalize wrapper');

-- 5. Vector 1 exact parity check (Title TOO_SHORT)
SELECT is(
  app_moderation_v2.canonical_early_result_digest(
    'input_validation',
    'invalid_input',
    '44444444-0000-4000-8000-000000000099'::uuid,
    1,
    '99999999-0000-4000-8000-000000000099'::uuid,
    'fairswap_moderation_v2.0.0',
    'fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603',
    NULL,
    jsonb_build_array(jsonb_build_object('code', 'TOO_SHORT', 'field', 'title'))
  ),
  'a7c02b840c66e822b64677f041d4172694c4b5eddbc765a713877c882d82dd23',
  'Vector 1 digest matches Node.js exact 286-byte SHA-256'
);

-- 6. Vector 2 exact parity check (Title TYPE error, null digest)
SELECT is(
  app_moderation_v2.canonical_early_result_digest(
    'input_validation',
    'invalid_input',
    '44444444-0000-4000-8000-000000000099'::uuid,
    1,
    '99999999-0000-4000-8000-000000000099'::uuid,
    'fairswap_moderation_v2.0.0',
    NULL,
    NULL,
    jsonb_build_array(jsonb_build_object('code', 'TYPE', 'field', 'title'))
  ),
  'a6d660f81f9ed14bf2ab10cff426f37afd5d722a0c39bd6632f0853a601b0091',
  'Vector 2 digest matches Node.js exact 219-byte SHA-256'
);

-- 7. Slot pre-seeding verification
SELECT is(
  (SELECT count(*)::integer FROM app_moderation_v2.input_admission_slots),
  2,
  'Exactly 2 admission slots pre-seeded'
);

-- 8. Gate enforcement: fail closed when disabled
SELECT is(
  (SELECT (app_moderation_v2.claim_moderation_v2_input('test_secret', 'worker_1', 30))->>'error'),
  'V2_DISABLED',
  'Claim fails closed when V2 gate is disabled'
);

SELECT * FROM finish();
ROLLBACK;