import {functionAclSql} from './accessories-v1-release.mjs';

const releaseTable = 'public.tablet_release_v1';
const delegate = 'app_security.impl_submit_mobile_v2_before_tablets(jsonb)';
const implementation = 'app_security.impl_submit_mobile_v2(jsonb)';
const publicSubmit = 'public.submit_mobile_v2(jsonb)';
const accessoryBody = '622323dbcdee479763e58c8cfda56e64';
const publicBody = 'a5fed26d37c6fa3d9886cae11131f979';
const tabletWrapperBody = 'ccac1148d1a79143c2f7a13221eace3b';
const bodyMatches = (signature, digest) =>
  `EXISTS (SELECT FROM pg_proc WHERE oid = to_regprocedure('${signature}') AND md5(prosrc) = '${digest}')`;
const tabletTables = `ARRAY['tablet_release_v1','tablet_brands_v1','tablet_models_v1','tablet_session_bindings_v1','listing_tablet_contexts']`;
const mobileReady = `EXISTS (SELECT FROM public.posting_category_definitions
  WHERE category_key = 'mobiles' AND subcategory_key = 'mobile-phones' AND version = 2 AND enabled)`;

function readOnly(sql) {
  return `BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; ${sql}; COMMIT;`;
}

function requireChecks(exec, checks, phase) {
  const fields = Object.entries(checks).map(([key, sql]) => `'${key}', (${sql})`);
  const result = JSON.parse(exec(readOnly(`SELECT jsonb_build_object(${fields.join(', ')})::text`)));
  for (const key of Object.keys(checks)) {
    if (result?.[key] !== true) throw new Error(`REUSABLE_RELEASE_TABLETS_${phase}_FAILED: ${key}`);
  }
  return result;
}

export function runTabletsPreflight(candidate, exec) {
  if (candidate.stage === 'activation') return runTabletsPostflight(false, exec);
  return requireChecks(exec, {
    accessories_active: `EXISTS (SELECT FROM public.accessory_release_v1 r
      JOIN public.categories c ON c.id = r.category_id WHERE r.enabled AND c.is_active AND c.slug = 'mobile-accessories')`,
    tablets_absent: `NOT EXISTS (SELECT FROM unnest(${tabletTables}) t WHERE to_regclass('public.' || t) IS NOT NULL)
      AND to_regprocedure('${delegate}') IS NULL`,
    tablet_category_inactive: "NOT EXISTS (SELECT FROM public.categories WHERE slug = 'tablets' AND (is_active OR new_listing_enabled))",
    recovery_installed: `EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'posting_upload_sessions' AND column_name = 'draft_protected')`,
    mobile_ready: mobileReady,
    reviewed_phone_functions: `${bodyMatches(publicSubmit, publicBody)} AND ${bodyMatches(implementation, accessoryBody)}
      AND ${functionAclSql([[publicSubmit, false, false, true], [implementation, true, false, true]])}`
  }, 'PREFLIGHT');
}

export function runTabletsPostflight(enabled, exec) {
  return requireChecks(exec, {
    release_state: `(SELECT count(*) = 1 AND bool_and(r.enabled = ${enabled} AND c.slug = 'tablets'
      AND c.macro_category = 'goods' AND c.is_active = ${enabled} AND NOT c.new_listing_enabled)
      FROM ${releaseTable} r JOIN public.categories c ON c.id = r.category_id)`,
    catalogue: `(SELECT coalesce(x->>'revision' = 'tablets-v1' AND (x->>'enabled')::boolean = ${enabled}
      AND jsonb_array_length(x->'brands') = 11 AND jsonb_array_length(x->'models') = 17, false)
      FROM (SELECT public.tablets_v1_catalogue() x) catalogue)`,
    forced_rls: `(SELECT count(*) = 5 AND bool_and(relrowsecurity AND relforcerowsecurity)
      FROM pg_class WHERE oid IN (SELECT to_regclass('public.' || t) FROM unnest(${tabletTables}) t))`,
    client_permissions: `NOT EXISTS (SELECT FROM unnest(${tabletTables}) t
      CROSS JOIN unnest(ARRAY['public','anon','authenticated','service_role']) r
      WHERE has_any_column_privilege(r, 'public.' || t, 'INSERT, UPDATE, REFERENCES')
         OR has_table_privilege(r, 'public.' || t, 'DELETE, TRUNCATE, TRIGGER'))
      AND NOT has_any_column_privilege('authenticated', 'public.tablet_session_bindings_v1', 'SELECT')
      AND NOT has_column_privilege('authenticated', 'public.listing_tablet_contexts', 'review_required', 'SELECT')
      AND NOT has_column_privilege('anon', 'public.listing_tablet_contexts', 'review_required', 'SELECT')`,
    function_permissions: functionAclSql([
      ['public.tablets_v1_catalogue()', false, false, true],
      ['public.tablet_v1_session(uuid,text)', false, false, true],
      ['public.submit_tablet_v1(jsonb)', false, false, true],
      ['app_security.impl_tablet_v1_session(uuid,text)', true, false, true],
      ['app_security.impl_submit_tablet_v1(jsonb)', true, false, true],
      [publicSubmit, false, false, true],
      [implementation, true, false, true],
      [delegate, true, false, false]
    ]),
    listing_guard: `EXISTS (SELECT FROM pg_trigger WHERE tgrelid = 'public.listings'::regclass
      AND tgname = 'zz_tablet_listing_guard_v1' AND NOT tgisinternal AND tgenabled = 'O'
      AND tgfoid = to_regprocedure('app_security.tablet_listing_guard_v1()'))`,
    phone_contract: `${mobileReady} AND ${bodyMatches(publicSubmit, publicBody)}
      AND ${bodyMatches(implementation, tabletWrapperBody)} AND ${bodyMatches(delegate, accessoryBody)}
      AND (SELECT a.proowner = b.proowner FROM pg_proc a, pg_proc b
        WHERE a.oid = to_regprocedure('${implementation}') AND b.oid = to_regprocedure('${delegate}'))`
  }, 'POSTFLIGHT');
}

export function readTabletsLedger(exec) {
  const ledger = JSON.parse(exec(readOnly(`SELECT jsonb_agg(jsonb_build_object(
    'version', version, 'name', name, 'hasStatements', coalesce(cardinality(statements) > 0, false),
    'statementCount', coalesce(cardinality(statements), 0),
    'statementsSha256', encode(sha256(convert_to(coalesce(to_jsonb(statements)::text, 'null'), 'UTF8')), 'hex')
  ) ORDER BY version)::text FROM supabase_migrations.schema_migrations`)));
  if (!Array.isArray(ledger) || new Set(ledger.map(row => row.version)).size !== ledger.length ||
      ledger.some(row => !/^\d{14}$/.test(row.version) || !/^[a-f0-9]{64}$/.test(row.statementsSha256))) {
    throw new Error('REUSABLE_RELEASE_TABLETS_INVALID_LEDGER');
  }
  return ledger;
}

export function verifyTabletsLedger(before, after, candidate) {
  const row = after.find(entry => entry.version === candidate.version);
  const previous = after.filter(entry => entry.version !== candidate.version);
  if (!row?.hasStatements || row.name !== candidate.filename.slice(15, -4) ||
      JSON.stringify(before) !== JSON.stringify(previous)) {
    throw new Error('REUSABLE_RELEASE_TABLETS_LEDGER_CHANGED');
  }
  return row.statementsSha256;
}
