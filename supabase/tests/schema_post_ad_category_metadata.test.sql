-- Run ONLY on a positively verified disposable local database after this migration.
-- This is schema/replay evidence, not browser posting or real-role authorization proof.
-- All fixtures, transient metadata-column removal and replay roll back together.
BEGIN;
SELECT no_plan();

CREATE TEMP TABLE a1p_migration_source AS
SELECT statements
FROM supabase_migrations.schema_migrations
WHERE version = '20261008210921' AND name = 'post_ad_category_metadata';

SELECT is((SELECT count(*)::integer FROM a1p_migration_source), 1,
  'exact applied migration history entry exists');
SELECT is((SELECT cardinality(statements) FROM a1p_migration_source), 1,
  'migration is one atomic statement, with no transaction-control replay');

-- Use the actual applied migration statement, not a duplicate imitation of its logic.
CREATE FUNCTION pg_temp.a1p_replay() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  source text[];
BEGIN
  SELECT statements INTO STRICT source FROM a1p_migration_source;
  IF cardinality(source) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'A1P_TEST_REQUIRES_SINGLE_RECORDED_MIGRATION_STATEMENT';
  END IF;
  EXECUTE source[1];
END;
$$;

CREATE FUNCTION pg_temp.a1p_snapshot() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'categories', (SELECT coalesce(jsonb_agg(
      to_jsonb(c) - 'macro_category' - 'new_listing_enabled' ORDER BY c.id
    ), '[]'::jsonb) FROM public.categories c),
    'attributes', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
      FROM public.category_attributes a),
    'listing_relationships', (SELECT coalesce(jsonb_agg(
      jsonb_build_array(id, category_id) ORDER BY id), '[]'::jsonb) FROM public.listings),
    'media', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb)
      FROM public.listing_media m),
    'audit', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
      FROM public.audit_logs a),
    'triggers', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.oid), '[]'::jsonb)
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'app_security')),
    'policies', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid), '[]'::jsonb)
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'app_security')),
    'functions', (SELECT coalesce(jsonb_agg(jsonb_build_array(
      p.oid, pg_catalog.pg_get_functiondef(p.oid), p.proacl) ORDER BY p.oid), '[]'::jsonb)
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'app_security') AND p.prokind IN ('f', 'p')),
    'table_security', (SELECT coalesce(jsonb_agg(jsonb_build_array(
      c.oid, c.relacl, c.relrowsecurity, c.relforcerowsecurity) ORDER BY c.oid), '[]'::jsonb)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'app_security')),
    'column_grants', (SELECT coalesce(jsonb_agg(jsonb_build_array(
      a.attrelid, a.attname, a.attacl) ORDER BY a.attrelid, a.attname), '[]'::jsonb)
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'app_security') AND a.attnum > 0 AND NOT a.attisdropped
        AND NOT (c.relname = 'categories' AND a.attname IN ('macro_category', 'new_listing_enabled')))
  );
$$;

-- A scoped unrelated fixture, plus an inactive supported row, challenge the backfill.
INSERT INTO public.categories (slug, name, is_active)
VALUES ('a1p-inert-unrelated-fixture', 'A1-P inert unrelated fixture', false);
UPDATE public.categories SET is_active = false WHERE slug = 'electronics';
-- Elevated fixture setup proves FK/identity preservation only, not seller RLS.
-- The disposable baseline must contain the migration-4 Jaipur city.
CREATE TEMP TABLE a1p_fixture_owner AS SELECT gen_random_uuid() AS id;
INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
SELECT id, 'a1p-' || id::text || '@example.invalid',
  '{"display_name":"A1-P inert schema owner","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}'::jsonb, '{}'::jsonb, now(), now()
FROM a1p_fixture_owner;
INSERT INTO public.policy_acceptance_records (user_id, terms_version, privacy_policy_version, acceptable_use_version, minimum_age_confirmed)
SELECT id, '2026-09-18', '2026-09-18', '2026-09-18', 18 FROM a1p_fixture_owner;
INSERT INTO public.listings (seller_id, category_id, city_id, title, category_attributes)
VALUES (
  (SELECT id FROM a1p_fixture_owner),
  (SELECT id FROM public.categories WHERE slug = 'bicycles-sports'),
  (SELECT id FROM public.cities WHERE slug = 'jaipur'),
  'A1-P inert mixed-category draft', '{"type":"road"}'::jsonb
);
CREATE TEMP TABLE a1p_before AS SELECT pg_temp.a1p_snapshot() AS state;

