-- Isolated forward-release pgTAP suite for supabase/forward-migrations/profile-onboarding.
-- AUTHORED / NOT RUN locally. Executed ONLY by scripts/ci/run-profile-onboarding-tests.mjs
-- against a disposable database that has the repo migrations plus this forward folder applied.
-- Never run on shared FairSwapTest / Production. Not registered in verify-db-results.mjs.
-- Everything runs inside one transaction that is rolled back.
BEGIN;
SET LOCAL statement_timeout = '60s';
SELECT no_plan();

-- ---------------------------------------------------------------- structure
SELECT has_table('public', 'user_private_details', 'private details table exists');
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity, 'private details: RLS enabled and forced')
FROM pg_catalog.pg_class c WHERE c.oid = 'public.user_private_details'::regclass;
SELECT ok(NOT has_table_privilege('anon', 'public.user_private_details', 'SELECT'), 'anon cannot SELECT private details');
SELECT ok(NOT has_table_privilege('anon', 'public.user_private_details', 'INSERT'), 'anon cannot INSERT private details');
SELECT ok(has_table_privilege('authenticated', 'public.user_private_details', 'SELECT'), 'authenticated can SELECT (RLS owner-only)');
SELECT ok(NOT has_table_privilege('authenticated', 'public.user_private_details', 'INSERT'), 'authenticated has no INSERT');
SELECT ok(NOT has_table_privilege('authenticated', 'public.user_private_details', 'UPDATE'), 'authenticated has no UPDATE');
SELECT ok(NOT has_table_privilege('authenticated', 'public.user_private_details', 'DELETE'), 'authenticated has no DELETE');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE'), 'authenticated cannot UPDATE profiles.avatar_url');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'UPDATE'), 'authenticated cannot UPDATE profiles.avatar_path');

SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'user_private_details' AND cmd <> 'SELECT'
), 'private details has no write policies');

-- Every function created by the seven migrations: explicit EXECUTE matrix.
-- expectation columns: may anon / authenticated execute? PUBLIC must never hold EXECUTE.
-- (Supabase default privileges can grant anon/authenticated on public functions, so each
-- role is checked per function with has_function_privilege, plus PUBLIC via aclexplode.)
CREATE TEMP TABLE _fn_expect (sig text PRIMARY KEY, anon_ok boolean NOT NULL, auth_ok boolean NOT NULL) ON COMMIT DROP;
INSERT INTO _fn_expect (sig, anon_ok, auth_ok) VALUES
  -- public schema
  ('public.enforce_user_private_details_integrity()', false, false),
  ('public.enforce_profile_public_text()', false, false),
  ('public.handle_new_user()', false, false),
  ('public.admin_list_profile_text_violations(integer)', false, true),
  ('public.save_my_public_profile(text,text)', false, true),
  ('public.complete_my_profile(text,text,uuid,uuid,text)', false, true),
  ('public.save_my_profile_details(text,text,text,text,uuid,uuid,text,boolean)', false, true),
  ('public.get_my_private_details()', false, true),
  ('public.public_profile_location(uuid[])', true, true),
  ('public.service_set_profile_avatar(uuid,text,text,text)', false, false),
  ('public.service_clear_profile_avatar(uuid,text)', false, false),
  -- app_security schema
  ('app_security.normalize_public_text(text)', false, true),
  ('app_security.validate_public_text(text,text)', false, true),
  ('app_security.impl_list_profile_text_violations(integer)', false, true),
  ('app_security.impl_save_my_public_profile(text,text)', false, true),
  ('app_security.impl_complete_my_profile(text,text,uuid,uuid,text)', false, true),
  ('app_security.impl_save_my_profile_details(text,text,text,text,uuid,uuid,text,boolean)', false, true),
  ('app_security.impl_public_profile_location(uuid[])', true, true),
  ('app_security.impl_fulfill_data_export(uuid)', false, true),
  ('app_security.impl_fulfill_data_export_base(uuid)', false, false),
  ('app_security.cleanup_profile_private_data_on_deletion()', false, false),
  ('app_security.impl_set_avatar(uuid,text,text,text)', false, false),
  ('app_security.impl_clear_avatar(uuid,text)', false, false),
  ('app_security.check_profile_public_fields(uuid,text,text)', false, false),
  ('app_security.resolve_profile_location(text,uuid,uuid)', false, false);

-- Completeness: all 25 expected functions exist, and no unexpected overload of these names
-- exists in public/app_security (a superseded signature or a missing function fails here).
SELECT is((SELECT count(*)::int FROM _fn_expect WHERE pg_catalog.to_regprocedure(sig) IS NOT NULL), 25,
  'all 25 new functions exist');
SELECT is((SELECT string_agg(sig, ', ' ORDER BY sig) FROM _fn_expect WHERE pg_catalog.to_regprocedure(sig) IS NULL), NULL,
  'no expected function is missing');
