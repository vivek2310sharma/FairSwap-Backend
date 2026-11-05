// Tablets V2 extends an active V1 installation. These checks query metadata and
// public reference data only; listing text, media and credentials stay out of receipts.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyCandidateSha, webPin} from './reusable-candidates.mjs';
import {deploymentReady, fail, functionAclSql, getJson} from './accessories-v1-release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tables = "ARRAY['tablet_release_v1','tablet_brands_v1','tablet_models_v1','tablet_session_bindings_v1','listing_tablet_contexts']";
const changed = "ARRAY['app_security.validate_tablet_v1(jsonb)','app_security.impl_submit_tablet_v1(jsonb)']";
const active = `(SELECT count(*) = 1 AND bool_and(r.enabled AND c.is_active AND NOT c.new_listing_enabled
  AND c.slug = 'tablets' AND c.macro_category = 'goods')
  FROM public.tablet_release_v1 r JOIN public.categories c ON c.id = r.category_id)`;
const references = `jsonb_build_object(
  'brands', (SELECT jsonb_agg(to_jsonb(b) - 'sort_order' ORDER BY b.id) FROM public.tablet_brands_v1 b),
  'models', (SELECT jsonb_agg(to_jsonb(m) - 'sort_order' ORDER BY m.id) FROM public.tablet_models_v1 m))`;
const metadata = `jsonb_build_object(
  'functions', (SELECT jsonb_agg(jsonb_build_object('oid', p.oid, 'owner', p.proowner, 'acl', p.proacl,
    'definer', p.prosecdef, 'config', p.proconfig, 'body', CASE WHEN p.oid IN
      (SELECT to_regprocedure(s) FROM unnest(${changed}) s) THEN NULL ELSE md5(p.prosrc) END) ORDER BY p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','app_security')),
  'tables', (SELECT jsonb_agg(jsonb_build_object('oid', c.oid, 'owner', c.relowner, 'acl', c.relacl,
    'rls', c.relrowsecurity, 'force', c.relforcerowsecurity) ORDER BY c.oid)
    FROM pg_class c WHERE c.oid IN (SELECT to_regclass('public.' || t) FROM unnest(${tables}) t)),
  'columns', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum) FROM pg_attribute a
    WHERE a.attrelid IN (SELECT to_regclass('public.' || t) FROM unnest(${tables}) t) AND a.attnum > 0),
  'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p
    WHERE p.polrelid IN (SELECT to_regclass('public.' || t) FROM unnest(${tables}) t)),
  'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
    WHERE t.tgrelid = 'public.listings'::regclass))`;
const intact = `(SELECT count(*) = 5 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class
  WHERE oid IN (SELECT to_regclass('public.' || t) FROM unnest(${tables}) t))
  AND NOT EXISTS (SELECT FROM public.tablet_models_v1 m LEFT JOIN public.tablet_brands_v1 b ON b.id=m.brand_id WHERE b.id IS NULL)
  AND NOT EXISTS (SELECT FROM public.listing_tablet_contexts c LEFT JOIN public.tablet_models_v1 m
    ON m.id=c.model_id AND m.brand_id=c.brand_id WHERE m.id IS NULL)
  AND NOT EXISTS (SELECT FROM pg_class c CROSS JOIN LATERAL
    aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid IN (SELECT to_regclass('public.' || t) FROM unnest(${tables}) t)
    AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname='anon'),
      (SELECT oid FROM pg_roles WHERE rolname='authenticated'),(SELECT oid FROM pg_roles WHERE rolname='service_role'))
    AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'))
  AND NOT EXISTS (SELECT FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
    WHERE c.attrelid IN (SELECT to_regclass('public.' || t) FROM unnest(${tables}) t)
    AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname='anon'),
      (SELECT oid FROM pg_roles WHERE rolname='authenticated'),(SELECT oid FROM pg_roles WHERE rolname='service_role'))
    AND a.privilege_type IN ('INSERT','UPDATE','REFERENCES'))
  AND NOT has_column_privilege('anon','public.listing_tablet_contexts','review_required','SELECT')
  AND NOT has_column_privilege('authenticated','public.listing_tablet_contexts','review_required','SELECT')
  AND ${functionAclSql([
    ['public.tablets_v1_catalogue()',false,false,true],
    ['public.tablet_v1_session(uuid,text)',false,false,true],
    ['public.submit_tablet_v1(jsonb)',false,false,true],
    ['app_security.impl_tablet_v1_session(uuid,text)',true,false,true],
    ['app_security.impl_submit_tablet_v1(jsonb)',true,false,true],
    ['app_security.validate_tablet_v1(jsonb)',true,false,false]
  ])}`;

function read(exec, checks) {
  const fields = Object.entries(checks).map(([name, sql]) => `'${name}', (${sql})`).join(', ');
  const value = JSON.parse(exec(`BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; SELECT jsonb_build_object(${fields})::text; COMMIT;`));
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join() !== Object.keys(checks).sort().join()) fail('TABLETS_V2_INVALID_RESPONSE');
  return value;
}

