-- AUTHORED / NOT RUN. Only on an explicitly approved disposable database after
-- supabase/forward-migrations/seller-profile/20261024100000_search_seller_public_listings.sql.
-- Never run these fixtures on shared FairSwapTest/Production.
-- Not registered in scripts/ci/verify-db-results.mjs requiredSuites (CI contract untouched).
BEGIN;
SET LOCAL statement_timeout = '30s';
SELECT no_plan();

SELECT has_function('public', 'search_seller_public_listings',
  ARRAY['uuid','text','text','text','integer','integer','text','integer','integer']);
SELECT has_function('app_security', 'impl_search_seller_public_listings',
  ARRAY['uuid','text','text','text','integer','integer','text','integer','integer']);

SELECT ok(NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=""'],
  'public wrapper is stable invoker with empty search_path')
FROM pg_catalog.pg_proc p
WHERE p.oid = 'public.search_seller_public_listings(uuid,text,text,text,integer,integer,text,integer,integer)'::regprocedure;

SELECT ok(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=""'],
  'implementation is stable definer with empty search_path')
FROM pg_catalog.pg_proc p
WHERE p.oid = 'app_security.impl_search_seller_public_listings(uuid,text,text,text,integer,integer,text,integer,integer)'::regprocedure;

SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
), 'no PUBLIC execute on ' || p.proname)
FROM pg_catalog.pg_proc p
WHERE p.proname IN ('search_seller_public_listings', 'impl_search_seller_public_listings');

SELECT ok(pg_catalog.has_function_privilege(role_name,
  'public.search_seller_public_listings(uuid,text,text,text,integer,integer,text,integer,integer)', 'EXECUTE'),
  role_name || ' can execute the public wrapper')
FROM (VALUES ('anon'), ('authenticated')) r(role_name);

-- Fail closed: unusable inputs return an empty page, never a broader one.
SELECT is((public.search_seller_public_listings(NULL))->>'total_count', '0', 'null seller returns nothing');
SELECT is((public.search_seller_public_listings(gen_random_uuid(), NULL, NULL, 'bogus'))->>'total_count', '0',
  'unknown condition returns nothing');
SELECT is((public.search_seller_public_listings(gen_random_uuid(), NULL, 'no-such-category'))->>'total_count', '0',
  'unknown category returns nothing');
SELECT is((public.search_seller_public_listings(gen_random_uuid(), NULL, NULL, NULL, 500, 100))->>'total_count', '0',
  'inverted price range returns nothing');
SELECT is((public.search_seller_public_listings(gen_random_uuid(), NULL, NULL, NULL, -1))->>'total_count', '0',
  'negative price returns nothing');
SELECT is((public.search_seller_public_listings(gen_random_uuid(), 'the'))->>'total_count', '0',
  'stop-word-only query returns nothing');

-- Pagination is clamped.
SELECT is((public.search_seller_public_listings(gen_random_uuid(), NULL, NULL, NULL, NULL, NULL, 'newest', 1, 1000))->>'per_page', '24',
  'per_page is clamped to 24');

-- Every fixture row returned must satisfy the public-visibility policy.
SELECT ok(NOT EXISTS (
  SELECT 1
  FROM public.listings l
  JOIN public.user_accounts ua ON ua.user_id = l.seller_id
  CROSS JOIN LATERAL jsonb_array_elements(
    (public.search_seller_public_listings(l.seller_id, NULL, NULL, NULL, NULL, NULL, 'newest', 1, 24))->'items') i
  WHERE (i->>'id')::uuid = l.id
    AND (l.status <> 'active'
      OR (l.expires_at IS NOT NULL AND l.expires_at <= pg_catalog.clock_timestamp())
      OR ua.account_status <> 'active')
), 'results contain only active, unexpired listings of active sellers');

SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.listings l
  CROSS JOIN LATERAL jsonb_array_elements(
    (public.search_seller_public_listings(l.seller_id, NULL, NULL, NULL, NULL, NULL, 'newest', 1, 24))->'items') i
  WHERE i ? 'pin_code' OR i ? 'landmark'
), 'results never expose pin_code or landmark');

SELECT * FROM finish();
ROLLBACK;