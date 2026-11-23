import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {releaseReusable} from '../../scripts/release/reusable-supabase-release.mjs';
import {rootCertificates} from 'node:tls';
import {getCandidate, planDispatch, verifyCandidateSha} from '../../scripts/release/reusable-candidates.mjs';
import {WEB_CONTRACT_PATHS, leafPlan, leafTransaction, leafPreflightSql, leafStateSql, verifyLeafWeb, verifyLeafReceipt, requireLeafEvidence, releaseV3Leaf, releaseV3GoodsBatch} from '../../scripts/release/v3-leaf-release.mjs';
import {V3_GOODS, V3_BATCH_MAX_LEAVES} from '../../scripts/release/reusable-candidates.mjs';
import {setupOrdinaryGoodsFixture} from '../ordinary-goods/fixture.mjs';

const pglitePath = process.env.FSW_PGLITE_MODULE ?? 'tests/ratings/node_modules/@electric-sql/pglite/dist/index.js';
const PGlite = existsSync(resolve(pglitePath)) ? (await import(pathToFileURL(resolve(pglitePath)).href)).PGlite : null;
const databaseRequired = process.env.REQUIRE_REAL_PG === '1' || process.env.GITHUB_WORKFLOW === 'Backend independent CI' || Boolean(process.env.FSW_PGLITE_MODULE);

const sha = 'a'.repeat(40);
const context = {TARGET: 'test', WEB_STAGING_SHA: sha, WEB_PRODUCTION_SHA: sha, GITHUB_SHA: sha};
const activate = 'v3-books-activate';
const deactivate = 'v3-books-deactivate';
const tables = 'v3-tables-chairs-activate';

test('V3 leaf registry and plan allow exactly two leaves, no adoption or promotion, and require ordered same-environment evidence', () => {
  for (const leaf of ['books', 'tables-chairs']) for (const action of ['activate', 'deactivate']) {
    const id = `v3-${leaf}-${action}`;
    assert.equal(verifyCandidateSha(id).candidate.autoPromote, false);
    const sql = leafTransaction(id, sha);
    assert.ok(sql.includes("set local lock_timeout='5s'"));
    assert.ok(sql.includes('pg_stat_xact_user_tables'));
    assert.doesNotMatch(sql, /LOCK TABLE|pg_class|string_agg|FROM public\.listings|FROM public\.listing_media|FROM storage\./i);
  }
  for (const id of ['v3-*-activate', 'v3-books,tables-chairs-activate', 'v3-cars-activate']) assert.throws(() => getCandidate(id), /UNKNOWN_CANDIDATE/);
  assert.throws(() => leafPlan(activate, 'FairSwapProd', context), /ENVIRONMENT_MISMATCH/);
  assert.throws(() => leafPlan(activate, 'FairSwapTest', {...context, WEB_STAGING_SHA: ''}), /WEB_COMMIT_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: activate, target: 'adopt'}), /INVALID_TARGET/);
  assert.throws(() => leafPlan(tables, 'FairSwapTest', context), /BOOKS_ACCEPTANCE_REQUIRED/);
  assert.throws(() => leafPlan(activate, 'FairSwapProd', {...context, TARGET: 'production'}), /TEST_ACCEPTANCE_REQUIRED/);
  const plan = leafPlan(tables, 'FairSwapProd', {...context, TARGET: 'production', TEST_ACTIVATION_RUN_ID: '12', BOOKS_ACCEPTANCE_RUN_ID: '13'});
  assert.deepEqual(plan.priorRuns.map(r => [r.candidateId, r.environment]), [[tables, 'FairSwapTest'], [activate, 'FairSwapProd']]);
  assert.equal(leafPlan(deactivate, 'FairSwapProd', {...context, TARGET: 'production'}).priorRuns.length, 0);
  assert.throws(() => leafTransaction(activate, "x'; select 1;"), /WEB_COMMIT_REQUIRED/);
});

