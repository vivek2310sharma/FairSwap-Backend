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
import {WEB_CONTRACT_PATHS, leafPlan, leafTransaction, leafPreflightSql, leafStateSql, verifyLeafWeb, verifyLeafReceipt, requireLeafEvidence, releaseV3Leaf} from '../../scripts/release/v3-leaf-release.mjs';
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

test('V3 disposable SQL: disabled, identity missing/off, moderation unavailable, canonical drift, Books-first, repeated activation, exact preservation and rollback',
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
    await setupOrdinaryGoodsFixture(sql => db.exec(sql));
    assert.equal(await state('v2-books', false), 'true');
    await rejects(leafPreflightSql(activate, sha), /GOODS_LISTING_OR_IDENTITY_GUARDS_MISSING/);
    await rejects(leafTransaction(activate, sha), /GOODS_LISTING_OR_IDENTITY_GUARDS_MISSING/);
    await db.exec(`create function app_security.enforce_verified_actor(uuid,boolean) returns void language plpgsql as $$begin return; end$$;`);
    for (const [table, fn] of [['listings','listings'], ['listing_media','by_listing'], ['posting_upload_sessions','posting_session'], ['posting_staged_media','staged_media']]) {
      await db.exec(`create function app_security.trg_identity_gate_${fn}() returns trigger language plpgsql as $$begin return new; end$$;
        create trigger trg_identity_gate before insert on public.${table} for each row execute function app_security.trg_identity_gate_${fn}();`);
    }
    await rejects(leafTransaction(activate, sha), /GOODS_SELLER_IDENTITY_ENFORCEMENT_OFF/);
    await db.exec("insert into public.app_system_settings(setting_key,setting_value) values('identity_verification_required','true')");
    await rejects(leafTransaction(activate, sha), /GOODS_FIVE_CHECK_MODERATION_NOT_READY/);
    await db.exec("update public.app_system_settings set setting_value='true' where setting_key='moderation_azure_enabled'");
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
