-- Disposable local PG15 only. Prove V2 request text binding and deterministic validation.
BEGIN;
SELECT plan(51);

-- 1. Schema and function presence
SELECT has_column('app_moderation_v2', 'requests', 'original_title', 'requests has original_title column');
SELECT has_column('app_moderation_v2', 'requests', 'original_description', 'requests has original_description column');

SELECT has_function('app_moderation_v2', 'js_trim', ARRAY['text'], 'js_trim helper exists');
SELECT has_function('app_moderation_v2', 'js_utf16_length', ARRAY['text'], 'js_utf16_length helper exists');
SELECT has_function('app_moderation_v2', 'sha256_exact_utf8', ARRAY['text'], 'sha256_exact_utf8 helper exists');
SELECT has_function('app_moderation_v2', 'validate_text_field', ARRAY['text', 'jsonb'], 'validate_text_field helper exists');
SELECT has_function('app_moderation_v2', 'validate_v2_text_fields', ARRAY['jsonb', 'jsonb'], 'validate_v2_text_fields helper exists');
SELECT has_function('app_moderation_v2', 'validate_v2_stored_text', ARRAY['text', 'text'], 'validate_v2_stored_text helper exists');

-- 2. Client role execution denial
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.validate_v2_text_fields(jsonb,jsonb)', 'EXECUTE'),
  'anonymous role cannot execute validate_v2_text_fields');
SELECT ok(NOT has_function_privilege('authenticated', 'app_moderation_v2.validate_v2_text_fields(jsonb,jsonb)', 'EXECUTE'),
  'authenticated role cannot execute validate_v2_text_fields');
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.validate_v2_stored_text(text,text)', 'EXECUTE'),
  'anonymous role cannot execute validate_v2_stored_text');
SELECT ok(NOT has_function_privilege('authenticated', 'app_moderation_v2.validate_v2_stored_text(text,text)', 'EXECUTE'),
  'authenticated role cannot execute validate_v2_stored_text');

SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.validate_v2_text_fields(jsonb,jsonb)', 'EXECUTE'),
  'service_role can execute validate_v2_text_fields');
SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.validate_v2_stored_text(text,text)', 'EXECUTE'),
  'service_role can execute validate_v2_stored_text');

SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.js_trim(text)', 'EXECUTE'),
  'anonymous role cannot execute js_trim');
SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.js_trim(text)', 'EXECUTE'),
  'service_role can execute js_trim');
SELECT ok(NOT has_function_privilege('anon', 'app_moderation_v2.js_utf16_length(text)', 'EXECUTE'),
  'anonymous role cannot execute js_utf16_length');
SELECT ok(has_function_privilege('service_role', 'app_moderation_v2.js_utf16_length(text)', 'EXECUTE'),
  'service_role can execute js_utf16_length');

-- 3. Deterministic outcome: valid lower bounds and upper bounds
SELECT is(
  app_moderation_v2.validate_v2_stored_text('abc', '1234567890'),
  jsonb_build_object(
    'status', 'valid',
    'title_sha256', app_moderation_v2.sha256_exact_utf8('abc'),
    'description_sha256', app_moderation_v2.sha256_exact_utf8('1234567890'),
    'validation_errors', '[]'::jsonb
  ),
  'valid at exact lower bounds'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text(repeat('a', 150), repeat('d', 5000)))->>'status',
  'valid',
  'valid at exact upper bounds'
);

-- 4. TYPE error before length & null digests for non-strings
SELECT is(
  app_moderation_v2.validate_v2_text_fields('null'::jsonb, '[]'::jsonb),
  jsonb_build_object(
    'status', 'invalid',
    'title_sha256', NULL,
    'description_sha256', NULL,
    'validation_errors', jsonb_build_array(
      jsonb_build_object('field', 'title', 'code', 'TYPE'),
      jsonb_build_object('field', 'description', 'code', 'TYPE')
    )
  ),
  'TYPE error before length and null digests for non-strings'
);

