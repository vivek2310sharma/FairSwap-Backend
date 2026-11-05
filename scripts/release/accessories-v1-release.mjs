// Accessories V1 release gates: ledger ordering, live preflight, strict read-only postflight, stage evidence.
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {PROJECT_REFS, getCandidate, planDispatch, verifyCandidateSha, webPin} from './reusable-candidates.mjs';

const BACKEND = 'vivek2310sharma/FairSwap-Backend';
const WORKFLOW_ID = 404601811;
const FOUNDATION = 'accessories-v1-foundation';
const ACTIVATION = 'accessories-v1-activation';
const SHA40 = /^[a-f0-9]{40}$/;
const ID = /^[1-9][0-9]*$/;
export const WORKFLOW_PATH = '.github/workflows/reusable-supabase-release.yml';
const TABLES = ['accessory_release_v1', 'accessory_types_v1', 'listing_accessory_contexts'];
const TYPE_IDS = [
  'audio', 'cable', 'charger', 'hub', 'keyboard-case', 'other-phone', 'other-wearable', 'phone-case',
  'phone-protector', 'phone-stand', 'power-bank', 'strap-adapter', 'stylus', 'tablet-case', 'tablet-charging',
  'tablet-protector', 'tablet-stand', 'watch-case', 'watch-charger', 'watch-strap', 'wireless-charger'
];

export function fail(code, detail) {
  throw new Error(`REUSABLE_RELEASE_${code}${detail ? `: ${detail}` : ''}`);
}

// ---- Ledger ----------------------------------------------------------------------------------

export function parseLedgerVersions(output) {
  const lines = String(output).split('\n');
  const unwrap = s => (s.startsWith('`') && s.endsWith('`') && s.length >= 2 ? s.slice(1, -1) : s);
  const headerIdx = lines.findIndex(line => {
    const p = line.split('|').map(s => unwrap(s.trim()).toUpperCase());
    return p.length >= 3 && p[0] === 'LOCAL' && p[1] === 'REMOTE' && p[2].startsWith('TIME');
  });
  if (headerIdx === -1) fail('LEDGER_HEADER_MISSING');
  const local = new Set();
  const remote = new Set();
  for (const raw of lines.slice(headerIdx + 1)) {
    const line = raw.trim();
    if (!line || line.startsWith('---') || line.startsWith('===') || line.startsWith('Connecting')) continue;
    const cols = line.split('|').map(s => unwrap(s.trim()));
    if (cols.length < 3) continue;
    for (const [col, set] of [[cols[0], local], [cols[1], remote]]) {
      if (col === '') continue;
      if (!/^\d{14}$/.test(col)) fail('LEDGER_MALFORMED_ROW', 'version format');
      if (set.has(col)) fail('LEDGER_MALFORMED_ROW', 'duplicate version');
      set.add(col);
    }
  }
  return {local, remote};
}

// Returns 'absent' | 'applied'; fails closed on partial state, missing prerequisites or incompatible ordering.
export function assertLedgerOrdering(candidate, ledgerOutput) {
  const {local, remote} = parseLedgerVersions(ledgerOutput);
  for (const v of candidate.requiredLedgerVersions ?? []) {
    if (!local.has(v) || !remote.has(v)) fail('PREREQUISITE_MIGRATION_MISSING', v);
  }
  for (const v of candidate.incompatibleLedgerVersions ?? []) {
    if (local.has(v) || remote.has(v)) fail('INCOMPATIBLE_MIGRATION_ORDER', v);
  }
  if (usesLedgerHash(candidate) &&
      (local.size !== remote.size || [...local].some(version => !remote.has(version)))) {
    fail('LEDGER_HISTORY_CHANGED');
  }
  const inLocal = local.has(candidate.version);
  const inRemote = remote.has(candidate.version);
  if (inLocal !== inRemote) fail('PARTIAL_RELEASE_LEDGER', candidate.version);
  return {state: inRemote ? 'applied' : 'absent', remote};
}

export function verifyHistoryPreserved(beforeRemote, ledgerAfter, version) {
  const after = parseLedgerVersions(ledgerAfter).remote;
  const expected = new Set([...beforeRemote, version]);
  const same = after.size === expected.size && [...expected].every(v => after.has(v));
  if (!same) fail('LEDGER_HISTORY_CHANGED');
}

// SHA-256 of JSON.stringify(SplitAndTrim(source)) from Supabase CLI v2.117.0.
// Bind each statement array to the candidate's independently verified source hash.
const ACCESSORIES_LEDGER = {
  [FOUNDATION]: ['790f6e2e06fb049d84903b42fad9bf8efd359a248ac0ecfcdd69f1e897142e9a',
    '0e512477703c1ed9fec061149245f91e82b312e4be58849f97294c198fe5456d'],
  [ACTIVATION]: ['3fe0647b33ad914efca86b5a9aa91590be1d2d42ac20eb42cdc5d38ee3baabcd',
    'f4ba4a6dde36fdd3bacaaf153d2d586f3c1e9906bf03c55b35fcee95efadaaa7']
};

