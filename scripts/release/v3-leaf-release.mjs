// One-leaf operator orchestration. No migrations, switches, provider calls or automatic promotion.
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {PROJECT_REFS, getCandidate, planDispatch, verifyCandidateSha} from './reusable-candidates.mjs';
import {getJson, downloadArtifact, readZipEntries, WORKFLOW_PATH} from './accessories-v1-release.mjs';
import {validateRootCertificate} from './fsw-sec-003-prelaunch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const backend = 'vivek2310sharma/FairSwap-Backend';
const web = 'vivek2310sharma/FairSwap-Web';
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw Error(`V3_LEAF_${code}`); };
const leaves = Object.freeze({
  'v2-books': ['c0ba9c51-8d6a-5c81-99e1-6be9c60a8fc5', 'v2-books-sports-hobbies'],
  'v2-tables-chairs': ['ec6a3d86-1ce8-574e-9a7b-bef64e1ccf41', 'v2-furniture-home']
});

export function leafPlan(candidateId, environment, c) {
  need(PROJECT_REFS[environment] && c.TARGET === (environment === 'FairSwapTest' ? 'test' : 'production'), 'ENVIRONMENT_MISMATCH');
  const plan = planDispatch({candidateId, target: c.TARGET, inputs: {
    web_staging_sha: c.WEB_STAGING_SHA, web_production_sha: c.WEB_PRODUCTION_SHA,
    test_activation_run_id: c.TEST_ACTIVATION_RUN_ID, books_acceptance_run_id: c.BOOKS_ACCEPTANCE_RUN_ID
  }});
  need(plan.candidate.v3Operation && leaves[plan.candidate.slug], 'SLUG_NOT_ALLOWED');
  return plan;
}

// Require the current deployment of the exact branch/environment, never an arbitrary preview.
export async function verifyLeafWeb(plan, c, fetcher = fetch) {
  need(c.WEB_EVIDENCE_TOKEN, 'WEB_EVIDENCE_REQUIRED');
  const production = plan.target === 'production';
  const environment = production ? 'Production' : 'Preview';
  const branch = production ? 'main' : 'staging';
  const base = `https://api.github.com/repos/${web}`;
  const deployments = await getJson(`${base}/deployments?environment=${environment}&per_page=1`, c.WEB_EVIDENCE_TOKEN, fetcher);
  const d = deployments?.[0];
  need(d?.sha === plan.webSha && d.environment === environment && [branch, plan.webSha].includes(d.ref) && Number.isSafeInteger(d.id), 'WEB_DEPLOYMENT_MISMATCH');
  const tip = await getJson(`${base}/commits/${branch}`, c.WEB_EVIDENCE_TOKEN, fetcher);
  need(tip.sha === plan.webSha, 'WEB_BRANCH_MISMATCH');
  if (production) {
    need(/^[a-f0-9]{40}$/.test(c.WEB_STAGING_SHA ?? ''), 'TESTED_WEB_COMMIT_REQUIRED');
    const comparison = await getJson(`${base}/compare/${c.WEB_STAGING_SHA}...${plan.webSha}`, c.WEB_EVIDENCE_TOKEN, fetcher);
    need(['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === c.WEB_STAGING_SHA, 'TESTED_WEB_RELEASE_REQUIRED');
  }
  const statuses = await getJson(`${base}/deployments/${d.id}/statuses?per_page=1`, c.WEB_EVIDENCE_TOKEN, fetcher);
  need(statuses?.[0]?.state === 'success', 'WEB_NOT_READY');
  return {sha: plan.webSha, environment, deploymentId: d.id};
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
      && a.name === `reusable-${stage}-${p.candidateId}-${p.runId}-${run.run_attempt}`
      && String(a.workflow_run?.id) === p.runId && a.workflow_run?.head_sha === c.GITHUB_SHA);
    need(artifacts?.length === 1, 'ACCEPTANCE_ARTIFACT_REQUIRED');
    const a = artifacts[0];
    need(Number.isSafeInteger(a.id) && a.archive_download_url === `https://api.github.com/repos/${backend}/actions/artifacts/${a.id}/zip`, 'ARTIFACT_URL_INVALID');
    const zip = await downloadArtifact(a.archive_download_url, c.GITHUB_TOKEN, fetcher);
    need(a.digest === `sha256:${hash(zip)}`, 'ARTIFACT_DIGEST_INVALID');
    const files = readZipEntries(zip);
    const name = `${p.candidateId}-${p.environment.toLowerCase()}.json`;
    const body = files.get(name);
    need(body && files.get(`SHA256SUMS_${p.environment.toLowerCase()}`)?.toString() === `${hash(body)}  ${name}\n`, 'RECEIPT_DIGEST_INVALID');
    verifyLeafReceipt(JSON.parse(body.toString()), p, c);
  }
}

