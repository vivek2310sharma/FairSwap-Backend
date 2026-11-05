// Wearables V1 release gates: Mobile Phones history reconciliation, live preflight, strict read-only postflight
// (a catalogue/ACL/ownership/moderation integrity check, NOT an E2E), narrowly scoped cross-commit Accessories evidence
// and independent Test E2E evidence. Read-only against hosted databases; nothing here applies SQL.
import {createHash} from 'node:crypto';
import {PROJECT_REFS, adoptionAttestation, getAdoption, getCandidate, webPin} from './reusable-candidates.mjs';
import {
  ENVIRONMENT_NAMES, RECEIPT_STATUSES, WORKFLOW_PATH, deploymentReady, downloadArtifact, fail, functionAclSql, getJson, readZipEntries
} from './accessories-v1-release.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,15}$/;
const ACCESSORIES_FOUNDATION = 'accessories-v1-foundation';

// ---- Mobile Phones history reconciliation ------------------------------------------------------
// Hosted ledgers record Mobile Phones under environment-specific versions that differ from the original filenames
// (20261025131116 / 20261025135152). The original versions are therefore never a ledger requirement. Provenance is
// proven per environment from this table, together with the installed objects checked by the live preflight.
export const MOBILE_PHONES_HISTORY = Object.freeze({
  FairSwapTest: Object.freeze([
    Object.freeze({version: '20261025195136', name: 'posting_v2_mobiles_foundation_20261025131116'}),
    Object.freeze({version: '20261025195824', name: 'activate_posting_v2_mobiles_20261025135152'})
  ]),
  FairSwapProd: Object.freeze([
    Object.freeze({version: '20261025200401', name: 'posting_v2_mobiles_foundation_20261025131116'}),
    Object.freeze({version: '20261025201712', name: 'activate_posting_v2_mobiles_20261025135152'})
  ])
});

// ledgerRows: readTabletsLedger() output (version, name, hasStatements). Fails closed on a missing, mixed or renamed history.
export function assertMobilePhonesProvenance(environment, ledgerRows) {
  const mine = MOBILE_PHONES_HISTORY[environment];
  if (!mine || !Array.isArray(ledgerRows)) fail('WEARABLES_MOBILE_HISTORY_INVALID');
  const other = MOBILE_PHONES_HISTORY[environment === 'FairSwapTest' ? 'FairSwapProd' : 'FairSwapTest'];
  const versions = new Set(ledgerRows.map(row => row.version));
  const foreign = other.filter(entry => versions.has(entry.version));
  if (foreign.length) fail('WEARABLES_MOBILE_HISTORY_MIXED', foreign.map(entry => entry.version).join(','));
  for (const entry of mine) {
    const row = ledgerRows.find(r => r.version === entry.version);
    if (!row) fail('WEARABLES_MOBILE_HISTORY_MISSING', entry.version);
    if (row.name !== entry.name) fail('WEARABLES_MOBILE_HISTORY_NAME_MISMATCH', entry.version);
    if (row.hasStatements !== true) fail('WEARABLES_MOBILE_HISTORY_NO_STATEMENTS', entry.version);
  }
  return mine.map(entry => entry.version);
}

// The CLI refuses to insert a migration older than the remote tail; fail closed with a clear code instead.
export function assertLedgerTail(candidate, ledgerRows) {
  const ahead = ledgerRows.filter(row => row.version >= candidate.version).map(row => row.version);
  if (ahead.length) fail('WEARABLES_LEDGER_TAIL_AHEAD', ahead.join(','));
}

// ---- Live read-only SQL ------------------------------------------------------------------------

const TABLES = [
  'wearable_release_v1', 'wearable_catalogue_revision_v1', 'wearable_brands_v1', 'wearable_models_v1',
  'wearable_session_bindings_v1', 'listing_wearable_contexts_v1', 'listing_wearable_risk_flags_v1'
];
const tableArr = `ARRAY[${TABLES.map(t => `'${t}'`).join(',')}]`;
const SESSION = 'app_security.impl_posting_v2_session(uuid,text,uuid)';
const CORE = 'app_security.impl_posting_session_core_v1(uuid,text,uuid,uuid)';
const WEARABLE_SESSION = 'app_security.impl_wearable_v1_session(uuid,text,uuid)';