SELECT is((
  SELECT count(*)::int FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'app_security')
    AND p.proname IN (SELECT split_part(split_part(sig, '(', 1), '.', 2) FROM _fn_expect)
), 25, 'no unexpected overload of the new function names (checked set is complete)');

-- Violations: PUBLIC, anon or authenticated holds EXECUTE contrary to the matrix.
SELECT is((
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig)
  FROM _fn_expect e
  WHERE pg_catalog.to_regprocedure(e.sig) IS NOT NULL
    AND (
      EXISTS (SELECT 1
              FROM pg_catalog.pg_proc p,
                   LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              WHERE p.oid = pg_catalog.to_regprocedure(e.sig)
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      OR pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(e.sig), 'EXECUTE') <> e.anon_ok
      OR pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(e.sig), 'EXECUTE') <> e.auth_ok
    )
), NULL, 'no PUBLIC/anon/authenticated EXECUTE outside the expected matrix on any new function');
SELECT ok(pg_catalog.has_function_privilege('service_role', 'app_security.impl_fulfill_data_export(uuid)', 'EXECUTE'), 'service_role keeps export impl EXECUTE (original ACL)');
SELECT ok(NOT pg_catalog.has_function_privilege('service_role', 'app_security.impl_fulfill_data_export_base(uuid)', 'EXECUTE'), 'renamed export base is not executable by service_role');

SELECT ok(p.prosecdef AND p.proconfig @> ARRAY['search_path=""'], p.proname || ' is definer with empty search_path')
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security'
  AND p.proname IN ('impl_save_my_public_profile','impl_complete_my_profile','impl_set_avatar','impl_clear_avatar','impl_public_profile_location');

SELECT ok(NOT has_function_privilege('anon', 'public.service_set_profile_avatar(uuid,text,text,text)', 'EXECUTE'), 'anon cannot call avatar set');
SELECT ok(NOT has_function_privilege('authenticated', 'public.service_set_profile_avatar(uuid,text,text,text)', 'EXECUTE'), 'authenticated cannot call avatar set');
SELECT ok(has_function_privilege('service_role', 'public.service_set_profile_avatar(uuid,text,text,text)', 'EXECUTE'), 'service_role can call avatar set');
SELECT ok(NOT has_function_privilege('authenticated', 'public.service_clear_profile_avatar(uuid,text)', 'EXECUTE'), 'authenticated cannot call avatar clear');
SELECT ok(NOT has_function_privilege('anon', 'public.save_my_public_profile(text,text)', 'EXECUTE'), 'anon cannot save profile');
SELECT ok(NOT has_function_privilege('anon', 'public.complete_my_profile(text,text,uuid,uuid,text)', 'EXECUTE'), 'anon cannot complete profile');
SELECT ok(NOT has_function_privilege('anon', 'public.get_my_private_details()', 'EXECUTE'), 'anon cannot read private details');
SELECT ok(has_function_privilege('anon', 'public.public_profile_location(uuid[])', 'EXECUTE'), 'anon can read public location projection');

-- Storage bucket
SELECT is((SELECT public FROM storage.buckets WHERE id = 'avatars'), true, 'avatars bucket is public');
SELECT is((SELECT file_size_limit FROM storage.buckets WHERE id = 'avatars'), 204800::bigint, 'avatars size limit 200KB');
SELECT is((SELECT allowed_mime_types FROM storage.buckets WHERE id = 'avatars'), ARRAY['image/webp']::text[], 'avatars accepts webp only');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND (qual ILIKE '%avatars%' OR with_check ILIKE '%avatars%')
    AND roles && ARRAY['anon','authenticated']::name[]
    AND cmd <> 'SELECT'
), 'no anon/authenticated write policy on avatars');
SELECT is((SELECT public FROM storage.buckets WHERE id = 'listing-originals'), false, 'listing-originals stays private');
SELECT is((SELECT public FROM storage.buckets WHERE id = 'listing-derivatives'), false, 'listing-derivatives stays private');