export function verifyAccessoriesLedger(activated, exec) {
  const expected = (activated ? [FOUNDATION, ACTIVATION] : [FOUNDATION]).map(id => {
    const {candidate, sha256} = verifyCandidateSha(id);
    const [source, statements] = ACCESSORIES_LEDGER[id];
    if (sha256 !== source) fail('ACCESSORIES_LEDGER_SOURCE_MISMATCH');
    return {version: candidate.version, name: candidate.filename.slice(15, -4), statements};
  });
  const raw = exec(`-- accessories-recovery-ledger
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name, 'statements', statements)
  ORDER BY version), '[]'::jsonb)::text
FROM supabase_migrations.schema_migrations
WHERE version IN ('20261102164135', '20261102164137', '20261102165946', '20261102170611');
COMMIT;`);
  let rows;
  try { rows = JSON.parse(raw); } catch { fail('ACCESSORIES_LEDGER_MISMATCH'); }
  if (!Array.isArray(rows) || rows.length !== expected.length || expected.some((want, i) => {
    const row = rows[i];
    return row?.version !== want.version || row.name !== want.name || !Array.isArray(row.statements)
      || createHash('sha256').update(JSON.stringify(row.statements)).digest('hex') !== want.statements;
  })) fail('ACCESSORIES_LEDGER_MISMATCH');
}

// ---- Live read-only SQL ----------------------------------------------------------------------

const PRE_KEYS = ['foundation_installed', 'enabled', 'category_active', 'tablets_wrapped'];

// Stage 1 never names public.accessory_release_v1: PostgreSQL resolves every relation in a statement at
// parse time, even inside an untaken CASE branch, so an uninstalled foundation would fail with 42P01.
const PREFLIGHT_SQL = `-- accessories-preflight
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'foundation_installed', to_regclass('public.accessory_release_v1') IS NOT NULL,
  'category_active', EXISTS (SELECT 1 FROM public.categories c WHERE c.slug = 'mobile-accessories' AND c.is_active),
  'tablets_wrapped', to_regprocedure('app_security.impl_submit_mobile_v2_before_tablets(jsonb)') IS NOT NULL
)::text;
COMMIT;`;

// Stage 2 runs only after stage 1 proved the table exists.
const PREFLIGHT_ENABLED_SQL = `-- accessories-preflight-enabled
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object('enabled', coalesce(bool_or(enabled), false))::text FROM public.accessory_release_v1;
COMMIT;`;

export function assertPreflight(candidate, state) {
  if (!state || typeof state !== 'object' || PRE_KEYS.some(k => typeof state[k] !== 'boolean')) {
    fail('PREFLIGHT_INVALID_RESPONSE');
  }
  if (state.tablets_wrapped) fail('INCOMPATIBLE_MIGRATION_ORDER', 'Tablets wrapper already installed');
  if (candidate.stage === 'foundation' && state.foundation_installed) fail('PARTIAL_RELEASE_STATE', 'foundation objects without ledger entry');
  if (candidate.stage === 'activation') {
    if (!state.foundation_installed) fail('PREREQUISITE_NOT_MET', 'foundation not installed');
    if (state.enabled || state.category_active) fail('INVALID_ACTIVATION_ORDER', 'category already active');
  }
  return state;
}

export function preflightQuery() {
  return PREFLIGHT_SQL;
}

export function preflightEnabledQuery() {
  return PREFLIGHT_ENABLED_SQL;
}

function parsePreflight(raw, keys) {
  let value;
  try {
    value = JSON.parse(String(raw).trim());
  } catch {
    fail('PREFLIGHT_INVALID_RESPONSE');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(k => typeof value[k] !== 'boolean')) {
    fail('PREFLIGHT_INVALID_RESPONSE');
  }
  return value;
}

// exec(sql) runs one read-only statement and returns its stdout. The enabled flag is read only once the table exists.
export function runLivePreflight(candidate, exec) {
  const base = parsePreflight(exec(preflightQuery()), ['foundation_installed', 'category_active', 'tablets_wrapped']);
  let enabled = false;
  if (base.foundation_installed) enabled = parsePreflight(exec(preflightEnabledQuery()), ['enabled']).enabled;
  return assertPreflight(candidate, {
    foundation_installed: base.foundation_installed, enabled, category_active: base.category_active, tablets_wrapped: base.tablets_wrapped
  });
}

const sqlList = a => `ARRAY[${a.map(x => `'${x}'`).join(',')}]`;

