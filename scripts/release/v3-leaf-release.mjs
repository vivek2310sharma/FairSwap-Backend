import {requireHostedE2e} from './v3-hosted-e2e.mjs';
// One-leaf operator orchestration. No migrations, switches, provider calls or automatic promotion.
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {V3_GOODS, PROJECT_REFS, getCandidate, planDispatch, verifyCandidateSha} from './reusable-candidates.mjs';
import {getJson, downloadArtifact, readZipEntries, WORKFLOW_PATH} from './accessories-v1-release.mjs';
import {validateRootCertificate} from './fsw-sec-003-prelaunch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const backend = 'vivek2310sharma/FairSwap-Backend';
const web = 'vivek2310sharma/FairSwap-Web';
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw Error(`V3_LEAF_${code}`); };
const leaves = Object.freeze(Object.fromEntries(V3_GOODS.map(g => [g.slug, [g.id, g.parent]])));
const contracts = Object.freeze(Object.fromEntries(V3_GOODS.map(g => [g.slug, g])));

export const WEB_CONTRACT_PATHS = Object.freeze([
  'src/lib/listings/ordinary-goods/categories.ts',
  'src/lib/listings/ordinary-goods/contract.ts',
  'src/lib/listings/ordinary-goods/server.ts',
  'src/app/api/post-ad/goods/[slug]/sessions/route.ts',
  'src/app/api/post-ad/goods/[slug]/sessions/[id]/media/route.ts',
  'src/app/api/post-ad/goods/[slug]/submit/route.ts'
]);

export function leafPlan(candidateId, environment, c) {
  need(PROJECT_REFS[environment] && c.TARGET === (environment === 'FairSwapTest' ? 'test' : 'production'), 'ENVIRONMENT_MISMATCH');
  const plan = planDispatch({candidateId, target: c.TARGET, inputs: {
    web_staging_sha: c.WEB_STAGING_SHA, web_production_sha: c.WEB_PRODUCTION_SHA,
    test_activation_run_id: c.TEST_ACTIVATION_RUN_ID, books_acceptance_run_id: c.BOOKS_ACCEPTANCE_RUN_ID, test_e2e_run_id: c.TEST_E2E_RUN_ID, v3_batch: c.V3_BATCH_JSON
  }});
  need(plan.candidate.v3Batch || (plan.candidate.v3Operation && leaves[plan.candidate.slug]), 'SLUG_NOT_ALLOWED');
  return plan;
}