-- ---------------------------------------------------------------- validator
SELECT is(app_security.validate_public_text('Rahul Sharma', 'display_name'), NULL, 'ordinary name passes');
SELECT is(app_security.validate_public_text('Priya Majorie Iyer', 'display_name'), NULL, 'Majorie is not blocked');
SELECT is(app_security.validate_public_text('Member-ghkpqaef', 'display_name'), NULL, 'generated fallback passes');
SELECT is(app_security.validate_public_text('A', 'display_name'), 'LENGTH', 'too short');
SELECT is(app_security.validate_public_text('call 98765 43210', 'display_name'), 'PHONE_NUMBER', 'phone blocked');
SELECT is(app_security.validate_public_text('९८७६५४३२१०', 'bio'), 'PHONE_NUMBER', 'devanagari digits normalised');
SELECT is(app_security.validate_public_text('me@gmail.com', 'bio'), 'CONTACT_INFO', 'email blocked');
SELECT is(app_security.validate_public_text('rahul@okaxis', 'bio'), 'CONTACT_INFO', 'UPI id blocked');
SELECT is(app_security.validate_public_text('visit www.shop.in', 'bio'), 'LINK', 'link blocked');
SELECT is(app_security.validate_public_text('visit shop dot com', 'bio'), 'LINK', 'obfuscated link blocked');
SELECT is(app_security.validate_public_text('pay advance on gpay', 'bio'), 'PAYMENT_INSTRUCTION', 'payment instruction blocked');
SELECT is(app_security.validate_public_text('F4irSw4p', 'display_name'), 'IMPERSONATION', 'leetspeak FairSwap blocked');
SELECT is(app_security.validate_public_text('Fair​Swap', 'display_name'), 'IMPERSONATION', 'zero-width evasion blocked');
SELECT is(app_security.validate_public_text('Official Support', 'display_name'), 'IMPERSONATION', 'official support blocked');
SELECT is(app_security.validate_public_text('Major Singh', 'display_name'), 'IMPERSONATION', 'Major blocked');
SELECT is(app_security.validate_public_text('Army Officer Raj', 'display_name'), 'IMPERSONATION', 'army officer blocked');
SELECT is(app_security.validate_public_text('I love cricket and books.', 'bio'), NULL, 'normal bio passes');

-- NFKC normalisation regression (pg_catalog.normalize(text, 'NFKC') must take the form as a text literal).
-- Fullwidth / compatibility forms are written as Unicode escapes so the file stays ASCII-safe.
SELECT is(app_security.normalize_public_text(U&'\FF35\FF30\FF29'), 'upi', 'NFKC folds fullwidth UPI to upi');
SELECT is(app_security.normalize_public_text(U&'\FF46\FF41\FF49\FF52\FF53\FF57\FF41\FF50'), 'fairswap', 'NFKC folds fullwidth fairswap');
SELECT is(app_security.validate_public_text(U&'\FF26\FF41\FF49\FF52\FF33\FF57\FF41\FF50 Support', 'display_name'), 'IMPERSONATION', 'NFKC-evaded FairSwap Support blocked');
SELECT is(app_security.validate_public_text(U&'\FF19\FF18\FF17\FF16\FF15\FF14\FF13\FF12\FF11\FF10', 'bio'), 'PHONE_NUMBER', 'fullwidth-digit phone number blocked');
SELECT is(app_security.validate_public_text(U&'pay on \FF35\FF30\FF29', 'bio'), 'PAYMENT_INSTRUCTION', 'fullwidth UPI payment instruction blocked');
SELECT is(app_security.validate_public_text('Aarav Kumar Reddy', 'display_name'), NULL, 'ordinary South Indian name passes after NFKC');
SELECT is(app_security.validate_public_text('राहुल शर्मा', 'display_name'), NULL, 'ordinary Devanagari name passes after NFKC');

-- ---------------------------------------------------------------- fixtures
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
 ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'owner.a@example.test',
  '{"display_name":"Asha Verma","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}', now(), now()),
 ('00000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'other.b@example.test',
  '{"display_name":"Official Support","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}', now(), now());