// Function ACL expectations: [signature, security definer, anon execute, authenticated execute]
const ACCESSORY_FUNCTIONS = [
  ['public.accessories_v1_catalogue()', false, false, true],
  ['public.submit_accessory_v1(jsonb)', false, false, true],
  ['public.search_accessories_v1(jsonb)', false, true, true],
  ['app_security.impl_submit_accessory_v1(jsonb)', true, false, true],
  ['app_security.impl_search_accessories_v1(jsonb)', true, true, true],
  ['app_security.validate_accessory_v1(jsonb)', true, false, false],
  ['app_security.accessory_listing_guard_v1()', true, false, false]
];
const MOBILE_FUNCTIONS = [
  ['public.submit_mobile_v2(jsonb)', false, false, true],
  ['public.posting_v2_session(uuid,text,uuid)', false, false, true],
  ['app_security.impl_submit_mobile_v2(jsonb)', true, false, true],
  ['app_security.impl_posting_v2_session(uuid,text,uuid)', true, false, true]
];

export function functionAclSql(rows) {
  const values = rows.map(([sig, def, anon, auth]) => `('${sig}', ${def}, ${anon}, ${auth})`).join(', ');
  return `(SELECT bool_and(
      to_regprocedure(v.sig) IS NOT NULL
      AND (SELECT p.prosecdef = v.def AND p.proconfig @> ARRAY['search_path=""']::text[] FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
      AND has_function_privilege('public', to_regprocedure(v.sig), 'EXECUTE') = false
      AND has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') = false
      AND has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') = v.anon
      AND has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') = v.auth
    ) FROM (VALUES ${values}) AS v(sig, def, anon, auth))`;
}

export function postflightQuery(stage) {
  const enabled = stage === 'activation';
  const tableArr = sqlList(TABLES);
  return `-- accessories-postflight ${stage}
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'release_state', (SELECT count(*) = 1 AND bool_and(r.enabled = ${enabled} AND r.category_id = c.id) FROM public.accessory_release_v1 r JOIN public.categories c ON c.slug = 'mobile-accessories'),
  'category_state', (SELECT count(*) = 1 FROM public.categories c
      WHERE c.slug = 'mobile-accessories' AND c.macro_category = 'goods' AND c.is_active = ${enabled} AND c.new_listing_enabled = false
        AND c.id = (SELECT category_id FROM public.accessory_release_v1)),
  'no_required_attributes', NOT EXISTS (SELECT 1 FROM public.category_attributes a JOIN public.categories c ON c.id = a.category_id WHERE c.slug = 'mobile-accessories' AND a.is_required),
  'type_catalogue', (SELECT count(*) = ${TYPE_IDS.length} AND array_agg(id ORDER BY id) = ${sqlList(TYPE_IDS)}::text[] FROM public.accessory_types_v1),
  'catalogue_rpc', (SELECT (x->>'version') = '1' AND x->>'revision' = 'accessories-v1' AND (x->>'enabled')::boolean = ${enabled}
      AND (x->>'listing_category_id')::uuid = (SELECT category_id FROM public.accessory_release_v1) FROM (SELECT public.accessories_v1_catalogue() AS x) q),
  'discovery_rpc', (SELECT jsonb_typeof(x->'items') = 'array' AND jsonb_typeof(x->'total_count') = 'number'${enabled ? '' : " AND (x->>'total_count') = '0' AND jsonb_array_length(x->'items') = 0"}
      FROM (SELECT public.search_accessories_v1('{}'::jsonb) AS x) q),
  'rls_forced', (SELECT count(*) = 3 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid = ANY (SELECT to_regclass('public.' || t) FROM unnest(${tableArr}) t)),
  'rls_policies', (SELECT count(*) = 3 AND bool_and(cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND cardinality(roles) = 2 AND roles::text[] @> ARRAY['anon','authenticated']
        AND (tablename, policyname) IN (('accessory_release_v1','accessory_release_read'),('accessory_types_v1','accessory_types_read'),('listing_accessory_contexts','accessory_context_read')))
      FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (${tableArr})),
  'no_client_writes', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public','anon','authenticated','service_role']) r CROSS JOIN unnest(${tableArr}) t
      WHERE has_any_column_privilege(r, 'public.' || t, 'INSERT') OR has_any_column_privilege(r, 'public.' || t, 'UPDATE') OR has_any_column_privilege(r, 'public.' || t, 'REFERENCES')
         OR has_table_privilege(r, 'public.' || t, 'DELETE') OR has_table_privilege(r, 'public.' || t, 'TRUNCATE') OR has_table_privilege(r, 'public.' || t, 'TRIGGER')),
  'table_read_acl', (SELECT bool_and(has_table_privilege('anon', 'public.' || t, 'SELECT') AND has_table_privilege('authenticated', 'public.' || t, 'SELECT')
        AND NOT has_table_privilege('public', 'public.' || t, 'SELECT') AND NOT has_table_privilege('service_role', 'public.' || t, 'SELECT')) FROM unnest(${tableArr}) t),
  'accessory_function_acl', ${functionAclSql(ACCESSORY_FUNCTIONS)},
  'mobile_function_acl', ${functionAclSql(MOBILE_FUNCTIONS)},
  'listing_guard_trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.listings'::regclass AND tgname = 'zz_accessory_listing_guard_v1' AND NOT tgisinternal AND tgenabled = 'O'),
  'mobile_wrappers_extended', (SELECT count(*) = 2 AND bool_and(p.prosrc ILIKE '%accessor%') FROM pg_proc p
      WHERE p.oid IN (to_regprocedure('app_security.impl_submit_mobile_v2(jsonb)'), to_regprocedure('app_security.impl_posting_v2_session(uuid,text,uuid)'))),
  'mobile_category_active', EXISTS (SELECT 1 FROM public.categories WHERE slug = 'mobile-phones' AND is_active),
  'session_recovery_column', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'posting_upload_sessions' AND column_name = 'draft_protected'),
  'tablets_not_wrapped', to_regprocedure('app_security.impl_submit_mobile_v2_before_tablets(jsonb)') IS NULL${enabled ? '' : `,
  'no_accessory_rows', NOT EXISTS (SELECT 1 FROM public.listing_accessory_contexts) AND NOT EXISTS (SELECT 1 FROM public.listings l JOIN public.categories c ON c.id = l.category_id WHERE c.slug = 'mobile-accessories')`}
)::text;
COMMIT;`;
}