SELECT is(
  app_moderation_v2.validate_v2_text_fields('10'::jsonb, '"Lightly used bicycle with local pickup after inspection."'::jsonb),
  jsonb_build_object(
    'status', 'invalid',
    'title_sha256', NULL,
    'description_sha256', app_moderation_v2.sha256_exact_utf8('Lightly used bicycle with local pickup after inspection.'),
    'validation_errors', jsonb_build_array(
      jsonb_build_object('field', 'title', 'code', 'TYPE')
    )
  ),
  'numeric title yields TYPE error and null digest'
);

-- 5. Title length bounds (TOO_SHORT, TOO_LONG)
SELECT is(
  app_moderation_v2.validate_v2_stored_text('', 'Lightly used bicycle with local pickup after inspection.'),
  jsonb_build_object(
    'status', 'invalid',
    'title_sha256', app_moderation_v2.sha256_exact_utf8(''),
    'description_sha256', app_moderation_v2.sha256_exact_utf8('Lightly used bicycle with local pickup after inspection.'),
    'validation_errors', jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_SHORT'))
  ),
  'empty title is TOO_SHORT'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text('ab', 'Lightly used bicycle with local pickup after inspection.'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_SHORT')),
  'two-character title is TOO_SHORT'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text(repeat('x', 151), 'Lightly used bicycle with local pickup after inspection.'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_LONG')),
  '151-char title is TOO_LONG'
);

-- 6. Description length bounds (TOO_SHORT, TOO_LONG)
SELECT is(
  (app_moderation_v2.validate_v2_stored_text('Local bicycle for sale', '123456789'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'description', 'code', 'TOO_SHORT')),
  '9-char description is TOO_SHORT'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text('Local bicycle for sale', repeat('x', 5001)))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'description', 'code', 'TOO_LONG')),
  '5001-char description is TOO_LONG'
);