SELECT is((SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1'), 'Asha Verma', 'valid metadata name kept');
SELECT matches((SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000b2'), '^Member-[a-z]{8}$', 'invalid metadata name replaced by neutral fallback');
SELECT ok((SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000b2') NOT ILIKE 'other%', 'name never derived from email');
SELECT is((SELECT count(*)::int FROM public.user_private_details WHERE user_id IN ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b2')), 2, 'signup seeds private rows');

-- Legacy-style user C: signed up before this release, so it has no private row.
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000000c3', 'authenticated', 'authenticated', 'legacy.c@example.test',
  '{"display_name":"Chandra Rao","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}', now(), now());
DELETE FROM public.user_private_details WHERE user_id = '00000000-0000-4000-8000-0000000000c3';

-- Deterministic, locally seeded postal fixtures (reserved fake PINs 999001-999002, fake state).
-- Inserted inside this rolled-back transaction; no dependency on the real postal import.
--   999001: single district (Test District A) with localities A1 and A2
--   999002: ambiguous PIN spanning Test District A (locality A2) and Test District B (locality B1)
--   Locality C1 (Test District C) is mapped to no PIN: used for PIN/locality mismatch.
INSERT INTO public.cities (id, name, state, slug) VALUES
  ('00000000-0000-4000-8000-00000000c0a1', 'Test District A', 'Test State', 'zz-test-district-a'),
  ('00000000-0000-4000-8000-00000000c0b1', 'Test District B', 'Test State', 'zz-test-district-b'),
  ('00000000-0000-4000-8000-00000000c0c1', 'Test District C', 'Test State', 'zz-test-district-c');
INSERT INTO public.localities (id, city_id, name, slug) VALUES
  ('00000000-0000-4000-8000-0000000010a1', '00000000-0000-4000-8000-00000000c0a1', 'Test Locality A1', 'zz-a1'),
  ('00000000-0000-4000-8000-0000000010a2', '00000000-0000-4000-8000-00000000c0a1', 'Test Locality A2', 'zz-a2'),
  ('00000000-0000-4000-8000-0000000010b1', '00000000-0000-4000-8000-00000000c0b1', 'Test Locality B1', 'zz-b1'),
  ('00000000-0000-4000-8000-0000000010c1', '00000000-0000-4000-8000-00000000c0c1', 'Test Locality C1', 'zz-c1');
-- source_record_key is NOT NULL with UNIQUE (source, source_record_key). The BEFORE INSERT
-- trigger trg_india_postal_data_source_record_key recomputes it as md5 of the canonical
-- metadata, but a value is still supplied explicitly so the insert is valid on its own; the
-- values are unique per row and the assertions below prove the trigger-canonical key is
-- a unique 32-char md5 for every fixture row.
INSERT INTO public.india_postal_data (pincode, office_name, district, state, source, source_record_key) VALUES
  ('999001', 'Test PO A1', 'Test District A', 'Test State', 'pgtap_fixture', 'pgtap-fixture-999001-test-po-a1'),
  ('999002', 'Test PO A2', 'Test District A', 'Test State', 'pgtap_fixture', 'pgtap-fixture-999002-test-po-a2'),
  ('999002', 'Test PO B1', 'Test District B', 'Test State', 'pgtap_fixture', 'pgtap-fixture-999002-test-po-b1');
SELECT is((SELECT count(*)::int FROM public.india_postal_data WHERE source = 'pgtap_fixture'), 3, 'three postal fixture rows seeded');
SELECT is((SELECT count(DISTINCT source_record_key)::int FROM public.india_postal_data WHERE source = 'pgtap_fixture' AND source_record_key ~ '^[0-9a-f]{32}$'), 3, 'trigger-canonical source_record_key is a unique md5 for every fixture row');
INSERT INTO public.postal_pincode_localities (pincode, locality_id, office_name, source) VALUES
  ('999001', '00000000-0000-4000-8000-0000000010a1', 'Test PO A1', 'pgtap_fixture'),
  ('999001', '00000000-0000-4000-8000-0000000010a2', 'Test PO A1', 'pgtap_fixture'),
  ('999002', '00000000-0000-4000-8000-0000000010a2', 'Test PO A2', 'pgtap_fixture'),
  ('999002', '00000000-0000-4000-8000-0000000010b1', 'Test PO B1', 'pgtap_fixture');
SELECT is((public.lookup_pincode('999001'))->>'success', 'true', 'fixture PIN 999001 resolves via the real lookup_pincode');
SELECT is(jsonb_array_length((public.lookup_pincode('999002'))->'districts'), 2, 'fixture PIN 999002 is multi-district');

-- ---------------------------------------------------------------- RLS as users
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

SELECT is((SELECT count(*)::int FROM public.user_private_details), 1, 'owner sees only own private row');
SELECT is((public.get_my_private_details())->>'exists', 'true', 'owner get_my_private_details exists');
SELECT is((public.get_my_private_details())->>'onboarding_completed', 'false', 'new user not onboarded');
SELECT throws_ok($$INSERT INTO public.user_private_details (user_id) VALUES ('00000000-0000-4000-8000-0000000000a1')$$, '42501', NULL, 'owner cannot INSERT directly');
SELECT throws_ok($$UPDATE public.user_private_details SET full_name = 'x'$$, '42501', NULL, 'owner cannot UPDATE directly');
SELECT throws_ok($$UPDATE public.profiles SET avatar_url = 'https://evil.example/x.png' WHERE id = '00000000-0000-4000-8000-0000000000a1'$$, '42501', NULL, 'owner cannot set avatar_url directly');
SELECT throws_ok($$SELECT public.service_set_profile_avatar('00000000-0000-4000-8000-0000000000a1', NULL, 'x', 'y')$$, '42501', NULL, 'owner cannot call service avatar RPC');

SELECT is((public.save_my_public_profile('Asha V', 'Hello there'))->>'success', 'true', 'save public profile ok');
SELECT is((public.save_my_public_profile('Support Team', NULL))->>'error', 'INVALID_DISPLAY_NAME', 'impersonation rejected by RPC');
SELECT is((public.save_my_public_profile('Asha V', 'call 9876543210'))->>'error', 'INVALID_BIO', 'phone in bio rejected by RPC');
SELECT throws_ok($$UPDATE public.profiles SET bio = 'mail me a@b.co' WHERE id = '00000000-0000-4000-8000-0000000000a1'$$, '22023', NULL, 'direct profile update still validated by trigger');

SELECT is((public.complete_my_profile(NULL, '12345', NULL, NULL, 'en'))->>'error', 'INVALID_PINCODE', 'bad pin rejected');
SELECT is((public.complete_my_profile(NULL, '110003', NULL, NULL, 'en'))->>'error', 'LOCALITY_REQUIRED', 'locality required');
SELECT is((public.complete_my_profile(NULL, '110003', gen_random_uuid(), NULL, 'hi'))->>'error', 'INVALID_LANGUAGE', 'hindi not accepted yet');
SELECT is((public.complete_my_profile(NULL, '110003', gen_random_uuid(), NULL, 'en'))->>'error' IN ('PIN_LOCALITY_MISMATCH','PINCODE_NOT_FOUND','DISTRICT_REQUIRED','PINCODE_ADMIN_DATA_UNAVAILABLE','CONFLICTING_POSTAL_STATES'), true, 'random locality never completes onboarding');
SELECT is((public.get_my_private_details())->>'onboarding_completed', 'false', 'failed completion leaves onboarding incomplete');

-- Other user cannot read A's data and public projection never leaks the PIN.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.user_private_details WHERE user_id = '00000000-0000-4000-8000-0000000000a1'), 0, 'other user cannot read A private row');
SELECT is((public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[]))::text, '[]', 'not-onboarded user has no public location');

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok($$SELECT count(*) FROM public.user_private_details$$, '42501', NULL, 'anon denied private table');
SELECT throws_ok($$SELECT public.get_my_private_details()$$, '42501', NULL, 'anon denied private RPC');
SELECT ok(public.public_profile_location(ARRAY[]::uuid[]) = '[]'::jsonb, 'anon location projection callable');

RESET ROLE;

-- ---------------------------------------------------------------- avatar RPCs (service role)
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT is((public.service_set_profile_avatar('00000000-0000-4000-8000-0000000000a1', NULL, '00000000-0000-4000-8000-0000000000b2/abcdef12.webp', 'https://x.test/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000000000b2/abcdef12.webp'))->>'error', 'INVALID_AVATAR_PATH', 'path must belong to target user');
SELECT is((public.service_set_profile_avatar('00000000-0000-4000-8000-0000000000a1', NULL, '00000000-0000-4000-8000-0000000000a1/abcdef12.webp', 'https://evil.test/a.png'))->>'error', 'INVALID_AVATAR_URL', 'url must end with the avatar path');
SELECT is((public.service_set_profile_avatar('00000000-0000-4000-8000-0000000000a1', NULL, '00000000-0000-4000-8000-0000000000a1/abcdef12.webp', 'https://x.test/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000000000a1/abcdef12.webp'))->>'error', 'AVATAR_OBJECT_MISSING', 'object must exist in storage');
RESET ROLE;

INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('avatars', '00000000-0000-4000-8000-0000000000a1/abcdef12.webp', NULL);
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT is((public.service_set_profile_avatar('00000000-0000-4000-8000-0000000000a1', NULL, '00000000-0000-4000-8000-0000000000a1/abcdef12.webp', 'https://x.test/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000000000a1/abcdef12.webp'))->>'success', 'true', 'avatar set when path, url and object valid');
SELECT is((public.service_set_profile_avatar('00000000-0000-4000-8000-0000000000a1', NULL, '00000000-0000-4000-8000-0000000000a1/abcdef12.webp', 'https://x.test/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000000000a1/abcdef12.webp'))->>'error', 'AVATAR_CONFLICT', 'stale old_path yields conflict (CAS)');
SELECT ok((SELECT r->>'success' = 'true' AND r->>'previous_path' = '00000000-0000-4000-8000-0000000000a1/abcdef12.webp' FROM (SELECT public.service_clear_profile_avatar('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1/abcdef12.webp') AS r) s), 'avatar cleared with matching old path and previous_path returned for immediate deletion');
RESET ROLE;

-- ---------------------------------------------------------------- atomic save / legacy-safe save
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', 'Asha Full Name', '110003', gen_random_uuid(), NULL, 'en'))->>'success', 'false', 'invalid location rejects the whole save');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1'), 'Asha V', 'rejected save wrote no public change');
SELECT is((public.get_my_private_details())->>'full_name', NULL::text, 'rejected save wrote no private change');
SELECT is((public.save_my_profile_details('Support Team', NULL))->>'error', 'INVALID_DISPLAY_NAME', 'atomic save: impersonation rejected');
SELECT is((public.save_my_profile_details('Asha Verma', 'x', NULL, NULL, NULL, NULL, 'hi'))->>'error', 'INVALID_LANGUAGE', 'atomic save: hindi not accepted yet');
SELECT is((public.save_my_profile_details('Asha Verma', NULL, NULL, '110003', NULL, NULL, 'en'))->>'error', 'LOCALITY_REQUIRED', 'PIN without locality rejected');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader'))->>'success', 'true', 'public-only save works without a PIN (legacy users)');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader'))->>'onboarding_completed', 'false', 'public-only save does not complete onboarding');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1'), 'Asha Verma', 'public-only save applied');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', 'Asha Full'))->>'success', 'true', 'full-name-only private save works');
SELECT is((public.get_my_private_details())->>'full_name', 'Asha Full', 'full name stored');
SELECT is((public.get_my_private_details())->>'onboarding_completed', 'false', 'full-name-only save does not complete onboarding');
SELECT ok(NOT has_function_privilege('anon', 'public.save_my_profile_details(text,text,text,text,uuid,uuid,text,boolean)', 'EXECUTE'), 'anon cannot call atomic save');
SELECT hasnt_function('public', 'save_my_profile_details', ARRAY['text','text','text','text','uuid','uuid','text'], 'superseded 7-arg overload does not exist');
SELECT ok(has_function_privilege('authenticated', 'public.save_my_profile_details(text,text,text,text,uuid,uuid,text,boolean)', 'EXECUTE'), 'authenticated can call atomic save');
RESET ROLE;