export function postflightKeys(stage) {
  const keys = ['release_state', 'category_state', 'no_required_attributes', 'type_catalogue', 'catalogue_rpc', 'discovery_rpc', 'rls_forced',
    'rls_policies', 'no_client_writes', 'table_read_acl', 'accessory_function_acl', 'mobile_function_acl', 'listing_guard_trigger',
    'mobile_wrappers_extended', 'mobile_category_active', 'session_recovery_column', 'tablets_not_wrapped'];
  if (stage === 'foundation') keys.push('no_accessory_rows');
  return keys;
}

// Only these two assertions describe the pre-Tablets phone wrappers; Tablets legitimately replaces them. A caller may exempt
// them solely in a separately verified post-Tablets adoption. Every other key must still be true.
export const POST_TABLETS_EXEMPT_KEYS = Object.freeze(['mobile_wrappers_extended', 'tablets_not_wrapped']);

export function runAccessoriesPostflight(candidate, rawOutput, {exemptKeys = []} = {}) {
  if (exemptKeys.some(k => !POST_TABLETS_EXEMPT_KEYS.includes(k))) fail('POSTFLIGHT_EXEMPTION_NOT_ALLOWED');
  let check;
  try {
    check = JSON.parse(String(rawOutput).trim());
  } catch {
    fail('POSTFLIGHT_INVALID_RESPONSE');
  }
  const keys = postflightKeys(candidate.stage);
  if (!check || typeof check !== 'object' || Array.isArray(check)) fail('POSTFLIGHT_INVALID_RESPONSE');
  const unexpected = Object.keys(check).filter(k => !keys.includes(k));
  const failed = keys.filter(k => check[k] !== true && !exemptKeys.includes(k));
  const missing = exemptKeys.filter(k => !(k in check));
  if (missing.length) failed.push(...missing);
  if (unexpected.length || failed.length) {
    fail('POSTFLIGHT_VERIFICATION_FAILED', [...failed, ...unexpected.map(k => `unexpected:${k}`)].join(','));
  }
  return check;
}

// ---- Web evidence and prior stage evidence -----------------------------------------------------

// Re-derives the offline plan inside the runner so it cannot be reached with weaker evidence than the workflow checked.
export function assertStageInputs(candidate, environment, ctx) {
  if (!candidate.strict) return null;
  return planDispatch({
    candidateId: candidate.id,
    target: environment === 'FairSwapProd' ? 'production' : 'test',
    inputs: {
      web_staging_sha: ctx.WEB_STAGING_SHA, web_production_sha: ctx.WEB_PRODUCTION_SHA,
      test_catalogue_run_id: ctx.TEST_CATALOGUE_RUN_ID,
      test_foundation_run_id: ctx.TEST_FOUNDATION_RUN_ID, test_activation_run_id: ctx.TEST_ACTIVATION_RUN_ID,
      prod_foundation_run_id: ctx.PROD_FOUNDATION_RUN_ID,
      accessories_prod_foundation_run_id: ctx.ACCESSORIES_PROD_FOUNDATION_RUN_ID, test_e2e_run_id: ctx.TEST_E2E_RUN_ID
    }
  });
}