function webFetcher(change = {}) {
  return async url => ({ok: true, json: async () => {
    if (url.includes('/compare/')) throw Error('ancestry must never be queried');
    if (url.includes('/contents/')) {
      const path = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      const bytes = Buffer.from(change.contractMismatch && url.endsWith('ref='+sha) ? 'different' : 'reviewed V3 contract');
      return {type: change.noContract ? 'dir' : 'file', path, encoding: 'base64', content: bytes.toString('base64'),
        sha: change.badBlob ? 'bad' : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
    }
    return url.includes('/commits/') ? {sha: change.tip ?? sha} : url.includes('/statuses?') ? [{state: change.state ?? 'success'}]
      : [{id: 1, sha, ref: 'staging', environment: 'Preview', ...change}];
  }});
}
test('V3 Web verification rejects wrong SHA, environment, branch, failed or unavailable deployment', async () => {
  const plan = leafPlan(activate, 'FairSwapTest', context);
  const c = {...context, WEB_EVIDENCE_TOKEN: 'mock'};
  assert.equal((await verifyLeafWeb(plan, c, webFetcher())).sha, sha);
  for (const change of [{sha: 'b'.repeat(40)}, {environment: 'Production'}, {ref: 'feature'}, {state: 'failure'}, {tip: 'b'.repeat(40)}]) {
    await assert.rejects(verifyLeafWeb(plan, c, webFetcher(change)), /WEB_/);
  }
  const prod = leafPlan(activate, 'FairSwapProd', {...context, TARGET: 'production', TEST_ACTIVATION_RUN_ID: '12'});
  // A focused port can share contract blobs with staging without sharing its ancestry.
  const focused = {...c, WEB_STAGING_SHA: 'b'.repeat(40)};
  assert.equal((await verifyLeafWeb(prod, focused, webFetcher({ref: sha, environment: 'Production'}))).environment, 'Production');
  assert.equal(WEB_CONTRACT_PATHS.length, 6);
  for (const change of [{noContract: true}, {badBlob: true}]) await assert.rejects(verifyLeafWeb(prod, focused, webFetcher({ref: sha, environment: 'Production', ...change})), /WEB_CONTRACT_/);
  await assert.rejects(verifyLeafWeb(prod, {...c, WEB_STAGING_SHA: 'b'.repeat(40)}, webFetcher({ref: sha, environment: 'Production', contractMismatch: true})), /WEB_CONTRACT_MISMATCH/);
  await assert.rejects(verifyLeafWeb(plan, context, webFetcher()), /WEB_EVIDENCE_REQUIRED/);
  await assert.rejects(verifyLeafWeb(plan, c, async () => ({ok: false, status: 403})), /LOOKUP_FAILED/);
});

test('V3 acceptance receipt rejects wrong Backend/Web commit, environment, leaf, operator or missing preservation', async () => {
  const p = {candidateId: activate, environment: 'FairSwapTest', runId: '12'};
  const r = {status: 'V3_LEAF_VERIFIED', postflightVerified: true, preservationVerified: true,
    candidateId: activate, environment: 'FairSwapTest', projectRef: 'wpppxlnbzqynvhpeuavd', reviewedCommit: sha,
    releaseWorkflowRun: '12', operatorSha256: getCandidate(activate).sha256, slug: 'v2-books', operation: 'activate', webSha: sha};
  assert.equal(verifyLeafReceipt(r, p, context), r);
  for (const change of [{reviewedCommit: 'b'.repeat(40)}, {webSha: 'b'.repeat(40)}, {environment: 'FairSwapProd'},
    {slug: 'v2-cars'}, {operatorSha256: ''}, {preservationVerified: false}, {operation: 'deactivate'}, {postflightVerified: false}]) {
    assert.throws(() => verifyLeafReceipt({...r, ...change}, p, context), /ACCEPTANCE_RECEIPT_INVALID/);
  }
  const plan = {...leafPlan(activate, 'FairSwapTest', context), priorRuns: [p]};
  await assert.rejects(requireLeafEvidence(plan, context, () => { throw Error('must not fetch'); }), /EVIDENCE_REQUIRED/);
  await assert.rejects(requireLeafEvidence(plan, {...context, GITHUB_TOKEN: 'mock'}, async () => ({ok: true, json: async () => ({id: 12, conclusion: 'failure'})})), /ACCEPTANCE_RUN_INVALID/);
});

// Minimal stored ZIP fixture for the existing bounded artifact reader; no network or credentials.
function receiptZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name), body = Buffer.from(value);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(n.length, 26);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50); d.writeUInt32LE(body.length, 20); d.writeUInt32LE(body.length, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(offset, 42);
    local.push(h,n,body); central.push(d,n); offset += h.length+n.length+body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local,directory,end]);
}