-- No CASCADE: a new dependency is a blocker, not permission to remove it.
ALTER TABLE public.categories DROP COLUMN macro_category, DROP COLUMN new_listing_enabled;
SELECT lives_ok('SELECT pg_temp.a1p_replay()', 'actual migration replays against preserved identities');

SELECT col_type_is('public', 'categories', 'macro_category', 'text', 'macro is SQL text');
SELECT col_is_null('public', 'categories', 'macro_category', 'macro is nullable');
SELECT col_hasnt_default('public', 'categories', 'macro_category', 'macro has no default');
SELECT col_type_is('public', 'categories', 'new_listing_enabled', 'boolean', 'enabled is boolean');
SELECT col_not_null('public', 'categories', 'new_listing_enabled', 'enabled is non-null');
SELECT col_default_is('public', 'categories', 'new_listing_enabled', 'false', 'enabled defaults false');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.categories'::regclass
    AND conname = 'categories_macro_category_check' AND contype = 'c'
), 'named macro CHECK exists');

SELECT is(c.macro_category, 'goods', c.slug || ' mapped Goods')
FROM public.categories c
WHERE c.slug IN ('electronics', 'furniture', 'home-appliances', 'books', 'hobbies')
ORDER BY c.slug;
SELECT ok(c.new_listing_enabled, c.slug || ' intended enabled')
FROM public.categories c
WHERE c.slug IN ('electronics', 'furniture', 'home-appliances', 'books', 'hobbies', 'bicycles-sports')
ORDER BY c.slug;
SELECT is((SELECT macro_category FROM public.categories WHERE slug = 'bicycles-sports'),
  NULL::text, 'mixed category remains SQL NULL');
SELECT is((SELECT is_active FROM public.categories WHERE slug = 'electronics'), false,
  'inactive supported category remains inactive');
SELECT is((SELECT macro_category FROM public.categories WHERE slug = 'a1p-inert-unrelated-fixture'),
  NULL::text, 'unrelated existing row is never implicit Goods');
SELECT is((SELECT new_listing_enabled FROM public.categories WHERE slug = 'a1p-inert-unrelated-fixture'),
  false, 'unrelated existing row gets false');

-- Compare digests so a failure does not print existing private/audit/media records.
SELECT is(md5((pg_temp.a1p_snapshot()->key)::text),
  (SELECT md5((state->key)::text) FROM a1p_before), description)
FROM (VALUES
  ('categories', 'category IDs, active states, business fields and timestamps preserved'),
  ('attributes', 'all attribute rows and definitions preserved'),
  ('listing_relationships', 'listing IDs and category relationships preserved'),
  ('media', 'media unchanged'),
  ('audit', 'no category audit side effects'),
  ('triggers', 'no listing/category/media trigger introduced or changed'),
  ('policies', 'RLS policies unchanged'),
  ('functions', 'posting/submission/Admin function bodies, signatures and grants unchanged'),
  ('table_security', 'table grants and RLS settings unchanged'),
  ('column_grants', 'pre-existing column grants unchanged')
) AS checks(key, description);
SELECT is((SELECT count(*)::integer FROM public.listings
  WHERE seller_id = (SELECT id FROM a1p_fixture_owner)
    AND category_id = (SELECT id FROM public.categories WHERE slug = 'bicycles-sports')), 1,
  'nonempty inert mixed listing relationship remains intact');

SELECT lives_ok(format(
  'INSERT INTO public.categories (slug, name, macro_category) VALUES (%L, %L, %L)',
  'a1p-valid-' || macro, 'A1-P inert valid macro fixture', macro
), macro || ' accepted')
FROM (VALUES ('goods'), ('vehicles'), ('property')) AS valid(macro);
SELECT lives_ok($sql$
  INSERT INTO public.categories (slug, name, macro_category, new_listing_enabled)
  VALUES ('a1p-valid-null', 'A1-P inert NULL fixture', NULL, true)
$sql$, 'SQL NULL with enabled true accepted; no non-null implication');
SELECT lives_ok($sql$
  INSERT INTO public.categories (slug, name)
  VALUES ('a1p-defaults', 'A1-P inert default fixture')
$sql$, 'new ordinary category accepts omitted metadata');
SELECT results_eq($sql$
  SELECT macro_category, new_listing_enabled FROM public.categories WHERE slug = 'a1p-defaults'
$sql$, $$ VALUES (NULL::text, false) $$, 'new fixture defaults NULL / false');

