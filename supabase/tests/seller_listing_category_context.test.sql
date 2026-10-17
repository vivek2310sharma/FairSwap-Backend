-- AUTHORED / NOT RUN. Only on an explicitly approved disposable database after
-- the new migration. Never run these fixtures on shared FairSwapTest/Production.
-- SQL role simulation is database-contract evidence, not live seller proof.
BEGIN;
SET LOCAL statement_timeout = '30s';
SELECT no_plan();

SELECT has_function('public', 'get_seller_listing_category_context', ARRAY['uuid']);
SELECT has_function('app_security', 'impl_get_seller_listing_category_context', ARRAY['uuid']);
SELECT ok(NOT p.prosecdef AND p.provolatile = 's' AND
  p.proconfig @> ARRAY['search_path=""'], 'public wrapper is stable invoker with empty search_path')
FROM pg_catalog.pg_proc p WHERE p.oid = 'public.get_seller_listing_category_context(uuid)'::regprocedure;
SELECT ok(p.prosecdef AND p.provolatile = 's' AND
  p.proconfig @> ARRAY['search_path=""'], 'private implementation is stable definer with empty search_path')
FROM pg_catalog.pg_proc p WHERE p.oid = 'app_security.impl_get_seller_listing_category_context(uuid)'::regprocedure;
SELECT is(p.proargnames, ARRAY['p_listing_id']::text[], 'only supplied context is the listing ID')
FROM pg_catalog.pg_proc p WHERE p.oid = 'public.get_seller_listing_category_context(uuid)'::regprocedure;
SELECT ok(pg_catalog.has_schema_privilege('authenticated', 'app_security', 'USAGE'),
  'existing authenticated schema USAGE supports the invoker chain');
SELECT ok(pg_catalog.has_function_privilege('authenticated', fn, 'EXECUTE'), fn || ' permits authenticated execution')
FROM (VALUES ('public.get_seller_listing_category_context(uuid)'),
  ('app_security.impl_get_seller_listing_category_context(uuid)')) f(fn);
SELECT ok(NOT pg_catalog.has_function_privilege(role_name, fn, 'EXECUTE'), role_name || ' cannot execute ' || fn)
FROM (VALUES ('anon'), ('service_role')) r(role_name)
CROSS JOIN (VALUES ('public.get_seller_listing_category_context(uuid)'),
  ('app_security.impl_get_seller_listing_category_context(uuid)')) f(fn);
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
), 'no default PUBLIC execution on ' || p.proname)
FROM pg_catalog.pg_proc p WHERE p.oid IN (
  'public.get_seller_listing_category_context(uuid)'::regprocedure,
  'app_security.impl_get_seller_listing_category_context(uuid)'::regprocedure);

-- Independent synthetic identities/reference rows only; no shared category updates.
CREATE TEMP TABLE sc_ids AS SELECT gen_random_uuid() AS owner_id,
  gen_random_uuid() AS other_id, gen_random_uuid() AS staff_id, gen_random_uuid() AS city_id;
GRANT SELECT ON sc_ids TO authenticated, anon;
CREATE TEMP TABLE sc_cases AS SELECT label, gen_random_uuid() AS category_id,
  gen_random_uuid() AS listing_id, active, enabled
FROM (VALUES ('active', true, true), ('closed', true, false),
  ('inactive', false, false), ('empty', true, true)) v(label, active, enabled);
GRANT SELECT ON sc_cases TO authenticated, anon;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
SELECT user_id, 'saved-context-' || user_id::text || '@example.invalid',
  '{"display_name":"Synthetic saved context owner","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}'::jsonb, '{}'::jsonb, now(), now()
FROM sc_ids CROSS JOIN LATERAL (VALUES (owner_id), (other_id), (staff_id)) ids(user_id);
INSERT INTO public.policy_acceptance_records (user_id, terms_version, privacy_policy_version, acceptable_use_version, minimum_age_confirmed)
SELECT user_id, '2026-09-18', '2026-09-18', '2026-09-18', 18
FROM sc_ids CROSS JOIN LATERAL (VALUES (owner_id), (other_id), (staff_id)) ids(user_id);
INSERT INTO public.staff_roles (user_id, role) SELECT staff_id, 'administrator' FROM sc_ids;
INSERT INTO public.cities (id, name, state, slug)
SELECT city_id, 'Synthetic context city', 'Synthetic context state', 'saved-context-' || city_id::text FROM sc_ids;
INSERT INTO public.categories (id, name, slug, is_active, macro_category, new_listing_enabled)
SELECT category_id, 'Synthetic saved category ' || label,
  'saved-context-' || category_id::text, active, 'goods', enabled FROM sc_cases;
INSERT INTO public.category_attributes (category_id, name, label, value_type, is_required, sort_order)
SELECT category_id, 'brand', 'Saved Brand', 'text', true, 1 FROM sc_cases WHERE label <> 'empty';
INSERT INTO public.listings (id, seller_id, category_id, city_id, title, category_attributes)
SELECT listing_id, owner_id, category_id, city_id, 'Synthetic saved context fixture',
  '{"brand":"Saved synthetic value"}'::jsonb FROM sc_cases CROSS JOIN sc_ids;

CREATE FUNCTION pg_temp.sc_snapshot() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'listings', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.listings l
      WHERE l.id IN (SELECT listing_id FROM sc_cases)),
    'categories', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.categories c
      WHERE c.id IN (SELECT category_id FROM sc_cases)),
    'attributes', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.category_attributes a
      WHERE a.category_id IN (SELECT category_id FROM sc_cases))
  );
