-- Tests: admin_moderation_analytics_security.test.sql
-- File: supabase/forward-migrations/moderation-analytics-v1/tests/admin_moderation_analytics_security.test.sql
-- Description: Focused pgTAP regression & authorization tests for get_admin_moderation_analytics RPC.
-- Executes against an isolated disposable database after applying the 58 baseline migrations
-- plus the moderation-analytics-v1 forward migration.
-- Note: Synthetic users rely on handle_new_user() trigger for active user_accounts; no duplicate inserts.

BEGIN;
SET LOCAL statement_timeout = '30s';
SELECT no_plan();

-- 1. Interface & search_path assertions (both wrapper and implementation declared STABLE with search_path="")
SELECT has_function('public', 'get_admin_moderation_analytics', ARRAY['text'], 'public.get_admin_moderation_analytics exists');
SELECT has_function('app_security', 'get_admin_moderation_analytics', ARRAY['text'], 'app_security.get_admin_moderation_analytics exists');
SELECT ok(NOT p.prosecdef AND p.provolatile = 's' AND
  p.proconfig @> ARRAY['search_path=""'], 'public wrapper is stable invoker with empty search_path')
FROM pg_catalog.pg_proc p WHERE p.oid = 'public.get_admin_moderation_analytics(text)'::regprocedure;
SELECT ok(p.prosecdef AND p.provolatile = 's' AND
  p.proconfig @> ARRAY['search_path=""'], 'app_security implementation is stable definer with empty search_path')
FROM pg_catalog.pg_proc p WHERE p.oid = 'app_security.get_admin_moderation_analytics(text)'::regprocedure;

-- 2. Privileges
SELECT function_privs_are('public', 'get_admin_moderation_analytics', ARRAY['text'], 'authenticated', ARRAY['EXECUTE'], 'authenticated can call public wrapper');
SELECT function_privs_are('public', 'get_admin_moderation_analytics', ARRAY['text'], 'anon', ARRAY[]::text[], 'anon cannot call public wrapper');
SELECT function_privs_are('app_security', 'get_admin_moderation_analytics', ARRAY['text'], 'anon', ARRAY[]::text[], 'anon cannot call private entry');
SELECT function_privs_are('app_security', 'get_admin_moderation_analytics', ARRAY['text'], 'authenticated', ARRAY['EXECUTE'], 'authenticated has execute on private entry');

-- 3. Anonymous execution denied
SET LOCAL ROLE anon;
DO $test$
BEGIN
  BEGIN
    PERFORM public.get_admin_moderation_analytics('today');
    RAISE EXCEPTION 'ANON_RPC_UNEXPECTED_SUCCESS';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;
RESET ROLE;
SELECT pass('anon call denied with insufficient_privilege');

-- Setup synthetic staff test fixtures (disposable transaction-local IDs)
CREATE TEMP TABLE an_ids AS
SELECT
  gen_random_uuid() AS user_id,
  gen_random_uuid() AS moderator_id,
  gen_random_uuid() AS admin_id;
GRANT SELECT ON an_ids TO authenticated, anon;

-- handle_new_user() trigger automatically creates user_accounts rows
INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
SELECT u_id, 'analytics-test-' || u_id::text || '@example.invalid',
  '{"display_name":"Synthetic Analytics User","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}'::jsonb,
  '{}'::jsonb, now(), now()
FROM an_ids CROSS JOIN LATERAL (VALUES (user_id), (moderator_id), (admin_id)) ids(u_id);

INSERT INTO public.policy_acceptance_records (user_id, terms_version, privacy_policy_version, acceptable_use_version, minimum_age_confirmed)
SELECT u_id, '2026-09-18', '2026-09-18', '2026-09-18', 18
FROM an_ids CROSS JOIN LATERAL (VALUES (user_id), (moderator_id), (admin_id)) ids(u_id);

INSERT INTO public.staff_roles (user_id, role)
SELECT moderator_id, 'moderator' FROM an_ids;
INSERT INTO public.staff_roles (user_id, role)
SELECT admin_id, 'administrator' FROM an_ids;

-- 4. Regular authenticated user denied
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', user_id::text, true) FROM an_ids;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', user_id, 'role', 'authenticated', 'aal', 'aal2')::text, true) FROM an_ids;

