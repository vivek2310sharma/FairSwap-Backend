import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {deflateRawSync, crc32 as zlibCrc32} from 'node:zlib';
import {join} from 'node:path';
import {rootCertificates} from 'node:tls';
import {X509Certificate, createHash} from 'node:crypto';
import {getCandidate, verifyCandidateSha, CANDIDATES, planDispatch, ACCESSORIES_WEB} from '../../scripts/release/reusable-candidates.mjs';
import {assertLedgerOrdering, assertPreflight, parseLedgerVersions, postflightKeys, postflightQuery, preflightEnabledQuery, preflightQuery, readZipEntries, recoveredFoundationSha, requireStageEvidence, runAccessoriesPostflight, runLivePreflight, validateReceipt, verifyAccessoriesLedger, verifyHistoryPreserved, verifyWebDeployments} from '../../scripts/release/accessories-v1-release.mjs';
import {parsePendingDryRun, verifyLedgerVersion, releaseReusable, subprocessFailure, REFS} from '../../scripts/release/reusable-supabase-release.mjs';

test('candidate registry correctly registers moderation-analytics-v1', () => {
  const c = getCandidate('moderation-analytics-v1');
  assert.equal(c.version, '20261102000000');
  assert.equal(c.filename, '20261102000000_admin_moderation_analytics_v1.sql');
  assert.equal(c.sha256, '8c046431a4f37369626cafee75dd8eb27bca25db96dab9d70c2125f1a2bc46f8');
});

test('candidate SHA matches actual file on disk', () => {
  const result = verifyCandidateSha('moderation-analytics-v1');
  assert.equal(result.sha256, '8c046431a4f37369626cafee75dd8eb27bca25db96dab9d70c2125f1a2bc46f8');
});

test('candidate registry correctly registers moderation-azure-v1', () => {
  const c = getCandidate('moderation-azure-v1');
  assert.equal(c.version, '20261104113705');
  assert.equal(c.filename, '20261104113705_azure_moderation_finalizer.sql');
  assert.equal(c.sha256, '8a87ad04f7516737d8248eb4cbd4dcf644428300e67d5dd1190b74ec25090fa8');
  assert.equal(c.autoPromote, true);
});

test('Azure candidate SHA matches the verified forward migration', () => {
  const c = verifyCandidateSha('moderation-azure-v1');
  assert.equal(c.sha256, '8a87ad04f7516737d8248eb4cbd4dcf644428300e67d5dd1190b74ec25090fa8');
});

test('candidate validation rejects unknown candidate', () => {
  assert.throws(() => {
    getCandidate('unknown-candidate-xyz');
  }, /REUSABLE_RELEASE_UNKNOWN_CANDIDATE/);
});

test('parsePendingDryRun passes on exact single matching migration from stdout and stderr combined', () => {
  const sample = `
    [info] Inspecting remote database...
    Applying migration 20261102000000_admin_moderation_analytics_v1.sql...
    Finished supabase db push.
  `;
  const res = parsePendingDryRun(sample, '20261102000000_admin_moderation_analytics_v1.sql');
  assert.deepEqual(res, ['20261102000000_admin_moderation_analytics_v1.sql']);
});

test('parsePendingDryRun fails if unexpected additional migrations are pending', () => {
  const sample = `
    Applying migration 20261101000000_unrelated.sql...
    Applying migration 20261102000000_admin_moderation_analytics_v1.sql...
  `;
  assert.throws(() => {
    parsePendingDryRun(sample, '20261102000000_admin_moderation_analytics_v1.sql');
  }, /REUSABLE_RELEASE_DRY_RUN_MISMATCH/);
});

test('parsePendingDryRun fails if no migrations are pending', () => {
  const sample = `
    All migrations already applied. Everything up to date.
  `;
  assert.throws(() => {
    parsePendingDryRun(sample, '20261102000000_admin_moderation_analytics_v1.sql');
  }, /REUSABLE_RELEASE_DRY_RUN_MISMATCH/);
});

test('verifyLedgerVersion requires valid LOCAL | REMOTE | TIME (UTC) table with synchronized candidate row', () => {
  const realisticCliOutput = `
Connecting to remote database...
LOCAL           | REMOTE          | TIME (UTC)
----------------+-----------------+---------------------
20261017205807  | 20261017205807  | 2026-10-17 20:58:07
20261102000000  | 20261102000000  | 2026-11-02 00:00:00
`;
  assert.doesNotThrow(() => {
    verifyLedgerVersion(realisticCliOutput, '20261102000000');
  });

  const backtickCliOutput = 'LOCAL | REMOTE | TIME (UTC)\n`20261102000000` | `20261102000000` | 2026-11-02 00:00:00\n';
  assert.doesNotThrow(() => verifyLedgerVersion(backtickCliOutput, '20261102000000'));
  const malformedBacktickCliOutput = 'LOCAL | REMOTE | TIME (UTC)\n`20261102000000 | 20261102000000 | 2026-11-02 00:00:00\n';
  assert.throws(() => verifyLedgerVersion(malformedBacktickCliOutput, '20261102000000'), /REUSABLE_RELEASE_LEDGER_MALFORMED_ROW/);
  // Missing headers fails closed
  const missingHeaderOutput = `
20261017205807  | 20261017205807  | 2026-10-17 20:58:07
20261102000000  | 20261102000000  | 2026-11-02 00:00:00
`;
  assert.throws(() => {
    verifyLedgerVersion(missingHeaderOutput, '20261102000000');
  }, /REUSABLE_RELEASE_LEDGER_HEADER_MISSING/);

  // Bare version string without table fails closed
  assert.throws(() => {
    verifyLedgerVersion('20261102000000 applied successfully', '20261102000000');
  }, /REUSABLE_RELEASE_LEDGER_HEADER_MISSING/);

  // Local-only migration fails closed
  const localOnlyOutput = `
LOCAL           | REMOTE          | TIME (UTC)
----------------+-----------------+---------------------
20261102000000  |                 |
`;
  assert.throws(() => {
    verifyLedgerVersion(localOnlyOutput, '20261102000000');
  }, /REUSABLE_RELEASE_LEDGER_UNSYNCHRONIZED/);

  // Remote-only migration fails closed
  const remoteOnlyOutput = `
LOCAL           | REMOTE          | TIME (UTC)
----------------+-----------------+---------------------
                | 20261102000000  | 2026-11-02 00:00:00
`;
  assert.throws(() => {
    verifyLedgerVersion(remoteOnlyOutput, '20261102000000');
  }, /REUSABLE_RELEASE_LEDGER_UNSYNCHRONIZED/);

  // Partial match fails closed
  const partialMatchOutput = `
LOCAL           | REMOTE          | TIME (UTC)
----------------+-----------------+---------------------
2026110200000099| 2026110200000099| 2026-11-02 00:00:00
`;
  assert.throws(() => {
    verifyLedgerVersion(partialMatchOutput, '20261102000000');
  }, /REUSABLE_RELEASE_LEDGER_PARTIAL_MATCH/);

  // Duplicate candidate rows fail closed
  const duplicateOutput = `
LOCAL           | REMOTE          | TIME (UTC)
----------------+-----------------+---------------------
20261102000000  | 20261102000000  | 2026-11-02 00:00:00
20261102000000  | 20261102000000  | 2026-11-02 00:00:01
`;
  assert.throws(() => {
    verifyLedgerVersion(duplicateOutput, '20261102000000');
  }, /REUSABLE_RELEASE_LEDGER_DUPLICATE_ROW/);

  // Missing version fails closed
  const missingVersionOutput = `
LOCAL           | REMOTE          | TIME (UTC)
----------------+-----------------+---------------------
20261017205807  | 20261017205807  | 2026-10-17 20:58:07
`;
  assert.throws(() => {
    verifyLedgerVersion(missingVersionOutput, '20261102000000');
  }, /REUSABLE_RELEASE_EXACT_LEDGER_ENTRY_MISSING/);
});

test('subprocessFailure sanitizes errors and maps diagnostic categories', () => {
  const sqlError = subprocessFailure({status: 1, stderr: 'psql: error: ERROR: 42501 permission denied for function foo'}, 'postflight');
  assert.equal(sqlError.message, 'REUSABLE_SUBPROCESS_POSTFLIGHT_SQL_PERMISSION_FAILED');

  const authError = subprocessFailure({status: 1, stderr: 'FATAL: 28P01 password authentication failed for user "postgres"'}, 'apply');
  assert.equal(sqlError.message.includes('password'), false);
  assert.equal(authError.message, 'REUSABLE_SUBPROCESS_APPLY_AUTHENTICATION_FAILED');

  const tlsError = subprocessFailure({status: 1, stderr: 'SSL connection failed: certificate verify failed'}, 'connect');
  assert.equal(tlsError.message, 'REUSABLE_SUBPROCESS_CONNECT_TLS_FAILED');
});

test('target environment references are correctly mapped', () => {
  assert.equal(REFS.FairSwapTest, 'wpppxlnbzqynvhpeuavd');
  assert.equal(REFS.FairSwapProd, 'kriuhwppxgxsyyrbjsau');
});