const GITHUB_HEADERS = token => ({Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'});

export async function getJson(url, token, fetcher, code = 'EVIDENCE_LOOKUP_FAILED') {
  const res = await fetcher(url, {headers: GITHUB_HEADERS(token)});
  if (!res.ok) {
    const hint = code === 'WEB_DEPLOYMENT_LOOKUP_FAILED' && res.status === 404
      ? ' (check FairSwap-Web access and Deployments/Contents read permissions on CHAT_RELEASE_AUDIT_TOKEN)'
      : '';
    fail(code, `${res.status}${hint}`);
  }
  return res.json();
}

// ---- Web deployment evidence -------------------------------------------------------------------

// Pure inspection of GitHub Deployments of the Web repository (created and updated by the Vercel integration).
// Staging evidence must come from a non-Production environment, Production evidence only from the Production
// environment, so one environment can never satisfy the other.
export async function deploymentReady(pin, token, fetcher, sha, wantProduction) {
  const web = pin.repository;
  const list = await getJson(`https://api.github.com/repos/${web}/deployments?sha=${sha}&per_page=100`, token, fetcher, 'WEB_DEPLOYMENT_LOOKUP_FAILED');
  if (!Array.isArray(list)) fail('WEB_DEPLOYMENT_LOOKUP_FAILED', 'shape');
  const candidates = list.filter(d => d && d.sha === sha && (d.environment === pin.productionEnvironment) === wantProduction);
  for (const d of candidates) {
    const statuses = await getJson(`https://api.github.com/repos/${web}/deployments/${d.id}/statuses?per_page=1`, token, fetcher, 'WEB_DEPLOYMENT_LOOKUP_FAILED');
    if (Array.isArray(statuses) && statuses[0]?.state === 'success') return d;
  }
  return null;
}

// Fails closed: without a readable, matching, READY deployment nothing may proceed to Accessories activation.
export async function verifyWebDeployments(plan, c, fetcher = fetch) {
  if (!plan.candidate.strict) return null;
  const token = c.WEB_EVIDENCE_TOKEN;
  if (!token) fail('WEB_EVIDENCE_UNAVAILABLE', 'no token');
  const pin = webPin(plan.candidate);
  const web = pin.repository;
  const result = {};
  if (plan.webStagingSha) {
    const d = await deploymentReady(pin, token, fetcher, plan.webStagingSha, false);
    if (!d) fail('WEB_STAGING_DEPLOYMENT_NOT_READY', plan.webStagingSha);
    result.stagingDeploymentId = d.id;
  }
  if (plan.webProductionSha) {
    const sha = plan.webProductionSha;
    const live = await getJson(`https://api.github.com/repos/${web}/deployments?environment=${pin.productionEnvironment}&per_page=1`, token, fetcher, 'WEB_DEPLOYMENT_LOOKUP_FAILED');
    if (!Array.isArray(live) || live[0]?.sha !== sha || live[0]?.environment !== pin.productionEnvironment) fail('WEB_PRODUCTION_NOT_CURRENT_DEPLOYMENT', sha);
    const d = await deploymentReady(pin, token, fetcher, sha, true);
    if (!d || d.id !== live[0].id) fail('WEB_PRODUCTION_DEPLOYMENT_NOT_READY', sha);
    // The deployed Production commit must contain the tested staging commit and be an ancestor of (or equal to) Web main.
    const tested = await getJson(`https://api.github.com/repos/${web}/compare/${plan.webStagingSha}...${sha}`, token, fetcher, 'WEB_DEPLOYMENT_LOOKUP_FAILED');
    if (!['ahead', 'identical'].includes(tested.status)) fail('WEB_PRODUCTION_MISSING_TESTED_RELEASE', sha);
    const main = await getJson(`https://api.github.com/repos/${web}/compare/${sha}...main`, token, fetcher, 'WEB_DEPLOYMENT_LOOKUP_FAILED');
    if (!['ahead', 'identical'].includes(main.status)) fail('WEB_PRODUCTION_NOT_ON_MAIN', sha);
    result.productionDeploymentId = d.id;
  }
  return result;
}

// ---- Prior stage evidence ----------------------------------------------------------------------

const MAX_RECEIPT_ZIP = 256 * 1024;
const MAX_RECEIPT_FILE = 64 * 1024;
export const RECEIPT_STATUSES = ['APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED', 'ALREADY_APPLIED_VERIFIED'];
export const ENVIRONMENT_NAMES = {test: 'FairSwapTest', prod: 'FairSwapProd'};
// Which earlier runs a receipt must itself record, keyed by `${candidateId}|${environment}`.
const RECEIPT_CHAIN = {
  'accessories-v1-foundation|test': [],
  'accessories-v1-activation|test': ['test_foundation_run_id'],
  'accessories-v1-foundation|prod': ['test_foundation_run_id', 'test_activation_run_id'],
  'accessories-v1-activation|prod': [],
  'tablets-v2-catalogue|test': [],
  'tablets-v2-catalogue|prod': ['test_catalogue_run_id'],
  'tablets-v1-foundation|test': [],
  'tablets-v1-activation|test': ['test_foundation_run_id'],
  'tablets-v1-foundation|prod': ['test_foundation_run_id', 'test_activation_run_id'],
  'tablets-v1-activation|prod': [],
  'wearables-v1-foundation|test': [],
  'wearables-v1-activation|test': ['test_foundation_run_id'],
  'wearables-v1-foundation|prod': ['test_foundation_run_id', 'test_activation_run_id'],
  'wearables-v1-activation|prod': []
};
// Candidates whose receipts must carry the installed-statements ledger hash (Test→Production byte identity).
export const usesLedgerHash = candidate => candidate.id === 'tablets-v2-catalogue' || /^(tablets|wearables)-v1-/.test(candidate.id);

// Minimal bounded ZIP reader for the single GitHub artifact archive (stored or deflate entries only).
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.length > MAX_RECEIPT_ZIP) fail('RECEIPT_ARCHIVE_INVALID');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('RECEIPT_ARCHIVE_INVALID');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count < 1 || count > 8) fail('RECEIPT_ARCHIVE_INVALID');
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) fail('RECEIPT_ARCHIVE_INVALID');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(name) || files.has(name) || usize > MAX_RECEIPT_FILE) fail('RECEIPT_ARCHIVE_INVALID');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) fail('RECEIPT_ARCHIVE_INVALID');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) fail('RECEIPT_ARCHIVE_INVALID');
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      try { data = inflateRawSync(raw, {maxOutputLength: MAX_RECEIPT_FILE}); } catch { fail('RECEIPT_ARCHIVE_INVALID'); }
    } else fail('RECEIPT_ARCHIVE_INVALID');
    if (data.length !== usize) fail('RECEIPT_ARCHIVE_INVALID');
    files.set(name, data);
  }
  return files;
}