// Require the current deployment of the exact branch/environment, never an arbitrary preview.
export async function verifyLeafWeb(plan, c, fetcher = fetch) {
  const webSha = plan.webSha ?? plan.plans?.[0]?.webSha;
  need(c.WEB_EVIDENCE_TOKEN, 'WEB_EVIDENCE_REQUIRED');
  const production = plan.target === 'production';
  const environment = production ? 'Production' : 'Preview';
  const branch = production ? 'main' : 'staging';
  const base = `https://api.github.com/repos/${web}`;
  const deployments = await getJson(`${base}/deployments?environment=${environment}&per_page=1`, c.WEB_EVIDENCE_TOKEN, fetcher);
  const d = deployments?.[0];
  need(d?.sha === webSha && d.environment === environment && [branch, webSha].includes(d.ref) && Number.isSafeInteger(d.id), 'WEB_DEPLOYMENT_MISMATCH');
  const tip = await getJson(`${base}/commits/${branch}`, c.WEB_EVIDENCE_TOKEN, fetcher);
  need(tip.sha === webSha, 'WEB_BRANCH_MISMATCH');
  if (production) {
    need(/^[a-f0-9]{40}$/.test(c.WEB_STAGING_SHA ?? ''), 'TESTED_WEB_COMMIT_REQUIRED');
    // Focused Production ports need byte-identical V3 contracts, not staging ancestry.
    for (const path of WEB_CONTRACT_PATHS) {
      const read = async sha => {
        const file = await getJson(`${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, c.WEB_EVIDENCE_TOKEN, fetcher);
        need(file?.type === 'file' && file.path === path && file.encoding === 'base64'
          && typeof file.content === 'string' && file.content.length <= 256 * 1024, 'WEB_CONTRACT_EVIDENCE_INVALID');
        const bytes = Buffer.from(file.content, 'base64');
        need(file.sha === createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), 'WEB_CONTRACT_BLOB_INVALID');
        return hash(bytes);
      };
      need(await read(c.WEB_STAGING_SHA) === await read(webSha), 'WEB_CONTRACT_MISMATCH');
    }
  }
  const statuses = await getJson(`${base}/deployments/${d.id}/statuses?per_page=1`, c.WEB_EVIDENCE_TOKEN, fetcher);
  need(statuses?.[0]?.state === 'success', 'WEB_NOT_READY');
  return {sha: webSha, environment, deploymentId: d.id};
}

export function verifyLeafReceipt(r, p, c) {
  const candidate = getCandidate(p.candidateId);
  need(r?.status === 'V3_LEAF_VERIFIED' && r.postflightVerified === true && r.preservationVerified === true
    && r.candidateId === p.candidateId && r.environment === p.environment && r.projectRef === PROJECT_REFS[p.environment]
    && r.reviewedCommit === c.GITHUB_SHA && r.releaseWorkflowRun === p.runId
    && r.operatorSha256 === candidate.sha256 && r.slug === candidate.slug && r.operation === 'activate'
    && /^[a-f0-9]{40}$/.test(r.webSha ?? '')
    && (p.environment !== 'FairSwapTest' || r.webSha === c.WEB_STAGING_SHA)
    && (p.environment !== 'FairSwapProd' || r.webSha === c.WEB_PRODUCTION_SHA), 'ACCEPTANCE_RECEIPT_INVALID');
  return r;
}

export async function requireLeafEvidence(plan, c, fetcher = fetch) {
  if (plan.plans) {
    for (const leaf of plan.plans) await requireLeafEvidence(leaf, leafContext(c, leaf), fetcher);
    return;
  }
  if (plan.target === 'production' && plan.candidate.v3Operation === 'activate') {
    if (!c.TEST_E2E_RUN_ID || !c.WEB_EVIDENCE_TOKEN) throw Error('V3_LEAF_HOSTED_TEST_E2E_EVIDENCE_UNAVAILABLE');
    await requireHostedE2e(plan, c, fetcher);
  }
  for (const p of plan.priorRuns) {
    need(c.GITHUB_TOKEN && /^[1-9][0-9]*$/.test(p.runId), 'EVIDENCE_REQUIRED');
    const base = `https://api.github.com/repos/${backend}/actions/runs/${p.runId}`;
    const run = await getJson(base, c.GITHUB_TOKEN, fetcher);
    need(String(run.id) === p.runId && run.workflow_id === 404601811 && run.path === WORKFLOW_PATH
      && run.head_repository?.full_name === backend && run.head_branch === 'main' && run.head_sha === c.GITHUB_SHA
      && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success'
      && run.actor?.login === 'vivek2310sharma' && run.triggering_actor?.login === 'vivek2310sharma'
      && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'ACCEPTANCE_RUN_INVALID');
    const data = await getJson(`${base}/artifacts?per_page=100`, c.GITHUB_TOKEN, fetcher);
    const stage = p.environment === 'FairSwapTest' ? 'test' : 'prod';
    const artifacts = data.artifacts?.filter(a => a.expired === false
      && [`reusable-${stage}-${p.candidateId}-${p.runId}-${run.run_attempt}`,
        `reusable-${stage}-v3-goods-batch-activate-${p.runId}-${run.run_attempt}`].includes(a.name)
      && String(a.workflow_run?.id) === p.runId && a.workflow_run?.head_sha === c.GITHUB_SHA);
    need(artifacts?.length === 1, 'ACCEPTANCE_ARTIFACT_REQUIRED');
    const a = artifacts[0];
    need(Number.isSafeInteger(a.id) && a.archive_download_url === `https://api.github.com/repos/${backend}/actions/artifacts/${a.id}/zip`, 'ARTIFACT_URL_INVALID');
    const zip = await downloadArtifact(a.archive_download_url, c.GITHUB_TOKEN, fetcher);
    need(a.digest === `sha256:${hash(zip)}`, 'ARTIFACT_DIGEST_INVALID');
    const files = readZipEntries(zip);
    const name = `${p.candidateId}-${p.environment.toLowerCase()}.json`;
    const body = files.get(name);
    need(body && files.get(`SHA256SUMS_${p.environment.toLowerCase()}`)?.toString().split('\n').filter(line => line.endsWith('  '+name)).join('\n') === `${hash(body)}  ${name}`, 'RECEIPT_DIGEST_INVALID');
    verifyLeafReceipt(JSON.parse(body.toString()), p, c);
  }
}

function stateExpression(slug, active, checkAvailability = true) {
  need(leaves[slug], 'SLUG_NOT_ALLOWED');
  const [id, parent] = leaves[slug];
  return `EXISTS (SELECT FROM app_security.ordinary_goods_contracts_v3 g
    JOIN public.categories c ON c.id=g.category_id JOIN public.categories p ON p.id=c.parent_id
    WHERE g.slug='${slug}' AND g.category_id='${id}' AND c.slug=g.slug AND g.parent_slug='${parent}' AND p.slug=g.parent_slug
      AND g.revision=1 AND g.risk='${contracts[slug].risk}'
      AND g.fields='${JSON.stringify(contracts[slug].fields).replaceAll("'", "''")}'::jsonb
      AND g.posting_flow='${contracts[slug].flow}' AND c.posting_flow=g.posting_flow
      AND g.macro_category='goods' AND c.macro_category=g.macro_category AND NOT g.draft_only
      AND NOT c.new_listing_enabled AND g.enabled=${active} AND c.is_active=${active}
      AND c.status='${active ? 'live' : 'coming_soon'}'
      ${checkAvailability ? `AND app_security.ordinary_goods_available_v3(g.category_id)=${active}` : ''}
      ${active ? "AND g.moderation_mode='five_check' AND p.is_active AND p.status='live'" : ''})`;
}

export function leafStateSql(slug, active, checkAvailability = true) {
  return `BEGIN READ ONLY; SET LOCAL statement_timeout='30s'; SELECT (${stateExpression(slug, active, checkAvailability)})::text; COMMIT;`;
}

// Bounded configuration snapshots only. No listing/media/storage row scans or locks.
function fingerprintSql(slug, operation, verify = false) {
  const [id] = leaves[slug];
  return `DO $preserve$
  DECLARE configuration jsonb; writes jsonb;
  BEGIN
    IF (SELECT count(*) FROM (SELECT 1 FROM public.categories LIMIT 257) x)>256
      OR (SELECT count(*) FROM (SELECT 1 FROM app_security.ordinary_goods_contracts_v3 LIMIT 257) x)>256
    THEN RAISE EXCEPTION 'V3_LEAF_CONFIGURATION_BOUND_EXCEEDED'; END IF;
    SELECT jsonb_build_object(
      'categories',(SELECT jsonb_agg(CASE WHEN c.id='${id}' THEN to_jsonb(c)-'status'-'is_active' ELSE to_jsonb(c) END ORDER BY c.id) FROM public.categories c),
      'contracts',(SELECT jsonb_agg(CASE WHEN g.category_id='${id}' THEN to_jsonb(g)-'enabled'${operation === 'activate' ? "-'moderation_mode'" : ''} ELSE to_jsonb(g) END ORDER BY g.category_id) FROM app_security.ordinary_goods_contracts_v3 g)
    ) INTO configuration;
    -- Transaction-local counters exclude concurrent user traffic. They cover all writes
    -- made by this operator and its triggers without reading unrelated application rows.
    IF (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_stat_xact_user_tables LIMIT 1025) x)>1024
    THEN RAISE EXCEPTION 'V3_LEAF_RELATION_BOUND_EXCEEDED'; END IF;
    SELECT coalesce(jsonb_object_agg(relid::text,jsonb_build_array(n_tup_ins,n_tup_upd,n_tup_del)), '{}'::jsonb)
      INTO writes FROM pg_catalog.pg_stat_xact_user_tables WHERE schemaname <> 'pg_temp' AND schemaname NOT LIKE 'pg_temp_%';
    ${verify ? `IF configuration IS DISTINCT FROM (SELECT value FROM pg_temp.v3_leaf_preserved WHERE name='configuration')
      THEN RAISE EXCEPTION 'V3_LEAF_UNRELATED_DATA_CHANGED'; END IF;
    IF EXISTS (SELECT FROM jsonb_each(writes) w LEFT JOIN pg_temp.v3_leaf_preserved b ON b.name='writes'
      WHERE (w.value->>0)::bigint <> coalesce((b.value->w.key->>0)::bigint,0)
        OR (w.value->>2)::bigint <> coalesce((b.value->w.key->>2)::bigint,0)
        OR (w.value->>1)::bigint - coalesce((b.value->w.key->>1)::bigint,0) <>
          CASE WHEN w.key IN ('public.categories'::regclass::oid::text,'app_security.ordinary_goods_contracts_v3'::regclass::oid::text) THEN 1 ELSE 0 END)
    THEN RAISE EXCEPTION 'V3_LEAF_UNRELATED_WRITES'; END IF;` : "INSERT INTO pg_temp.v3_leaf_preserved VALUES('configuration',configuration),('writes',writes);"}
  END $preserve$;`;
}

function operatorSql(candidateId, webSha) {
  const {slug} = getCandidate(candidateId);
  const {fullPath} = verifyCandidateSha(candidateId, root);
  // Keep the reviewed operator body and every check intact, removing only its transaction envelope and psql directive.
  return readFileSync(fullPath, 'utf8').replace(/^\\set.*$/gm, '')
    .replace(/^begin;\s*$/mi, '').replace(/^commit;\s*$/mi, '')
    .replaceAll(":'slug'", `'${slug}'`).replaceAll(":'web_commit'", `'${webSha}'`).replaceAll(":'moderation_mode'", "'five_check'");
}

export function leafTransaction(candidateId, webSha) {
  const candidate = getCandidate(candidateId);
  const {slug, v3Operation: operation} = candidate;
  need(leaves[slug] && ['activate', 'deactivate'].includes(operation), 'SLUG_NOT_ALLOWED');
  need(/^[a-f0-9]{40}$/.test(webSha ?? ''), 'WEB_COMMIT_REQUIRED');
  const operator = operatorSql(candidateId, webSha);
  const active = operation === 'activate';
  return `BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
-- Serialize only this leaf and its parent; no unrelated table locks.
SELECT 1 FROM app_security.ordinary_goods_contracts_v3 WHERE category_id='${leaves[slug][0]}' FOR UPDATE;
SELECT 1 FROM public.categories WHERE id='${leaves[slug][0]}' FOR UPDATE;
SELECT 1 FROM public.categories WHERE slug='${leaves[slug][1]}' FOR SHARE;
${active && slug === 'v2-tables-chairs' ? `SELECT 1 FROM app_security.ordinary_goods_contracts_v3 WHERE slug='v2-books' FOR SHARE;
SELECT 1 FROM public.categories WHERE id='${leaves['v2-books'][0]}' FOR SHARE;` : ''}
CREATE TEMP TABLE v3_leaf_preserved(name text PRIMARY KEY,value jsonb) ON COMMIT DROP;
DO $state$ BEGIN
  IF NOT (${stateExpression(slug, !active, active)}) THEN RAISE EXCEPTION 'V3_LEAF_PREFLIGHT_FAILED'; END IF;
  ${active && slug === 'v2-tables-chairs' ? `IF NOT (${stateExpression('v2-books', true)}) THEN RAISE EXCEPTION 'V3_LEAF_BOOKS_REQUIRED'; END IF;` : ''}
END $state$;
${fingerprintSql(slug, operation)}
${operator}
SET CONSTRAINTS ALL IMMEDIATE;
${fingerprintSql(slug, operation, true)}
DO $state$ BEGIN IF NOT (${stateExpression(slug, active)}) THEN RAISE EXCEPTION 'V3_LEAF_POSTFLIGHT_FAILED'; END IF; END $state$;
COMMIT;`;
}

export function leafPreflightSql(candidateId, webSha) {
  const candidate = getCandidate(candidateId);
  const active = candidate.v3Operation === 'activate';
  // leafTransaction validates the allowlist, UUID/revision state and safe substitutions.
  leafTransaction(candidateId, webSha);
  const checks = active ? operatorSql(candidateId, webSha).split('  update public.categories')[0]
    .replace(' for update;', ';') + 'end $$;' : '';
  return `BEGIN READ ONLY; SET LOCAL statement_timeout='30s';
DO $state$ BEGIN
  IF NOT (${stateExpression(candidate.slug, !active, active)}) THEN RAISE EXCEPTION 'V3_LEAF_PREFLIGHT_FAILED'; END IF;
  ${active && candidate.slug === 'v2-tables-chairs' ? `IF NOT (${stateExpression('v2-books', true)}) THEN RAISE EXCEPTION 'V3_LEAF_BOOKS_REQUIRED'; END IF;` : ''}
END $state$;
${checks}
COMMIT;`;
}

export async function releaseV3Leaf({environment, candidateId, context: c = process.env, runner, fetcher = fetch, receiptDir = resolve('release-receipts'), skipEvidence = false}) {
  const plan = leafPlan(candidateId, environment, c);
  need(c.GITHUB_ACTIONS === 'true' && c.GITHUB_EVENT_NAME === 'workflow_dispatch' && c.GITHUB_REF === 'refs/heads/main'
    && c.GITHUB_REPOSITORY === backend && c.GITHUB_WORKFLOW_REF === `${backend}/${WORKFLOW_PATH}@refs/heads/main`
    && c.GITHUB_ACTOR === 'vivek2310sharma' && c.GITHUB_TRIGGERING_ACTOR === 'vivek2310sharma'
    && /^[a-f0-9]{40}$/.test(c.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/.test(c.GITHUB_RUN_ID ?? ''), 'OWNER_DISPATCH_REQUIRED');
  const candidate = plan.candidate;
  verifyCandidateSha(candidateId, root);
  if (candidate.v3Operation === 'activate' && !skipEvidence) {
    await requireLeafEvidence(plan, c, fetcher);
    await verifyLeafWeb(plan, c, fetcher);
  }
  const dir = mkdtempSync(join(tmpdir(), 'v3-leaf-'));
  try {
    const cert = join(dir, 'root.crt');
    writeFileSync(cert, validateRootCertificate(c.CHAT_DB_SSL_ROOT_CERT_PEM), {mode: 0o600});
    need(/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(c.CHAT_DB_POOLER_HOST ?? '') && c.CHAT_DATABASE_PASSWORD, 'DATABASE_CONFIG_REQUIRED');
    // Same project-scoped session-pooler/TLS contract as the reusable migration runner.
    const connection = `postgresql://postgres.${PROJECT_REFS[environment]}@${c.CHAT_DB_POOLER_HOST}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(cert)}&connect_timeout=10`;
    const env = {PATH: process.env.PATH, PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert, PGCONNECT_TIMEOUT: '10', PGPASSWORD: c.CHAT_DATABASE_PASSWORD};
    const exec = sql => {
      const args = ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', connection];
      if (runner) return runner('psql', args, env, sql);
      const result = spawnSync('psql', args, {env, input: sql, encoding: 'utf8', timeout: 120000});
      // Never expose database error DETAIL, credentials or row values.
      need(!result.error && result.status === 0, 'SQL_FAILED');
      return result.stdout;
    };
    const active = candidate.v3Operation === 'activate';
    exec(leafPreflightSql(candidateId, plan.webSha));
    exec(leafTransaction(candidateId, plan.webSha));
    try {
      need(exec(leafStateSql(candidate.slug, active)).trim() === 'true', 'POSTFLIGHT_FAILED');
    } catch {
      // A committed activation with failed independent verification is compensated by
      // the same reviewed one-leaf rollback, then checked read-only. Never emit acceptance.
      if (active) {
        exec(leafTransaction(candidateId.replace(/-activate$/, '-deactivate'), plan.webSha));
        need(exec(leafStateSql(candidate.slug, false)).trim() === 'true', 'ROLLBACK_VERIFICATION_FAILED');
        throw Error('V3_LEAF_POSTFLIGHT_FAILED_ROLLBACK_VERIFIED');
      }
      throw Error('V3_LEAF_ROLLBACK_VERIFICATION_FAILED');
    }
    const receipt = {status: 'V3_LEAF_VERIFIED', candidateId, slug: candidate.slug, operation: candidate.v3Operation,
      environment, projectRef: PROJECT_REFS[environment], reviewedCommit: c.GITHUB_SHA, releaseWorkflowRun: c.GITHUB_RUN_ID,
      operatorSha256: candidate.sha256, webSha: plan.webSha, postflightVerified: true, preservationVerified: true};
    mkdirSync(receiptDir, {recursive: true, mode: 0o700});
    const name = `${candidateId}-${environment.toLowerCase()}.json`;
    const body = JSON.stringify(receipt, null, 2) + '\n';
    writeFileSync(join(receiptDir, name), body, {mode: 0o600});
    writeFileSync(join(receiptDir, `SHA256SUMS_${environment.toLowerCase()}`), `${hash(body)}  ${name}\n`, {mode: 0o600});
    return receipt;
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

function leafContext(c, plan) {
  return {...c, TEST_ACTIVATION_RUN_ID: plan.testActivationRunId, TEST_E2E_RUN_ID: plan.testE2eRunId,
    BOOKS_ACCEPTANCE_RUN_ID: plan.booksAcceptanceRunId};
}

// One workflow and reviewed operators; each category commits and verifies independently.
// Any later failure compensates every earlier activation from THIS batch, in reverse order.
export async function releaseV3GoodsBatch(options) {
  const c = options.context ?? process.env;
  const plan = leafPlan(options.candidateId, options.environment, c);
  need(plan.candidate.v3Batch && plan.plans, 'BATCH_REQUIRED');
  verifyCandidateSha(options.candidateId, root);
  // Validate all immutable evidence before the first mutation.
  if (plan.candidate.v3Batch === 'activate') {
    await requireLeafEvidence(plan, c, options.fetcher);
    await verifyLeafWeb(plan, c, options.fetcher);
  }
  const completed = [];
  const receiptDir = options.receiptDir ?? resolve('release-receipts');
  try {
    for (const leaf of plan.plans) {
      const receipt = await releaseV3Leaf({...options, candidateId: leaf.candidate.id,
        context: leafContext(c, leaf), receiptDir, skipEvidence: true});
      completed.push({leaf, receipt});
    }
  } catch (error) {
    let failed = false;
    if (plan.candidate.v3Batch === 'activate') {
      for (const {leaf} of [...completed].reverse()) {
        try {
          await releaseV3Leaf({...options, candidateId: leaf.candidate.id.replace(/-activate$/, '-deactivate'),
            context: leafContext(c, leaf), receiptDir, skipEvidence: true});
          rmSync(join(receiptDir, `${leaf.candidate.id}-${options.environment.toLowerCase()}.json`), {force: true});
        } catch { failed = true; }
      }
    }
    // Never leave a successful batch checksum after partial failure.
    rmSync(join(receiptDir, `SHA256SUMS_${options.environment.toLowerCase()}`), {force: true});
    throw Error(failed ? 'V3_LEAF_BATCH_ROLLBACK_FAILED' : 'V3_LEAF_BATCH_FAILED', {cause: error});
  }
  const sums = completed.map(({leaf}) => {
    const name = `${leaf.candidate.id}-${options.environment.toLowerCase()}.json`;
    return `${hash(readFileSync(join(receiptDir, name)))}  ${name}\n`;
  }).join('');
  writeFileSync(join(receiptDir, `SHA256SUMS_${options.environment.toLowerCase()}`), sums, {mode: 0o600});
  // Existing workflow proof step and integrity job bind this summary to all per-leaf receipts.
  const summary = {status: 'V3_BATCH_VERIFIED', candidateId: options.candidateId,
    environment: options.environment, reviewedCommit: c.GITHUB_SHA, releaseWorkflowRun: c.GITHUB_RUN_ID,
    receipts: completed.map(({leaf, receipt}) => ({candidateId: leaf.candidate.id, operatorSha256: receipt.operatorSha256})),
    receiptsSha256: hash(sums)};
  const name = `${options.candidateId}-${options.environment.toLowerCase()}.json`;
  const body = JSON.stringify(summary, null, 2)+'\n';
  writeFileSync(join(receiptDir, name), body, {mode: 0o600});
  writeFileSync(join(receiptDir, `SHA256SUMS_${options.environment.toLowerCase()}`), sums+`${hash(body)}  ${name}\n`, {mode: 0o600});
  return summary;
}