test('failed postflight blocks receipt generation and throws fail-closed error', async () => {
  // Synthetic runner simulating push success but postflight failure
  const mockRunner = (cmd, args) => {
    if (cmd === 'supabase' && args.includes('--version')) return '2.117.0\n';
    if (cmd === 'supabase' && args.includes('init')) return '';
    if (cmd === 'supabase' && args.includes('link')) {
      const workdirIdx = args.indexOf('--workdir');
      const ws = args[workdirIdx + 1];
      mkdirSync(join(ws, 'supabase/.temp'), {recursive: true});
      writeFileSync(join(ws, 'supabase/.temp/project-ref'), 'wpppxlnbzqynvhpeuavd\n');
      return '';
    }
    if (cmd === 'supabase' && args.includes('migration') && args.includes('fetch')) {
      const workdirIdx = args.indexOf('--workdir');
      const ws = args[workdirIdx + 1];
      mkdirSync(join(ws, 'supabase/migrations'), {recursive: true});
      for (let i = 1; i <= 55; i++) {
        writeFileSync(join(ws, 'supabase/migrations', `202601010000${String(i).padStart(2, '0')}_test.sql`), '-- test');
      }
      return '';
    }
    if (cmd === 'supabase' && args.includes('db') && args.includes('push') && args.includes('--dry-run')) {
      return 'Applying migration 20261102000000_admin_moderation_analytics_v1.sql...';
    }
    if (cmd === 'supabase' && args.includes('db') && args.includes('push')) return '';
    if (cmd === 'supabase' && args.includes('migration') && args.includes('list')) {
      return `
LOCAL           | REMOTE          | TIME (UTC)
----------------+-----------------+---------------------
20261102000000  | 20261102000000  | 2026-11-02 00:00:00
`;
    }
    if (cmd === 'psql') {
      // Simulate missing security definer or missing permissions
      return JSON.stringify({
        public_signature_exact: true,
        app_security_signature_exact: false, // FAILURE
        no_public_execute: true,
        no_anon_execute: true,
        auth_can_execute: true
      });
    }
    return '';
  };

  const validPem = rootCertificates.find(p => {
    const c = new X509Certificate(p);
    return c.ca && Date.parse(c.validFrom) <= Date.now() && Date.parse(c.validTo) > Date.now();
  });

  const sampleEnv = {
    SUPABASE_ACCESS_TOKEN: 'sbp_mock_token',
    CHAT_DATABASE_PASSWORD: 'mock_password',
    CHAT_DB_POOLER_HOST: 'aws-0-ap-south-1.pooler.supabase.com',
    CHAT_DB_SSL_ROOT_CERT_PEM: validPem
  };

  await assert.rejects(async () => {
    await releaseReusable({
      environment: 'FairSwapTest',
      candidateId: 'moderation-analytics-v1',
      context: sampleEnv,
      runner: mockRunner,
      receiptDir: '/tmp/test-receipts-never-written'
    });
  }, /REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED/);
});

test('workflow syntax contains required security checks', () => {
  const yaml = readFileSync(join(process.cwd(), '.github/workflows/reusable-supabase-release.yml'), 'utf8');
  assert(yaml.includes('concurrency:'));
  assert(yaml.includes('github.repository == \'vivek2310sharma/FairSwap-Backend\''));
  assert(yaml.includes('github.actor == \'vivek2310sharma\''));
  assert(yaml.includes('github.triggering_actor == \'vivek2310sharma\''));
  assert(yaml.includes('inputs.approved_sha == github.sha'));
  assert(yaml.includes('environment: FairSwapTest'));
  assert(yaml.includes('environment: FairSwapProd'));
  assert(yaml.includes('- moderation-azure-v1'));
});

test('Azure moderation postflight query is evaluated for moderation-azure-v1 candidate', async () => {
  const {verifyRemotePostflight} = await import('../../scripts/release/reusable-supabase-release.mjs');
  const mockRunner = (cmd, args) => {
    if (cmd === 'psql') {
      return JSON.stringify({
        verified_hashes_table_rls: true,
        scan_receipts_table_rls: true,
        tables_no_anon: true,
        tables_no_auth: true,
        tables_service_role_all_ops: true,
        registrar_search_path: true,
        finalizer_search_path: true,
        rpc_exact_signatures: true,
        registrar_no_public: true,
        registrar_service_role: true,
        finalizer_no_public: true,
        finalizer_service_role: true
      });
    }
    return '';
  };

  const res = await verifyRemotePostflight('FairSwapTest', 'moderation-azure-v1', 'postgres://mock', {}, mockRunner);
  assert.equal(res.verified_hashes_table_rls, true);
  assert.equal(res.tables_service_role_all_ops, true);
  assert.equal(res.rpc_exact_signatures, true);
  assert.equal(res.finalizer_service_role, true);
});

// ---------------------------------------------------------------------------------------------
// Accessories V1
// ---------------------------------------------------------------------------------------------
const FOUNDATION = 'accessories-v1-foundation';
const ACTIVATION = 'accessories-v1-activation';
const TABLETS = '20261102165946';
const web = {web_staging_sha: ACCESSORIES_WEB.stagingSha};
const SHA_PROD_WEB = 'a'.repeat(40);

const ledger = versions => `Connecting to remote database...
LOCAL | REMOTE | TIME (UTC)
---+---+---
${versions.map(v => `${v} | ${v} | 2026-11-02 00:00:00`).join('\n')}
`;
const baseHistory = Array.from({length: 55}, (_, i) => `202601010000${String(i).padStart(2, '0')}`);
const goodPost = stage => Object.fromEntries(postflightKeys(stage).map(k => [k, true]));
const goodPre = {foundation_installed: false, enabled: false, category_active: false, tablets_wrapped: false};
const installedPre = {...goodPre, foundation_installed: true};
const validPem = rootCertificates.find(p => {
  const c = new X509Certificate(p);
  return c.ca && Date.parse(c.validFrom) <= Date.now() && Date.parse(c.validTo) > Date.now();
});
const baseEnv = {
  SUPABASE_ACCESS_TOKEN: 'sbp_mock_token', CHAT_DATABASE_PASSWORD: 'mock_password',
  CHAT_DB_POOLER_HOST: 'aws-0-ap-south-1.pooler.supabase.com', CHAT_DB_SSL_ROOT_CERT_PEM: validPem
};

function makeRunner({before, after, pre = goodPre, post, version, filename, calls = [], sql}) {
  let listCalls = 0;
  return (cmd, args) => {
    calls.push(cmd === 'psql' ? `psql:${args[args.length - 1].split('\n')[0]}` : `${cmd} ${args.filter(a => !a.startsWith('--')).join(' ')}`);
    if (cmd === 'supabase' && args.includes('--version')) return '2.117.0\n';
    if (cmd === 'supabase' && args.includes('link')) {
      const ws = args[args.indexOf('--workdir') + 1];
      mkdirSync(join(ws, 'supabase/.temp'), {recursive: true});
      writeFileSync(join(ws, 'supabase/.temp/project-ref'), `${args[args.indexOf('--project-ref') + 1]}\n`);
      return '';
    }
    if (cmd === 'supabase' && args.includes('fetch')) {
      const ws = args[args.indexOf('--workdir') + 1];
      mkdirSync(join(ws, 'supabase/migrations'), {recursive: true});
      baseHistory.forEach(v => writeFileSync(join(ws, 'supabase/migrations', `${v}_t.sql`), '-- t'));
      return '';
    }
    if (cmd === 'supabase' && args.includes('--dry-run')) return `Applying migration ${filename}...`;
    if (cmd === 'supabase' && args.includes('list')) return ledger(listCalls++ === 0 ? before : after);
    if (cmd === 'psql') {
      const q = args[args.length - 1];
      return JSON.stringify(sql ? sql(q) : q.includes('accessories-preflight') ? pre : post);
    }
    return '';
  };
}

async function release(candidateId, environment, o) {
  const c = getCandidate(candidateId);
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'fs-test-receipts-'));
  const runner = makeRunner({version: c.version, filename: c.filename, calls, ...o});
  const receipt = await releaseReusable({environment, candidateId, context: {...baseEnv, ...(o.env ?? {})}, runner, receiptDir: dir});
  return {receipt, calls, dir};
}

test('accessories candidates register exact versions, files and SHA-256 hashes', () => {
  const f = getCandidate(FOUNDATION);
  const a = getCandidate(ACTIVATION);
  assert.equal(f.version, '20261102164135');
  assert.equal(f.filename, '20261102164135_accessories_v1.sql');
  assert.equal(f.sha256, '790f6e2e06fb049d84903b42fad9bf8efd359a248ac0ecfcdd69f1e897142e9a');
  assert.equal(a.version, '20261102164137');
  assert.equal(a.filename, '20261102164137_activate_accessories_v1.sql');
  assert.equal(a.sha256, '3fe0647b33ad914efca86b5a9aa91590be1d2d42ac20eb42cdc5d38ee3baabcd');
  assert.equal(verifyCandidateSha(FOUNDATION).sha256, f.sha256);
  assert.equal(verifyCandidateSha(ACTIVATION).sha256, a.sha256);
  // Exactly one migration per stage directory, no extras
  for (const c of [f, a]) {
    const dir = join(process.cwd(), c.path, '..');
    assert.deepEqual(readdirSync(dir), [c.filename]);
  }
});

test('modified candidate bytes are rejected by hash verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-test-root-'));
  const c = getCandidate(ACTIVATION);
  mkdirSync(join(root, c.path, '..'), {recursive: true});
  writeFileSync(join(root, c.path), readFileSync(join(process.cwd(), c.path), 'utf8') + '\n-- extra');
  assert.throws(() => verifyCandidateSha(ACTIVATION, root), /REUSABLE_RELEASE_CANDIDATE_HASH_MISMATCH/);
});

test('moderation candidate is unchanged and still auto-promotes', () => {
  const m = getCandidate('moderation-analytics-v1');
  assert.equal(m.autoPromote, true);
  assert.notEqual(m.strict, true);
  const plan = planDispatch({candidateId: 'moderation-analytics-v1', target: 'test'});
  assert.deepEqual(plan.priorRuns, []);
  assert.throws(() => planDispatch({candidateId: 'moderation-analytics-v1', target: 'production'}), /TARGET_NOT_SUPPORTED/);
  assert.equal(getCandidate(FOUNDATION).autoPromote, false);
});