// W-AZ-1: the activation migration wraps the installed Azure finalizer (20261104113705, history untouched). The wrapper keeps the
// original name; the Azure body is renamed and must remain byte-identical (sha256 of pg_proc.prosrc, derived from the pinned Azure file).
// Resequenced provider-switching (20261104223000) updates the inner body while preserving the outer W-AZ-1 wrapper.
const FINALIZER = 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)';
const FINALIZER_AZURE = 'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)';
export const AZURE_FINALIZER_BODY_SHA256 = 'fb49b713b5e37b784df6c43cad18ad63a036796d0463a2ad7350acf011ee30be';
export const SWITCHING_FINALIZER_BODY_SHA256 = 'da759b51a920b6ff3048a2a1f53527fc1bb35373878c1f53ee904b505189556e';
const bodyIsAzure = sig => `(SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') IN ('${AZURE_FINALIZER_BODY_SHA256}', '${SWITCHING_FINALIZER_BODY_SHA256}')
  AND prosecdef AND provolatile = 'v' AND prorettype = 'jsonb'::regtype AND proconfig @> ARRAY['search_path=""']::text[]
  FROM pg_proc WHERE oid = to_regprocedure('${sig}'))`;

const readOnly = sql => `BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; ${sql}; COMMIT;`;

function requireChecks(exec, checks, phase) {
  const fields = Object.entries(checks).map(([key, sql]) => `'${key}', (${sql})`);
  let result;
  try {
    result = JSON.parse(exec(readOnly(`SELECT jsonb_build_object(${fields.join(', ')})::text`)));
  } catch (error) {
    if (String(error?.message).startsWith('REUSABLE_')) throw error;
    fail(`WEARABLES_${phase}_INVALID_RESPONSE`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(`WEARABLES_${phase}_INVALID_RESPONSE`);
  const unexpected = Object.keys(result).filter(key => !(key in checks));
  const failed = Object.keys(checks).filter(key => result[key] !== true);
  if (unexpected.length || failed.length) {
    fail(`WEARABLES_${phase}_FAILED`, [...failed, ...unexpected.map(key => `unexpected:${key}`)].join(','));
  }
  return result;
}

// Objects the foundation migration builds on. Any drift aborts before a single migration is applied.
const BASELINE_CHECKS = {
  phone_objects: `to_regprocedure('public.submit_mobile_v2(jsonb)') IS NOT NULL
    AND to_regprocedure('app_security.impl_submit_mobile_v2(jsonb)') IS NOT NULL
    AND to_regprocedure('public.posting_v2_session(uuid,text,uuid)') IS NOT NULL
    AND to_regprocedure('${SESSION}') IS NOT NULL
    AND to_regprocedure('app_security.phone_content_guard(text)') IS NOT NULL`,
  mobile_category_defined: `EXISTS (SELECT FROM public.posting_category_definitions
    WHERE category_key = 'mobiles' AND subcategory_key = 'mobile-phones' AND version = 2)`,
  session_recovery: `EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'posting_upload_sessions' AND column_name = 'draft_protected')`,
  accessories_installed: "to_regclass('public.accessory_release_v1') IS NOT NULL",
  mobile_function_acl: functionAclSql([
    ['public.submit_mobile_v2(jsonb)', false, false, true],
    ['public.posting_v2_session(uuid,text,uuid)', false, false, true],
    ['app_security.impl_submit_mobile_v2(jsonb)', true, false, true],
    [SESSION, true, false, true]
  ])
};

export function runWearablesPreflight(candidate, exec) {
  if (candidate.stage === 'foundation') {
    // Never names a Wearables relation: PostgreSQL resolves relations at parse time, even in an untaken branch.
    return requireChecks(exec, {
      ...BASELINE_CHECKS,
      session_baseline: `to_regprocedure('${SESSION}') IS NOT NULL AND (SELECT pg_get_functiondef(to_regprocedure('${SESSION}'))
        LIKE '%accessory_release_v1%' AND pg_get_functiondef(to_regprocedure('${SESSION}')) LIKE '%list_recovery%'
        AND pg_get_functiondef(to_regprocedure('${SESSION}')) NOT LIKE '%wearable%')`,
      wearables_absent: `to_regclass('public.wearable_release_v1') IS NULL AND to_regprocedure('${CORE}') IS NULL
        AND to_regprocedure('public.submit_wearable_v1(jsonb)') IS NULL`,
      category_clean: `NOT EXISTS (SELECT FROM public.categories WHERE slug = 'wearables' AND (is_active OR new_listing_enabled))
        AND NOT EXISTS (SELECT FROM public.listings l JOIN public.categories c ON c.id = l.category_id WHERE c.slug = 'wearables')`
    }, 'PREFLIGHT');
  }
  return requireChecks(exec, {
    ...BASELINE_CHECKS,
    foundation_installed: `to_regclass('public.wearable_release_v1') IS NOT NULL AND to_regprocedure('${CORE}') IS NOT NULL
      AND to_regprocedure('public.submit_wearable_v1(jsonb)') IS NOT NULL`,
    // The installed finalizer must be exactly the reviewed Azure body and not yet wrapped; otherwise activation aborts (BASELINE_DRIFT).
    azure_finalizer_baseline: `to_regprocedure('${FINALIZER_AZURE}') IS NULL AND ${bodyIsAzure(FINALIZER)}`,
    foundation_disabled: `(SELECT count(*) = 1 AND NOT bool_or(r.enabled OR c.is_active OR c.new_listing_enabled)
      FROM public.wearable_release_v1 r JOIN public.categories c ON c.id = r.category_id)`,
    catalogue_complete: `(SELECT count(*) = 1 AND bool_and(v.rows_approved = (SELECT count(*) FROM public.wearable_models_v1 WHERE status = 'approved'))
      FROM public.wearable_catalogue_revision_v1 v)`
  }, 'PREFLIGHT');
}

const noClientWrites = `NOT EXISTS (SELECT FROM unnest(${tableArr}) t
  CROSS JOIN unnest(ARRAY['public','anon','authenticated','service_role']) r
  WHERE has_any_column_privilege(r, 'public.' || t, 'INSERT, UPDATE, REFERENCES')
     OR has_table_privilege(r, 'public.' || t, 'DELETE, TRUNCATE, TRIGGER'))`;

const FUNCTIONS = [
  ['public.wearables_v1_catalogue()', false, false, true],
  ['public.wearable_v1_session(uuid,text,uuid)', false, false, true],
  ['public.submit_wearable_v1(jsonb)', false, false, true],
  ['public.search_wearables_v1(jsonb)', false, true, true],
  [WEARABLE_SESSION, true, false, true],
  ['app_security.impl_submit_wearable_v1(jsonb)', true, false, true],
  ['app_security.impl_search_wearables_v1(jsonb)', true, true, true],
  ['app_security.validate_wearable_v1(jsonb)', true, false, false],
  ['app_security.wearable_listing_guard_v1()', true, false, false],
  [CORE, true, false, false],
  ['app_security.wearable_name_key(text)', false, false, true],
  ['app_security.wearable_base_key(text)', false, false, true],
  ['public.submit_mobile_v2(jsonb)', false, false, true],
  ['public.posting_v2_session(uuid,text,uuid)', false, false, true],
  ['app_security.impl_submit_mobile_v2(jsonb)', true, false, true],
  [SESSION, true, false, true]
];

// Keys are part of the receipt contract; changing them is a reviewed change.
export function wearablesPostflightChecks(stage) {
  const enabled = stage === 'activation';
  const checks = {
    release_state: `(SELECT count(*) = 1 AND bool_and(r.enabled = ${enabled} AND c.slug = 'wearables'
      AND c.is_active = ${enabled} AND NOT c.new_listing_enabled)
      FROM public.wearable_release_v1 r JOIN public.categories c ON c.id = r.category_id)`,
    catalogue_revision: `(SELECT count(*) = 1 AND bool_and(v.rows_approved = (SELECT count(*) FROM public.wearable_models_v1 WHERE status = 'approved'))
      FROM public.wearable_catalogue_revision_v1 v)`,
    forced_rls: `(SELECT count(*) = ${TABLES.length} AND bool_and(relrowsecurity AND relforcerowsecurity)
      FROM pg_class WHERE oid IN (SELECT to_regclass('public.' || t) FROM unnest(${tableArr}) t))`,
    client_permissions: `${noClientWrites}
      AND NOT EXISTS (SELECT FROM unnest(ARRAY['public','anon','service_role']) r CROSS JOIN unnest(${tableArr}) t
        WHERE t <> 'listing_wearable_contexts_v1' AND has_any_column_privilege(r, 'public.' || t, 'SELECT'))
      AND NOT EXISTS (SELECT FROM unnest(ARRAY['public','service_role']) r
        WHERE has_any_column_privilege(r, 'public.listing_wearable_contexts_v1', 'SELECT'))
      AND NOT has_any_column_privilege('authenticated', 'public.wearable_session_bindings_v1', 'SELECT')
      AND NOT has_column_privilege('authenticated', 'public.wearable_models_v1', 'status', 'SELECT')
      AND has_any_column_privilege('anon', 'public.listing_wearable_contexts_v1', 'SELECT')`,
    function_permissions: functionAclSql(FUNCTIONS),
    // Session ownership: the core is reachable only from the two definers that hard-code their category selector, and
    // no transaction setting participates in authorisation.
    session_core_isolation: `(SELECT array_agg(n.nspname || '.' || p.proname ORDER BY p.proname)
        = ARRAY['app_security.impl_posting_v2_session','app_security.impl_wearable_v1_session']
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosrc LIKE '%impl_posting_session_core_v1%' AND p.oid <> to_regprocedure('${CORE}'))
      AND NOT EXISTS (SELECT FROM pg_proc p WHERE p.oid IN (to_regprocedure('${CORE}'), to_regprocedure('${SESSION}'),
        to_regprocedure('${WEARABLE_SESSION}'), to_regprocedure('app_security.impl_submit_wearable_v1(jsonb)'))
        AND (p.prosrc ILIKE '%set_config%' OR p.prosrc ILIKE '%current_setting%'))`,
    session_ownership: `NOT EXISTS (SELECT FROM public.wearable_session_bindings_v1 b
        JOIN public.posting_upload_sessions s ON s.id = b.session_id JOIN public.listings l ON l.id = s.listing_id
        WHERE l.seller_id <> s.owner_id OR l.category_id <> b.category_id)
      AND NOT EXISTS (SELECT FROM public.wearable_session_bindings_v1 b
        WHERE b.category_id <> (SELECT category_id FROM public.wearable_release_v1))
      AND NOT EXISTS (SELECT FROM public.listings l WHERE l.category_id = (SELECT category_id FROM public.wearable_release_v1)
        AND NOT EXISTS (SELECT FROM public.posting_upload_sessions s JOIN public.wearable_session_bindings_v1 b ON b.session_id = s.id
          WHERE s.listing_id = l.id AND s.owner_id = l.seller_id AND b.category_id = l.category_id))
      AND NOT EXISTS (SELECT FROM public.listing_wearable_contexts_v1 x JOIN public.listings l ON l.id = x.listing_id
        WHERE l.category_id <> x.category_id)`,
    moderation_guard: `EXISTS (SELECT FROM pg_trigger WHERE tgrelid = 'public.listings'::regclass
        AND tgname = 'zz_wearable_listing_guard_v1' AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 23
        AND tgfoid = to_regprocedure('app_security.wearable_listing_guard_v1()'))
      AND (SELECT prosrc LIKE '%is_active_staff_aal2%' AND prosrc LIKE '%listing_wearable_risk_flags_v1%'
        AND prosrc LIKE '%Wearable listing requires staff review%' FROM pg_proc WHERE oid = to_regprocedure('app_security.wearable_listing_guard_v1()'))`,
    moderation_flags: `(SELECT count(*) = 1 AND bool_and(cmd = 'SELECT' AND roles::text[] = ARRAY['authenticated']
        AND qual LIKE '%is_active_staff_aal2%') FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'listing_wearable_risk_flags_v1')
      AND NOT EXISTS (SELECT FROM public.listing_wearable_contexts_v1 x
        WHERE (x.other_model OR x.pairing_status IN ('still_paired','unknown'))
        AND NOT EXISTS (SELECT FROM public.listing_wearable_risk_flags_v1 f WHERE f.listing_id = x.listing_id))`,
    session_wrapper: `(SELECT pg_get_functiondef(to_regprocedure('${SESSION}')) LIKE '%impl_posting_session_core_v1%')`,
    catalogue_rpc: `(SELECT (x->>'version') = '1' AND (x->>'enabled')::boolean = ${enabled}
      AND (x->>'listing_category_id')::uuid = (SELECT category_id FROM public.wearable_release_v1)
      FROM (SELECT public.wearables_v1_catalogue() AS x) q)`,
    discovery_rpc: `(SELECT jsonb_typeof(x->'items') = 'array' AND jsonb_typeof(x->'total_count') = 'number'${enabled ? '' : " AND (x->>'total_count') = '0'"}
      FROM (SELECT public.search_wearables_v1('{}'::jsonb) AS x) q)`
  };
  if (enabled) {
    // Flagged wearables can never finalize as auto-approved: the finalizer is the wrapper, the Azure body is intact and
    // callable only through it, and no client role (nor service_role directly) can reach the renamed Azure function.
    checks.azure_finalizer_wearable_routing = `(SELECT prosecdef AND proconfig @> ARRAY['search_path=""']::text[]
        AND prosrc LIKE '%listing_wearable_risk_flags_v1%' AND prosrc LIKE '%impl_finalize_moderation_result_azure_v1%' AND prosrc LIKE '%needs_review%'
        FROM pg_proc WHERE oid = to_regprocedure('${FINALIZER}'))
      AND ${bodyIsAzure(FINALIZER_AZURE)}
      AND has_function_privilege('service_role', '${FINALIZER}', 'EXECUTE')
      AND NOT has_function_privilege('public', '${FINALIZER}', 'EXECUTE') AND NOT has_function_privilege('anon', '${FINALIZER}', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', '${FINALIZER}', 'EXECUTE')
      AND NOT EXISTS (SELECT FROM unnest(ARRAY['public','anon','authenticated','service_role']) r
        WHERE has_function_privilege(r, '${FINALIZER_AZURE}', 'EXECUTE'))`;
  }
  if (!enabled) {
    checks.no_wearable_rows = `NOT EXISTS (SELECT FROM public.listing_wearable_contexts_v1) AND NOT EXISTS (SELECT FROM public.wearable_session_bindings_v1)
      AND NOT EXISTS (SELECT FROM public.listing_wearable_risk_flags_v1)`;
  }
  return checks;
}

export function runWearablesPostflight(candidate, exec) {
  return requireChecks(exec, wearablesPostflightChecks(candidate.stage), 'POSTFLIGHT');
}

// ---- Cross-commit Accessories Production evidence ---------------------------------------------
// Scope: exactly one candidate (accessories-v1-foundation) in exactly one environment (FairSwapProd). Normal stage
// evidence stays same-commit (requireStageEvidence). Here a prior commit is accepted only if it is a verified ancestor.

async function verifiedMainRun(c, runId, fetcher, headSha) {
  const run = await getJson(`https://api.github.com/repos/${c.GITHUB_REPOSITORY}/actions/runs/${runId}`, c.GITHUB_TOKEN, fetcher);
  if (run.path !== WORKFLOW_PATH || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || run.status !== 'completed' || run.conclusion !== 'success' || !SHA40.test(run.head_sha ?? '')
    || (headSha && run.head_sha !== headSha)) {
    fail('CROSS_COMMIT_RUN_NOT_VERIFIED', runId);
  }
  return run;
}

export const ADOPTED_STATUS = 'ADOPTED_EXISTING_INSTALLATION_VERIFIED';

export function validateCrossCommitReceipt(runId, run, files) {
  const candidate = getCandidate(ACCESSORIES_FOUNDATION);
  const jsonName = `${candidate.id}-fairswapprod.json`;
  const sumsName = 'SHA256SUMS_fairswapprod';
  const body = files.get(jsonName);
  const sums = files.get(sumsName);
  if (!body || !sums) fail('CROSS_COMMIT_RECEIPT_INVALID', 'files');
  const digest = createHash('sha256').update(body).digest('hex');
  if (sums.toString('utf8') !== `${digest}  ${jsonName}\n`) fail('CROSS_COMMIT_RECEIPT_INVALID', 'checksum');
  let r;
  try { r = JSON.parse(body.toString('utf8')); } catch { fail('CROSS_COMMIT_RECEIPT_INVALID', 'json'); }
  const chain = Array.isArray(r.priorRuns) ? r.priorRuns : [];
  const adopted = r.status === ADOPTED_STATUS;
  const expected = adopted ? getAdoption(candidate.id, 'FairSwapProd') : null;
  const checks = {
    candidate: r.candidateId === candidate.id && r.stage === 'foundation',
    version: r.migrationVersion === candidate.version && r.migrationFile === candidate.filename,
    hash: r.migrationSha256 === candidate.sha256,
    environment: r.environment === ENVIRONMENT_NAMES.prod && r.projectRef === PROJECT_REFS.FairSwapProd,
    commit: r.reviewedCommit === run.head_sha,
    run: String(r.releaseWorkflowRun) === String(runId),
    postflight: r.postflightVerified === true && (adopted || RECEIPT_STATUSES.includes(r.status)),
    // An adoption receipt attests the installed state only: no Web evidence, no Test chain, and it must say plainly that
    // this workflow did not install the migration and that there is no original release run.
    web: adopted ? r.webStagingSha === null : r.webStagingSha === webPin(candidate).stagingSha,
    chain: adopted
      ? Array.isArray(r.priorRuns) && r.priorRuns.length === 0
      : JSON.stringify(chain.map(x => x?.key)) === JSON.stringify(['test_foundation_run_id', 'test_activation_run_id'])
        && chain.every(x => RUN_ID.test(String(x?.runId ?? ''))),
    adoption: adopted
      ? JSON.stringify(r.adoption) === JSON.stringify(adoptionAttestation(expected))
      : r.adoption === undefined
  };
  const bad = Object.keys(checks).filter(key => !checks[key]);
  if (bad.length) fail('CROSS_COMMIT_RECEIPT_INVALID', bad.join(','));
  return r;
}

export async function requirePriorCommitEvidence(plan, c, fetcher = fetch) {
  const evidence = {};
  for (const prior of plan.crossCommitRuns ?? []) {
    if (prior.candidateId !== ACCESSORIES_FOUNDATION || prior.environment !== 'prod') fail('CROSS_COMMIT_SCOPE_VIOLATION', prior.key);
    if (!c.GITHUB_SHA || !SHA40.test(c.GITHUB_SHA)) fail('CROSS_COMMIT_RUN_NOT_VERIFIED', 'current sha');
    const repo = c.GITHUB_REPOSITORY;
    const run = await verifiedMainRun(c, prior.runId, fetcher);
    // Reviewed commit ancestry: the prior release commit must be contained in the commit being released.
    const compare = await getJson(`https://api.github.com/repos/${repo}/compare/${run.head_sha}...${c.GITHUB_SHA}`, c.GITHUB_TOKEN, fetcher);
    if (!['ahead', 'identical'].includes(compare.status)) fail('CROSS_COMMIT_NOT_ANCESTOR', prior.runId);
    const base = `https://api.github.com/repos/${repo}/actions/runs/${prior.runId}`;
    const data = await getJson(`${base}/artifacts?per_page=100`, c.GITHUB_TOKEN, fetcher);
    const prefix = `reusable-prod-${prior.candidateId}-${prior.runId}-`;
    const found = (data.artifacts ?? []).filter(a => a.name.startsWith(prefix) && a.expired === false && String(a.workflow_run?.id) === prior.runId);
    if (!found.length) fail('CROSS_COMMIT_RECEIPT_MISSING', prior.runId);
    let receipt;
    for (const a of found) {
      if (typeof a.archive_download_url !== 'string' || !a.archive_download_url.startsWith(`https://api.github.com/repos/${repo}/actions/artifacts/`)) {
        fail('CROSS_COMMIT_RECEIPT_INVALID', 'url');
      }
      const next = validateCrossCommitReceipt(prior.runId, run, readZipEntries(await downloadArtifact(a.archive_download_url, c.GITHUB_TOKEN, fetcher)));
      if (receipt && JSON.stringify(receipt) !== JSON.stringify(next)) fail('CROSS_COMMIT_RECEIPT_INVALID', 'inconsistent');
      receipt = next;
    }
    // The recorded Test chain must be successful runs of this workflow on the same reviewed commit (none for adoption).
    for (const x of receipt.priorRuns) await verifiedMainRun(c, String(x.runId), fetcher, run.head_sha);
    evidence[prior.key] = {runId: prior.runId, reviewedCommit: run.head_sha, ledgerVersion: getCandidate(ACCESSORIES_FOUNDATION).version,
      basis: receipt.status === ADOPTED_STATUS ? 'adopted-existing-installation' : 'release-workflow'};
  }
  return evidence;
}

// ---- Independent Test E2E evidence -------------------------------------------------------------
// A SQL postflight is a smoke/integrity check. Production additionally needs a real authenticated journey against the
// Web staging deployment on FairSwapTest, produced by a separate run in the Web repository and bound to the exact
// Wearables SQL, Web staging commit and Test activation run.
export const WEARABLES_E2E = Object.freeze({
  workflowPath: '.github/workflows/wearables-e2e-test.yml',
  artifactPrefix: 'wearables-e2e-test-',
  // The runner commit may differ from the tested staging commit ONLY in these files (no application, SQL or dependency change).
  runnerPaths: Object.freeze([/^\.github\/workflows\/wearables-e2e-test\.yml$/, /^e2e\/wearables\/[A-Za-z0-9._/-]+$/]),
  maxRunnerFiles: 100,
  receiptName: 'wearables-v1-e2e-test.json',
  sumsName: 'SHA256SUMS_e2e',
  schema: 'wearables-v1-e2e/1',
  steps: Object.freeze([
    'authenticated_listing_creation', 'media_upload', 'ownership_rls', 'pairing_state_restrictions',
    'moderator_aal2_review', 'buyer_visibility'
  ])
});

export function validateE2eReceipt(runId, run, c, files, pin = webPin(getCandidate('wearables-v1-activation'))) {
  const body = files.get(WEARABLES_E2E.receiptName);
  const sums = files.get(WEARABLES_E2E.sumsName);
  if (!body || !sums) fail('E2E_RECEIPT_INVALID', 'files');
  const digest = createHash('sha256').update(body).digest('hex');
  if (sums.toString('utf8') !== `${digest}  ${WEARABLES_E2E.receiptName}\n`) fail('E2E_RECEIPT_INVALID', 'checksum');
  let r;
  try { r = JSON.parse(body.toString('utf8')); } catch { fail('E2E_RECEIPT_INVALID', 'json'); }
  const foundation = getCandidate('wearables-v1-foundation');
  const activation = getCandidate('wearables-v1-activation');
  const stepKeys = r.steps && typeof r.steps === 'object' && !Array.isArray(r.steps) ? Object.keys(r.steps) : [];
  const checks = {
    schema: r.schema === WEARABLES_E2E.schema && r.result === 'PASS',
    run: String(r.runId) === String(runId),
    environment: r.environment === 'FairSwapTest' && r.projectRef === PROJECT_REFS.FairSwapTest,
    // webStagingSha is the tested application commit; runnerSha/deployedWebSha is the deployed commit that carries the runner.
    web: r.webStagingSha === pin.stagingSha && r.runnerSha === pin.e2eRunnerSha && run.head_sha === r.runnerSha && r.deployedWebSha === r.runnerSha,
    sql: r.foundationSha256 === foundation.sha256 && r.activationSha256 === activation.sha256,
    activation_run: String(r.testActivationRunId) === String(c.TEST_ACTIVATION_RUN_ID ?? ''),
    flags: r.webFlagEnabledInTest === true && r.webFlagEnabledInProduction === false,
    steps: JSON.stringify([...stepKeys].sort()) === JSON.stringify([...WEARABLES_E2E.steps].sort())
      && WEARABLES_E2E.steps.every(step => r.steps[step] === true)
  };
  const bad = Object.keys(checks).filter(key => !checks[key]);
  if (bad.length) fail('E2E_RECEIPT_INVALID', bad.join(','));
  return r;
}

// `pin` is a test seam only; the workflow always uses the reviewed registry pin.
export async function verifyE2eEvidence(plan, c, fetcher = fetch, pin) {
  if (!plan.e2eRunId) return null;
  pin ??= webPin(plan.candidate);
  const token = c.WEB_EVIDENCE_TOKEN;
  if (!token) fail('E2E_EVIDENCE_UNAVAILABLE', 'no token');
  // The runner commit pin is reviewed Backend source. Unset means no E2E evidence can exist yet: Production stays blocked.
  if (!SHA40.test(pin.e2eRunnerSha ?? '') || pin.e2eRunnerSha === pin.stagingSha) fail('E2E_RUNNER_PIN_UNSET');
  const repo = pin.repository;
  // Source provenance: the runner commit must contain the tested staging commit and add nothing but runner files.
  const diff = await getJson(`https://api.github.com/repos/${repo}/compare/${pin.stagingSha}...${pin.e2eRunnerSha}`, token, fetcher, 'E2E_EVIDENCE_LOOKUP_FAILED');
  const files = Array.isArray(diff.files) ? diff.files : null;
  const allowed = name => typeof name === 'string' && !name.split('/').some(part => part === '' || part === '.' || part === '..')
    && WEARABLES_E2E.runnerPaths.some(re => re.test(name));
  if (diff.status !== 'ahead' || !files || files.length === 0 || files.length > WEARABLES_E2E.maxRunnerFiles
    || files.some(f => !allowed(f.filename) || (f.previous_filename !== undefined && !allowed(f.previous_filename)))) {
    fail('E2E_RUNNER_COMMIT_NOT_ISOLATED', pin.e2eRunnerSha);
  }
  // The runner commit must itself be a READY, non-Production Web deployment (the code the E2E actually exercised).
  if (!await deploymentReady(pin, token, fetcher, pin.e2eRunnerSha, false)) fail('E2E_RUNNER_DEPLOYMENT_NOT_READY', pin.e2eRunnerSha);
  const base = `https://api.github.com/repos/${repo}/actions/runs/${plan.e2eRunId}`;
  const run = await getJson(base, token, fetcher, 'E2E_EVIDENCE_LOOKUP_FAILED');
  if (run.path !== WEARABLES_E2E.workflowPath || run.head_sha !== pin.e2eRunnerSha || run.status !== 'completed' || run.conclusion !== 'success') {
    fail('E2E_RUN_NOT_VERIFIED', plan.e2eRunId);
  }
  const data = await getJson(`${base}/artifacts?per_page=100`, token, fetcher, 'E2E_EVIDENCE_LOOKUP_FAILED');
  const prefix = `${WEARABLES_E2E.artifactPrefix}${plan.e2eRunId}-`;
  const found = (data.artifacts ?? []).filter(a => a.name.startsWith(prefix) && a.expired === false && String(a.workflow_run?.id) === plan.e2eRunId);
  if (!found.length) fail('E2E_RECEIPT_MISSING', plan.e2eRunId);
  let receipt;
  for (const a of found) {
    if (typeof a.archive_download_url !== 'string' || !a.archive_download_url.startsWith(`https://api.github.com/repos/${pin.repository}/actions/artifacts/`)) {
      fail('E2E_RECEIPT_INVALID', 'url');
    }
    const next = validateE2eReceipt(plan.e2eRunId, run, c, readZipEntries(await downloadArtifact(a.archive_download_url, token, fetcher)), pin);
    if (receipt && JSON.stringify(receipt) !== JSON.stringify(next)) fail('E2E_RECEIPT_INVALID', 'inconsistent');
    receipt = next;
  }
  return {runId: plan.e2eRunId, webStagingSha: receipt.webStagingSha, runnerSha: pin.e2eRunnerSha};
}