test('V3 stage evidence verifies the exact successful run, attempt, immutable artifact digest and hashed Test receipt', async () => {
  const c = {...context, TARGET: 'production', TEST_ACTIVATION_RUN_ID: '12', GITHUB_TOKEN: 'mock'};
  const production = leafPlan(activate, 'FairSwapProd', c);
  await assert.rejects(requireLeafEvidence(production, c, () => { throw Error('must not fetch'); }), /HOSTED_TEST_E2E_EVIDENCE_UNAVAILABLE/);
  const plan = {...production, target: 'test'};
  const name = activate+'-fairswaptest.json';
  const receipt = {status: 'V3_LEAF_VERIFIED', postflightVerified: true, preservationVerified: true, candidateId: activate,
    environment: 'FairSwapTest', projectRef: 'wpppxlnbzqynvhpeuavd', reviewedCommit: sha, releaseWorkflowRun: '12',
    operatorSha256: getCandidate(activate).sha256, slug: 'v2-books', operation: 'activate', webSha: sha};
  const body = JSON.stringify(receipt), hash = value => createHash('sha256').update(value).digest('hex');
  const zip = receiptZip({[name]: body, SHA256SUMS_fairswaptest: hash(body)+'  '+name+'\n'});
  const fetcher = (change = {}) => async url => ({ok: true, arrayBuffer: async () => zip, json: async () => url.endsWith('artifacts?per_page=100')
    ? {artifacts: [{id: 21, expired: false, name: 'reusable-test-'+activate+'-12-1', workflow_run: {id: 12, head_sha: sha},
      archive_download_url: 'https://api.github.com/repos/vivek2310sharma/FairSwap-Backend/actions/artifacts/21/zip', digest: 'sha256:'+hash(zip), ...change}]}
    : {id: 12, workflow_id: 404601811, path: '.github/workflows/reusable-supabase-release.yml', head_repository: {full_name: 'vivek2310sharma/FairSwap-Backend'},
      head_branch: 'main', head_sha: sha, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', actor: {login: 'vivek2310sharma'}, triggering_actor: {login: 'vivek2310sharma'}, run_attempt: 1}});
  await requireLeafEvidence(plan, c, fetcher());
  for (const change of [{digest: 'sha256:wrong'}, {expired: true}, {name: 'wrong-attempt'}, {archive_download_url: 'https://example.test/zip'}]) {
    await assert.rejects(requireLeafEvidence(plan, c, fetcher(change)), /ARTIFACT_|ACCEPTANCE_ARTIFACT/);
  }
});

test('V3 runner uses existing TLS/environment connection, read-only flights and rollback operator; rejects unauthorized contexts before SQL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3-leaf-test-'));
  const c = {...context, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'vivek2310sharma/FairSwap-Backend', GITHUB_WORKFLOW_REF: 'vivek2310sharma/FairSwap-Backend/.github/workflows/reusable-supabase-release.yml@refs/heads/main',
    GITHUB_ACTOR: 'vivek2310sharma', GITHUB_TRIGGERING_ACTOR: 'vivek2310sharma', GITHUB_RUN_ID: '14',
    CHAT_DB_SSL_ROOT_CERT_PEM: rootCertificates[0], CHAT_DATABASE_PASSWORD: 'mock', CHAT_DB_POOLER_HOST: 'aws-0-eu-west-1.pooler.supabase.com'};
  const calls = [];
  const runner = (cmd, args, env, sql) => { calls.push(sql); assert.equal(cmd, 'psql'); assert.ok(args.includes('ON_ERROR_STOP=1'));
    assert.ok(args.join(' ').includes('postgres.wpppxlnbzqynvhpeuavd@')); assert.equal(env.PGSSLMODE, 'verify-full'); return 'true'; };
  try {
    const receipt = await releaseReusable({candidateId: deactivate, environment: 'FairSwapTest', context: c, runner, receiptDir: dir});
    assert.equal(receipt.operation, 'deactivate');
    assert.equal(calls.length, 3);
    assert.ok(calls[0].startsWith('BEGIN READ ONLY;'));
    assert.ok(calls[1].includes('GOODS_DEACTIVATION_FAILED'));
    assert.ok(calls[2].startsWith('BEGIN READ ONLY;'));
    await assert.rejects(releaseV3Leaf({candidateId: deactivate, environment: 'FairSwapTest', context: {...c, GITHUB_ACTOR: 'other'}, runner}), /OWNER_DISPATCH_REQUIRED/);
    assert.equal(calls.length, 3);
    await assert.rejects(releaseV3Leaf({candidateId: activate, environment: 'FairSwapProd',
      context: {...c, TARGET: 'production', TEST_ACTIVATION_RUN_ID: '12'}, runner,
      fetcher: () => { throw Error('must not fetch or touch Production'); }}), /HOSTED_TEST_E2E_EVIDENCE_UNAVAILABLE/);
    assert.equal(calls.length, 3);
    const compensation = [];
    await assert.rejects(releaseV3Leaf({candidateId: activate, environment: 'FairSwapTest',
      context: {...c, WEB_EVIDENCE_TOKEN: 'mock'}, receiptDir: dir, fetcher: webFetcher(),
      runner: (cmd, args, env, sql) => {
        compensation.push(sql);
        return compensation.length === 3 ? 'false' : 'true';
      }}), /POSTFLIGHT_FAILED_ROLLBACK_VERIFIED/);
    assert.equal(compensation.length, 5);
    assert.ok(compensation[3].includes('GOODS_DEACTIVATION_FAILED'));
    assert.ok(compensation[4].startsWith('BEGIN READ ONLY;'));
    assert.throws(() => readFileSync(join(dir, activate+'-fairswaptest.json')), /ENOENT/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('V3 disposable SQL: disabled, identity missing/optional, provider-neutral moderation unavailable, canonical drift, Books-first, repeated activation, exact preservation and rollback',
  {skip: !PGlite && !databaseRequired ? 'PGlite unavailable in this unrelated job' : false}, async () => {
  assert.ok(PGlite, 'PGlite is mandatory in Backend independent CI and release database gates');
  const db = new PGlite();
  const scalar = async sql => Object.values((await db.query(sql)).rows[0])[0];
  const state = async (slug, active) => {
    const results = await db.exec(leafStateSql(slug, active));
    return Object.values(results.find(r => r.rows?.length).rows[0])[0];
  };
  const rejects = async (sql, re) => { await assert.rejects(db.exec(sql), re); await db.exec('rollback'); };
  const a = () => db.exec(leafTransaction(activate, sha));
  try {
    await setupOrdinaryGoodsFixture(sql => db.exec(sql), {providerNeutral: true});
    assert.equal(await state('v2-books', false), 'true');
    await rejects(leafPreflightSql(activate, sha), /GOODS_LISTING_OR_IDENTITY_GUARDS_MISSING/);
    await rejects(leafTransaction(activate, sha), /GOODS_LISTING_OR_IDENTITY_GUARDS_MISSING/);
    await db.exec(`create function app_security.enforce_verified_actor(uuid,boolean) returns void language plpgsql as $$begin return; end$$;`);
    for (const [table, fn] of [['listings','listings'], ['listing_media','by_listing'], ['posting_upload_sessions','posting_session'], ['posting_staged_media','staged_media']]) {
      await db.exec(`create function app_security.trg_identity_gate_${fn}() returns trigger language plpgsql as $$begin return new; end$$;
        create trigger trg_identity_gate before insert on public.${table} for each row execute function app_security.trg_identity_gate_${fn}();`);
    }
    // Global identity enforcement is optional; only the shared automation switch gates activation.
    await db.exec("update public.app_system_settings set setting_value='false' where setting_key='moderation_automation_enabled'");
    await rejects(leafTransaction(activate, sha), /GOODS_MODERATION_NOT_READY/);
    await db.exec("update public.app_system_settings set setting_value='true' where setting_key='moderation_automation_enabled'");
    await rejects(leafTransaction(tables, sha), /BOOKS_REQUIRED/);
    await db.exec("update app_security.ordinary_goods_contracts_v3 set revision=2 where slug='v2-books'");
    await rejects(leafTransaction(activate, sha), /PREFLIGHT_FAILED/);
    await db.exec("update app_security.ordinary_goods_contracts_v3 set revision=1 where slug='v2-books'");
    // A side-effecting category trigger must abort the entire operator transaction.
    await db.exec(`create function public.v3_bad_side_effect() returns trigger language plpgsql as $$begin
      update app_security.ordinary_goods_contracts_v3 set revision=2 where slug='v2-other-hobbies'; return new; end$$;
      create trigger v3_bad_side_effect after update on public.categories for each row execute function public.v3_bad_side_effect();`);
    await rejects(leafTransaction(activate, sha), /UNRELATED_DATA_CHANGED/);
    assert.equal(await state('v2-books', false), 'true');
    assert.equal(await scalar("select revision from app_security.ordinary_goods_contracts_v3 where slug='v2-other-hobbies'"), 1);
    await db.exec('drop trigger v3_bad_side_effect on public.categories; drop function public.v3_bad_side_effect()');
    await db.exec(`insert into public.listings(id,category_id,title,price_paise,price_type,condition) select '00000000-0000-4000-8000-000000000101', c.id, 'Preserved listing',100,'fixed','good'
      from public.categories c where c.id=(select category_id from public.accessory_release_v1 limit 1);
      insert into public.listing_media(id,listing_id,original_filename) values ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000101','Preserved media');
      insert into public.car_contract_versions values ('00000000-0000-4000-8000-000000000103','preserved-contract');
      insert into storage.objects values ('fixture','preserved-object');`);
    for (const mutation of [
      "update public.listings set title='changed' where id='00000000-0000-4000-8000-000000000101'",
      'update public.listing_media set display_order=1',
      "update public.car_contract_versions set contract_key='changed'",
      "delete from storage.objects"
    ]) {
      await db.exec(`create function public.v3_bad_side_effect() returns trigger language plpgsql as $$begin ${mutation}; return new; end$$;
        create ${mutation.includes('storage.objects') ? 'constraint trigger' : 'trigger'} v3_bad_side_effect after update on public.categories
        ${mutation.includes('storage.objects') ? 'deferrable initially deferred' : ''} for each row execute function public.v3_bad_side_effect();`);
      await rejects(leafTransaction(activate, sha), /UNRELATED_DATA_CHANGED|UNRELATED_WRITES/);
      assert.equal(await state('v2-books', false), 'true');
      await db.exec('drop trigger v3_bad_side_effect on public.categories; drop function public.v3_bad_side_effect()');
    }
    await db.exec(leafPreflightSql(activate, sha));
    await a();
    assert.equal(await state('v2-books', true), 'true');
    await rejects(leafTransaction(activate, sha), /PREFLIGHT_FAILED/);
    await db.exec(leafTransaction(tables, sha));
    assert.equal(await state('v2-tables-chairs', true), 'true');
    await db.exec(leafTransaction('v3-tables-chairs-deactivate', sha));
    await db.exec("update public.app_system_settings set setting_value='false' where setting_key in ('identity_verification_required','moderation_azure_enabled','moderation_automation_enabled')");
    await db.exec(leafPreflightSql(deactivate, sha));
    await db.exec(leafTransaction(deactivate, sha));
    assert.equal(await state('v2-books', false), 'true');
    assert.equal(await state('v2-tables-chairs', false), 'true');
    await rejects(leafTransaction(deactivate, sha), /PREFLIGHT_FAILED/);
  } finally { await db.close(); }
});

test('V3 goods batch: validation, candidate restrictions, partial failure and reverse-order rollback', async () => {
  const batchActivate = 'v3-goods-batch-activate';
  const batchDeactivate = 'v3-goods-batch-deactivate';
  assert.equal(verifyCandidateSha(batchActivate).candidate.autoPromote, false);
  assert.equal(verifyCandidateSha(batchDeactivate).candidate.autoPromote, false);

  // Category restrictions: 43 allowed, restricted goods and vehicles rejected
  assert.equal(V3_GOODS.length, 43);
  const allowSlugs = new Set(V3_GOODS.map(g => g.slug));
  for (const restricted of ['v2-baby-gear-car-seats', 'v2-other-items', 'v2-cars', 'v2-two-wheelers', 'v2-commercial-vehicles', 'v2-property-sale']) {
    assert.ok(!allowSlugs.has(restricted));
    assert.throws(() => getCandidate(`v3-${restricted.slice(3)}-activate`), /UNKNOWN_CANDIDATE/);
  }

  // Batch plan dispatch validation
  const validBatch = [{candidateId: 'v3-air-conditioners-activate'}, {candidateId: 'v3-laptops-activate'}];
  assert.throws(() => planDispatch({candidateId: batchActivate, target: 'test', inputs: {web_staging_sha: sha}}), /V3_BATCH_JSON_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: batchActivate, target: 'test', inputs: {web_staging_sha: sha, v3_batch: '[]'}}), /V3_BATCH_SIZE_INVALID/);
  assert.throws(() => planDispatch({candidateId: batchActivate, target: 'test', inputs: {web_staging_sha: sha, v3_batch: JSON.stringify([{candidateId: 'v3-unknown-activate'}])}}), /UNKNOWN_CANDIDATE/);
  assert.throws(() => planDispatch({candidateId: batchActivate, target: 'test', inputs: {web_staging_sha: sha, v3_batch: JSON.stringify([{candidateId: 'v3-air-conditioners-deactivate'}])}}), /V3_BATCH_LEAF_INVALID/);
  assert.throws(() => planDispatch({candidateId: batchActivate, target: 'test', inputs: {web_staging_sha: sha, v3_batch: JSON.stringify([validBatch[0], validBatch[0]])}}), /V3_BATCH_LEAF_INVALID/);
  assert.throws(() => planDispatch({candidateId: batchActivate, target: 'test', inputs: {web_staging_sha: sha, v3_batch: JSON.stringify([{candidateId: 'v3-books-activate'}, {candidateId: 'v3-tables-chairs-activate', booksAcceptanceRunId: '12'}])}}), /V3_BATCH_BOOKS_SEPARATE_DISPATCH_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: batchActivate, target: 'production', inputs: {web_production_sha: sha, v3_batch: JSON.stringify(validBatch)}}), /V3_BATCH_E2E_REQUIRED/);

  const testPlan = planDispatch({candidateId: batchActivate, target: 'test', inputs: {v3_batch: JSON.stringify(validBatch), web_staging_sha: sha}});
  assert.equal(testPlan.plans.length, 2);

  // Batch execution and compensation
  const dir = mkdtempSync(join(tmpdir(), 'v3-batch-test-'));
  const c = {...context, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'vivek2310sharma/FairSwap-Backend', GITHUB_WORKFLOW_REF: 'vivek2310sharma/FairSwap-Backend/.github/workflows/reusable-supabase-release.yml@refs/heads/main',
    GITHUB_ACTOR: 'vivek2310sharma', GITHUB_TRIGGERING_ACTOR: 'vivek2310sharma', GITHUB_RUN_ID: '14',
    CHAT_DB_SSL_ROOT_CERT_PEM: rootCertificates[0], CHAT_DATABASE_PASSWORD: 'mock', CHAT_DB_POOLER_HOST: 'aws-0-eu-west-1.pooler.supabase.com',
    WEB_EVIDENCE_TOKEN: 'mock', V3_BATCH_JSON: JSON.stringify(validBatch)};

  try {
    // 1. Successful batch execution
    const executedSql = [];
    const mockRunner = (cmd, args, env, sql) => { executedSql.push(sql); return 'true'; };
    const summary = await releaseV3GoodsBatch({candidateId: batchActivate, environment: 'FairSwapTest',
      context: c, runner: mockRunner, receiptDir: dir, fetcher: webFetcher()});
    assert.equal(summary.status, 'V3_BATCH_VERIFIED');
    assert.equal(summary.receipts.length, 2);
    assert.ok(existsSync(join(dir, 'SHA256SUMS_fairswaptest')));
    assert.ok(existsSync(join(dir, 'v3-air-conditioners-activate-fairswaptest.json')));
    assert.ok(existsSync(join(dir, 'v3-laptops-activate-fairswaptest.json')));
    assert.ok(existsSync(join(dir, `${batchActivate}-fairswaptest.json`)));

    // 2. Partial failure during second leaf triggers reverse-order rollback of first leaf
    const failDir = mkdtempSync(join(tmpdir(), 'v3-batch-fail-'));
    let calls = 0;
    const partialSql = [];
    const failingRunner = (cmd, args, env, sql) => {
      partialSql.push(sql);
      calls++;
      // Leaf 1 succeeds (calls 1, 2, 3: preflight, tx, postflight)
      // Leaf 2 fails postflight (calls 4, 5: preflight, tx; call 6: postflight fails)
      if (calls === 6) return 'false';
      return 'true';
    };
    await assert.rejects(releaseV3GoodsBatch({candidateId: batchActivate, environment: 'FairSwapTest',
      context: c, runner: failingRunner, receiptDir: failDir, fetcher: webFetcher()}), /V3_LEAF_BATCH_FAILED/);

    // Verify leaf 1 rollback was executed in reverse order
    assert.ok(partialSql.some(s => s.includes('air-conditioners') && s.includes('GOODS_DEACTIVATION_FAILED')));
    // Check that SHA256SUMS was cleaned up and no successful batch receipt was written
    assert.ok(!existsSync(join(failDir, 'SHA256SUMS_fairswaptest')));
    assert.ok(!existsSync(join(failDir, `${batchActivate}-fairswaptest.json`)));
    rmSync(failDir, {recursive: true, force: true});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('V3 goods batch: bounded to five leaves and stops starting leaves once the time budget is spent, compensating', async () => {
  const ids = V3_GOODS.slice(0, 6).map(g => ({candidateId: `v3-${g.slug.slice(3)}-activate`}));
  assert.equal(V3_BATCH_MAX_LEAVES, 5);
  assert.throws(() => planDispatch({candidateId: 'v3-goods-batch-activate', target: 'test', inputs: {web_staging_sha: sha, v3_batch: JSON.stringify(ids)}}), /V3_BATCH_SIZE_INVALID/);
  assert.equal(planDispatch({candidateId: 'v3-goods-batch-activate', target: 'test', inputs: {web_staging_sha: sha, v3_batch: JSON.stringify(ids.slice(0, 5))}}).plans.length, 5);

  const batch = [{candidateId: 'v3-air-conditioners-activate'}, {candidateId: 'v3-laptops-activate'}];
  const c = {...context, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'vivek2310sharma/FairSwap-Backend', GITHUB_WORKFLOW_REF: 'vivek2310sharma/FairSwap-Backend/.github/workflows/reusable-supabase-release.yml@refs/heads/main',
    GITHUB_ACTOR: 'vivek2310sharma', GITHUB_TRIGGERING_ACTOR: 'vivek2310sharma', GITHUB_RUN_ID: '15',
    CHAT_DB_SSL_ROOT_CERT_PEM: rootCertificates[0], CHAT_DATABASE_PASSWORD: 'mock', CHAT_DB_POOLER_HOST: 'aws-0-eu-west-1.pooler.supabase.com',
    WEB_EVIDENCE_TOKEN: 'mock', V3_BATCH_JSON: JSON.stringify(batch)};
  const dir = mkdtempSync(join(tmpdir(), 'v3-batch-budget-'));
  try {
    let t = 0; const sqls = [];
    // Clock jumps past the budget after the first leaf: leaf 2 never starts, leaf 1 is compensated, no batch receipt remains.
    await assert.rejects(releaseV3GoodsBatch({candidateId: 'v3-goods-batch-activate', environment: 'FairSwapTest', context: c,
      runner: (cmd, args, env, sql) => { sqls.push(sql); return 'true'; }, receiptDir: dir, fetcher: webFetcher(),
      budgetMs: 1000, now: () => (t += 2000)}), error => /V3_LEAF_BATCH_FAILED/.test(error.message) && /BATCH_TIME_BUDGET_EXCEEDED/.test(error.cause.message));
    assert.ok(!sqls.some(s => s.includes('laptops')));
    assert.ok(sqls.some(s => s.includes('air-conditioners') && s.includes('GOODS_DEACTIVATION_FAILED')));
    assert.ok(!existsSync(join(dir, 'SHA256SUMS_fairswaptest')));
    assert.ok(!existsSync(join(dir, 'v3-air-conditioners-activate-fairswaptest.json')));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('V3 correction preserves all other functions, RLS, grants, contracts and categories; 43 activations work in all four provider settings',
  {skip: !PGlite && !databaseRequired ? 'PGlite unavailable in this unrelated job' : false}, async () => {
  assert.ok(PGlite, 'database engine required');
  const {V3_ACTIVATION_CORRECTION: correction} = await import('../../scripts/release/reusable-candidates.mjs');
  assert.equal(createHash('sha256').update(readFileSync(correction.path)).digest('hex'),correction.sha256);
  const db=new PGlite();
  const scalar=async sql=>Object.values((await db.query(sql)).rows[0])[0];
  const snapshot=()=>scalar(`select jsonb_build_object(
    'functions',(select jsonb_agg(to_jsonb(p)-'prosrc' order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_security')),
    'policies',(select jsonb_agg(to_jsonb(p) order by oid) from pg_policy p),
    'tables',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_security','storage')),
    'triggers',(select jsonb_agg(to_jsonb(t) order by oid) from pg_trigger t),
    'contracts',(select jsonb_agg(to_jsonb(g) order by slug) from app_security.ordinary_goods_contracts_v3 g),
    'categories',(select jsonb_agg(to_jsonb(c) order by id) from public.categories c),
    'settings',(select jsonb_agg(to_jsonb(s) order by setting_key) from public.app_system_settings s)
  )`);
  try {
    await setupOrdinaryGoodsFixture(sql=>db.exec(sql));
    await db.exec('alter table public.app_system_settings add column updated_at timestamptz default clock_timestamp()');
    await db.exec(readFileSync(getCandidate('moderation-google-cloud-v1').path,'utf8'));
    const before=await snapshot();
    const bodies=async()=> (await db.query("select p.oid::text, md5(prosrc) digest from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_security') order by p.oid")).rows;
    const beforeBodies=await bodies();
    // The operator refuses historical runtime even if the global identity switch is enabled.
    await assert.rejects(db.exec(leafPreflightSql(activate,sha)),/CORRECTION_REQUIRED/);
    await db.exec('rollback');
    await db.exec(readFileSync(correction.path,'utf8'));
    assert.deepEqual(await snapshot(),before);
    const afterBodies=await bodies();
    const changed=afterBodies.filter((row,i)=>row.digest!==beforeBodies[i].digest);
    assert.deepEqual(changed.map(row=>row.digest).sort(),correction.functions.map(row=>row[1]).sort());
    // Add only synthetic normal identity policy hooks; do not turn the global requirement on.
    await db.exec(`create function app_security.enforce_verified_actor(uuid,boolean) returns void language plpgsql as $$begin return; end$$;`);
    for(const [table,fn] of [['listings','listings'],['listing_media','by_listing'],['posting_upload_sessions','posting_session'],['posting_staged_media','staged_media']]) {
      await db.exec(`create function app_security.trg_identity_gate_${fn}() returns trigger language plpgsql as $$begin return new; end$$;
        create trigger trg_identity_gate before insert on public.${table} for each row execute function app_security.trg_identity_gate_${fn}();`);
    }
    for(const [azure,google] of [[false,false],[true,false],[false,true],[true,true]]) {
      await db.query("update public.app_system_settings set setting_value=$1 where setting_key='moderation_azure_enabled'",[String(azure)]);
      await db.query("update public.app_system_settings set setting_value=$1 where setting_key='moderation_google_cloud_enabled'",[String(google)]);
      for(const {slug} of V3_GOODS) {
        await db.exec(leafTransaction(`v3-${slug.slice(3)}-activate`,sha));
        assert.equal(Object.values((await db.exec(leafStateSql(slug,true))).find(r=>r.rows?.length).rows[0])[0],'true');
      }
      assert.equal(await scalar('select count(*)::integer from app_security.ordinary_goods_contracts_v3 where enabled'),43);
      // All 15 restricted contracts remain byte-identical, disabled, with their original categories.
      const restricted=(await db.query('select * from app_security.ordinary_goods_contracts_v3 order by slug')).rows.filter(g=>!V3_GOODS.some(a=>a.slug===g.slug));
      assert.equal(restricted.length,15);
      assert.deepEqual(restricted,before.contracts.filter(g=>!V3_GOODS.some(a=>a.slug===g.slug)));
      for (const [signature] of correction.functions) {
        await db.exec('begin');
        const definition=await scalar(`select pg_get_functiondef('${signature}'::regprocedure)`);
        await db.exec(definition.replace('AS $function$', 'AS $function$\n-- regression: body drift\n'));
        await assert.rejects(db.exec(leafPreflightSql(activate,sha)),/CORRECTION_REQUIRED/);
        await db.exec('rollback');
        await db.exec('begin');
        await db.exec(definition.replace('AS $function$', 'AS $function$\n-- regression: body drift\n'));
        await db.exec(leafTransaction(deactivate,sha));
        assert.equal(await scalar("select enabled from app_security.ordinary_goods_contracts_v3 where slug='v2-books'"),false);
        await db.exec('rollback');
        await db.exec(definition);
        await db.exec(leafTransaction(activate,sha));
      }
      // RESET ALL changes proconfig to NULL without touching prosrc. Test both
      // the orchestration predicate and the standalone operator's independent gate.
      for (const [signature,digest] of correction.functions) {
        const definition=await scalar(`select pg_get_functiondef('${signature}'::regprocedure)`);
        const reset=`alter function ${signature} reset all`;
        const operator=readFileSync(getCandidate(activate).path,'utf8').replace(/^\\set.*$/gm,'')
          .replaceAll(":'slug'","'v2-books'").replaceAll(":'web_commit'",`'${sha}'`).replaceAll(":'moderation_mode'","'five_check'");
        await db.exec(reset);
        assert.equal(Object.values((await db.exec(leafStateSql('v2-books',true))).find(r=>r.rows?.length).rows[0])[0],'false');
        await db.exec(definition);
        await db.exec(leafTransaction(deactivate,sha));
        for (const sql of [leafPreflightSql(activate,sha),operator]) {
          await db.exec(reset);
          assert.equal(await scalar(`select proconfig is null and md5(prosrc)='${digest}' from pg_proc where oid='${signature}'::regprocedure`),true);
          await assert.rejects(db.exec(sql),/CORRECTION_REQUIRED/);
          await db.exec('rollback');
          await db.exec(definition);
        }
        await db.exec(leafTransaction(activate,sha));
        await db.exec(reset);
        await db.exec(leafTransaction(deactivate,sha));
        assert.equal(await scalar("select enabled from app_security.ordinary_goods_contracts_v3 where slug='v2-books'"),false);
        await db.exec(definition);
        await db.exec(leafTransaction(activate,sha));
      }
      for(const {slug} of [...V3_GOODS].reverse()) await db.exec(leafTransaction(`v3-${slug.slice(3)}-deactivate`,sha));
    }
  } finally {await db.close();}
});