// Pure check of a receipt's contents against everything the earlier stage must have proved.
export function validateReceipt(p, c, files, {originalChain = false} = {}) {
  const candidate = getCandidate(p.candidateId);
  const env = ENVIRONMENT_NAMES[p.environment];
  const lower = env.toLowerCase();
  const jsonName = `${candidate.id}-${lower}.json`;
  const sumsName = `SHA256SUMS_${lower}`;
  const body = files.get(jsonName);
  const sums = files.get(sumsName);
  if (!body || !sums) fail('RECEIPT_CONTENT_INVALID', `${p.key}:files`);
  const digest = createHash('sha256').update(body).digest('hex');
  if (sums.toString('utf8') !== `${digest}  ${jsonName}\n`) fail('RECEIPT_CONTENT_INVALID', `${p.key}:checksum`);
  let r;
  try { r = JSON.parse(body.toString('utf8')); } catch { fail('RECEIPT_CONTENT_INVALID', `${p.key}:json`); }
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('RECEIPT_CONTENT_INVALID', `${p.key}:json`);
  const chain = RECEIPT_CHAIN[`${candidate.id}|${p.environment}`];
  const stagingWeb = candidate.stage === 'activation' || p.environment === 'prod' ? webPin(candidate).stagingSha : null;
  const checks = {
    candidate: r.candidateId === candidate.id,
    version: r.migrationVersion === candidate.version && r.migrationFile === candidate.filename,
    hash: r.migrationSha256 === candidate.sha256 &&
      (!usesLedgerHash(candidate) || /^[a-f0-9]{64}$/.test(r.ledgerStatementsSha256 ?? '')),
    environment: r.environment === env && r.projectRef === PROJECT_REFS[env],
    commit: r.reviewedCommit === c.GITHUB_SHA,
    run: String(r.releaseWorkflowRun) === p.runId,
    postflight: r.postflightVerified === true && RECEIPT_STATUSES.includes(r.status),
    stage: r.stage === candidate.stage,
    web: candidate.id === 'tablets-v2-catalogue' && p.environment === 'prod'
      ? SHA40.test(r.webStagingSha ?? '') && r.webStagingSha === c.WEB_STAGING_SHA
      : (r.webStagingSha ?? null) === stagingWeb,
    chain: Array.isArray(r.priorRuns) && r.priorRuns.length === chain.length && chain.every((key, i) => {
      const entry = r.priorRuns[i];
      return entry?.key === key && (originalChain
        ? typeof entry.runId === 'string' && ID.test(entry.runId)
        : entry.runId === String(c[key.toUpperCase()] ?? ''));
    })
  };
  const bad = Object.keys(checks).filter(k => !checks[k]);
  if (bad.length) fail('RECEIPT_CONTENT_INVALID', `${p.key}:${bad.join(',')}`);
  return r;
}

export async function downloadArtifact(url, token, fetcher) {
  const res = await fetcher(url, {headers: GITHUB_HEADERS(token), redirect: 'follow'});
  if (!res.ok) fail('EVIDENCE_LOOKUP_FAILED', String(res.status));
  return Buffer.from(await res.arrayBuffer());
}

