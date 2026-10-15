-- Issue 133: disposable effective authenticated-role SQL authorization checks.
-- This is isolated PG contract evidence, not a live hosted authorization probe.
-- Never run fixture writes on FairSwapProd or hosted FairSwapTest.
BEGIN;
SET LOCAL statement_timeout = '45s';
SELECT no_plan();

SELECT has_function('app_security','is_new_listing_category_eligible',ARRAY['uuid']);
SELECT ok(p.provolatile='s' AND NOT p.prosecdef AND p.proisstrict
  AND p.proconfig @> ARRAY['search_path=""']::text[],
  'category-eligibility helper is stable, strict, invoker and empty-search-path')
FROM pg_catalog.pg_proc AS p
WHERE p.oid='app_security.is_new_listing_category_eligible(uuid)'::regprocedure;
SELECT ok(pg_catalog.has_function_privilege('authenticated',
  'app_security.is_new_listing_category_eligible(uuid)','EXECUTE'),
  'ordinary authenticated role can execute the invoker-only helper');
SELECT ok(NOT pg_catalog.has_function_privilege('anon',
  'app_security.is_new_listing_category_eligible(uuid)','EXECUTE'),
  'anon cannot directly execute private helper');
SELECT ok(NOT pg_catalog.has_function_privilege('service_role',
  'app_security.is_new_listing_category_eligible(uuid)','EXECUTE'),
  'no new service-role helper execution privilege');
SELECT ok(p.polcmd='a' AND p.polpermissive AND p.polroles::text='{0}'
  AND pg_catalog.strpos(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,true),
    'app_security.is_new_listing_category_eligible(category_id)')>0,
  'original permissive PUBLIC INSERT policy now also checks category eligibility')
FROM pg_catalog.pg_policy AS p
WHERE p.polrelid='public.listings'::regclass AND p.polname='listings_insert_policy';

CREATE TEMP TABLE i133_ids AS SELECT
  pg_catalog.gen_random_uuid() AS owner_id,
  pg_catalog.gen_random_uuid() AS other_id,
  pg_catalog.gen_random_uuid() AS city_id,
  pg_catalog.gen_random_uuid() AS disabled_category_id,
  pg_catalog.gen_random_uuid() AS inactive_category_id,
  pg_catalog.gen_random_uuid() AS unknown_category_id,
  pg_catalog.gen_random_uuid() AS legacy_listing_id;
GRANT SELECT ON i133_ids TO authenticated, anon;

INSERT INTO auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
SELECT actor_id,'i133-'||actor_id::text||'@example.invalid',
  '{"display_name":"Issue 133 synthetic actor","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}'::jsonb,
  '{}'::jsonb,now(),now()
FROM i133_ids CROSS JOIN LATERAL (VALUES(owner_id),(other_id)) AS users(actor_id);
INSERT INTO public.policy_acceptance_records
  (user_id,terms_version,privacy_policy_version,acceptable_use_version,minimum_age_confirmed)
SELECT actor_id,'2026-09-18','2026-09-18','2026-09-18',18
FROM i133_ids CROSS JOIN LATERAL (VALUES(owner_id),(other_id)) AS users(actor_id);
INSERT INTO public.cities(id,name,state,slug)
SELECT city_id,'Issue 133 synthetic city','Synthetic state','i133-'||city_id::text
FROM i133_ids;
INSERT INTO public.categories(id,name,slug,is_active,macro_category,new_listing_enabled)
SELECT disabled_category_id,'Issue 133 disabled Goods','i133-disabled-'||disabled_category_id::text,
  true,'goods',false FROM i133_ids;
INSERT INTO public.categories(id,name,slug,is_active,macro_category,new_listing_enabled)
SELECT inactive_category_id,'Issue 133 inactive Goods','i133-inactive-'||inactive_category_id::text,
  false,'goods',true FROM i133_ids;
-- Elevated fixture setup models an OLD saved draft, not a new seller INSERT.
INSERT INTO public.listings(id,seller_id,category_id,city_id,title,category_attributes)
SELECT legacy_listing_id,owner_id,
  (SELECT id FROM public.categories WHERE slug='bicycles-sports'),
  city_id,'Issue 133 old saved bicycle draft','{"type":"road"}'::jsonb
FROM i133_ids;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',owner_id::text,true) FROM i133_ids;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub',owner_id,'role','authenticated','aal','aal1')::text,true)
FROM i133_ids;
SELECT is(auth.uid(),(SELECT owner_id FROM i133_ids),
  'caller is ordinary authenticated owner, not an elevated role');
SELECT ok(app_security.is_new_listing_category_eligible(
  (SELECT id FROM public.categories WHERE slug='electronics')),
  'enabled Goods category remains eligible');
SELECT ok(NOT app_security.is_new_listing_category_eligible(
  (SELECT id FROM public.categories WHERE slug='bicycles-sports')),
  'retired mixed bicycle category cannot be newly assigned');
SELECT ok(NOT app_security.is_new_listing_category_eligible(disabled_category_id),
  'disabled Goods category is not eligible') FROM i133_ids;