test('Azure moderation candidate is correctly sequenced after all installed Test migrations', () => {
  const azure = getCandidate('moderation-azure-v1');
  const accessoriesFoundation = getCandidate('accessories-v1-foundation');
  const accessoriesActivation = getCandidate('accessories-v1-activation');
  const analytics = getCandidate('moderation-analytics-v1');

  // Verify version ordering: Azure V1 must be strictly newer than analytics and accessories
  assert(BigInt(azure.version) > BigInt('20261102164135'), 'Azure V1 version must be later than Test-installed accessories foundation 20261102164135');
  assert(BigInt(azure.version) > BigInt(accessoriesFoundation.version), 'Azure V1 must be sequenced after accessories foundation');
  assert(BigInt(azure.version) > BigInt(accessoriesActivation.version), 'Azure V1 must be sequenced after accessories activation');
  assert(BigInt(azure.version) > BigInt(analytics.version), 'Azure V1 must be sequenced after analytics');

  // Verify candidate properties
  assert.equal(azure.filename, `${azure.version}_azure_moderation_finalizer.sql`);
  assert.equal(azure.path, `supabase/forward-migrations/moderation-azure-v1/${azure.filename}`);
  assert.equal(azure.autoPromote, true);
});

test('unrecognized or non-strict candidates can never pass through a NO_SPECIFIC_POSTFLIGHT fallback', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/release/reusable-supabase-release.mjs'), 'utf8');
  assert(!/return\s*\{\s*status:\s*'NO_SPECIFIC_POSTFLIGHT'/.test(src));
  assert(src.includes('REUSABLE_RELEASE_NO_POSTFLIGHT_IMPLEMENTED'));
  assert.deepEqual(Object.keys(CANDIDATES).sort(), ['accessories-v1-activation', 'accessories-v1-foundation', 'moderation-analytics-v1', 'moderation-azure-v1', 'tablets-v1-activation', 'tablets-v1-foundation']);
});

test('moderation postflight still passes when every check is true', async () => {
  const c = getCandidate('moderation-analytics-v1');
  const ok = {public_signature_exact: true, app_security_signature_exact: true, no_public_execute: true, no_anon_execute: true, auth_can_execute: true};
  const {verifyRemotePostflight} = await import('../../scripts/release/reusable-supabase-release.mjs');
  assert.deepEqual(await verifyRemotePostflight('FairSwapTest', c.id, 'url', {}, () => JSON.stringify(ok)), ok);
});

test('dispatch plan requires Web verification and ordered stage evidence', () => {
  assert.throws(() => planDispatch({candidateId: ACTIVATION, target: 'test', inputs: {test_foundation_run_id: '10'}}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: ACTIVATION, target: 'test', inputs: {...web, web_staging_sha: 'b'.repeat(40), test_foundation_run_id: '10'}}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: ACTIVATION, target: 'test', inputs: web}), /EVIDENCE_RUN_REQUIRED_TEST_FOUNDATION_RUN_ID/);
  assert.throws(() => planDispatch({candidateId: FOUNDATION, target: 'production', inputs: {...web, test_foundation_run_id: '10'}}), /EVIDENCE_RUN_REQUIRED_TEST_ACTIVATION_RUN_ID/);
  assert.throws(() => planDispatch({candidateId: FOUNDATION, target: 'production', inputs: {test_foundation_run_id: '10', test_activation_run_id: '11'}}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: ACTIVATION, target: 'production', inputs: {...web, test_activation_run_id: '11', prod_foundation_run_id: '12'}}), /WEB_PRODUCTION_VERIFICATION_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: ACTIVATION, target: 'production', inputs: {...web, test_activation_run_id: '11', prod_foundation_run_id: '12', web_production_sha: ACCESSORIES_WEB.productionBaselineSha}}), /WEB_PRODUCTION_VERIFICATION_REQUIRED/);
  assert.throws(() => planDispatch({candidateId: ACTIVATION, target: 'production', inputs: {...web, test_activation_run_id: '11', web_production_sha: SHA_PROD_WEB}}), /EVIDENCE_RUN_REQUIRED_PROD_FOUNDATION_RUN_ID/);
  assert.throws(() => planDispatch({candidateId: FOUNDATION, target: 'staging'}), /INVALID_TARGET/);
  assert.equal(planDispatch({candidateId: FOUNDATION, target: 'test'}).priorRuns.length, 0);
  assert.equal(planDispatch({candidateId: FOUNDATION, target: 'production', inputs: {...web, test_foundation_run_id: '10', test_activation_run_id: '11'}}).priorRuns.length, 2);
  const act = planDispatch({candidateId: ACTIVATION, target: 'production', inputs: {...web, test_activation_run_id: '11', prod_foundation_run_id: '12', web_production_sha: SHA_PROD_WEB}});
  assert.deepEqual(act.priorRuns.map(r => [r.runId, r.environment]), [['11', 'test'], ['12', 'prod']]);
});

test('ledger ordering: missing prerequisite, Tablets ahead, partial state and applied detection fail closed', () => {
  const f = getCandidate(FOUNDATION);
  const a = getCandidate(ACTIVATION);
  assert.throws(() => assertLedgerOrdering(a, ledger(baseHistory)), /PREREQUISITE_MIGRATION_MISSING/);
  assert.throws(() => assertLedgerOrdering(a, 'LOCAL | REMOTE | TIME (UTC)\n20261102164135 | | \n'), /PREREQUISITE_MIGRATION_MISSING/);
  assert.throws(() => assertLedgerOrdering(f, ledger([...baseHistory, TABLETS])), /INCOMPATIBLE_MIGRATION_ORDER/);
  assert.throws(() => assertLedgerOrdering(a, ledger([...baseHistory, f.version, TABLETS])), /INCOMPATIBLE_MIGRATION_ORDER/);
  assert.throws(() => assertLedgerOrdering(f, ledger([...baseHistory, a.version])), /INCOMPATIBLE_MIGRATION_ORDER/);
  assert.throws(() => assertLedgerOrdering(f, `LOCAL | REMOTE | TIME (UTC)\n${f.version} | | \n`), /PARTIAL_RELEASE_LEDGER/);
  assert.throws(() => assertLedgerOrdering(f, `LOCAL | REMOTE | TIME (UTC)\n | ${f.version} | \n`), /PARTIAL_RELEASE_LEDGER/);
  assert.equal(assertLedgerOrdering(f, ledger(baseHistory)).state, 'absent');
  assert.equal(assertLedgerOrdering(f, ledger([...baseHistory, f.version])).state, 'applied');
  assert.equal(assertLedgerOrdering(a, ledger([...baseHistory, f.version, a.version])).state, 'applied');
  assert.throws(() => parseLedgerVersions('20261102164135 applied'), /LEDGER_HEADER_MISSING/);
  assert.throws(() => verifyHistoryPreserved(new Set(baseHistory), ledger(baseHistory.slice(1).concat(f.version)), f.version), /LEDGER_HISTORY_CHANGED/);
  assert.throws(() => verifyHistoryPreserved(new Set(baseHistory), ledger([...baseHistory, f.version, '20270101000000']), f.version), /LEDGER_HISTORY_CHANGED/);
});

test('live preflight rejects invalid activation order and Tablets wrappers', () => {
  const f = getCandidate(FOUNDATION);
  const a = getCandidate(ACTIVATION);
  assert.doesNotThrow(() => assertPreflight(f, goodPre));
  assert.doesNotThrow(() => assertPreflight(a, installedPre));
  assert.throws(() => assertPreflight(a, goodPre), /PREREQUISITE_NOT_MET/);
  assert.throws(() => assertPreflight(a, {...installedPre, category_active: true}), /INVALID_ACTIVATION_ORDER/);
  assert.throws(() => assertPreflight(a, {...installedPre, enabled: true}), /INVALID_ACTIVATION_ORDER/);
  assert.throws(() => assertPreflight(f, {...goodPre, tablets_wrapped: true}), /INCOMPATIBLE_MIGRATION_ORDER/);
  assert.throws(() => assertPreflight(f, installedPre), /PARTIAL_RELEASE_STATE/);
  assert.throws(() => assertPreflight(f, {foundation_installed: 'yes'}), /PREFLIGHT_INVALID_RESPONSE/);
});

test('postflight queries are read-only and inspect RLS, ACL, state and Mobile Phones compatibility', () => {
  for (const q of [postflightQuery('foundation'), postflightQuery('activation'), preflightQuery()]) {
    assert(q.includes('BEGIN READ ONLY;') && q.trim().endsWith('COMMIT;'));
    assert(!/\b(insert\s+into|update\s+public|delete\s+from|alter\s+|create\s+|drop\s+|truncate\s+|grant\s+|revoke\s+)/i.test(q.replace(/has_\w+_privilege\([^)]*\)/g, '')));
  }
  const foundation = postflightQuery('foundation');
  assert(foundation.includes('enabled = false') && foundation.includes("c.is_active = false") && foundation.includes('no_accessory_rows'));
  const activation = postflightQuery('activation');
  assert(activation.includes('enabled = true') && activation.includes('c.is_active = true') && !activation.includes('no_accessory_rows'));
  for (const q of [foundation, activation]) {
    for (const needle of ['relforcerowsecurity', 'pg_policies', "'accessory_context_read'", 'submit_accessory_v1', 'submit_mobile_v2', 'posting_v2_session',
      "slug = 'mobile-phones'", 'draft_protected', 'zz_accessory_listing_guard_v1', 'impl_submit_mobile_v2_before_tablets', "new_listing_enabled = false"]) {
      assert(q.includes(needle), needle);
    }
  }
});

test('postflight rejects incorrect permissions, RLS, missing and unexpected checks', () => {
  const f = getCandidate(FOUNDATION);
  assert.doesNotThrow(() => runAccessoriesPostflight(f, JSON.stringify(goodPost('foundation'))));
  for (const key of ['rls_forced', 'rls_policies', 'no_client_writes', 'accessory_function_acl', 'mobile_function_acl', 'catalogue_rpc', 'category_state']) {
    assert.throws(() => runAccessoriesPostflight(f, JSON.stringify({...goodPost('foundation'), [key]: false})), new RegExp(`POSTFLIGHT_VERIFICATION_FAILED: ${key}`));
    assert.throws(() => runAccessoriesPostflight(f, JSON.stringify({...goodPost('foundation'), [key]: null})), /POSTFLIGHT_VERIFICATION_FAILED/);
  }
  const partial = goodPost('foundation');
  delete partial.rls_forced;
  assert.throws(() => runAccessoriesPostflight(f, JSON.stringify(partial)), /POSTFLIGHT_VERIFICATION_FAILED/);
  assert.throws(() => runAccessoriesPostflight(f, JSON.stringify({...goodPost('foundation'), extra: true})), /POSTFLIGHT_VERIFICATION_FAILED/);
  assert.throws(() => runAccessoriesPostflight(f, JSON.stringify({status: 'NO_SPECIFIC_POSTFLIGHT'})), /POSTFLIGHT_VERIFICATION_FAILED/);
  assert.throws(() => runAccessoriesPostflight(f, 'not json'), /POSTFLIGHT_INVALID_RESPONSE/);
});