async function verifyFoundationSource(candidateOrPrevious, previousOrCurrent, currentOrToken, tokenOrFetcher, maybeFetcher) {
  let candidateId, previous, current, token, fetcher;
  if (maybeFetcher !== undefined) {
    candidateId = typeof candidateOrPrevious === 'string' ? candidateOrPrevious : candidateOrPrevious.id;
    previous = previousOrCurrent;
    current = currentOrToken;
    token = tokenOrFetcher;
    fetcher = maybeFetcher;
  } else {
    candidateId = FOUNDATION;
    previous = candidateOrPrevious;
    current = previousOrCurrent;
    token = currentOrToken;
    fetcher = tokenOrFetcher;
  }
  const {candidate, sha256} = verifyCandidateSha(candidateId);
  const base = `https://api.github.com/repos/${BACKEND}`;
  const comparison = await getJson(`${base}/compare/${previous}...${current}?per_page=1`, token, fetcher);
  if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== previous
      || comparison.base_commit?.sha !== previous || comparison.behind_by !== 0) {
    fail('EVIDENCE_ANCESTRY_NOT_VERIFIED');
  }
  const blob = await getJson(`${base}/contents/${candidate.path}?ref=${previous}`, token, fetcher);
  if (blob.type !== 'file' || blob.path !== candidate.path || blob.encoding !== 'base64'
      || typeof blob.content !== 'string' || blob.content.length > 256 * 1024) {
    fail('EVIDENCE_SOURCE_MISMATCH');
  }
  const bytes = Buffer.from(blob.content, 'base64');
  if (blob.size !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    fail('EVIDENCE_SOURCE_MISMATCH');
  }
}

// Wearables recursion follows only the Test links of a receipt (activation's own link is foundation).
const WEARABLES_CHAIN_LINKS = {test_foundation_run_id: 'foundation', test_activation_run_id: 'activation'};
const MAX_CHAIN_DEPTH = 3;