-- Legacy profile values (invalid under today's rules) must not block unrelated updates.
ALTER TABLE public.profiles DISABLE TRIGGER trg_profiles_public_text;
UPDATE public.profiles SET display_name = 'Major Singh', bio = 'call 9876543210' WHERE id = '00000000-0000-4000-8000-0000000000a1';
ALTER TABLE public.profiles ENABLE TRIGGER trg_profiles_public_text;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is((public.save_my_profile_details('Major Singh', 'call 9876543210', 'Asha Full'))->>'success', 'true', 'unchanged legacy name/bio do not block a save');
SELECT is((public.save_my_public_profile('Major Singh', 'call 9876543210'))->>'success', 'true', 'legacy-safe public save');
SELECT is((public.save_my_profile_details('Major Singh', 'Now a clean bio'))->>'success', 'true', 'changing only the bio works with a legacy name');
SELECT is((public.save_my_profile_details('Official Admin', 'Now a clean bio'))->>'error', 'INVALID_DISPLAY_NAME', 'changed name is still validated');
SELECT is((public.save_my_profile_details('Major Singh', 'mail me a@b.co'))->>'error', 'INVALID_BIO', 'changed bio is still validated');
RESET ROLE;

-- ---------------------------------------------------------------- FORCE RLS / owner assumptions
SELECT ok(r.rolbypassrls OR r.rolsuper, 'definer owner bypasses FORCE RLS: ' || p.proname)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
WHERE p.pronamespace = 'app_security'::regnamespace
  AND p.proname IN ('impl_complete_my_profile', 'impl_save_my_profile_details', 'impl_set_avatar',
                    'impl_clear_avatar', 'impl_public_profile_location', 'impl_fulfill_data_export');
-- ---------------------------------------------------------------- no cleanup queue / worker
-- Avatar objects are deleted immediately by the Web route; no queue or consumer RPC may exist.
SELECT hasnt_table('public', 'avatar_cleanup_queue', 'avatar cleanup queue table does not exist');
SELECT hasnt_function('public', 'service_claim_avatar_cleanup', 'claim RPC does not exist');
SELECT hasnt_function('public', 'service_complete_avatar_cleanup', 'complete RPC does not exist');
SELECT hasnt_function('public', 'service_fail_avatar_cleanup', 'fail RPC does not exist');
SELECT hasnt_function('public', 'enqueue_avatar_on_profile_delete', 'profile-delete enqueue trigger function does not exist');

-- ---------------------------------------------------------------- seeded-fixture flows
-- Atomic save: a rejected location writes NOTHING (neither public nor private).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is((public.save_my_profile_details('Atomic Probe', 'probe bio', 'Probe Full', '999001', '00000000-0000-4000-8000-0000000010c1', NULL, 'en'))->>'error', 'PIN_LOCALITY_MISMATCH', 'locality of another PIN rejects the whole save');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1'), 'Major Singh', 'atomic: failed save left public name untouched');
SELECT is((public.get_my_private_details())->>'full_name', 'Asha Full', 'atomic: failed save left private name untouched');
SELECT is((public.get_my_private_details())->>'pin_code', NULL, 'atomic: failed save stored no PIN');

-- Multi-district PIN: must pick a district explicitly, and it must match the locality.
SELECT is((public.complete_my_profile(NULL, '999002', '00000000-0000-4000-8000-0000000010a2', NULL, 'en'))->>'error', 'DISTRICT_REQUIRED', 'ambiguous PIN requires an explicit district');
SELECT is((public.complete_my_profile(NULL, '999002', '00000000-0000-4000-8000-0000000010a2', '00000000-0000-4000-8000-00000000c0b1', 'en'))->>'error', 'DISTRICT_MISMATCH', 'district not owning the locality is rejected');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', NULL, '999002', '00000000-0000-4000-8000-0000000010a2', NULL, 'en'))->>'error', 'DISTRICT_REQUIRED', 'atomic save also requires a district for ambiguous PIN');
SELECT is((public.complete_my_profile(NULL, '999001', '00000000-0000-4000-8000-0000000010a1', '00000000-0000-4000-8000-00000000c0b1', 'en'))->>'error', 'DISTRICT_MISMATCH', 'single-district PIN rejects a foreign district');
SELECT is((public.complete_my_profile(NULL, '999002', '00000000-0000-4000-8000-0000000010c1', '00000000-0000-4000-8000-00000000c0c1', 'en'))->>'error', 'PIN_LOCALITY_MISMATCH', 'locality not mapped to the PIN is rejected');
SELECT is((public.get_my_private_details())->>'onboarding_completed', 'false', 'rejected completions never mark onboarding complete');

-- Positive completion through the atomic save (ambiguous PIN with explicit district).
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', 'Asha Full', '999002', '00000000-0000-4000-8000-0000000010a2', '00000000-0000-4000-8000-00000000c0a1', 'en'))->>'success', 'true', 'ambiguous PIN + explicit matching district completes');
SELECT is((public.get_my_private_details())->>'onboarding_completed', 'true', 'onboarding completed after valid PIN/locality/district');
SELECT is((public.get_my_private_details())->>'locality', 'Test Locality A2', 'locality resolved from IDs');
SELECT is((public.get_my_private_details())->>'district', 'Test District A', 'district resolved from IDs');
SELECT is((public.get_my_private_details())->>'state', 'Test State', 'state derived server-side');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1'), 'Asha Verma', 'atomic success wrote the public name');
-- Single-district PIN, plain complete_my_profile; the result never carries the PIN.
SELECT is((public.complete_my_profile('Asha Full', '999001', '00000000-0000-4000-8000-0000000010a1', NULL, 'en'))->>'success', 'true', 'single-district PIN completes without a district id');
SELECT ok(NOT ((public.complete_my_profile('Asha Full', '999001', '00000000-0000-4000-8000-0000000010a1', NULL, 'en')) ? 'pin_code'), 'completion result does not echo the PIN');
SELECT is((public.get_my_private_details())->>'pin_code', '999001', 'owner can read own PIN');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', NULL, '999001', '00000000-0000-4000-8000-0000000010a1', '00000000-0000-4000-8000-00000000c0a1', 'en'))->>'district', 'Test District A', 'single-district PIN accepts the matching district id');

-- Full name: clear without a PIN, leave unchanged when omitted, reject contradictory input.
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', NULL, NULL, NULL, NULL, 'en', true))->>'success', 'true', 'clearing full name needs no PIN');
SELECT is((public.get_my_private_details())->>'full_name', NULL::text, 'full name cleared');
SELECT is((public.get_my_private_details())->>'pin_code', '999001', 'clearing the name keeps the saved location');
SELECT is((public.get_my_private_details())->>'onboarding_completed', 'true', 'clearing the name keeps onboarding complete');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', 'Asha Full'))->>'success', 'true', 'name can be set again without a PIN');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader'))->>'success', 'true', 'omitting the name is a no-op for it');
SELECT is((public.get_my_private_details())->>'full_name', 'Asha Full', 'omitted full name left unchanged (not cleared)');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', 'Contradiction', NULL, NULL, NULL, 'en', true))->>'error', 'INVALID_FULL_NAME', 'name + clear flag together is rejected');
SELECT is((public.get_my_private_details())->>'full_name', 'Asha Full', 'rejected contradiction wrote nothing');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', NULL, '999001', '00000000-0000-4000-8000-0000000010a2', NULL, 'en', true))->>'success', 'true', 'location change + name clear in one call');
SELECT is((public.get_my_private_details())->>'locality', 'Test Locality A2', 'location updated in the same call');
SELECT is((public.get_my_private_details())->>'full_name', NULL::text, 'name cleared in the same call');
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader', 'Asha Full'))->>'success', 'true', 'restore name for the later export check');
RESET ROLE;