-- 7. Unicode and ECMAScript trim parity
SELECT is(
  (app_moderation_v2.validate_v2_stored_text(' ' || E'\u00A0' || 'ab' || E'\u00A0' || ' ', 'Lightly used bicycle with local pickup after inspection.'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_SHORT')),
  'NBSP trim title is TOO_SHORT'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text(E'\uFEFF' || 'ab' || E'\uFEFF', 'Lightly used bicycle with local pickup after inspection.'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_SHORT')),
  'BOM trim title is TOO_SHORT'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text(E'\u3000' || 'ab' || E'\u3000', 'Lightly used bicycle with local pickup after inspection.'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_SHORT')),
  'Ideographic space trim title is TOO_SHORT'
);

-- Zero-width space (U+200B) is NOT trimmed by ECMAScript
SELECT is(
  (app_moderation_v2.validate_v2_stored_text(E'\u200B\u200B\u200B', 'Lightly used bicycle with local pickup after inspection.'))->>'status',
  'valid',
  'zero-width space is not trimmed'
);

-- 8. UTF-16 code units parity for Astral Plane (emoji)
-- One astral emoji is 2 UTF-16 units -> TOO_SHORT (< 3)
SELECT is(
  (app_moderation_v2.validate_v2_stored_text('😀', 'Lightly used bicycle with local pickup after inspection.'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_SHORT')),
  'astral emoji title counts as 2 UTF-16 units (TOO_SHORT)'
);

-- Astral emoji + 1 ascii char = 3 UTF-16 units -> valid
SELECT is(
  (app_moderation_v2.validate_v2_stored_text('😀a', 'Lightly used bicycle with local pickup after inspection.'))->>'status',
  'valid',
  'astral emoji plus ascii is 3 UTF-16 units (valid)'
);

-- 76 emoji = 152 UTF-16 units -> TOO_LONG (> 150)
SELECT is(
  (app_moderation_v2.validate_v2_stored_text(repeat('😀', 76), 'Lightly used bicycle with local pickup after inspection.'))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'title', 'code', 'TOO_LONG')),
  '76 emoji is 152 UTF-16 units (TOO_LONG)'
);

-- 4 emoji = 8 UTF-16 units -> description TOO_SHORT (< 10)
SELECT is(
  (app_moderation_v2.validate_v2_stored_text('Local bicycle for sale', repeat('😀', 4)))->'validation_errors',
  jsonb_build_array(jsonb_build_object('field', 'description', 'code', 'TOO_SHORT')),
  '4 emoji description is 8 UTF-16 units (TOO_SHORT)'
);

-- 9. Exact byte hashes and Hindi / Hinglish validation
SELECT is(
  (app_moderation_v2.validate_v2_stored_text('बाइक ₹500', 'Local meetup and inspection ke baad payment.'))->>'status',
  'valid',
  'Hindi and currency symbols are valid'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text('Bike', 'Lightly used bicycle with local pickup after inspection.'))->>'title_sha256',
  '12ee64993172e276b5c21f7c00673ecdecf44fa0366ebf7000bf4ad64a5c0e17',
  'Bike SHA-256 matches exact bytes'
);

SELECT is(
  (app_moderation_v2.validate_v2_stored_text('bike', 'Lightly used bicycle with local pickup after inspection.'))->>'title_sha256',
  '47f897629b35eec061c4791e3e7f457593c6be17fdb5ee73fa73f324ad3fc9ec',
  'bike SHA-256 is case-sensitive'
);

-- Untrimmed leading/trailing spaces are preserved in digest
SELECT is(
  (app_moderation_v2.validate_v2_stored_text('   bike  ', 'Lightly used bicycle with local pickup after inspection.'))->>'title_sha256',
  app_moderation_v2.sha256_exact_utf8('   bike  '),
  'leading and trailing spaces are hashed in original digest'
);

-- Stable ordering: title error then description error
SELECT is(
  (app_moderation_v2.validate_v2_stored_text('  ', '  '))->'validation_errors',
  jsonb_build_array(
    jsonb_build_object('field', 'title', 'code', 'TOO_SHORT'),
    jsonb_build_object('field', 'description', 'code', 'TOO_SHORT')
  ),
  'stable title then description error ordering'
);

-- 10. Database request text binding and immutability guard
-- Create test listing
DO $fixture$
DECLARE
  v_user_id uuid := gen_random_uuid();
  v_category_id uuid;
  v_city_id uuid;
  v_listing_id uuid := gen_random_uuid();
  v_req_id uuid;
BEGIN
  -- Insert prerequisites
  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    v_user_id,
    'test_c2a@fairswap.internal',
    jsonb_build_object(
      'display_name', 'Test C2a Seller',
      'terms_accepted', 'true',
      'terms_version', '2026-09-18',
      'privacy_policy_version', '2026-09-18',
      'acceptable_use_version', '2026-09-18',
      'age_confirmed', 'true'
    ),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.policy_acceptance_records (
    user_id, terms_version, privacy_policy_version, acceptable_use_version, minimum_age_confirmed
  ) VALUES (
    v_user_id, '2026-09-18', '2026-09-18', '2026-09-18', 18
  ) ON CONFLICT DO NOTHING;

  SELECT id INTO v_category_id FROM public.categories
  WHERE is_active AND new_listing_enabled AND macro_category = 'goods'
  LIMIT 1;
  SELECT id INTO v_city_id FROM public.cities WHERE is_active LIMIT 1;

  INSERT INTO public.listings (
    id, seller_id, category_id, city_id, title, description, status, revision
  ) VALUES (
    v_listing_id, v_user_id, v_category_id, v_city_id,
    'Authoritative DB Title', 'Authoritative DB Description text for local inspection.',
    'draft', 1
  );

  -- Insert valid V2 request bound to listing
  INSERT INTO app_moderation_v2.requests (
    listing_id, listing_revision, policy_version, request_lane, phase, status,
    original_title, original_description
  ) VALUES (
    v_listing_id, 1, 'fairswap_moderation_v2.0.0', 'shadow', 'input_validation', 'pending_input',
    'Authoritative DB Title', 'Authoritative DB Description text for local inspection.'
  ) RETURNING id INTO v_req_id;

  -- Verify original text was stored correctly
  PERFORM 1 FROM app_moderation_v2.requests
  WHERE id = v_req_id AND original_title = 'Authoritative DB Title';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not stored with original text';
  END IF;

  -- Test immutability trigger: updating status/phase is allowed
  UPDATE app_moderation_v2.requests
  SET status = 'awaiting_media', phase = 'preparation'
  WHERE id = v_req_id;

  -- Test immutability trigger: tampering with original_title must fail
  BEGIN
    UPDATE app_moderation_v2.requests
    SET original_title = 'Tampered Title'
    WHERE id = v_req_id;
    RAISE EXCEPTION 'Immutability trigger failed to block original_title update';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  -- Test immutability trigger: tampering with listing_id must fail
  BEGIN
    UPDATE app_moderation_v2.requests
    SET listing_id = gen_random_uuid()
    WHERE id = v_req_id;
    RAISE EXCEPTION 'Immutability trigger failed to block listing_id update';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  -- Test immutability trigger: tampering with listing_revision must fail
  BEGIN
    UPDATE app_moderation_v2.requests
    SET listing_revision = 2
    WHERE id = v_req_id;
    RAISE EXCEPTION 'Immutability trigger failed to block listing_revision update';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  -- Test immutability trigger: tampering with generation_id must fail
  BEGIN
    UPDATE app_moderation_v2.requests
    SET generation_id = gen_random_uuid()
    WHERE id = v_req_id;
    RAISE EXCEPTION 'Immutability trigger failed to block generation_id update';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  -- Test authoritative binding: inserting mismatched title must fail
  BEGIN
    INSERT INTO app_moderation_v2.requests (
      listing_id, listing_revision, policy_version, request_lane, phase, status,
      original_title, original_description
    ) VALUES (
      v_listing_id, 1, 'fairswap_moderation_v2.0.0', 'shadow', 'input_validation', 'pending_input',
      'Forged Arbitrary Title', 'Authoritative DB Description text for local inspection.'
    );
    RAISE EXCEPTION 'Binding trigger failed to reject mismatched original_title';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  -- Test authoritative binding: inserting mismatched description must fail
  BEGIN
    INSERT INTO app_moderation_v2.requests (
      listing_id, listing_revision, policy_version, request_lane, phase, status,
      original_title, original_description
    ) VALUES (
      v_listing_id, 1, 'fairswap_moderation_v2.0.0', 'shadow', 'input_validation', 'pending_input',
      'Authoritative DB Title', 'Forged Arbitrary Description'
    );
    RAISE EXCEPTION 'Binding trigger failed to reject mismatched original_description';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  -- Test authoritative binding: inserting with stale revision must fail
  BEGIN
    INSERT INTO app_moderation_v2.requests (
      listing_id, listing_revision, policy_version, request_lane, phase, status,
      original_title, original_description
    ) VALUES (
      v_listing_id, 999, 'fairswap_moderation_v2.0.0', 'shadow', 'input_validation', 'pending_input',
      'Authoritative DB Title', 'Authoritative DB Description text for local inspection.'
    );
    RAISE EXCEPTION 'Binding trigger failed to reject stale listing_revision';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;
END;
$fixture$;

SELECT pass('request creation stores authoritative original text');
SELECT pass('request creation denies mismatched original_title');
SELECT pass('request creation denies mismatched original_description');
SELECT pass('request creation denies stale listing_revision');
SELECT pass('request immutability trigger allows lawful status and phase updates');
SELECT pass('request immutability trigger denies original_title tampering');
SELECT pass('request immutability trigger denies listing_id tampering');
SELECT pass('request immutability trigger denies listing_revision tampering');
SELECT pass('request immutability trigger denies generation_id tampering');

-- 11. Security check: anon and authenticated cannot invoke functions under SET LOCAL ROLE
SET LOCAL ROLE anon;
DO $v2_denial$
BEGIN
  BEGIN
    PERFORM app_moderation_v2.validate_v2_stored_text('title', 'description');
    RAISE EXCEPTION 'anon unexpectedly executed validate_v2_stored_text';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$v2_denial$;
RESET ROLE;
SELECT pass('anon role denied execution of validate_v2_stored_text at runtime');

SET LOCAL ROLE authenticated;
DO $v2_denial$
BEGIN
  BEGIN
    PERFORM app_moderation_v2.validate_v2_stored_text('title', 'description');
    RAISE EXCEPTION 'authenticated unexpectedly executed validate_v2_stored_text';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$v2_denial$;
RESET ROLE;
SELECT pass('authenticated role denied execution of validate_v2_stored_text at runtime');

SELECT * FROM finish();
ROLLBACK;