test('foundation Test release installs disabled with strict ordered checks and receipt', async () => {
  const {receipt, calls, dir} = await release(FOUNDATION, 'FairSwapTest', {
    before: baseHistory, after: [...baseHistory, getCandidate(FOUNDATION).version], post: goodPost('foundation')
  });
  assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
  assert.equal(receipt.stage, 'foundation');
  assert.equal(receipt.migrationSha256, getCandidate(FOUNDATION).sha256);
  assert(existsSync(join(dir, `${FOUNDATION}-fairswaptest.json`)));
  const order = ['psql:-- accessories-preflight', 'supabase db push --dry-run'.replace(' --dry-run', ''), 'psql:-- accessories-postflight foundation'];
  assert(calls.findIndex(c => c === order[0]) < calls.findIndex(c => c.startsWith('supabase db push')));
  assert(calls.findIndex(c => c.startsWith('supabase db push')) < calls.indexOf(order[2]));
});

test('activation Test release requires foundation evidence inputs and live disabled foundation', async () => {
  const f = getCandidate(FOUNDATION);
  const a = getCandidate(ACTIVATION);
  const env = {...web, TEST_FOUNDATION_RUN_ID: '10'};
  const wrapped = {WEB_STAGING_SHA: web.web_staging_sha, TEST_FOUNDATION_RUN_ID: '10'};
  const ok = await release(ACTIVATION, 'FairSwapTest', {before: [...baseHistory, f.version], after: [...baseHistory, f.version, a.version], pre: installedPre, post: goodPost('activation'), env: wrapped});
  assert.equal(ok.receipt.stage, 'activation');
  assert.equal(ok.receipt.webStagingSha, ACCESSORIES_WEB.stagingSha);
  // Missing Web verification
  await assert.rejects(release(ACTIVATION, 'FairSwapTest', {before: [...baseHistory, f.version], after: [], pre: installedPre, post: goodPost('activation'), env: {TEST_FOUNDATION_RUN_ID: '10'}}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  // Missing prerequisite migration in ledger
  await assert.rejects(release(ACTIVATION, 'FairSwapTest', {before: baseHistory, after: [], pre: installedPre, post: goodPost('activation'), env: wrapped}), /PREREQUISITE_MIGRATION_MISSING/);
  // Category already active (invalid order) and foundation missing live
  await assert.rejects(release(ACTIVATION, 'FairSwapTest', {before: [...baseHistory, f.version], after: [], pre: {...installedPre, category_active: true}, post: goodPost('activation'), env: wrapped}), /INVALID_ACTIVATION_ORDER/);
  await assert.rejects(release(ACTIVATION, 'FairSwapTest', {before: [...baseHistory, f.version], after: [], pre: goodPre, post: goodPost('activation'), env: wrapped}), /PREREQUISITE_NOT_MET/);
  void env;
});

test('Production foundation requires Web and Test evidence, then verifies disabled state', async () => {
  const f = getCandidate(FOUNDATION);
  const env = {WEB_STAGING_SHA: web.web_staging_sha, TEST_FOUNDATION_RUN_ID: '10', TEST_ACTIVATION_RUN_ID: '11'};
  const ok = await release(FOUNDATION, 'FairSwapProd', {before: baseHistory, after: [...baseHistory, f.version], post: goodPost('foundation'), env});
  assert.equal(ok.receipt.environment, 'FairSwapProd');
  await assert.rejects(release(FOUNDATION, 'FairSwapProd', {before: baseHistory, after: [...baseHistory, f.version], post: goodPost('foundation'), env: {WEB_STAGING_SHA: env.WEB_STAGING_SHA, TEST_FOUNDATION_RUN_ID: '10'}}), /EVIDENCE_RUN_REQUIRED_TEST_ACTIVATION_RUN_ID/);
  await assert.rejects(release(FOUNDATION, 'FairSwapProd', {before: baseHistory, after: [...baseHistory, f.version], post: goodPost('foundation'), env: {...env, WEB_STAGING_SHA: ''}}), /WEB_STAGING_VERIFICATION_REQUIRED/);
});

test('Production activation requires deployed Web production commit and Production foundation', async () => {
  const f = getCandidate(FOUNDATION);
  const a = getCandidate(ACTIVATION);
  const env = {WEB_STAGING_SHA: web.web_staging_sha, WEB_PRODUCTION_SHA: SHA_PROD_WEB, TEST_ACTIVATION_RUN_ID: '11', PROD_FOUNDATION_RUN_ID: '12'};
  const ok = await release(ACTIVATION, 'FairSwapProd', {before: [...baseHistory, f.version], after: [...baseHistory, f.version, a.version], pre: installedPre, post: goodPost('activation'), env});
  assert.equal(ok.receipt.webProductionSha, SHA_PROD_WEB);
  await assert.rejects(release(ACTIVATION, 'FairSwapProd', {before: [...baseHistory, f.version], after: [], pre: installedPre, post: goodPost('activation'), env: {...env, WEB_PRODUCTION_SHA: ''}}), /WEB_PRODUCTION_VERIFICATION_REQUIRED/);
});

test('failed postflight, partial and already-applied releases fail closed or resume verified', async () => {
  const f = getCandidate(FOUNDATION);
  const a = getCandidate(ACTIVATION);
  const bad = {...goodPost('foundation'), rls_policies: false};
  await assert.rejects(release(FOUNDATION, 'FairSwapTest', {before: baseHistory, after: [...baseHistory, f.version], post: bad}), /POSTFLIGHT_VERIFICATION_FAILED: rls_policies/);
  // Apply that leaves the ledger unsynchronized or with changed history
  await assert.rejects(release(FOUNDATION, 'FairSwapTest', {before: baseHistory, after: baseHistory, post: goodPost('foundation')}), /EXACT_LEDGER_ENTRY_MISSING/);
  await assert.rejects(release(FOUNDATION, 'FairSwapTest', {before: baseHistory, after: [...baseHistory.slice(1), f.version], post: goodPost('foundation')}), /LEDGER_HISTORY_CHANGED/);
  // Partial release state: ledger half-recorded
  await assert.rejects(releaseReusable({environment: 'FairSwapTest', candidateId: FOUNDATION, context: {...baseEnv}, receiptDir: '/tmp/never',
    runner: (cmd, args) => (cmd === 'supabase' && args.includes('list') ? `LOCAL | REMOTE | TIME (UTC)\n${f.version} | |\n` : makeRunner({before: baseHistory, after: baseHistory, post: goodPost('foundation'), filename: f.filename})(cmd, args))}), /PARTIAL_RELEASE_LEDGER/);
  // Already applied: Test and Production resume with postflight only and no push
  for (const environment of ['FairSwapTest', 'FairSwapProd']) {
    const env = environment === 'FairSwapProd' ? {WEB_STAGING_SHA: web.web_staging_sha, TEST_FOUNDATION_RUN_ID: '10', TEST_ACTIVATION_RUN_ID: '11'} : {};
    const r = await release(FOUNDATION, environment, {before: [...baseHistory, f.version], after: [...baseHistory, f.version], post: goodPost('foundation'), env});
    assert.equal(r.receipt.status, 'ALREADY_APPLIED_VERIFIED');
    assert(!r.calls.some(c => c.startsWith('supabase db push')));
  }
  // Already applied but database state wrong still fails
  await assert.rejects(release(FOUNDATION, 'FairSwapTest', {before: [...baseHistory, f.version], after: [], post: bad}), /POSTFLIGHT_VERIFICATION_FAILED/);
  // Activation applied while Tablets already landed
  await assert.rejects(release(ACTIVATION, 'FairSwapTest', {before: [...baseHistory, f.version, TABLETS], after: [], pre: installedPre, post: goodPost('activation'), env: {WEB_STAGING_SHA: web.web_staging_sha, TEST_FOUNDATION_RUN_ID: '10'}}), /INCOMPATIBLE_MIGRATION_ORDER/);
  void a;
});

test('Tablets wrapper present live blocks foundation before any push', async () => {
  const calls = [];
  await assert.rejects(release(FOUNDATION, 'FairSwapTest', {before: baseHistory, after: [], pre: {...goodPre, tablets_wrapped: true}, post: goodPost('foundation'), calls}), /INCOMPATIBLE_MIGRATION_ORDER/);
  assert(!calls.some(c => c.startsWith('supabase db push')));
});

const GH = 'vivek2310sharma/FairSwap-Backend';
const SHA_C = 'c'.repeat(40);
const ctx = {GITHUB_REPOSITORY: GH, GITHUB_SHA: SHA_C, GITHUB_TOKEN: 't', TEST_FOUNDATION_RUN_ID: '10', TEST_ACTIVATION_RUN_ID: '11', PROD_FOUNDATION_RUN_ID: '12'};
const goodRun = {path: '.github/workflows/reusable-supabase-release.yml', head_sha: SHA_C, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success'};

function crc32(buf) {
  return zlibCrc32(buf) >>> 0;
}

function makeZip(files, method = 8) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = Buffer.from(data);
    const comp = method === 8 ? deflateRawSync(body) : body;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(body), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(body), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function receiptFor(candidateId, env, runId, over = {}) {
  const cand = getCandidate(candidateId);
  const chain = {
    'accessories-v1-foundation|test': [],
    'accessories-v1-activation|test': [['test_foundation_run_id', '10']],
    'accessories-v1-foundation|prod': [['test_foundation_run_id', '10'], ['test_activation_run_id', '11']]
  }[`${candidateId}|${env}`] ?? [];
  const full = env === 'test' ? 'FairSwapTest' : 'FairSwapProd';
  return {
    environment: full, projectRef: REFS[full], candidateId, migrationVersion: cand.version, migrationFile: cand.filename, migrationSha256: cand.sha256,
    reviewedCommit: SHA_C, releaseWorkflowRun: runId, status: 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED', dryRunPending: [cand.filename], postflightVerified: true,
    stage: cand.stage, webStagingSha: cand.stage === 'activation' || env === 'prod' ? ACCESSORIES_WEB.stagingSha : null, webProductionSha: null,
    priorRuns: chain.map(([key, id]) => ({key, runId: id})), timestamp: '2026-11-03T00:00:00.000Z', ...over
  };
}

function receiptZip(candidateId, env, runId, over, {sums} = {}) {
  const full = (env === 'test' ? 'FairSwapTest' : 'FairSwapProd').toLowerCase();
  const body = JSON.stringify(receiptFor(candidateId, env, runId, over), null, 2) + '\n';
  const digest = sums ?? createHash('sha256').update(body).digest('hex');
  return makeZip({[`${candidateId}-${full}.json`]: body, [`SHA256SUMS_${full}`]: `${digest}  ${candidateId}-${full}.json\n`});
}

function evidenceFetcher({run = goodRun, runId, candidateId, env, zip, art}) {
  const url = `https://api.github.com/repos/${GH}/actions/artifacts/9/zip`;
  const artifacts = art ?? [{name: `reusable-${env}-${candidateId}-${runId}-1`, expired: false, workflow_run: {id: Number(runId)}, archive_download_url: url}];
  return async u => {
    if (u === url) return {ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length)};
    return {ok: true, status: 200, json: async () => (u.includes('/artifacts') ? {artifacts} : run)};
  };
}

const prior = [{key: 'test_activation_run_id', runId: '11', candidateId: ACTIVATION, environment: 'test'}];

test('stage evidence must be a successful same-commit run whose receipt contents match', async () => {
  const zip = receiptZip(ACTIVATION, 'test', '11');
  const f = o => evidenceFetcher({runId: '11', candidateId: ACTIVATION, env: 'test', zip, ...o});
  await assert.doesNotReject(requireStageEvidence(prior, ctx, f()));
  // Failed Test postflight => failed run => Production blocked
  await assert.rejects(requireStageEvidence(prior, ctx, f({run: {...goodRun, conclusion: 'failure'}})), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(requireStageEvidence(prior, ctx, f({run: {...goodRun, head_sha: 'd'.repeat(40)}})), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(requireStageEvidence(prior, ctx, f({run: {...goodRun, path: '.github/workflows/other.yml'}})), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(requireStageEvidence(prior, ctx, f({art: []})), /EVIDENCE_RECEIPT_MISSING/);
  await assert.rejects(requireStageEvidence(prior, ctx, f({art: [{name: `reusable-prod-${ACTIVATION}-11-1`, expired: false, workflow_run: {id: 11}}]})), /EVIDENCE_RECEIPT_MISSING/);
  await assert.rejects(requireStageEvidence(prior, ctx, f({art: [{name: `reusable-test-${ACTIVATION}-11-1`, expired: true, workflow_run: {id: 11}}]})), /EVIDENCE_RECEIPT_MISSING/);
  await assert.rejects(requireStageEvidence(prior, ctx, f({art: [{name: `reusable-test-${ACTIVATION}-11-1`, expired: false, workflow_run: {id: 99}}]})), /EVIDENCE_RECEIPT_MISSING/);
  await assert.rejects(requireStageEvidence(prior, ctx, async () => ({ok: false, status: 404})), /EVIDENCE_LOOKUP_FAILED/);
});

test('receipt artifact contents are verified, not just the artifact name', async () => {
  const cases = {
    candidate: {candidateId: FOUNDATION},
    hash: {migrationSha256: 'a'.repeat(64)},
    version: {migrationVersion: '20261102164135'},
    environment: {environment: 'FairSwapProd'},
    project: {projectRef: REFS.FairSwapProd},
    commit: {reviewedCommit: 'd'.repeat(40)},
    run: {releaseWorkflowRun: '99'},
    postflight: {postflightVerified: false},
    status: {status: 'FAIL'},
    stage: {stage: 'foundation'},
    web: {webStagingSha: 'e'.repeat(40)},
    chain: {priorRuns: [{key: 'test_foundation_run_id', runId: '77'}]}
  };
  for (const [name, over] of Object.entries(cases)) {
    const zip = receiptZip(ACTIVATION, 'test', '11', over);
    await assert.rejects(requireStageEvidence(prior, ctx, evidenceFetcher({runId: '11', candidateId: ACTIVATION, env: 'test', zip})), /RECEIPT_CONTENT_INVALID/, name);
  }
  // Tampered receipt (checksum mismatch), missing files, traversal names and non-GitHub download URLs
  const tampered = receiptZip(ACTIVATION, 'test', '11', {}, {sums: 'b'.repeat(64)});
  await assert.rejects(requireStageEvidence(prior, ctx, evidenceFetcher({runId: '11', candidateId: ACTIVATION, env: 'test', zip: tampered})), /RECEIPT_CONTENT_INVALID/);
  const empty = makeZip({'other.txt': 'x'});
  await assert.rejects(requireStageEvidence(prior, ctx, evidenceFetcher({runId: '11', candidateId: ACTIVATION, env: 'test', zip: empty})), /RECEIPT_CONTENT_INVALID/);
  assert.throws(() => readZipEntries(makeZip({'../evil': 'x'})), /RECEIPT_ARCHIVE_INVALID/);
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all, definitely')), /RECEIPT_ARCHIVE_INVALID/);
  const badUrl = [{name: `reusable-test-${ACTIVATION}-11-1`, expired: false, workflow_run: {id: 11}, archive_download_url: 'https://evil.example/x.zip'}];
  await assert.rejects(requireStageEvidence(prior, ctx, evidenceFetcher({runId: '11', candidateId: ACTIVATION, env: 'test', zip: receiptZip(ACTIVATION, 'test', '11'), art: badUrl})), /RECEIPT_CONTENT_INVALID/);
  // Stored (uncompressed) archives are also accepted
  const stored = makeZip({a: 'hello'}, 0);
  assert.equal(readZipEntries(stored).get('a').toString(), 'hello');
});

test('production foundation requires both Test receipts to chain to the same Test runs', async () => {
  const tp = [
    {key: 'test_foundation_run_id', runId: '10', candidateId: FOUNDATION, environment: 'test'},
    {key: 'test_activation_run_id', runId: '11', candidateId: ACTIVATION, environment: 'test'}
  ];
  const zips = {'10': receiptZip(FOUNDATION, 'test', '10'), '11': receiptZip(ACTIVATION, 'test', '11')};
  const fetcher = zipsByRun => async u => {
    const m = u.match(/runs\/(\d+)/);
    if (m && !u.includes('/artifacts')) return {ok: true, status: 200, json: async () => goodRun};
    if (m) {
      const id = m[1];
      const cid = id === '10' ? FOUNDATION : ACTIVATION;
      return {ok: true, status: 200, json: async () => ({artifacts: [{name: `reusable-test-${cid}-${id}-1`, expired: false, workflow_run: {id: Number(id)}, archive_download_url: `https://api.github.com/repos/${GH}/actions/artifacts/${id}/zip`}]})};
    }
    const id = u.match(/artifacts\/(\d+)\/zip/)[1];
    const z = zipsByRun[id];
    return {ok: true, status: 200, arrayBuffer: async () => z.buffer.slice(z.byteOffset, z.byteOffset + z.length)};
  };
  await assert.doesNotReject(requireStageEvidence(tp, ctx, fetcher(zips)));
  // Test activation was run against a different Test foundation => chain mismatch
  await assert.rejects(requireStageEvidence(tp, {...ctx, TEST_FOUNDATION_RUN_ID: '10', TEST_ACTIVATION_RUN_ID: '11'},
    fetcher({...zips, '11': receiptZip(ACTIVATION, 'test', '11', {priorRuns: [{key: 'test_foundation_run_id', runId: '5'}]})})), /RECEIPT_CONTENT_INVALID/);
});

// Golden token lengths from the pinned CLI's SplitAndTrim scanner, in JS code units.
const tokenLengths = {
  [FOUNDATION]: [100, 27, 33, 662, 204, 86, 480, 127, 371, 91, 112, 108, 71, 317, 292, 786, 117, 523, 528, 594,
    527, 375, 383, 816, 833, 824, 818, 963, 531, 801, 1077, 633, 569, 425, 425, 369, 317, 373, 350, 100, 76,
    6578, 108, 1512, 108, 159, 4920, 181, 145, 121, 7318, 7986, 8705, 192, 149, 130, 116, 6],
  [ACTIVATION]: [93, 27, 33, 203, 106, 51, 6]
};

function accessoryLedgerRow(id) {
  const c = getCandidate(id);
  let remaining = readFileSync(c.path, 'utf8').trimStart();
  const statements = tokenLengths[id].map(length => {
    const statement = remaining.slice(0, length);
    assert.equal(remaining[length], ';');
    remaining = remaining.slice(length + 1).trimStart();
    return statement;
  });
  assert.equal(remaining, '');
  return {version: c.version, name: c.filename.slice(15, -4), statements};
}

const ancestor = 'b'.repeat(40);
const ancestorOption = {allowFoundationAncestors: true};
const testFoundation = {key: 'test_foundation_run_id', runId: '10', candidateId: FOUNDATION, environment: 'test'};
const prodFoundation = {key: 'prod_foundation_run_id', runId: '12', candidateId: FOUNDATION, environment: 'prod'};

function historicalEvidence(entries, over = {}) {
  const candidate = getCandidate(FOUNDATION);
  const source = readFileSync(candidate.path);
  return async raw => {
    const u = new URL(raw);
    const ok = value => ({ok: true, json: async () => value});
    if (u.pathname.includes('/compare/')) return ok(over.comparison ?? {
      status: 'ahead', behind_by: 0, base_commit: {sha: ancestor}, merge_base_commit: {sha: ancestor}
    });
    if (u.pathname.includes('/contents/')) {
      const bytes = over.source ?? source;
      return ok({type: 'file', path: candidate.path, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length});
    }
    const m = u.pathname.match(/\/(runs|artifacts)\/(\d+)(?:\/(artifacts|zip))?$/);
    assert(m, raw);
    const [, kind, id, suffix] = m;
    const entry = entries[id];
    if (!entry) return {ok: false, status: 404};
    const {candidateId, environment, commit = ancestor, receipt = {}} = entry;
    const zip = receiptZip(candidateId, environment, id, {reviewedCommit: commit, ...receipt}, {sums: over.sums});
    if (kind === 'artifacts') return {ok: true, arrayBuffer: async () => zip};
    if (!suffix) return ok({...goodRun, id: Number(id), head_sha: commit, run_attempt: 1, workflow_id: 404601811,
      head_repository: {full_name: GH}, actor: {login: 'vivek2310sharma'}, triggering_actor: {login: 'vivek2310sharma'}, ...over.run});
    const artifact = {id: Number(id), name: `reusable-${environment}-${candidateId}-${id}-1`, expired: false,
      workflow_run: {id: Number(id), head_sha: commit}, archive_download_url: `https://api.github.com/repos/${GH}/actions/artifacts/${id}/zip`,
      digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`, ...over.artifact};
    return ok({artifacts: over.missing ? [] : [artifact]});
  };
}

test('ancestor evidence requires the original immutable run and matching source and receipt', async () => {
  const entries = {'10': testFoundation};
  const check = (over, p = testFoundation) => requireStageEvidence([p], ctx, historicalEvidence(entries, over), ancestorOption);
  assert.equal((await check()).test_foundation_run_id.reviewedCommit, ancestor);
  for (const [over, error] of [
    [{run: {workflow_id: 5}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {triggering_actor: {login: 'someone-else'}}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {conclusion: 'failure'}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {run_attempt: 2}}, /EVIDENCE_RECEIPT_MISSING/],
    [{missing: true}, /EVIDENCE_RECEIPT_MISSING/],
    [{artifact: {expired: true}}, /EVIDENCE_RECEIPT_MISSING/],
    [{artifact: {digest: 'sha256:' + '0'.repeat(64)}}, /artifact digest/],
    [{sums: '0'.repeat(64)}, /checksum/],
    [{source: Buffer.from('select 1;')}, /EVIDENCE_SOURCE_MISMATCH/],
    [{comparison: {status: 'diverged'}}, /EVIDENCE_ANCESTRY_NOT_VERIFIED/],
    [{comparison: {status: 'ahead', behind_by: 0, base_commit: {sha: ancestor}, merge_base_commit: {sha: SHA_C}}}, /EVIDENCE_ANCESTRY_NOT_VERIFIED/]
  ]) await assert.rejects(check(over), error);
  await assert.rejects(check({}, {...testFoundation, candidateId: ACTIVATION}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(check({}, {...testFoundation, candidateId: 'tablets-v1-foundation'}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(requireStageEvidence([testFoundation], ctx, historicalEvidence({
    '10': {...testFoundation, receipt: {reviewedCommit: SHA_C}}
  }), ancestorOption), /RECEIPT_CONTENT_INVALID: .*commit/);
});

test('historical Production foundation verifies its own Test chain', async () => {
  const entries = {'10': testFoundation, '11': prior[0], '12': prodFoundation};
  const check = () => requireStageEvidence([prodFoundation], ctx, historicalEvidence(entries), ancestorOption);
  assert.equal((await check()).prod_foundation_run_id.reviewedCommit, ancestor);
  entries['11'] = {...prior[0], commit: SHA_C};
  await assert.rejects(check(), /EVIDENCE_RUN_NOT_VERIFIED/);
  entries['11'] = {...prior[0], receipt: {priorRuns: [{key: testFoundation.key, runId: '99'}]}};
  await assert.rejects(check(), /RECEIPT_CONTENT_INVALID: .*chain/);
  delete entries['11'];
  await assert.rejects(check(), /EVIDENCE_LOOKUP_FAILED: 404/);
});

test('Production foundation can use current Test activation only when it records the same recovered foundation', () => {
  const plan = planDispatch({candidateId: FOUNDATION, target: 'production', inputs: {
    ...web, test_foundation_run_id: '10', test_activation_run_id: '11'
  }});
  const receipts = {test_foundation_run_id: {reviewedCommit: ancestor}, test_activation_run_id: {reviewedCommit: SHA_C}};
  assert.throws(() => recoveredFoundationSha(plan, receipts, SHA_C), /EVIDENCE_RECOVERY_TEST_NOT_VERIFIED/);
  receipts.test_activation_run_id.recoveredFoundationCommit = ancestor;
  assert.equal(recoveredFoundationSha(plan, receipts, SHA_C), ancestor);
});

test('recovery verifies an applied Test activation and a disabled Production foundation without replay', async () => {
  const foundation = accessoryLedgerRow(FOUNDATION);
  const activation = accessoryLedgerRow(ACTIVATION);
  const env = {GITHUB_SHA: SHA_C, ACCESSORIES_RECOVERED_FOUNDATION_SHA: ancestor,
    WEB_STAGING_SHA: ACCESSORIES_WEB.stagingSha, TEST_FOUNDATION_RUN_ID: '10', TEST_ACTIVATION_RUN_ID: '11'};
  for (const [candidate, environment, rows, stage] of [
    [ACTIVATION, 'FairSwapTest', [foundation, activation], 'activation'],
    [FOUNDATION, 'FairSwapProd', [foundation], 'foundation']
  ]) {
    const before = [...baseHistory, ...rows.map(r => r.version)];
    const sql = q => q.includes('recovery-ledger') ? rows : goodPost(stage);
    const res = await release(candidate, environment, {before, sql, env});
    assert.equal(res.receipt.status, 'ALREADY_APPLIED_VERIFIED');
    assert.equal(res.receipt.recoveredFoundationCommit, ancestor);
    assert(res.calls.includes(`psql:-- accessories-postflight ${stage}`));
    assert(!res.calls.some(c => c.startsWith('supabase db push')));
    rmSync(res.dir, {recursive: true});
    await assert.rejects(release(candidate, environment, {before: before.slice(0, -1), sql, env}), /RECOVERY_STATE_MISMATCH/);
    await assert.rejects(release(candidate, environment, {before: [...before, TABLETS], sql, env}), /INCOMPATIBLE_MIGRATION_ORDER/);
    await assert.rejects(release(candidate, environment, {before, env, sql: q => q.includes('recovery-ledger')
      ? [{...foundation, statements: ['select 1']}, ...rows.slice(1)]
      : goodPost(stage)}), /ACCESSORIES_LEDGER_MISMATCH/);
    await assert.rejects(release(candidate, environment, {before, env, sql: q => q.includes('recovery-ledger')
      ? rows : {...goodPost(stage), release_state: false}}), /POSTFLIGHT_VERIFICATION_FAILED: release_state/);
  }
});

test('Production activation rechecks the recovered disabled foundation before the normal apply path', async () => {
  const f = accessoryLedgerRow(FOUNDATION);
  const a = accessoryLedgerRow(ACTIVATION);
  const before = [...baseHistory, f.version];
  const after = [...before, a.version];
  const env = {GITHUB_SHA: SHA_C, ACCESSORIES_RECHECK_PROD_FOUNDATION: 'true',
    WEB_STAGING_SHA: ACCESSORIES_WEB.stagingSha, WEB_PRODUCTION_SHA: SHA_PROD_WEB,
    TEST_ACTIVATION_RUN_ID: '11', PROD_FOUNDATION_RUN_ID: '12'};
  let ledgerReads = 0;
  const sql = q => q.includes('recovery-ledger') ? (ledgerReads++ === 0 ? [f] : [f, a])
    : q.includes('postflight foundation') ? goodPost('foundation')
    : q.includes('postflight activation') ? goodPost('activation') : installedPre;
  const {receipt, calls, dir} = await release(ACTIVATION, 'FairSwapProd', {before, after, env, sql});
  assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
  assert.equal(ledgerReads, 2);
  assert(calls.indexOf('psql:-- accessories-postflight foundation') < calls.findIndex(c => c.startsWith('supabase db push')));
  rmSync(dir, {recursive: true});
  await assert.rejects(release(ACTIVATION, 'FairSwapProd', {before: after, after, env, sql}), /RECOVERY_STATE_MISMATCH/);
  await assert.rejects(release(ACTIVATION, 'FairSwapProd', {before, after, env, sql: q => q.includes('recovery-ledger') ? [f]
    : {...goodPost('foundation'), category_state: false}}), /POSTFLIGHT_VERIFICATION_FAILED: category_state/);
});

test('ledger verification rejects changed boundaries, order, names, NULLs, and unexpected versions', () => {
  const f = accessoryLedgerRow(FOUNDATION);
  const a = accessoryLedgerRow(ACTIVATION);
  assert.doesNotThrow(() => verifyAccessoriesLedger(true, () => JSON.stringify([f, a])));
  for (const rows of [[a, f], [f], [f, a, a], [{...f, name: 'wrong'}, a], [{...f, statements: null}, a],
    [{...f, statements: [f.statements.join(';')]}, a], [{...f, statements: [...f.statements].reverse()}, a]]) {
    assert.throws(() => verifyAccessoriesLedger(true, () => JSON.stringify(rows)), /ACCESSORIES_LEDGER_MISMATCH/);
  }
});

// ---- Web deployment evidence -----------------------------------------------------------------

const WEB = ACCESSORIES_WEB.repository;
const PROD_SHA = 'f'.repeat(40);

function webFetcher(o = {}) {
  const dep = (id, sha, environment) => ({id, sha, environment});
  const deployments = o.deployments ?? [dep(1, ACCESSORIES_WEB.stagingSha, 'Preview'), dep(2, PROD_SHA, 'Production')];
  return async u => {
    const ok = body => ({ok: true, status: 200, json: async () => body});
    if (o.fail) return {ok: false, status: o.fail};
    let m;
    if ((m = u.match(/deployments\/(\d+)\/statuses/))) return ok([{state: (o.states ?? {})[m[1]] ?? 'success'}]);
    if (u.includes('/deployments?environment=Production')) return ok(o.live ?? deployments.filter(d => d.environment === 'Production').slice(0, 1));
    if ((m = u.match(/deployments\?sha=([0-9a-f]+)/))) return ok(deployments.filter(d => d.sha === m[1]));
    if (u.includes(`/compare/${ACCESSORIES_WEB.stagingSha}...`)) return ok({status: o.tested ?? 'ahead'});
    if (u.includes('...main')) return ok({status: o.main ?? 'ahead'});
    throw new Error(`unexpected ${u}`);
  };
}

const planFor = (cid, target, extra = {}) => planDispatch({candidateId: cid, target, inputs: {
  web_staging_sha: ACCESSORIES_WEB.stagingSha, test_foundation_run_id: '10', test_activation_run_id: '11', prod_foundation_run_id: '12', ...extra
}});

test('Web staging deployment must be READY in a non-Production environment', async () => {
  const plan = planFor(ACTIVATION, 'test');
  const env = {WEB_EVIDENCE_TOKEN: 't'};
  assert.equal((await verifyWebDeployments(plan, env, webFetcher())).stagingDeploymentId, 1);
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({states: {1: 'in_progress'}})), /WEB_STAGING_DEPLOYMENT_NOT_READY/);
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({states: {1: 'failure'}})), /WEB_STAGING_DEPLOYMENT_NOT_READY/);
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({deployments: []})), /WEB_STAGING_DEPLOYMENT_NOT_READY/);
  // A Production-environment deployment can never satisfy staging evidence
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({deployments: [{id: 1, sha: ACCESSORIES_WEB.stagingSha, environment: 'Production'}]})), /WEB_STAGING_DEPLOYMENT_NOT_READY/);
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({fail: 404})), /WEB_DEPLOYMENT_LOOKUP_FAILED/);
  await assert.rejects(verifyWebDeployments(plan, {}, webFetcher()), /WEB_EVIDENCE_UNAVAILABLE/);
  // Moderation is unaffected
  assert.equal(await verifyWebDeployments(planFor('moderation-analytics-v1', 'test'), {}, webFetcher({fail: 500})), null);
});

test('a random Production Web SHA cannot pass; the exact current READY Production deployment is required', async () => {
  const plan = planFor(ACTIVATION, 'production', {web_production_sha: PROD_SHA});
  const env = {WEB_EVIDENCE_TOKEN: 't'};
  const good = await verifyWebDeployments(plan, env, webFetcher());
  assert.deepEqual(good, {stagingDeploymentId: 1, productionDeploymentId: 2});
  const random = planFor(ACTIVATION, 'production', {web_production_sha: 'a'.repeat(40)});
  await assert.rejects(verifyWebDeployments(random, env, webFetcher()), /WEB_PRODUCTION_NOT_CURRENT_DEPLOYMENT/);
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({states: {2: 'pending'}})), /WEB_PRODUCTION_DEPLOYMENT_NOT_READY/);
  // A newer Production deployment (rollback or later release) supersedes the claimed SHA
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({live: [{id: 9, sha: 'b'.repeat(40), environment: 'Production'}]})), /WEB_PRODUCTION_NOT_CURRENT_DEPLOYMENT/);
  // Preview deployment of the same SHA is not Production evidence
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({deployments: [{id: 1, sha: ACCESSORIES_WEB.stagingSha, environment: 'Preview'}, {id: 2, sha: PROD_SHA, environment: 'Preview'}], live: [{id: 2, sha: PROD_SHA, environment: 'Preview'}]})), /WEB_PRODUCTION_NOT_CURRENT_DEPLOYMENT/);
  // Production must contain the tested staging release and be on Web main
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({tested: 'diverged'})), /WEB_PRODUCTION_MISSING_TESTED_RELEASE/);
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({tested: 'behind'})), /WEB_PRODUCTION_MISSING_TESTED_RELEASE/);
  await assert.rejects(verifyWebDeployments(plan, env, webFetcher({main: 'diverged'})), /WEB_PRODUCTION_NOT_ON_MAIN/);
  await assert.rejects(verifyWebDeployments(plan, {}, webFetcher()), /WEB_EVIDENCE_UNAVAILABLE/);
  // Production foundation needs only the staging deployment; Production Web is not required yet
  const prodFoundation = planFor(FOUNDATION, 'production');
  assert.deepEqual(await verifyWebDeployments(prodFoundation, env, webFetcher({deployments: [{id: 1, sha: ACCESSORIES_WEB.stagingSha, environment: 'Preview'}]})), {stagingDeploymentId: 1});
});

// ---- Real PostgreSQL preflight ---------------------------------------------------------------

const OLD_PREFLIGHT_SQL = `BEGIN READ ONLY;
SELECT jsonb_build_object(
  'foundation_installed', to_regclass('public.accessory_release_v1') IS NOT NULL,
  'enabled', CASE WHEN to_regclass('public.accessory_release_v1') IS NULL THEN false ELSE (SELECT coalesce(bool_or(enabled), false) FROM public.accessory_release_v1) END
)::text;
COMMIT;`;

function findPgBin() {
  const dirs = [process.env.FSW_TEST_PG_BIN, '/private/tmp/tablets-integration/pg17/bin', ...(existsSync('/usr/lib/postgresql') ? readdirSync('/usr/lib/postgresql').sort().reverse().map(v => `/usr/lib/postgresql/${v}/bin`) : [])];
  return dirs.find(d => d && existsSync(join(d, 'initdb')) && existsSync(join(d, 'postgres')) && existsSync(join(d, 'psql')));
}

function startPg(bin) {
  const dir = mkdtempSync('/tmp/fsp-');
  const sh = (cmd, args, opts = {}) => {
    const r = spawnSync(join(bin, cmd), args, {encoding: 'utf8', ...opts});
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
    return r.stdout;
  };
  sh('initdb', ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
  sh('pg_ctl', ['-D', join(dir, 'data'), '-w', '-l', join(dir, 'log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${dir}' -c fsync=off`, 'start']);
  const psql = (sql, db = 'postgres') => spawnSync(join(bin, 'psql'), ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', dir, '-U', 'postgres', '-d', db, '-c', sql], {encoding: 'utf8'});
  const run = (sql, db) => { const r = psql(sql, db); if (r.status !== 0) throw Object.assign(new Error(r.stderr), {stderr: r.stderr}); return r.stdout; };
  return {run, psql, stop: () => { try { sh('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } finally { rmSync(dir, {recursive: true, force: true}); } }};
}

const pgBin = findPgBin();
if (!pgBin && process.env.REQUIRE_REAL_PG === '1') {
  test('real PostgreSQL is required for the preflight tests in release CI', () => assert.fail('no PostgreSQL server binaries found'));
}

test('real PostgreSQL: recovery reads the exact statement arrays and rejects a changed entry',
  {skip: pgBin ? false : 'no local PostgreSQL binaries'}, () => {
    const pg = startPg(pgBin);
    try {
      const rows = [accessoryLedgerRow(FOUNDATION), accessoryLedgerRow(ACTIVATION)];
      const json = JSON.stringify(rows).replaceAll("'", "''");
      pg.run(`CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, name text, statements text[]);
        INSERT INTO supabase_migrations.schema_migrations
        SELECT * FROM jsonb_to_recordset('${json}'::jsonb) AS r(version text, name text, statements text[]);`);
      verifyAccessoriesLedger(true, pg.run);
      pg.run(`UPDATE supabase_migrations.schema_migrations SET statements[1] = 'select 1' WHERE version = '${rows[0].version}'`);
      assert.throws(() => verifyAccessoriesLedger(true, pg.run), /ACCESSORIES_LEDGER_MISMATCH/);
    } finally {
      pg.stop();
    }
  });

test('real PostgreSQL: preflight SQL runs on an uninstalled foundation and gates stages correctly', {skip: pgBin ? false : 'no local PostgreSQL binaries (set FSW_TEST_PG_BIN); enforced when REQUIRE_REAL_PG=1'}, () => {
  const foundationSql = readFileSync(join(process.cwd(), CANDIDATES[FOUNDATION].path), 'utf8');
  const ddl = foundationSql.match(/create table public\.accessory_release_v1 \([^;]*\);/i)[0];
  const pg = startPg(pgBin);
  try {
    pg.run(`create schema app_security;
      create table public.categories(id uuid primary key default gen_random_uuid(), slug text unique not null, is_active boolean not null default false);
      insert into public.categories(slug, is_active) values ('mobile-phones', true)`);
    const exec = sql => pg.run(sql);
    const f = getCandidate(FOUNDATION);
    const a = getCandidate(ACTIVATION);

    // The defective query really fails on PostgreSQL before the foundation exists (relation resolved at parse time).
    const old = pg.psql(OLD_PREFLIGHT_SQL);
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /42P01|does not exist/);

    // Corrected preflight: both candidate stages are evaluated against the real, uninstalled baseline.
    const statements = [];
    const spy = sql => { statements.push(sql); return exec(sql); };
    assert.deepEqual(runLivePreflight(f, spy), {foundation_installed: false, enabled: false, category_active: false, tablets_wrapped: false});
    assert.equal(statements.length, 1, 'enabled query must not run before the table exists');
    assert.throws(() => runLivePreflight(a, exec), /PREREQUISITE_NOT_MET/);
    assert.equal(JSON.parse(exec(preflightQuery()).trim()).foundation_installed, false);

    // Foundation installed (real DDL from the migration), category disabled: activation allowed, foundation rejected.
    pg.run(`${ddl} insert into public.categories(slug) values ('mobile-accessories'); insert into public.accessory_release_v1(category_id) select id from public.categories where slug='mobile-accessories'`);
    assert.deepEqual(runLivePreflight(a, exec), {foundation_installed: true, enabled: false, category_active: false, tablets_wrapped: false});
    assert.throws(() => runLivePreflight(f, exec), /PARTIAL_RELEASE_STATE/);

    // Already enabled or category active: activation rejected
    pg.run('update public.accessory_release_v1 set enabled = true');
    assert.throws(() => runLivePreflight(a, exec), /INVALID_ACTIVATION_ORDER/);
    pg.run(`update public.accessory_release_v1 set enabled = false; update public.categories set is_active = true where slug = 'mobile-accessories'`);
    assert.throws(() => runLivePreflight(a, exec), /INVALID_ACTIVATION_ORDER/);
    pg.run(`update public.categories set is_active = false where slug = 'mobile-accessories'`);

    // Tablets wrapper present: both stages fail closed
    pg.run('create function app_security.impl_submit_mobile_v2_before_tablets(jsonb) returns jsonb language sql as $$ select $1 $$');
    assert.throws(() => runLivePreflight(a, exec), /INCOMPATIBLE_MIGRATION_ORDER/);

    // The preflight is read-only: it cannot write even if misused
    const write = pg.psql(`${preflightQuery().replace('SELECT jsonb_build_object', 'CREATE TABLE public.should_fail(x int); SELECT jsonb_build_object')}`);
    assert.notEqual(write.status, 0);
    assert.match(write.stderr, /read-only transaction/);
  } finally {
    pg.stop();
  }
});

test('preflight rejects malformed live responses and never queries enabled for an uninstalled foundation', () => {
  const f = getCandidate(FOUNDATION);
  assert.throws(() => runLivePreflight(f, () => 'not json'), /PREFLIGHT_INVALID_RESPONSE/);
  assert.throws(() => runLivePreflight(f, () => JSON.stringify({foundation_installed: 'no'})), /PREFLIGHT_INVALID_RESPONSE/);
  const calls = [];
  runLivePreflight(f, sql => { calls.push(sql); return JSON.stringify({foundation_installed: false, category_active: false, tablets_wrapped: false}); });
  assert.equal(calls.length, 1);
  assert(!preflightQuery().includes('FROM public.accessory_release_v1'));
  assert(preflightEnabledQuery().includes('FROM public.accessory_release_v1'));
  assert.throws(() => runLivePreflight(getCandidate(ACTIVATION), sql => JSON.stringify(sql.includes('enabled') ? {} : {foundation_installed: true, category_active: false, tablets_wrapped: false})), /PREFLIGHT_INVALID_RESPONSE/);
});

test('workflow verifies the deployed Web release before any database step and uses only existing secrets', () => {
  const yaml = readFileSync(join(process.cwd(), '.github/workflows/reusable-supabase-release.yml'), 'utf8');
  const jobs = yaml.split(/\n  (?=test:|production:)/);
  for (const job of jobs.slice(1)) {
    const web = job.indexOf('Verify deployed Web release');
    const exec = job.indexOf('Execute ');
    assert(web > 0 && exec > web, 'Web verification must precede the release step');
    assert(job.indexOf('verifyWebDeployments') > 0);
  }
  assert(yaml.includes("REQUIRE_REAL_PG: '1'"));
  // the Web token must never reach the step that holds database credentials
  for (const m of yaml.matchAll(/- name: Execute [^\n]*\n[\s\S]*?(?=\n      - |\n  \w|$)/g)) assert(!m[0].includes('WEB_EVIDENCE_TOKEN'));
});

test('workflow gates Production behind verified evidence and keeps moderation auto-promotion', () => {
  const yaml = readFileSync(join(process.cwd(), '.github/workflows/reusable-supabase-release.yml'), 'utf8');
  for (const id of ['accessories-v1-foundation', 'accessories-v1-activation', 'moderation-analytics-v1']) assert(yaml.includes(`- ${id}`));
  for (const input of ['target:', 'web_staging_sha:', 'web_production_sha:', 'test_foundation_run_id:', 'test_activation_run_id:', 'prod_foundation_run_id:']) assert(yaml.includes(input));
  assert(yaml.includes('requireStageEvidence'));
  assert(yaml.includes('needs: [verify, test, verify_test]'));
  assert(yaml.includes("inputs.target == 'test' && needs.verify.outputs.auto_promote == 'true' && needs.test.result == 'success' && needs.verify_test.result == 'success'"));
  assert(yaml.includes("inputs.target == 'production' && needs.test.result == 'skipped'"));
  assert(/test:\n    needs: verify\n    if: .*inputs\.target == 'test'/.test(yaml));
  assert(!yaml.includes('workflow_run'));
  assert(!/^name:.*accessories/im.test(yaml));
  const secrets = [...yaml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(secrets)], ['CHAT_DATABASE_PASSWORD', 'CHAT_DB_SSL_ROOT_CERT_PEM', 'CHAT_RELEASE_AUDIT_TOKEN', 'FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN', 'FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN']);
});

test('Tablets SQL is pinned and both Accessories stages must precede it', () => {
  const foundation = verifyCandidateSha('tablets-v1-foundation').candidate;
  const activation = verifyCandidateSha('tablets-v1-activation').candidate;
  const ledger = (...versions) => 'LOCAL | REMOTE | TIME (UTC)\n' + versions.map(v => `${v} | ${v} | time`).join('\n');
  const prerequisites = ['20261102164135', '20261102164137'];
  assert.throws(() => assertLedgerOrdering(foundation, ledger(prerequisites[0])), /PREREQUISITE_MIGRATION_MISSING/);
  assert.equal(assertLedgerOrdering(foundation, ledger(...prerequisites)).state, 'absent');
  assert.throws(() => assertLedgerOrdering(activation, ledger(...prerequisites)), /PREREQUISITE_MIGRATION_MISSING/);
  assert.equal(assertLedgerOrdering(activation, ledger(...prerequisites, foundation.version)).state, 'absent');
  assert.throws(() => assertLedgerOrdering(foundation, ledger(...prerequisites, activation.version)), /INCOMPATIBLE_MIGRATION_ORDER/);
});

test('Tablets Production requires the corresponding successful Test stages', () => {
  const inputs = {
    web_staging_sha: ACCESSORIES_WEB.stagingSha,
    web_production_sha: '1'.repeat(40),
    test_foundation_run_id: '12',
    test_activation_run_id: '13',
    prod_foundation_run_id: '14'
  };
  const plan = (stage, evidence = inputs) =>
    planDispatch({candidateId: `tablets-v1-${stage}`, target: 'production', inputs: evidence});
  assert.deepEqual(plan('foundation').priorRuns.map(r => [r.candidateId, r.environment]), [
    ['tablets-v1-foundation', 'test'], ['tablets-v1-activation', 'test']
  ]);
  assert.deepEqual(plan('activation').priorRuns.map(r => [r.candidateId, r.environment]), [
    ['tablets-v1-activation', 'test'], ['tablets-v1-foundation', 'prod']
  ]);
  assert.equal(plan('foundation').webStagingSha, '1039873c2fa62845f19627d298cb9f3ba185d819');
  assert.throws(() => plan('foundation', {...inputs, web_staging_sha: 'b5efb427b0cd5cb8acb0f8503593eebcaafce39e'}),
    /WEB_STAGING_VERIFICATION_REQUIRED/);
  assert.throws(() => plan('foundation', {...inputs, test_activation_run_id: ''}), /EVIDENCE_RUN_REQUIRED/);
  assert.throws(() => plan('activation', {...inputs, prod_foundation_run_id: ''}), /EVIDENCE_RUN_REQUIRED/);
});

test('Tablets ledger postflight detects changed historical SQL and wrong candidate identity', async () => {
  const {verifyTabletsLedger} = await import('../../scripts/release/tablets-v1-release.mjs');
  const candidate = getCandidate('tablets-v1-foundation');
  const old = {version: '20261102164135', name: 'accessories_v1', statementsSha256: 'a'.repeat(64), hasStatements: true};
  const next = {version: candidate.version, name: 'posting_v2_tablets', statementsSha256: 'b'.repeat(64), hasStatements: true};
  assert.equal(verifyTabletsLedger([old], [old, next], candidate), next.statementsSha256);
  assert.throws(() => verifyTabletsLedger([old], [{...old, statementsSha256: 'c'.repeat(64)}, next], candidate), /LEDGER_CHANGED/);
  assert.throws(() => verifyTabletsLedger([old], [old, {...next, name: 'wrong'}], candidate), /LEDGER_CHANGED/);
});

test('Tablets release checks history before apply and records the installed statement hash', async () => {
  const candidateId = 'tablets-v1-foundation';
  const candidate = getCandidate(candidateId);
  const names = {
    '20261102164135': 'accessories_v1',
    '20261102164137': 'activate_accessories_v1',
    [candidate.version]: 'posting_v2_tablets'
  };
  const before = [...baseHistory, ...candidate.requiredLedgerVersions];
  const after = [...before, candidate.version];
  const entry = version => ({
    version, name: names[version] ?? 'historical', hasStatements: true, statementsSha256: 'a'.repeat(64)
  });
  const mock = change => {
    let reads = 0;
    return {
      before, after,
      sql: query => {
        assert.match(query, /^BEGIN READ ONLY;/);
        if (!query.includes('supabase_migrations.schema_migrations')) {
          return Object.fromEntries([...query.matchAll(/'([a-z_]+)', \(/g)].map(([, key]) => [key, true]));
        }
        const history = (++reads < 3 ? before : after).map(entry);
        if (change && reads === 2) history[0].statementsSha256 = 'b'.repeat(64);
        return history;
      }
    };
  };
  const {receipt, dir} = await release(candidateId, 'FairSwapTest', mock(false));
  try {
    assert.equal(receipt.ledgerStatementsSha256, 'a'.repeat(64));
    assert.equal(receipt.postflightVerified, true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
  const calls = [];
  const runner = makeRunner({...mock(true), filename: candidate.filename, calls});
  await assert.rejects(releaseReusable({environment: 'FairSwapTest', candidateId, context: baseEnv, runner}),
    /TABLETS_LEDGER_CHANGED/);
  assert.equal(calls.filter(call => call.startsWith('supabase db push ')).length, 1);
});