SELECT ok(NOT app_security.is_new_listing_category_eligible(inactive_category_id),
  'inactive Goods category is not eligible') FROM i133_ids;
SELECT ok(NOT app_security.is_new_listing_category_eligible(unknown_category_id),
  'nonexistent category is not eligible') FROM i133_ids;
SELECT ok(NOT EXISTS(
  SELECT 1 FROM public.categories AS c
  WHERE c.is_active AND c.new_listing_enabled AND c.macro_category IN ('vehicles','property')
    AND NOT app_security.is_new_listing_category_eligible(c.id)),
  'all installed Test Vehicle/Property enabled draft metadata remains RLS-eligible');
SELECT ok(app_security.is_new_listing_category_eligible(c.id),
  'one installed active family category remains RLS eligible: '||c.macro_category)
FROM public.categories AS c
WHERE c.is_active AND c.new_listing_enabled
  AND c.macro_category IN ('vehicles','property')
  AND c.id=(SELECT d.id FROM public.categories AS d
    WHERE d.is_active AND d.new_listing_enabled AND d.macro_category=c.macro_category
    ORDER BY d.id LIMIT 1);

SELECT lives_ok($new_goods$
  INSERT INTO public.listings(category_id,city_id,title)
  SELECT c.id,i.city_id,'Issue 133 allowed Goods draft'
  FROM public.categories AS c CROSS JOIN i133_ids AS i WHERE c.slug='electronics'
$new_goods$,'direct authenticated enabled Goods insert allowed');
SELECT throws_ok($new_legacy$
  INSERT INTO public.listings(category_id,city_id,title)
  SELECT c.id,i.city_id,'Issue 133 denied legacy draft'
  FROM public.categories AS c CROSS JOIN i133_ids AS i WHERE c.slug='bicycles-sports'
$new_legacy$,'42501',NULL,'retired mixed category direct INSERT denied by RLS');
SELECT throws_ok($disabled$
  INSERT INTO public.listings(category_id,city_id,title)
  SELECT disabled_category_id,city_id,'Issue 133 denied disabled draft' FROM i133_ids
$disabled$,'42501',NULL,'disabled Goods category direct INSERT denied by RLS');
SELECT throws_ok($inactive$
  INSERT INTO public.listings(category_id,city_id,title)
  SELECT inactive_category_id,city_id,'Issue 133 denied inactive draft' FROM i133_ids
$inactive$,'42501',NULL,'inactive Goods category direct INSERT denied by RLS');
SELECT throws_ok($missing$
  INSERT INTO public.listings(category_id,city_id,title)
  SELECT unknown_category_id,city_id,'Issue 133 denied unknown draft' FROM i133_ids
$missing$,'42501',NULL,'unknown category direct INSERT denied before FK check');
SELECT lives_ok($saved_edit$
  UPDATE public.listings
  SET title='Issue 133 saved bicycle draft remains editable'
  WHERE id=(SELECT legacy_listing_id FROM i133_ids)
$saved_edit$,'saved legacy listing owner UPDATE remains available');
SELECT is((SELECT title FROM public.listings
  WHERE id=(SELECT legacy_listing_id FROM i133_ids)),
  'Issue 133 saved bicycle draft remains editable','old draft retained its owner edit');
SELECT is((SELECT c.slug FROM public.listings l
  JOIN public.categories c ON c.id=l.category_id
  WHERE l.id=(SELECT legacy_listing_id FROM i133_ids)),
  'bicycles-sports','owner edit did not reassign old category');

SELECT set_config('request.jwt.claim.sub',other_id::text,true) FROM i133_ids;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub',other_id,'role','authenticated','aal','aal1')::text,true)
FROM i133_ids;
SELECT is(auth.uid(),(SELECT other_id FROM i133_ids),
  'switched to an unrelated ordinary authenticated seller');
SELECT lives_ok($other$
  UPDATE public.listings SET title='Issue 133 foreign edit must not persist'
  WHERE id=(SELECT legacy_listing_id FROM i133_ids)
$other$,'non-owner update affects no owner rows under unchanged RLS');
SELECT is((SELECT count(*) FROM public.listings
  WHERE id=(SELECT legacy_listing_id FROM i133_ids)),0::bigint,
  'non-owner cannot read the other sellers saved draft');

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{}',true);
SELECT throws_ok($anon$
  INSERT INTO public.listings(category_id,city_id,title)
  SELECT c.id,i.city_id,'Issue 133 anonymous denied draft'
  FROM public.categories AS c CROSS JOIN i133_ids AS i WHERE c.slug='electronics'
$anon$,'42501',NULL,'anonymous role still cannot INSERT via direct API');

RESET ROLE;
SELECT is((SELECT title FROM public.listings
  WHERE id=(SELECT legacy_listing_id FROM i133_ids)),
  'Issue 133 saved bicycle draft remains editable',
  'unauthorised edit attempt left stored legacy listing unchanged');
SELECT * FROM finish();
ROLLBACK;
