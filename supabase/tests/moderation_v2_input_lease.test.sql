BEGIN;
SELECT plan(33);

-- 1. Tables exist
SELECT has_table('app_moderation_v2', 'input_admission_slots', 'input_admission_slots exists');
SELECT has_table('app_moderation_v2', 'input_claims', 'input_claims exists');
SELECT has_table('app_moderation_v2', 'input_results', 'input_results exists');

-- 2. RLS enabled on all three tables
SELECT ok((SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'app_moderation_v2.input_admission_slots'::regclass), 'slots has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'app_moderation_v2.input_claims'::regclass), 'claims has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'app_moderation_v2.input_results'::regclass), 'results has RLS enabled');

-- 3. Client roles denied
SELECT ok(NOT has_table_privilege('anon', 'app_moderation_v2.input_admission_slots', 'SELECT'), 'anon denied SELECT on slots');
SELECT ok(NOT has_table_privilege('anon', 'app_moderation_v2.input_claims', 'SELECT'), 'anon denied SELECT on claims');
SELECT ok(NOT has_table_privilege('anon', 'app_moderation_v2.input_results', 'SELECT'), 'anon denied SELECT on results');
SELECT ok(NOT has_table_privilege('authenticated', 'app_moderation_v2.input_admission_slots', 'SELECT'), 'authenticated denied SELECT on slots');
SELECT ok(NOT has_table_privilege('authenticated', 'app_moderation_v2.input_claims', 'SELECT'), 'authenticated denied SELECT on claims');
SELECT ok(NOT has_table_privilege('authenticated', 'app_moderation_v2.input_results', 'SELECT'), 'authenticated denied SELECT on results');

-- 4. Routine existence & denial
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.canonical_early_result_json(text,text,uuid,integer,uuid,text,text,text,jsonb)', 'EXECUTE'), 'anon denied canonical_json');
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.canonical_early_result_digest(text,text,uuid,integer,uuid,text,text,text,jsonb)', 'EXECUTE'), 'anon denied canonical_digest');
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.claim_moderation_v2_input(text,text,integer)', 'EXECUTE'), 'anon denied claim');
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.heartbeat_moderation_v2_input(text,uuid,uuid,text,integer)', 'EXECUTE'), 'anon denied heartbeat');
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.recover_expired_input_claims(text,integer)', 'EXECUTE'), 'anon denied recover');
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.finalize_moderation_v2_input(text,uuid,uuid,text,jsonb)', 'EXECUTE'), 'anon denied finalize');

-- 5. Service role has execution rights
SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.claim_moderation_v2_input(text,text,integer)', 'EXECUTE'), 'service_role can execute claim');
SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.heartbeat_moderation_v2_input(text,uuid,uuid,text,integer)', 'EXECUTE'), 'service_role can execute heartbeat');
SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.recover_expired_input_claims(text,integer)', 'EXECUTE'), 'service_role can execute recover');
SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.finalize_moderation_v2_input(text,uuid,uuid,text,jsonb)', 'EXECUTE'), 'service_role can execute finalize');

-- 6. Slot pre-seeding verification
SELECT is(
  (SELECT count(*)::integer FROM app_moderation_v2.input_admission_slots),
  2,
  'Exactly 2 admission slots pre-seeded'
);

-- 7. Gate enforcement: fail closed when disabled
SELECT is(
  (SELECT (app_moderation_v2.claim_moderation_v2_input('test_secret', 'worker_1', 30))->>'error'),
  'V2_DISABLED',
  'Claim fails closed when V2 gate is disabled'
);

-- 8. Test Vector 1 exact parity check (Title TOO_SHORT)
SELECT is(
  app_moderation_v2.canonical_early_result_digest(
    'input_validation',
    'invalid_input',
    '44444444-0000-4000-8000-000000000099'::uuid,
    1,
    '99999999-0000-4000-8000-000000000099'::uuid,
    'fairswap_moderation_v2.0.0',
    '1fefaaaceda5a7e199e2c612ca6716d6da8065eed5a1a50979a309f27797e01f',
    NULL,
    jsonb_build_array(jsonb_build_object('code', 'TOO_SHORT', 'field', 'title'))
  ),
  'da0ccb13af761e55e295776abd0843d9c27549ccbc1bfa4fab8a8476f2b4e093',
  'Vector 1 digest matches Node.js exact 286-byte SHA-256'
);

-- 9. Test Vector 2 exact parity check (Title TYPE error, null digest)
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

-- 10. Runtime denial under SET LOCAL ROLE anon and authenticated
SET LOCAL ROLE anon;
DO $v2_anon_denial$
BEGIN
  BEGIN
    PERFORM 1 FROM app_moderation_v2.input_admission_slots;
    RAISE EXCEPTION 'anon unexpectedly accessed admission slots';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$v2_anon_denial$;
RESET ROLE;
SELECT pass('anon role denied reading admission slots at runtime');

SET LOCAL ROLE authenticated;
DO $v2_auth_denial$
BEGIN
  BEGIN
    PERFORM 1 FROM app_moderation_v2.input_claims;
    RAISE EXCEPTION 'authenticated unexpectedly accessed claims';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$v2_auth_denial$;
RESET ROLE;
SELECT pass('authenticated role denied reading claims at runtime');