function stateExpression(slug, active, checkAvailability = true) {
  need(leaves[slug], 'SLUG_NOT_ALLOWED');
  const [id, parent] = leaves[slug];
  return `EXISTS (SELECT FROM app_security.ordinary_goods_contracts_v3 g
    JOIN public.categories c ON c.id=g.category_id JOIN public.categories p ON p.id=c.parent_id
    WHERE g.slug='${slug}' AND g.category_id='${id}' AND c.slug=g.slug AND g.parent_slug='${parent}' AND p.slug=g.parent_slug
      AND g.revision=1 AND g.posting_flow='generic' AND c.posting_flow=g.posting_flow
      AND g.macro_category='goods' AND c.macro_category=g.macro_category AND NOT g.draft_only
      AND NOT c.new_listing_enabled AND g.enabled=${active} AND c.is_active=${active}
      AND c.status='${active ? 'live' : 'coming_soon'}'
      ${checkAvailability ? `AND app_security.ordinary_goods_available_v3(g.category_id)=${active}` : ''}
      ${active ? "AND g.moderation_mode='five_check' AND p.is_active AND p.status='live'" : ''})`;
}

export function leafStateSql(slug, active, checkAvailability = true) {
  return `BEGIN READ ONLY; SET LOCAL statement_timeout='30s'; SELECT (${stateExpression(slug, active, checkAvailability)})::text; COMMIT;`;
}

// Hash all persistent rows without returning private data. The only excluded columns are
// exactly those the selected operator is permitted to change, on the canonical target row.
function fingerprintSql(slug, operation, verify = false) {
  const [id] = leaves[slug];
  return `DO $preserve$
  DECLARE r record; expression text; digest text;
  BEGIN
    FOR r IN SELECT n.nspname, c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','app_security','storage','supabase_migrations') AND c.relkind IN ('r','p')
      ORDER BY n.nspname,c.relname
    LOOP
      expression := 'to_jsonb(t)';
      IF r.nspname='public' AND r.relname='categories' THEN
        expression := 'CASE WHEN t.id=''${id}''::uuid THEN to_jsonb(t)-''status''-''is_active'' ELSE to_jsonb(t) END';
      ELSIF r.nspname='app_security' AND r.relname='ordinary_goods_contracts_v3' THEN
        expression := 'CASE WHEN t.category_id=''${id}''::uuid THEN to_jsonb(t)-''enabled''${operation === 'activate' ? "-''moderation_mode''" : ''} ELSE to_jsonb(t) END';
      END IF;
      EXECUTE format('SELECT md5(coalesce(string_agg(x, chr(10) ORDER BY x), '''')) FROM (SELECT (%s)::text x FROM %I.%I t) s',expression,r.nspname,r.relname) INTO digest;
      IF EXISTS (SELECT FROM pg_temp.v3_leaf_preserved WHERE name=r.nspname||'.'||r.relname) THEN
        IF digest IS DISTINCT FROM (SELECT value FROM pg_temp.v3_leaf_preserved WHERE name=r.nspname||'.'||r.relname) THEN
          RAISE EXCEPTION 'V3_LEAF_UNRELATED_DATA_CHANGED';
        END IF;
      ELSE
        ${verify ? "RAISE EXCEPTION 'V3_LEAF_TABLE_INVENTORY_CHANGED';" : "INSERT INTO pg_temp.v3_leaf_preserved VALUES(r.nspname||'.'||r.relname,digest);"}
      END IF;
    END LOOP;
    SELECT md5(jsonb_build_object(
      'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_security')),
      'relations',(SELECT jsonb_agg(to_jsonb(c) - 'relpages' - 'reltuples' - 'relallvisible' - 'relfrozenxid' - 'relminmxid' ORDER BY c.oid) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_security','storage','supabase_migrations')),
      'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal),
      'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p)
    )::text) INTO digest;
    ${verify ? "IF digest IS DISTINCT FROM (SELECT value FROM pg_temp.v3_leaf_preserved WHERE name='metadata') THEN RAISE EXCEPTION 'V3_LEAF_SECURITY_CHANGED'; END IF;" : "INSERT INTO pg_temp.v3_leaf_preserved VALUES('metadata',digest);"}
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
-- Block concurrent writes during preservation verification; never mistake traffic for operator side effects.
DO $locks$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','app_security','storage','supabase_migrations') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname
  LOOP EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE',r.nspname,r.relname); END LOOP;
END $locks$;
CREATE TEMP TABLE v3_leaf_preserved(name text PRIMARY KEY,value text) ON COMMIT DROP;
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

export async function releaseV3Leaf({environment, candidateId, context: c = process.env, runner, fetcher = fetch, receiptDir = resolve('release-receipts')}) {
  const plan = leafPlan(candidateId, environment, c);
  need(c.GITHUB_ACTIONS === 'true' && c.GITHUB_EVENT_NAME === 'workflow_dispatch' && c.GITHUB_REF === 'refs/heads/main'
    && c.GITHUB_REPOSITORY === backend && c.GITHUB_WORKFLOW_REF === `${backend}/${WORKFLOW_PATH}@refs/heads/main`
    && c.GITHUB_ACTOR === 'vivek2310sharma' && c.GITHUB_TRIGGERING_ACTOR === 'vivek2310sharma'
    && /^[a-f0-9]{40}$/.test(c.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/.test(c.GITHUB_RUN_ID ?? ''), 'OWNER_DISPATCH_REQUIRED');
  const candidate = plan.candidate;
  verifyCandidateSha(candidateId, root);
  if (candidate.v3Operation === 'activate') {
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