$$;
CREATE TEMP TABLE sc_before AS SELECT md5(pg_temp.sc_snapshot()::text) AS digest;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', owner_id::text, true) FROM sc_ids;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal1')::text, true) FROM sc_ids;
SELECT is(public.get_seller_listing_category_context(listing_id)->'category'->>'id',
  category_id::text, label || ' owner gets actual saved category') FROM sc_cases;
SELECT is((public.get_seller_listing_category_context(listing_id)->'category'->>'is_active')::boolean,
  active, label || ' returns actual active state') FROM sc_cases;
SELECT is((public.get_seller_listing_category_context(listing_id)->'category'->>'new_listing_enabled')::boolean,
  enabled, label || ' returns actual assignment state') FROM sc_cases;
SELECT is(public.get_seller_listing_category_context(listing_id)->'category'->>'macro_category',
  'goods', label || ' returns actual macro') FROM sc_cases;
SELECT is(jsonb_array_length(public.get_seller_listing_category_context(listing_id)->'attributes'),
  CASE WHEN label = 'empty' THEN 0 ELSE 1 END, label || ' includes definitions or successful empty array') FROM sc_cases;
SELECT is(public.get_seller_listing_category_context(listing_id)->'attributes'->0->>'category_id',
  category_id::text, label || ' attributes belong only to saved category') FROM sc_cases WHERE label <> 'empty';
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(
  public.get_seller_listing_category_context(listing_id)) k), ARRAY['attributes', 'category']::text[],
  label || ' has only reference result keys') FROM sc_cases;
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(
  public.get_seller_listing_category_context(listing_id)->'category') k),
  ARRAY['id', 'is_active', 'macro_category', 'name', 'new_listing_enabled']::text[],
  label || ' category projection has no listing/private/unrelated fields') FROM sc_cases;
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(
  public.get_seller_listing_category_context(listing_id)->'attributes'->0) k),
  ARRAY['category_id', 'id', 'is_required', 'label', 'name', 'options', 'sort_order', 'validation_rules', 'value_type']::text[],
  label || ' attribute projection is explicit') FROM sc_cases WHERE label <> 'empty';
SELECT is((SELECT count(*)::integer FROM public.categories WHERE id = (SELECT category_id FROM sc_cases WHERE label = 'inactive')),
  0, 'ordinary discovery still hides inactive category');
SELECT is((SELECT count(*)::integer FROM public.category_attributes WHERE category_id = (SELECT category_id FROM sc_cases WHERE label = 'inactive')),
  0, 'ordinary discovery still hides inactive attribute definitions');
SELECT lives_ok(format('SELECT app_security.impl_get_seller_listing_category_context(%L::uuid)', listing_id),
  'owner direct private call has the same authorization') FROM sc_cases WHERE label = 'inactive';
SELECT throws_ok('SELECT public.get_seller_listing_category_context(NULL::uuid)', '42501', 'Listing unavailable', 'null ID discloses no reference data');
SELECT throws_ok('SELECT public.get_seller_listing_category_context(''00000000-0000-4000-8000-000000000000''::uuid)',
  '42501', 'Listing unavailable', 'unknown ID has same unavailable result');

SELECT set_config('request.jwt.claim.sub', other_id::text, true) FROM sc_ids;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', other_id, 'role', 'authenticated', 'aal', 'aal1')::text, true) FROM sc_ids;
SELECT throws_ok(format('SELECT public.get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', 'Listing unavailable', label || ' ordinary non-owner denied') FROM sc_cases;
SELECT throws_ok(format('SELECT app_security.impl_get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', 'Listing unavailable', label || ' private direct call also denies non-owner') FROM sc_cases;

SELECT set_config('request.jwt.claim.sub', staff_id::text, true) FROM sc_ids;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', staff_id, 'role', 'authenticated', 'aal', 'aal2')::text, true) FROM sc_ids;
SELECT ok(app_security.is_active_staff_aal2('administrator'), 'fixture is genuinely authorized staff at AAL2');
SELECT throws_ok(format('SELECT public.get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', 'Listing unavailable', label || ' staff non-owner denied by seller endpoint') FROM sc_cases;
SELECT throws_ok(format('SELECT app_security.impl_get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', 'Listing unavailable', label || ' staff direct implementation denied') FROM sc_cases;

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '{}', true);
SELECT throws_ok(format('SELECT public.get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', 'Authentication required', 'authenticated role without identity denied') FROM sc_cases WHERE label = 'inactive';
SELECT throws_ok(format('SELECT app_security.impl_get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', 'Authentication required', 'direct implementation without identity denied') FROM sc_cases WHERE label = 'inactive';
SET LOCAL ROLE anon;
SELECT throws_ok(format('SELECT public.get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', NULL, 'anonymous role cannot execute wrapper') FROM sc_cases WHERE label = 'inactive';
SELECT throws_ok(format('SELECT app_security.impl_get_seller_listing_category_context(%L::uuid)', listing_id),
  '42501', NULL, 'anonymous role cannot execute private implementation') FROM sc_cases WHERE label = 'inactive';

RESET ROLE;
SELECT is(md5(pg_temp.sc_snapshot()::text), (SELECT digest FROM sc_before),
  'all successful/denied reads preserve exact fixture listing/category/attribute records');
SELECT * FROM finish();
ROLLBACK;