// Ancestor eligibility is opt-in for the Accessories workflow. The protected target
// must still verify the live ledger and state before using the recovered evidence.
// `ancestorPolicy` (a Set of `${candidateId}|${environment}|${key}`) is a separate opt-in used only by Wearables;
// it never applies to a tuple outside the set and defaults to none.
export async function requireStageEvidence(priorRuns, c, fetcher = fetch, {allowFoundationAncestors = false, ancestorPolicy = null} = {}, depth = 0) {
  const receipts = {};
  if (depth > MAX_CHAIN_DEPTH) fail('EVIDENCE_RUN_NOT_VERIFIED', 'chain depth');
  for (const p of priorRuns) {
    const candidate = getCandidate(p.candidateId);
    const base = `https://api.github.com/repos/${c.GITHUB_REPOSITORY}/actions/runs/${p.runId}`;
    const run = await getJson(base, c.GITHUB_TOKEN, fetcher);
    const historical = run.head_sha !== c.GITHUB_SHA;
    const isWearablesTestFoundation = candidate.id === 'wearables-v1-foundation'
      && p.key === 'test_foundation_run_id' && p.environment === 'test';
    const policyAncestor = ancestorPolicy instanceof Set && ancestorPolicy.has(`${candidate.id}|${p.environment}|${p.key}`);
    const allowAncestor = (allowFoundationAncestors && candidate.id === FOUNDATION
      && p.key === `${p.environment}_foundation_run_id` && ['test', 'prod'].includes(p.environment))
      || isWearablesTestFoundation || policyAncestor;
    if (run.path !== WORKFLOW_PATH || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
      || run.status !== 'completed' || run.conclusion !== 'success'
      || (historical && !allowAncestor)) {
      fail('EVIDENCE_RUN_NOT_VERIFIED', p.key);
    }
    const immutable = allowFoundationAncestors || isWearablesTestFoundation || policyAncestor || candidate.id === 'tablets-v2-catalogue';
    if (immutable && (c.GITHUB_REPOSITORY !== BACKEND || !c.GITHUB_TOKEN || !ID.test(p.runId)
        || !SHA40.test(run.head_sha) || !SHA40.test(c.GITHUB_SHA)
        || String(run.id) !== p.runId || run.workflow_id !== WORKFLOW_ID
        || run.head_repository?.full_name !== BACKEND || run.actor?.login !== 'vivek2310sharma'
        || run.triggering_actor?.login !== 'vivek2310sharma'
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)) {
      fail('EVIDENCE_RUN_NOT_VERIFIED', p.key);
    }
    if (historical) await verifyFoundationSource(candidate, run.head_sha, c.GITHUB_SHA, c.GITHUB_TOKEN, fetcher);

    const data = await getJson(`${base}/artifacts?per_page=100`, c.GITHUB_TOKEN, fetcher);
    const prefix = `reusable-${p.environment}-${p.candidateId}-${p.runId}-`;
    const found = (data.artifacts ?? []).filter(a => a.expired === false && String(a.workflow_run?.id) === p.runId
      && (immutable ? a.name === prefix + run.run_attempt : a.name.startsWith(prefix)));
    if (!found.length || (immutable && found.length !== 1)) fail('EVIDENCE_RECEIPT_MISSING', p.key);
    for (const a of found) {
      const artifactBase = `https://api.github.com/repos/${c.GITHUB_REPOSITORY}/actions/artifacts/`;
      if (typeof a.archive_download_url !== 'string' || !a.archive_download_url.startsWith(artifactBase)
        || (immutable && (!ID.test(String(a.id)) || a.archive_download_url !== `${artifactBase}${a.id}/zip`
          || a.workflow_run?.head_sha !== run.head_sha))) {
        fail('RECEIPT_CONTENT_INVALID', `${p.key}:url`);
      }
      const zip = await downloadArtifact(a.archive_download_url, c.GITHUB_TOKEN, fetcher);
      if (immutable && a.digest !== `sha256:${createHash('sha256').update(zip).digest('hex')}`) {
        fail('RECEIPT_CONTENT_INVALID', `${p.key}:artifact digest`);
      }
      // Wearables links are re-verified below from the receipt's recorded runs, so the chain is matched in original mode.
      const receipt = validateReceipt(p, {...c, GITHUB_SHA: run.head_sha}, readZipEntries(zip), {originalChain: historical || policyAncestor});
      if ((policyAncestor || isWearablesTestFoundation) && receipt.recoveredFoundationCommit !== undefined) {
        fail('RECEIPT_CONTENT_INVALID', `${p.key}:release result`);
      }
      if (immutable && (receipt.webProductionSha !== null
        || (receipt.recoveredFoundationCommit !== undefined &&
          (!SHA40.test(receipt.recoveredFoundationCommit) || receipt.recoveredFoundationCommit === run.head_sha
            || receipt.status !== 'ALREADY_APPLIED_VERIFIED' || (candidate.id === FOUNDATION ? p.environment !== 'prod' : p.environment !== 'test')))
        || JSON.stringify(receipt.dryRunPending) !== JSON.stringify(
        receipt.status === 'ALREADY_APPLIED_VERIFIED' ? [] : [candidate.filename]))) {
        fail('RECEIPT_CONTENT_INVALID', `${p.key}:release result`);
      }
      if (receipts[p.key] && receipts[p.key].ledgerStatementsSha256 !== receipt.ledgerStatementsSha256) {
        fail('RECEIPT_CONTENT_INVALID', `${p.key}:inconsistent ledger hashes`);
      }
      if (policyAncestor && receipt.priorRuns.length) {
        // Bounded to the allowlisted stage chain: each recorded run must be a verified run of the exact earlier stage,
        // at this receipt's commit or an ancestor of it, with its own SQL hash, artifact digest and receipt checked.
        const links = receipt.priorRuns.map(x => ({key: x.key, runId: x.runId}));
        const family = candidate.id.slice(0, -candidate.stage.length);
        if (new Set([p.runId, ...links.map(x => x.runId)]).size !== links.length + 1
            || links.some(x => !WEARABLES_CHAIN_LINKS[x.key])) {
          fail('EVIDENCE_RUN_NOT_VERIFIED', `${p.key}:chain`);
        }
        const linked = await requireStageEvidence(links.map(x => ({
          ...x, candidateId: family + WEARABLES_CHAIN_LINKS[x.key], environment: 'test'
        })), {...c, GITHUB_SHA: run.head_sha}, fetcher, {allowFoundationAncestors, ancestorPolicy}, depth + 1);
        // Test -> Production byte identity: a Production foundation records the Test foundation's installed-statements hash.
        const testFoundation = linked.test_foundation_run_id;
        if (candidate.stage === 'foundation' && testFoundation
            && testFoundation.ledgerStatementsSha256 !== receipt.ledgerStatementsSha256) {
          fail('RECEIPT_CONTENT_INVALID', `${p.key}:ledger hash`);
        }
      }
      if (historical && p.environment === 'prod' && !policyAncestor) {
        const [foundation, activation] = receipt.priorRuns;
        const testReceipts = await requireStageEvidence([
          {...foundation, candidateId: FOUNDATION, environment: 'test'},
          {...activation, candidateId: ACTIVATION, environment: 'test'}
        ], {...c, GITHUB_SHA: run.head_sha, TEST_FOUNDATION_RUN_ID: foundation.runId,
          TEST_ACTIVATION_RUN_ID: activation.runId}, fetcher, {allowFoundationAncestors: true});
        const testCommit = testReceipts.test_foundation_run_id.reviewedCommit;
        if (testCommit !== run.head_sha &&
            (testReceipts.test_activation_run_id.recoveredFoundationCommit !== testCommit
              || receipt.recoveredFoundationCommit !== testCommit)) {
          fail('EVIDENCE_RECOVERY_TEST_NOT_VERIFIED');
        }
      }
      receipts[p.key] = receipt;
    }
  }
  return receipts;
}

// Production foundation may rely on Test's ancestor foundation only through a
// current Test activation receipt that records its successful live verification.
export function recoveredFoundationSha(plan, receipts, current) {
  const entry = plan.priorRuns.find(p => p.candidateId === FOUNDATION);
  if (!entry) return '';
  const previous = receipts[entry.key].reviewedCommit;
  if (previous === current) return '';
  if (!SHA40.test(previous)) fail('EVIDENCE_RUN_NOT_VERIFIED', entry.key);
  if (plan.candidate.id === FOUNDATION &&
      receipts.test_activation_run_id?.recoveredFoundationCommit !== previous) {
    fail('EVIDENCE_RECOVERY_TEST_NOT_VERIFIED');
  }
  return previous;
}