export function runTabletsV2Preflight(exec) {
  const state = read(exec, {
    active, intact, references, metadata,
    v1_catalogue: `(SELECT count(*) = 11 FROM public.tablet_brands_v1)
      AND (SELECT count(*) = 17 FROM public.tablet_models_v1)`
  });
  if (state.active !== true || state.intact !== true || state.v1_catalogue !== true
    || !Array.isArray(state.references?.brands) || !Array.isArray(state.references?.models) || !state.metadata) {
    fail('TABLETS_V2_PREFLIGHT_FAILED');
  }
  return state;
}

export function runTabletsV2Postflight(before, exec) {
  if (!before) fail('TABLETS_V2_PREFLIGHT_REQUIRED');
  // The immutable, hash-checked file supplies exactly the two reviewed function bodies.
  const source = verifyCandidateSha('tablets-v2-catalogue', root);
  const functions = changedFunctionChecks(source.fullPath);
  const state = read(exec, {
    active, intact, references, metadata,
    catalogue: `(SELECT count(*) = 30 FROM public.tablet_brands_v1)
      AND (SELECT count(*) = 306 FROM public.tablet_models_v1)
      AND (SELECT jsonb_array_length(x->'brands')=30 AND jsonb_array_length(x->'models')=306
        AND x->>'revision'='tablets-v1' AND x->'enabled'='true'::jsonb FROM (SELECT public.tablets_v1_catalogue() x) c)`,
    fallbacks: `NOT EXISTS (SELECT FROM public.tablet_brands_v1 b WHERE
      (SELECT count(*) FROM public.tablet_models_v1 m WHERE m.brand_id=b.id AND m.other AND m.name='Other model')<>1)
      AND NOT EXISTS (SELECT FROM public.tablet_models_v1 m JOIN public.tablet_brands_v1 b ON b.id=m.brand_id WHERE b.name='Other' AND NOT m.other)
      AND (SELECT name='Other' FROM public.tablet_brands_v1 ORDER BY sort_order DESC LIMIT 1)
      AND NOT EXISTS (SELECT FROM public.tablet_models_v1 m WHERE m.other AND EXISTS
        (SELECT FROM public.tablet_models_v1 n WHERE n.brand_id=m.brand_id AND NOT n.other AND n.sort_order>=m.sort_order))`,
    indexes: `(SELECT count(*)=3 AND bool_and(i.indisunique AND i.indisvalid) FROM pg_index i
      WHERE i.indexrelid IN (to_regclass('public.tablet_brands_v2_normalized_name'),
      to_regclass('public.tablet_models_v2_normalized_name'),to_regclass('public.tablet_models_v2_one_other')))`,
    functions
  });
  for (const field of ['active','intact','catalogue','fallbacks','indexes','functions']) {
    if (state[field] !== true) fail('TABLETS_V2_POSTFLIGHT_FAILED', field);
  }
  try {
    assert.deepEqual(state.metadata, before.metadata);
    for (const kind of ['brands','models']) {
      assert.ok(Array.isArray(state.references?.[kind]));
      const installed = new Map(state.references[kind].map(row => [row.id, row]));
      for (const row of before.references[kind]) assert.deepEqual(installed.get(row.id), row);
    }
  } catch { fail('TABLETS_V2_EXISTING_CONTRACT_CHANGED'); }
  return {verified: true};
}

function changedFunctionChecks(path) {
  const sql = readFileSync(path, 'utf8');
  return ['validate_tablet_v1','impl_submit_tablet_v1'].map(name => {
    const match = sql.match(new RegExp(`create or replace function app_security\\.${name}\\([^]*?as \\$\\$([^]*?)\\$\\$;`, 'i'));
    if (!match) fail('TABLETS_V2_SOURCE_FUNCTION_MISSING', name);
    const digest = createHash('sha256').update(match[1]).digest('hex');
    return `EXISTS (SELECT FROM pg_proc WHERE oid=to_regprocedure('app_security.${name}(jsonb)')
      AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${digest}')`;
  }).join(' AND ');
}

export async function verifyTabletsV2Web(plan, context, fetcher = fetch, testReceipt) {
  if (plan.candidate.id !== 'tablets-v2-catalogue' || plan.target !== 'production') return null;
  const pin = webPin(plan.candidate);
  const token = context.WEB_EVIDENCE_TOKEN;
  if (!token) fail('WEB_EVIDENCE_UNAVAILABLE');
  const sha = plan.webStagingSha;
  const deployed = await deploymentReady(pin, token, fetcher, sha, false);
  if (!deployed) fail('WEB_STAGING_DEPLOYMENT_NOT_READY');
  if (testReceipt && (!Number.isFinite(Date.parse(testReceipt.timestamp))
    || !Number.isFinite(Date.parse(deployed.created_at)) || Date.parse(deployed.created_at) < Date.parse(testReceipt.timestamp))) {
    fail('TABLETS_V2_STAGING_MUST_FOLLOW_TEST');
  }
  const data = await getJson(`https://api.github.com/repos/${pin.repository}/actions/runs?branch=staging&head_sha=${sha}&event=push&status=success&per_page=100`, token, fetcher);
  const run = data.workflow_runs?.find(run => run.head_sha === sha && run.head_branch === 'staging'
    && run.head_repository?.full_name === pin.repository && run.path === '.github/workflows/ci.yml'
    && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success');
  if (!run) fail('TABLETS_V2_STAGING_CI_REQUIRED');
  return {stagingDeploymentId: deployed.id, stagingCiRunId: run.id};
}