-- 11. Functional fixture: Setup listing, request, claim, heartbeat, recovery and finalization
DO $fixture$
DECLARE
  v_listing_id uuid := '44444444-0000-4000-8000-000000000099'::uuid;
  v_req_id uuid;
  v_claim_res jsonb;
  v_hb_res jsonb;
  v_fin_res jsonb;
  v_replay_res jsonb;
  v_token text;
  v_attempt_id uuid;
BEGIN
  -- Direct insert into public.listings (compatible with disposable PG15 minimal harness)
  INSERT INTO public.listings (id, revision, title, description, status)
  VALUES (v_listing_id, 1, 'Valid Bicycle for Local Commute', 'Description text that is well over ten characters long.', 'pending_review')
  ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, status = 'pending_review', revision = 1;

  -- Temporarily enable V2 and approve policy for fixture test
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_v2_enabled';
  UPDATE public.app_system_settings SET setting_value = 'shadow' WHERE setting_key = 'moderation_v2_mode';
  UPDATE app_moderation_v2.policy_registry SET is_approved = true, approved_evaluator_build = repeat('a', 64)
  WHERE policy_version = 'fairswap_moderation_v2.0.0';

  -- Create V2 request
  INSERT INTO app_moderation_v2.requests (
    listing_id, listing_revision, policy_version, request_lane, phase, status,
    original_title, original_description
  ) VALUES (
    v_listing_id, 1, 'fairswap_moderation_v2.0.0', 'shadow', 'input_validation', 'pending_input',
    'Valid Bicycle for Local Commute', 'Description text that is well over ten characters long.'
  ) RETURNING id INTO v_req_id;

  -- Claim
  v_claim_res := app_moderation_v2.claim_moderation_v2_input('test_secret', 'worker_test', 30);
  IF (v_claim_res->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Claim failed: %', v_claim_res;
  END IF;

  v_token := v_claim_res->>'claim_token';
  v_attempt_id := (v_claim_res->>'attempt_id')::uuid;

  -- Heartbeat
  v_hb_res := app_moderation_v2.heartbeat_moderation_v2_input('test_secret', v_req_id, v_attempt_id, v_token, 30);
  IF (v_hb_res->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Heartbeat failed: %', v_hb_res;
  END IF;

  -- Finalize (Valid text transition)
  v_fin_res := app_moderation_v2.finalize_moderation_v2_input(
    'test_secret', v_req_id, v_attempt_id, v_token,
    jsonb_build_object(
      'contract_version', '2.0.0',
      'policy_version', 'fairswap_moderation_v2.0.0',
      'evaluator_version', 'v2.0.0',
      'request_id', v_req_id,
      'attempt_id', v_attempt_id,
      'evaluated_at', (to_jsonb(clock_timestamp()) #>> '{}'),
      'phase', 'input_validation',
      'outcome', 'valid',
      'listing_id', v_listing_id,
      'listing_revision', 1,
      'generation_id', v_claim_res->>'generation_id',
      'title_sha256', app_moderation_v2.sha256_exact_utf8('Valid Bicycle for Local Commute'),
      'description_sha256', app_moderation_v2.sha256_exact_utf8('Description text that is well over ten characters long.'),
      'validation_errors', '[]'::jsonb
    )
  );

  IF (v_fin_res->>'success')::boolean IS NOT TRUE OR v_fin_res->>'decision' <> 'valid' THEN
    RAISE EXCEPTION 'Finalize failed: %', v_fin_res;
  END IF;

  -- Replay
  v_replay_res := app_moderation_v2.finalize_moderation_v2_input(
    'test_secret', v_req_id, v_attempt_id, v_token,
    jsonb_build_object(
      'contract_version', '2.0.0',
      'policy_version', 'fairswap_moderation_v2.0.0',
      'evaluator_version', 'v2.0.0',
      'request_id', v_req_id,
      'attempt_id', v_attempt_id,
      'evaluated_at', (to_jsonb(clock_timestamp()) #>> '{}'),
      'phase', 'input_validation',
      'outcome', 'valid',
      'listing_id', v_listing_id,
      'listing_revision', 1,
      'generation_id', v_claim_res->>'generation_id',
      'title_sha256', app_moderation_v2.sha256_exact_utf8('Valid Bicycle for Local Commute'),
      'description_sha256', app_moderation_v2.sha256_exact_utf8('Description text that is well over ten characters long.'),
      'validation_errors', '[]'::jsonb
    )
  );

  IF (v_replay_res->>'idempotent_replay')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Replay failed: %', v_replay_res;
  END IF;
END;
$fixture$;

SELECT pass('functional claim, heartbeat, valid-text finalization and idempotent replay succeeded');
SELECT is((SELECT status FROM public.listings WHERE id = '44444444-0000-4000-8000-000000000099'::uuid), 'pending_review', 'listing status remains pending_review (never published)');
SELECT is((SELECT phase FROM app_moderation_v2.requests WHERE listing_id = '44444444-0000-4000-8000-000000000099'::uuid), 'preparation', 'request phase advanced to preparation');
SELECT is((SELECT status FROM app_moderation_v2.requests WHERE listing_id = '44444444-0000-4000-8000-000000000099'::uuid), 'awaiting_media', 'request status advanced to awaiting_media');
SELECT is((SELECT count(*)::integer FROM app_moderation_v2.input_admission_slots WHERE active_claim_id IS NOT NULL), 0, 'all admission slots freed after completion');

SELECT * FROM finish();
ROLLBACK;