SELECT throws_ok(format(
  'INSERT INTO public.categories (slug, name, macro_category) VALUES (%L, %L, %L)',
  'a1p-invalid-macro', 'A1-P inert invalid fixture', macro
), '23514', NULL, 'reject invalid macro ' || quote_literal(macro))
FROM (VALUES (''), (' '), (E'\t'), ('Goods'), ('VEHICLES'), ('unknown'), (' goods')) AS invalid(macro);
SELECT throws_ok($sql$
  INSERT INTO public.categories (slug, name, new_listing_enabled)
  VALUES ('a1p-invalid-enabled', 'A1-P inert NULL boolean fixture', NULL)
$sql$, '23502', NULL, 'enabled rejects SQL NULL');
SELECT throws_ok('SELECT pg_temp.a1p_replay()', 'P0001',
  'A1P_UNEXPECTED_EXISTING_METADATA_COLUMNS', 'existing columns fail rather than IF NOT EXISTS');

-- Catch only the expected migration error, then deliberately unwind the entire
-- scenario. TAP bookkeeping is outside this subtransaction and is not rolled back.
CREATE FUNCTION pg_temp.a1p_failure_scenario(kind text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  before_attempt jsonb;
  outcome jsonb;
  failure_message text;
BEGIN
  BEGIN
    ALTER TABLE public.categories DROP COLUMN macro_category, DROP COLUMN new_listing_enabled;
    IF kind = 'missing' THEN
      UPDATE public.categories SET slug = 'a1p-hidden-electronics' WHERE slug = 'electronics';
    ELSIF kind = 'fields' THEN
      UPDATE public.categories SET name = 'A1-P inert mismatched name' WHERE slug = 'electronics';
    ELSIF kind = 'attributes' THEN
      UPDATE public.category_attributes SET label = 'A1-P inert mismatched label'
      WHERE category_id = (SELECT id FROM public.categories WHERE slug = 'electronics') AND name = 'brand';
    ELSE
      RAISE EXCEPTION 'unknown A1-P test scenario';
    END IF;
    before_attempt := pg_temp.a1p_snapshot();
    BEGIN
      PERFORM pg_temp.a1p_replay();
      outcome := jsonb_build_object('error', 'unexpected success', 'atomic', false);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS failure_message = MESSAGE_TEXT;
      outcome := jsonb_build_object('error', failure_message, 'atomic',
        pg_temp.a1p_snapshot() = before_attempt AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.categories'::regclass AND NOT attisdropped
            AND attname IN ('macro_category', 'new_listing_enabled')
        ));
    END;
    RAISE EXCEPTION USING ERRCODE = 'ZX001', MESSAGE = 'rollback inert scenario';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN
    NULL;
  END;
  RETURN outcome;
END;
$$;

CREATE TEMP TABLE a1p_failure_results AS
SELECT kind, expected_error, pg_temp.a1p_failure_scenario(kind) AS outcome
FROM (VALUES
  ('missing', 'A1P_CATEGORY_IDENTITY_MISSING_OR_AMBIGUOUS: electronics'),
  ('fields', 'A1P_CATEGORY_FIELDS_MISMATCH: electronics'),
  ('attributes', 'A1P_CATEGORY_ATTRIBUTES_MISMATCH: electronics')
) AS cases(kind, expected_error);
SELECT is(outcome->>'error', expected_error, kind || ' assertion reports exact identity')
FROM a1p_failure_results ORDER BY kind;
SELECT ok((outcome->>'atomic')::boolean, kind || ' failure leaves no partial schema/backfill/data')
FROM a1p_failure_results ORDER BY kind;
SELECT has_column('public', 'categories', 'macro_category', 'scenario rollback restores migrated schema');
SELECT is((SELECT name FROM public.categories WHERE slug = 'electronics'), 'Electronics',
  'scenario rollback preserves existing identity');

SELECT * FROM finish();
ROLLBACK;