SELECT throws_ok(
  'SELECT public.get_admin_moderation_analytics(''today'')',
  '42501',
  'Administrator authorization required',
  'regular user denied by administrator check'
);

-- 5. Moderator denied (moderator is not administrator)
SELECT set_config('request.jwt.claim.sub', moderator_id::text, true) FROM an_ids;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', moderator_id, 'role', 'authenticated', 'aal', 'aal2')::text, true) FROM an_ids;

SELECT throws_ok(
  'SELECT public.get_admin_moderation_analytics(''today'')',
  '42501',
  'Administrator authorization required',
  'moderator denied by administrator check'
);

-- Administrator with AAL1 denied (mandates AAL2)
SELECT set_config('request.jwt.claim.sub', admin_id::text, true) FROM an_ids;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true) FROM an_ids;

SELECT throws_ok(
  'SELECT public.get_admin_moderation_analytics(''today'')',
  '42501',
  'Administrator authorization required',
  'administrator with AAL1 denied (requires AAL2)'
);

-- 6. Genuinely authorized administrator at AAL2
SELECT set_config('request.jwt.claim.sub', admin_id::text, true) FROM an_ids;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text, true) FROM an_ids;
SELECT ok(app_security.is_active_staff_aal2('administrator'), 'fixture is verified administrator at AAL2');

-- 7. Boundary and Normalization Verification (using statement_timestamp() for exact alignment with STABLE function)
CREATE TEMP TABLE an_bounds AS
SELECT
  (pg_catalog.date_trunc('day', statement_timestamp() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata' AS today_start;

-- Range 'today': window_start must equal midnight IST today
SELECT is(
  (public.get_admin_moderation_analytics('today')->>'window_start')::timestamptz,
  (SELECT today_start FROM an_bounds),
  'today window_start is exact midnight IST today'
);

-- Range 'yesterday': window_start is today_start - 1 day, window_end is today_start
SELECT is(
  (public.get_admin_moderation_analytics('yesterday')->>'window_start')::timestamptz,
  (SELECT today_start - INTERVAL '1 day' FROM an_bounds),
  'yesterday window_start is today_start - 1 day'
);
SELECT is(
  (public.get_admin_moderation_analytics('yesterday')->>'window_end')::timestamptz,
  (SELECT today_start FROM an_bounds),
  'yesterday window_end is today_start'
);

-- Range '7d': exactly 7 calendar dates (today + 6 prior calendar days)
SELECT is(
  (public.get_admin_moderation_analytics('7d')->>'window_start')::timestamptz,
  (SELECT today_start - INTERVAL '6 days' FROM an_bounds),
  '7d window_start is today_start - 6 days (exactly 7 calendar dates)'
);

-- Range '30d': exactly 30 calendar dates (today + 29 prior calendar days)
SELECT is(
  (public.get_admin_moderation_analytics('30d')->>'window_start')::timestamptz,
  (SELECT today_start - INTERVAL '29 days' FROM an_bounds),
  '30d window_start is today_start - 29 days (exactly 30 calendar dates)'
);

-- Invalid range normalized to 'today'
SELECT is(
  (public.get_admin_moderation_analytics('malformed_range')->>'range'),
  'today',
  'invalid range normalized to today'
);
SELECT is(
  (public.get_admin_moderation_analytics('malformed_range')->>'window_start')::timestamptz,
  (SELECT today_start FROM an_bounds),
  'invalid range window_start matches today_start'
);

-- Truthful unavailable telemetry state & zero data accuracy
SELECT is(
  (public.get_admin_moderation_analytics('today')->'image_scans'->>'status'),
  'unavailable',
  'image_scans status is unavailable'
);
SELECT is(
  (public.get_admin_moderation_analytics('today')->'costs'->>'azure'),
  'Not connected',
  'azure cost is Not connected'
);
SELECT is(
  (public.get_admin_moderation_analytics('today')->'costs'->>'openai'),
  'Not connected',
  'openai cost is Not connected'
);
SELECT is(
  ((public.get_admin_moderation_analytics('today')->'metrics'->>'images_uploaded')::integer >= 0),
  true,
  'metrics.images_uploaded is a valid non-negative integer'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