-- Legacy user C (no private row): public-only editing works and creates no private row.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c3","role":"authenticated"}', true);
SELECT is((public.get_my_private_details())->>'exists', 'false', 'legacy user has no private row');
SELECT is((public.save_my_profile_details('Chandra Rao', 'New bio'))->>'success', 'true', 'legacy user edits public fields without a PIN');
SELECT is((public.save_my_profile_details('Chandra Rao', 'New bio', NULL, NULL, NULL, NULL, 'en', true))->>'success', 'true', 'clear flag on a user with no private row succeeds');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.user_private_details WHERE user_id = '00000000-0000-4000-8000-0000000000c3'), 0, 'public-only / clear-only saves create no private row');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c3","role":"authenticated"}', true);
SELECT is((public.save_my_profile_details('Chandra Rao', 'New bio', 'Chandra Full'))->>'success', 'true', 'legacy user can add a private name without a PIN');
SELECT is((public.get_my_private_details())->>'onboarding_completed', 'false', 'name-only edit does not complete onboarding');
RESET ROLE;

-- Non-owner denial: B's identity is always B, never A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
SELECT is((public.save_my_profile_details('Bhavna Rao', 'B bio', 'B Full', '999001', '00000000-0000-4000-8000-0000000010a1', NULL, 'en'))->>'success', 'true', 'B completes its own profile');
SELECT is((public.get_my_private_details())->>'full_name', 'B Full', 'B reads only its own private details');
WITH u AS (UPDATE public.profiles SET bio = 'hijack' WHERE id = '00000000-0000-4000-8000-0000000000a1' RETURNING 1) SELECT is((SELECT count(*)::int FROM u), 0, 'B cannot update A public profile (RLS)');
SELECT is((SELECT count(*)::int FROM public.user_private_details WHERE user_id <> '00000000-0000-4000-8000-0000000000b2'), 0, 'B sees no other private rows');
RESET ROLE;
SELECT is((SELECT full_name FROM public.user_private_details WHERE user_id = '00000000-0000-4000-8000-0000000000a1'), 'Asha Full', 'A private details unaffected by B calls');
SELECT is((SELECT bio FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1'), 'Reader', 'A bio unaffected by B calls');

-- Public locality projection: locality + district only; active + onboarded only; never PIN/IDs.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT is(jsonb_array_length(public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[])), 1, 'onboarded active user is projected');
SELECT is((public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[]))->0->>'locality', 'Test Locality A2', 'projection exposes locality name');
SELECT is((public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[]))->0->>'district', 'Test District A', 'projection exposes district name');
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys((public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[]))->0) k), ARRAY['district','locality','user_id'], 'projection has exactly user_id/locality/district');
SELECT ok(position('999001' in (public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b2']::uuid[]))::text) = 0
  AND position('999002' in (public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b2']::uuid[]))::text) = 0, 'projection never contains a PIN');
SELECT is(jsonb_array_length(public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000c3']::uuid[])), 0, 'not-onboarded user is not projected');
RESET ROLE;
UPDATE public.user_accounts SET account_status = 'suspended' WHERE user_id = '00000000-0000-4000-8000-0000000000a1';
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT is(jsonb_array_length(public.public_profile_location(ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[])), 0, 'suspended user is not projected');
RESET ROLE;

-- Suspended account: owner save and the service avatar RPC both refuse; owner reads stay allowed.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is((public.save_my_profile_details('Asha Verma', 'Reader'))->>'error', 'ACCOUNT_RESTRICTED', 'suspended user cannot save the profile');
SELECT is((public.get_my_private_details())->>'exists', 'true', 'suspended owner can still read own private details (privacy rights)');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('avatars', '00000000-0000-4000-8000-0000000000a1/0123abcd.webp', NULL);
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT is((public.service_set_profile_avatar('00000000-0000-4000-8000-0000000000a1', NULL, '00000000-0000-4000-8000-0000000000a1/0123abcd.webp', 'https://x.test/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000000000a1/0123abcd.webp'))->>'error', 'ACCOUNT_RESTRICTED', 'avatar RPC refuses a suspended account');
RESET ROLE;
UPDATE public.user_accounts SET account_status = 'active' WHERE user_id = '00000000-0000-4000-8000-0000000000a1';

-- ---------------------------------------------------------------- export integration
-- The request is created as the owner (authenticated JWT for user A), under the real trigger and RLS.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
INSERT INTO public.privacy_requests (id, user_id, request_type)
VALUES ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-0000000000a1', 'export_data');
SELECT is((public.admin_fulfill_data_export('00000000-0000-4000-8000-00000000e001'))->'private_details'->>'full_name', 'Asha Full', 'export includes private details for the owner');
SELECT ok((public.admin_fulfill_data_export('00000000-0000-4000-8000-00000000e001')) ? 'policy_acceptances', 'export keeps existing sections');
-- Authorization is still enforced by the (renamed, unchanged) base: a non-owner non-admin is refused.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.admin_fulfill_data_export('00000000-0000-4000-8000-00000000e001')$$, NULL, 'Forbidden: not authorized to export this data', 'non-owner non-admin cannot export another user''s data');
SELECT throws_ok($$SELECT app_security.impl_fulfill_data_export_base('00000000-0000-4000-8000-00000000e001')$$, '42501', NULL, 'authenticated cannot call the renamed base directly');
RESET ROLE;

SELECT is(app_security.validate_public_text('Deleted User', 'display_name'), NULL, 'deletion anonymisation name passes the validator');

-- ---------------------------------------------------------------- deletion cleanup
-- Account deletion removes the private row and stops advertising the avatar on the profile.
-- It does NOT erase the Storage object (deferred), so only the profile columns are asserted.
UPDATE public.profiles
SET avatar_path = '00000000-0000-4000-8000-0000000000a1/abcdef12.webp',
    avatar_url = 'https://x.test/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000000000a1/abcdef12.webp'
WHERE id = '00000000-0000-4000-8000-0000000000a1';
UPDATE public.user_accounts SET account_status = 'deletion_pending' WHERE user_id = '00000000-0000-4000-8000-0000000000a1';
SELECT is((SELECT count(*)::int FROM public.user_private_details WHERE user_id = '00000000-0000-4000-8000-0000000000a1'), 0, 'private details removed on deletion');
SELECT ok((SELECT avatar_path IS NULL AND avatar_url IS NULL FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1'), 'avatar_path/avatar_url cleared on deletion');

SELECT * FROM finish();
ROLLBACK;
