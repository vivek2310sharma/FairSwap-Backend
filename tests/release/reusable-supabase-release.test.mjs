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
import {getCandidate, verifyCandidateSha, CANDIDATES, planDispatch, ACCESSORIES_WEB, WEARABLES_WEB, WEB_PINS, EXISTING_INSTALLATIONS, adoptionAttestation, getAdoption} from '../../scripts/release/reusable-candidates.mjs';
import {
  ADOPTED_STATUS, MOBILE_PHONES_HISTORY, WEARABLES_E2E, assertLedgerTail, assertMobilePhonesProvenance, requirePriorCommitEvidence, runWearablesPostflight,
  runWearablesPreflight, validateCrossCommitReceipt, verifyE2eEvidence, wearablesPostflightChecks, AZURE_FINALIZER_BODY_SHA256
} from '../../scripts/release/wearables-v1-release.mjs';
import {assertLedgerOrdering, assertPreflight, parseLedgerVersions, postflightKeys, postflightQuery, preflightEnabledQuery, preflightQuery, readZipEntries, recoveredFoundationSha, requireStageEvidence, runAccessoriesPostflight, runLivePreflight, validateReceipt, verifyAccessoriesLedger, verifyHistoryPreserved, verifyWebDeployments} from '../../scripts/release/accessories-v1-release.mjs';
import {adoptExistingInstallation, parsePendingDryRun, verifyLedgerVersion, releaseReusable, subprocessFailure, REFS} from '../../scripts/release/reusable-supabase-release.mjs';

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

test('candidate registry correctly registers moderation-switching-v1', () => {
  const c = getCandidate('moderation-switching-v1');
  assert.equal(c.version, '20261104223000');
  assert.equal(c.filename, '20261104223000_moderation_provider_switching.sql');
  assert.equal(c.sha256, '1e75154d50333e94aa80894f0c59a507d0ab3ebad34e99f2e909506d64b94a7d');
  assert.equal(c.autoPromote, true);
});

test('moderation switching candidate SHA matches the verified forward migration', () => {
  const c = verifyCandidateSha('moderation-switching-v1');
  assert.equal(c.sha256, '1e75154d50333e94aa80894f0c59a507d0ab3ebad34e99f2e909506d64b94a7d');
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
  assert.deepEqual(Object.keys(CANDIDATES).sort(), ['accessories-v1-activation', 'accessories-v1-foundation', 'moderation-analytics-v1', 'moderation-azure-v1', 'moderation-switching-v1', 'tablets-v1-activation', 'tablets-v1-foundation', 'tablets-v2-catalogue', 'wearables-v1-activation', 'wearables-v1-foundation']);
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

test('strict evidence checks remain active when allowFoundationAncestors is true', async () => {
  const entries = {'10': testFoundation};
  const baseCheck = over => requireStageEvidence([testFoundation], ctx, historicalEvidence(entries, over), {allowFoundationAncestors: true});
  await assert.rejects(baseCheck({run: {actor: {login: 'unauthorized-user'}}}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(baseCheck({run: {head_repository: {full_name: 'fork/FairSwap-Backend'}}}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(baseCheck({artifact: {name: 'reusable-test-accessories-v1-foundation-10-2'}}), /EVIDENCE_RECEIPT_MISSING/);
  await assert.rejects(baseCheck({artifact: {digest: 'sha256:' + 'e'.repeat(64)}}), /artifact digest/);
  await assert.rejects(baseCheck({artifact: {archive_download_url: 'https://evil.example/artifact.zip'}}), /RECEIPT_CONTENT_INVALID.*url/);
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
  for (const m of yaml.matchAll(/- name: Execute [^\n]*\n[\s\S]*?(?=\n      - |\n  \w|$)/g)) assert(!m[0].includes('WEB_EVIDENCE_TOKEN') || m[0].includes("WEB_EVIDENCE_TOKEN: ${{ inputs.candidate == 'tablets-v2-catalogue' && secrets.CHAT_RELEASE_AUDIT_TOKEN || '' }}"));
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

// ---- Wearables V1 -----------------------------------------------------------------------------

const ADOPTED_SHA = '70f752d5484a4e5a85680e4b2fd8ef5c257fef2f74979bd803fa4db1bf43f772';
const WF = 'wearables-v1-foundation';
const WA = 'wearables-v1-activation';
const WEARABLES_SUMS = readFileSync(join(process.cwd(), 'supabase/forward-migrations/wearables-v1/SHA256SUMS'), 'utf8');
const mobileRows = environment => MOBILE_PHONES_HISTORY[environment].map(h => ({...h, hasStatements: true}));
const wDep = (id, sha, environment) => ({id, sha, environment});
const wInputs = {
  web_staging_sha: WEARABLES_WEB.stagingSha, web_production_sha: 'e'.repeat(40), test_foundation_run_id: '10', test_activation_run_id: '11',
  prod_foundation_run_id: '12', accessories_prod_foundation_run_id: '50', test_e2e_run_id: '60'
};
const wPlan = (cid, target, extra = {}) => planDispatch({candidateId: cid, target, inputs: {...wInputs, ...extra}});

test('Wearables candidates register exact SQL, SHA256SUMS hashes and leave the 58 immutable migrations untouched', () => {
  const sums = Object.fromEntries(WEARABLES_SUMS.trim().split('\n').map(line => {
    const [hash, file] = line.split('  ');
    return [file.split('/').pop(), hash];
  }));
  for (const [id, version, filename] of [[WF, '20261104120000', '20261104120000_posting_v2_wearables.sql'], [WA, '20261104120100', '20261104120100_activate_wearables_v1.sql']]) {
    const c = getCandidate(id);
    assert.equal(c.version, version);
    assert.equal(c.filename, filename);
    assert.equal(c.sha256, sums[filename]);
    assert.equal(verifyCandidateSha(id).sha256, sums[filename]);
    assert.equal(c.strict, true);
    assert.equal(c.autoPromote, false);
    assert.deepEqual(readdirSync(join(process.cwd(), c.path, '..')), [c.filename]);
  }
  assert.equal(readdirSync(join(process.cwd(), 'supabase/migrations')).filter(f => f.endsWith('.sql')).length, 58);
  const r = spawnSync('node', ['scripts/verify-migration-manifest.mjs'], {encoding: 'utf8'});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /58 migration files match/);
});

test('Wearables ledger ordering: Accessories foundation is required, activation follows foundation, Tablets order is free', () => {
  const f = getCandidate(WF);
  const a = getCandidate(WA);
  const l = (...v) => ledger(v);
  assert.throws(() => assertLedgerOrdering(f, l('20261025195136')), /PREREQUISITE_MIGRATION_MISSING/);
  assert.equal(assertLedgerOrdering(f, l('20261102164135')).state, 'absent');
  // Tablets installed before Wearables is a supported coexistence order
  assert.equal(assertLedgerOrdering(f, l('20261102164135', '20261102164137', '20261102165946', '20261102170611')).state, 'absent');
  assert.throws(() => assertLedgerOrdering(f, l('20261102164135', a.version)), /INCOMPATIBLE_MIGRATION_ORDER/);
  assert.throws(() => assertLedgerOrdering(a, l('20261102164135')), /PREREQUISITE_MIGRATION_MISSING/);
  // W-AZ-1: activation wraps the Azure finalizer, so the strict order is Azure -> foundation -> activation
  assert.throws(() => assertLedgerOrdering(a, l('20261102164135', f.version)), /PREREQUISITE_MIGRATION_MISSING.*20261104113705/);
  assert.throws(() => assertLedgerOrdering(a, l('20261102164135', '20261104113705')), /PREREQUISITE_MIGRATION_MISSING/);
  assert.equal(assertLedgerOrdering(a, l('20261102164135', '20261104113705', f.version)).state, 'absent');
  assert.deepEqual([...a.requiredLedgerVersions], ['20261102164135', '20261104113705', '20261104120000']);
  assert.ok(!f.requiredLedgerVersions.includes('20261104113705'), 'foundation stays independent of Azure (no change to the reviewed foundation)');
  assert.throws(() => assertLedgerOrdering(f, 'LOCAL | REMOTE | TIME (UTC)\n20261102164135 |  | t'), /PARTIAL_RELEASE_LEDGER|PREREQUISITE_MIGRATION_MISSING/);
  // original Mobile Phones filename versions are no longer a ledger requirement
  assert.ok(!f.requiredLedgerVersions.includes('20261025131116') && !f.requiredLedgerVersions.includes('20261025135152'));
});

test('Mobile Phones provenance reconciles both hosted histories and fails closed otherwise', () => {
  for (const environment of ['FairSwapTest', 'FairSwapProd']) {
    assert.deepEqual(assertMobilePhonesProvenance(environment, mobileRows(environment)), MOBILE_PHONES_HISTORY[environment].map(h => h.version));
    // unrelated history rows (including the original filename versions) are neither required nor accepted as provenance
    assert.doesNotThrow(() => assertMobilePhonesProvenance(environment, [...mobileRows(environment), {version: '20261025131116', name: 'posting_v2_mobiles', hasStatements: true}]));
  }
  assert.deepEqual(MOBILE_PHONES_HISTORY.FairSwapTest.map(h => h.version), ['20261025195136', '20261025195824']);
  assert.deepEqual(MOBILE_PHONES_HISTORY.FairSwapProd.map(h => h.version), ['20261025200401', '20261025201712']);
  const original = [{version: '20261025131116', name: 'posting_v2_mobiles', hasStatements: true}, {version: '20261025135152', name: 'activate_posting_v2_mobiles', hasStatements: true}];
  assert.throws(() => assertMobilePhonesProvenance('FairSwapTest', original), /WEARABLES_MOBILE_HISTORY_MISSING/);
  assert.throws(() => assertMobilePhonesProvenance('FairSwapTest', mobileRows('FairSwapProd')), /WEARABLES_MOBILE_HISTORY_MIXED/);
  assert.throws(() => assertMobilePhonesProvenance('FairSwapProd', mobileRows('FairSwapTest')), /WEARABLES_MOBILE_HISTORY_MIXED/);
  assert.throws(() => assertMobilePhonesProvenance('FairSwapProd', [...mobileRows('FairSwapProd'), ...mobileRows('FairSwapTest')]), /WEARABLES_MOBILE_HISTORY_MIXED/);
  assert.throws(() => assertMobilePhonesProvenance('FairSwapTest', mobileRows('FairSwapTest').slice(0, 1)), /WEARABLES_MOBILE_HISTORY_MISSING/);
  assert.throws(() => assertMobilePhonesProvenance('FairSwapTest', mobileRows('FairSwapTest').map(r => ({...r, name: 'other'}))), /NAME_MISMATCH/);
  assert.throws(() => assertMobilePhonesProvenance('FairSwapTest', mobileRows('FairSwapTest').map(r => ({...r, hasStatements: false}))), /NO_STATEMENTS/);
  assert.throws(() => assertMobilePhonesProvenance('Unknown', []), /MOBILE_HISTORY_INVALID/);
});

test('Wearables ledger tail guard fails closed when the hosted history is already ahead', () => {
  const f = getCandidate(WF);
  // both hosted ledgers end at Azure moderation 20261104113705, which the resequenced Wearables versions now follow
  assert.doesNotThrow(() => assertLedgerTail(f, [{version: '20261102170611'}, {version: '20261104113705'}]));
  assert.doesNotThrow(() => assertLedgerTail(getCandidate(WA), [{version: '20261104113705'}, {version: f.version}]));
  assert.ok(f.version > '20261104113705' && getCandidate(WA).version > f.version);
  assert.throws(() => assertLedgerTail(f, [{version: '20261104130000'}]), /WEARABLES_LEDGER_TAIL_AHEAD/);
  assert.throws(() => assertLedgerTail(f, [{version: f.version}]), /WEARABLES_LEDGER_TAIL_AHEAD/);
});

test('Web pins are family specific; Accessories and Tablets behaviour is unchanged', () => {
  assert.equal(WEARABLES_WEB.stagingSha, 'e37e28df1d387a02bcbea19487dfe0f82d198f74');
  assert.equal(WEB_PINS['accessories-v1'], ACCESSORIES_WEB);
  assert.equal(WEB_PINS['tablets-v1'], ACCESSORIES_WEB);
  assert.equal(wPlan(WF, 'test').priorRuns.length, 0);
  assert.equal(wPlan(WA, 'test').webStagingSha, WEARABLES_WEB.stagingSha);
  // A pin from another family never satisfies Wearables, and vice versa
  assert.throws(() => wPlan(WA, 'test', {web_staging_sha: ACCESSORIES_WEB.stagingSha}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  assert.throws(() => planFor(ACTIVATION, 'test', {web_staging_sha: WEARABLES_WEB.stagingSha}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  assert.throws(() => planFor('tablets-v1-activation', 'test', {web_staging_sha: WEARABLES_WEB.stagingSha}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  // Accessories keeps its Production baseline rejection and gains no Wearables-only fields
  assert.throws(() => planFor(ACTIVATION, 'production', {web_production_sha: ACCESSORIES_WEB.productionBaselineSha}), /WEB_PRODUCTION_VERIFICATION_REQUIRED/);
  const acc = planFor(FOUNDATION, 'production');
  assert.equal(acc.crossCommitRuns, undefined);
  assert.equal(acc.e2eRunId, undefined);
  assert.equal(planFor('tablets-v1-foundation', 'production').e2eRunId, undefined);
});

test('Wearables Production plans require Test, Accessories Production and E2E evidence', () => {
  const foundation = wPlan(WF, 'production');
  assert.deepEqual(foundation.priorRuns.map(r => [r.candidateId, r.environment]), [[WF, 'test'], [WA, 'test']]);
  assert.deepEqual(foundation.crossCommitRuns.map(r => [r.key, r.candidateId, r.environment, r.runId]), [['accessories_prod_foundation_run_id', 'accessories-v1-foundation', 'prod', '50']]);
  assert.equal(foundation.e2eRunId, '60');
  const activation = wPlan(WA, 'production');
  assert.deepEqual(activation.priorRuns.map(r => [r.candidateId, r.environment]), [[WA, 'test'], [WF, 'prod']]);
  assert.equal(activation.webProductionSha, 'e'.repeat(40));
  for (const stage of [WF, WA]) {
    assert.throws(() => wPlan(stage, 'production', {accessories_prod_foundation_run_id: ''}), /EVIDENCE_RUN_REQUIRED_ACCESSORIES_PROD_FOUNDATION_RUN_ID/);
    assert.throws(() => wPlan(stage, 'production', {accessories_prod_foundation_run_id: '0x1'}), /EVIDENCE_RUN_REQUIRED/);
    assert.throws(() => wPlan(stage, 'production', {test_e2e_run_id: ''}), /EVIDENCE_RUN_REQUIRED_TEST_E2E_RUN_ID/);
    assert.throws(() => wPlan(stage, 'production', {web_staging_sha: 'b'.repeat(40)}), /WEB_STAGING_VERIFICATION_REQUIRED/);
  }
  assert.throws(() => wPlan(WF, 'production', {test_activation_run_id: ''}), /EVIDENCE_RUN_REQUIRED/);
  assert.throws(() => wPlan(WA, 'production', {prod_foundation_run_id: ''}), /EVIDENCE_RUN_REQUIRED/);
  assert.throws(() => wPlan(WA, 'production', {web_production_sha: 'short'}), /WEB_PRODUCTION_VERIFICATION_REQUIRED/);
  // Test stages never ask for Production-only evidence
  assert.equal(wPlan(WA, 'test').e2eRunId, undefined);
  assert.throws(() => wPlan(WA, 'test', {test_foundation_run_id: ''}), /EVIDENCE_RUN_REQUIRED/);
});

test('Wearables Web verification uses the Wearables pin and cannot be satisfied by the Accessories commit', async () => {
  const env = {WEB_EVIDENCE_TOKEN: 't'};
  const fetcherFor = (deployments, o = {}) => async u => {
    const ok = body => ({ok: true, status: 200, json: async () => body});
    let m;
    if ((m = u.match(/deployments\/(\d+)\/statuses/))) return ok([{state: 'success'}]);
    if (u.includes('/deployments?environment=Production')) return ok(o.live ?? deployments.filter(d => d.environment === 'Production').slice(0, 1));
    if ((m = u.match(/deployments\?sha=([0-9a-f]+)/))) return ok(deployments.filter(d => d.sha === m[1]));
    if (u.includes(`/compare/${WEARABLES_WEB.stagingSha}...`)) return ok({status: o.tested ?? 'ahead'});
    if (u.includes('...main')) return ok({status: 'ahead'});
    throw new Error(`unexpected ${u}`);
  };
  const good = [wDep(1, WEARABLES_WEB.stagingSha, 'Preview'), wDep(2, 'e'.repeat(40), 'Production')];
  assert.deepEqual(await verifyWebDeployments(wPlan(WA, 'production'), env, fetcherFor(good)), {stagingDeploymentId: 1, productionDeploymentId: 2});
  await assert.rejects(verifyWebDeployments(wPlan(WA, 'test'), env, fetcherFor([wDep(1, ACCESSORIES_WEB.stagingSha, 'Preview')])), /WEB_STAGING_DEPLOYMENT_NOT_READY/);
  await assert.rejects(verifyWebDeployments(wPlan(WA, 'production'), env, fetcherFor(good, {tested: 'diverged'})), /WEB_PRODUCTION_MISSING_TESTED_RELEASE/);
  // the old Accessories production baseline cannot be Wearables Production evidence: it does not contain the tested commit
  const old = [wDep(1, WEARABLES_WEB.stagingSha, 'Preview'), wDep(2, ACCESSORIES_WEB.productionBaselineSha, 'Production')];
  await assert.rejects(verifyWebDeployments(wPlan(WA, 'production', {web_production_sha: ACCESSORIES_WEB.productionBaselineSha}), env, fetcherFor(old, {tested: 'behind'})), /WEB_PRODUCTION_MISSING_TESTED_RELEASE/);
});

test('Wearables receipts are bound to the Wearables Web pin and to the current commit', async () => {
  const chain = [{key: 'test_foundation_run_id', runId: '10'}];
  const mk = over => receiptFor(WA, 'test', '11', {priorRuns: chain, ledgerStatementsSha256: 'a'.repeat(64), webStagingSha: WEARABLES_WEB.stagingSha, ...over});
  const run = async over => {
    const body = JSON.stringify(mk(over), null, 2) + '\n';
    const name = `${WA}-fairswaptest.json`;
    const zip = makeZip({[name]: body, SHA256SUMS_fairswaptest: `${createHash('sha256').update(body).digest('hex')}  ${name}\n`});
    return requireStageEvidence([{key: 'test_activation_run_id', runId: '11', candidateId: WA, environment: 'test'}], ctx,
      evidenceFetcher({runId: '11', candidateId: WA, env: 'test', zip}));
  };
  assert.equal((await run({}))['test_activation_run_id'].candidateId, WA);
  await assert.rejects(run({webStagingSha: ACCESSORIES_WEB.stagingSha}), /RECEIPT_CONTENT_INVALID.*web/);
  await assert.rejects(run({ledgerStatementsSha256: undefined}), /RECEIPT_CONTENT_INVALID.*hash/);
  // normal same-commit rule is unchanged: a receipt from an earlier commit is rejected for Wearables stages
  await assert.rejects(run({reviewedCommit: 'd'.repeat(40)}), /RECEIPT_CONTENT_INVALID.*commit/);
});

test('Wearables Test activation accepts a verified immutable ancestor foundation receipt', async () => {
  const ancestorCommit = 'e96d1b6e00746ce13902f2b1fbbdcb9233fbfb3d';
  const candidate = getCandidate(WF);
  const source = readFileSync(candidate.path);
  const testFoundation = {key: 'test_foundation_run_id', runId: '41979462046', candidateId: WF, environment: 'test'};
  const makeEvidence = (over = {}) => {
    const receipt = receiptFor(WF, 'test', '41979462046', {
      reviewedCommit: ancestorCommit,
      ledgerStatementsSha256: 'a'.repeat(64),
      ...(over.receipt ?? {})
    });
    const body = JSON.stringify(receipt, null, 2) + '\n';
    const name = `${WF}-fairswaptest.json`;
    const zip = makeZip({[name]: body, SHA256SUMS_fairswaptest: `${over.sums ?? createHash('sha256').update(body).digest('hex')}  ${name}\n`});
    return async raw => {
      const u = new URL(raw);
      const ok = value => ({ok: true, json: async () => value});
      if (u.pathname.includes('/compare/')) {
        return ok(over.comparison ?? {
          status: 'ahead', behind_by: 0, base_commit: {sha: ancestorCommit}, merge_base_commit: {sha: ancestorCommit}
        });
      }
      if (u.pathname.includes('/contents/')) {
        const bytes = over.source ?? source;
        return ok({type: 'file', path: candidate.path, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length});
      }
      const m = u.pathname.match(/\/(runs|artifacts)\/(\d+)(?:\/(artifacts|zip))?$/);
      assert(m, raw);
      const [, kind, id, suffix] = m;
      if (kind === 'artifacts') return {ok: true, arrayBuffer: async () => zip};
      if (!suffix) {
        return ok({
          path: goodRun.path, head_sha: ancestorCommit, head_branch: 'main', event: 'workflow_dispatch',
          status: 'completed', conclusion: 'success', id: Number(id), run_attempt: 1, workflow_id: 404601811,
          head_repository: {full_name: GH}, actor: {login: 'vivek2310sharma'}, triggering_actor: {login: 'vivek2310sharma'},
          ...over.run
        });
      }
      const artifact = {
        id: Number(id), name: `reusable-test-${WF}-${id}-1`, expired: false,
        workflow_run: {id: Number(id), head_sha: ancestorCommit},
        archive_download_url: `https://api.github.com/repos/${GH}/actions/artifacts/${id}/zip`,
        digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`,
        ...over.artifact
      };
      return ok({artifacts: over.missing ? [] : [artifact]});
    };
  };

  const check = over => requireStageEvidence([testFoundation], ctx, makeEvidence(over));
  const res = await check();
  assert.equal(res.test_foundation_run_id.reviewedCommit, ancestorCommit);
  assert.equal(res.test_foundation_run_id.candidateId, WF);

  // Fails closed if ancestor comparison diverged or behind
  await assert.rejects(check({comparison: {status: 'diverged'}}), /EVIDENCE_ANCESTRY_NOT_VERIFIED/);
  await assert.rejects(check({comparison: {status: 'ahead', behind_by: 0, base_commit: {sha: ancestorCommit}, merge_base_commit: {sha: SHA_C}}}), /EVIDENCE_ANCESTRY_NOT_VERIFIED/);

  // Fails closed if SQL source on ancestor commit differs from candidate
  await assert.rejects(check({source: Buffer.from('select 1;')}), /EVIDENCE_SOURCE_MISMATCH/);

  // Fails closed if run was not successful
  await assert.rejects(check({run: {conclusion: 'failure'}}), /EVIDENCE_RUN_NOT_VERIFIED/);

  // Strict validation: Production foundation cannot use this Test-only ancestor path
  await assert.rejects(
    requireStageEvidence([{key: 'prod_foundation_run_id', runId: '41979462046', candidateId: WF, environment: 'prod'}], ctx, makeEvidence()),
    /EVIDENCE_RUN_NOT_VERIFIED/
  );
});

// Cross-commit Accessories Production evidence
const A40 = 'a1'.repeat(20);
const C40 = 'c2'.repeat(20);
const xCtx = {GITHUB_REPOSITORY: GH, GITHUB_TOKEN: 't', GITHUB_SHA: C40};
const xRun = over => ({path: '.github/workflows/reusable-supabase-release.yml', head_sha: A40, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', ...over});

function xFetcher(o = {}) {
  const art = `https://api.github.com/repos/${GH}/actions/artifacts/9/zip`;
  const receipt = receiptFor('accessories-v1-foundation', 'prod', '50', {reviewedCommit: A40, ...(o.receipt ?? {})});
  const body = JSON.stringify(receipt, null, 2) + '\n';
  const name = 'accessories-v1-foundation-fairswapprod.json';
  const zip = makeZip({[name]: body, SHA256SUMS_fairswapprod: `${o.sums ?? createHash('sha256').update(body).digest('hex')}  ${name}\n`});
  const base = `https://api.github.com/repos/${GH}/actions/runs`;
  const ok = json => ({ok: true, status: 200, json: async () => json});
  return async u => {
    if (u === art) return {ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length)};
    if (u === `${base}/50`) return ok(xRun(o.run));
    if (u === `${base}/50/artifacts?per_page=100`) return ok({artifacts: o.artifacts ?? [{name: 'reusable-prod-accessories-v1-foundation-50-1', expired: false, workflow_run: {id: 50}, archive_download_url: art}]});
    if (u === `${base}/10` || u === `${base}/11`) return ok(xRun(o.chain));
    if (u === `https://api.github.com/repos/${GH}/compare/${A40}...${C40}`) return ok({status: o.compare ?? 'ahead'});
    throw new Error(`unexpected ${u}`);
  };
}

test('cross-commit Accessories Production evidence accepts only a verified ancestor release', async () => {
  const plan = wPlan(WF, 'production');
  assert.deepEqual(await requirePriorCommitEvidence(plan, xCtx, xFetcher()),
    {accessories_prod_foundation_run_id: {runId: '50', reviewedCommit: A40, ledgerVersion: '20261102164135', basis: 'release-workflow'}});
  assert.deepEqual(await requirePriorCommitEvidence(wPlan(WF, 'test'), xCtx, xFetcher({run: {conclusion: 'failure'}})), {});
  const bad = (o, re) => assert.rejects(requirePriorCommitEvidence(plan, xCtx, xFetcher(o)), re);
  await bad({compare: 'diverged'}, /CROSS_COMMIT_NOT_ANCESTOR/);
  await bad({compare: 'behind'}, /CROSS_COMMIT_NOT_ANCESTOR/);
  await bad({run: {conclusion: 'failure'}}, /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  await bad({run: {head_branch: 'feature/x'}}, /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  await bad({run: {event: 'push'}}, /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  await bad({run: {path: '.github/workflows/other.yml'}}, /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  await bad({run: {status: 'in_progress'}}, /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  await bad({artifacts: []}, /CROSS_COMMIT_RECEIPT_MISSING/);
  await bad({artifacts: [{name: 'reusable-prod-accessories-v1-foundation-50-1', expired: true, workflow_run: {id: 50}, archive_download_url: 'x'}]}, /CROSS_COMMIT_RECEIPT_MISSING/);
  await bad({artifacts: [{name: 'reusable-prod-accessories-v1-foundation-50-1', expired: false, workflow_run: {id: 50}, archive_download_url: 'https://evil.example/zip'}]}, /CROSS_COMMIT_RECEIPT_INVALID/);
  await bad({sums: 'f'.repeat(64)}, /CROSS_COMMIT_RECEIPT_INVALID.*checksum/);
  await bad({receipt: {environment: 'FairSwapTest', projectRef: REFS.FairSwapTest}}, /CROSS_COMMIT_RECEIPT_INVALID.*environment/);
  await bad({receipt: {migrationSha256: 'f'.repeat(64)}}, /CROSS_COMMIT_RECEIPT_INVALID.*hash/);
  await bad({receipt: {reviewedCommit: 'd'.repeat(40)}}, /CROSS_COMMIT_RECEIPT_INVALID.*commit/);
  await bad({receipt: {releaseWorkflowRun: '51'}}, /CROSS_COMMIT_RECEIPT_INVALID.*run/);
  await bad({receipt: {postflightVerified: false}}, /CROSS_COMMIT_RECEIPT_INVALID.*postflight/);
  await bad({receipt: {status: 'FAIL'}}, /CROSS_COMMIT_RECEIPT_INVALID.*postflight/);
  await bad({receipt: {priorRuns: []}}, /CROSS_COMMIT_RECEIPT_INVALID.*chain/);
  await bad({receipt: {priorRuns: [{key: 'test_foundation_run_id', runId: '10'}, {key: 'prod_foundation_run_id', runId: '11'}]}}, /CROSS_COMMIT_RECEIPT_INVALID.*chain/);
  await bad({receipt: {webStagingSha: WEARABLES_WEB.stagingSha}}, /CROSS_COMMIT_RECEIPT_INVALID.*web/);
  // the receipt's recorded Test chain must be successful runs on the same reviewed commit
  await bad({chain: {head_sha: 'd'.repeat(40)}}, /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  await bad({chain: {conclusion: 'cancelled'}}, /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  // scope is limited to the Accessories Production foundation
  for (const widened of [{candidateId: ACTIVATION, environment: 'prod'}, {candidateId: FOUNDATION, environment: 'test'}, {candidateId: WF, environment: 'prod'}]) {
    await assert.rejects(requirePriorCommitEvidence({...plan, crossCommitRuns: [{...plan.crossCommitRuns[0], ...widened}]}, xCtx, xFetcher()), /CROSS_COMMIT_SCOPE_VIOLATION/);
  }
  await assert.rejects(requirePriorCommitEvidence(plan, {...xCtx, GITHUB_SHA: 'main'}, xFetcher()), /CROSS_COMMIT_RUN_NOT_VERIFIED/);
  assert.throws(() => validateCrossCommitReceipt('50', xRun(), new Map()), /CROSS_COMMIT_RECEIPT_INVALID/);
});

// Independent Test E2E evidence. The runner lives in a LATER, reviewed and deployed Web commit than the tested staging commit.
const RUNNER = '9a'.repeat(20);
const E2E_PIN = Object.freeze({...WEARABLES_WEB, e2eRunnerSha: RUNNER});
const REPO_API = `https://api.github.com/repos/${WEARABLES_WEB.repository}`;

function e2eFetcher(o = {}) {
  const art = `${REPO_API}/actions/artifacts/7/zip`;
  const steps = Object.fromEntries(WEARABLES_E2E.steps.map(step => [step, true]));
  const receipt = {
    schema: WEARABLES_E2E.schema, result: 'PASS', runId: '60', environment: 'FairSwapTest', projectRef: REFS.FairSwapTest,
    webStagingSha: WEARABLES_WEB.stagingSha, runnerSha: RUNNER, deployedWebSha: RUNNER,
    foundationSha256: getCandidate(WF).sha256, activationSha256: getCandidate(WA).sha256,
    testActivationRunId: '11', webFlagEnabledInTest: true, webFlagEnabledInProduction: false, steps: {...steps, ...(o.steps ?? {})}, ...(o.receipt ?? {})
  };
  const body = JSON.stringify(receipt, null, 2) + '\n';
  const zip = makeZip({[WEARABLES_E2E.receiptName]: body, [WEARABLES_E2E.sumsName]: `${o.sums ?? createHash('sha256').update(body).digest('hex')}  ${WEARABLES_E2E.receiptName}\n`});
  const base = `${REPO_API}/actions/runs/60`;
  const ok = json => ({ok: true, status: 200, json: async () => json});
  const files = o.files ?? [{filename: '.github/workflows/wearables-e2e-test.yml'}, {filename: 'e2e/wearables/journey.spec.ts'}];
  const deployments = o.deployments ?? [{id: 5, sha: RUNNER, environment: 'Preview'}];
  return async u => {
    if (u === art) return {ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length)};
    if (u === `${REPO_API}/compare/${WEARABLES_WEB.stagingSha}...${RUNNER}`) return ok({status: o.compare ?? 'ahead', files});
    if (u.includes('/deployments?sha=')) return ok(deployments.filter(d => u.includes(d.sha)));
    if (/deployments\/\d+\/statuses/.test(u)) return ok([{state: o.deployState ?? 'success'}]);
    if (u === base) return ok({path: WEARABLES_E2E.workflowPath, head_sha: RUNNER, status: 'completed', conclusion: 'success', ...(o.run ?? {})});
    if (u === `${base}/artifacts?per_page=100`) return ok({artifacts: o.artifacts ?? [{name: 'wearables-e2e-test-60-1', expired: false, workflow_run: {id: 60}, archive_download_url: art}]});
    throw new Error(`unexpected ${u}`);
  };
}

test('Production requires independent Test E2E evidence, not only a successful SQL postflight receipt', async () => {
  const plan = wPlan(WF, 'production');
  const env = {WEB_EVIDENCE_TOKEN: 't', TEST_ACTIVATION_RUN_ID: '11'};
  assert.deepEqual(await verifyE2eEvidence(plan, env, e2eFetcher(), E2E_PIN), {runId: '60', webStagingSha: WEARABLES_WEB.stagingSha, runnerSha: RUNNER});
  assert.equal(await verifyE2eEvidence(wPlan(WA, 'test'), {}, e2eFetcher(), E2E_PIN), null);
  // the SQL-only path cannot reach Production: no E2E run id, no plan
  assert.throws(() => wPlan(WF, 'production', {test_e2e_run_id: undefined}), /EVIDENCE_RUN_REQUIRED_TEST_E2E_RUN_ID/);
  const bad = (o, re, e = env) => assert.rejects(verifyE2eEvidence(plan, e, e2eFetcher(o), E2E_PIN), re);
  await bad({}, /E2E_EVIDENCE_UNAVAILABLE/, {TEST_ACTIVATION_RUN_ID: '11'});
  for (const step of WEARABLES_E2E.steps) await bad({steps: {[step]: false}}, /E2E_RECEIPT_INVALID.*steps/);
  await bad({steps: {extra_step: true}}, /E2E_RECEIPT_INVALID.*steps/);
  await bad({run: {conclusion: 'failure'}}, /E2E_RUN_NOT_VERIFIED/);
  // the run must be on exactly the pinned runner commit, not the staging commit and not any other commit
  await bad({run: {head_sha: WEARABLES_WEB.stagingSha}}, /E2E_RUN_NOT_VERIFIED/);
  await bad({run: {head_sha: 'd'.repeat(40)}}, /E2E_RUN_NOT_VERIFIED/);
  await bad({run: {path: '.github/workflows/other.yml'}}, /E2E_RUN_NOT_VERIFIED/);
  await bad({artifacts: []}, /E2E_RECEIPT_MISSING/);
  await bad({sums: 'f'.repeat(64)}, /E2E_RECEIPT_INVALID.*checksum/);
  await bad({receipt: {result: 'FAIL'}}, /E2E_RECEIPT_INVALID.*schema/);
  await bad({receipt: {environment: 'FairSwapProd', projectRef: REFS.FairSwapProd}}, /E2E_RECEIPT_INVALID.*environment/);
  await bad({receipt: {webStagingSha: ACCESSORIES_WEB.stagingSha}}, /E2E_RECEIPT_INVALID.*web/);
  await bad({receipt: {runnerSha: WEARABLES_WEB.stagingSha}}, /E2E_RECEIPT_INVALID.*web/);
  await bad({receipt: {deployedWebSha: WEARABLES_WEB.stagingSha}}, /E2E_RECEIPT_INVALID.*web/);
  await bad({receipt: {activationSha256: 'f'.repeat(64)}}, /E2E_RECEIPT_INVALID.*sql/);
  await bad({receipt: {testActivationRunId: '99'}}, /E2E_RECEIPT_INVALID.*activation_run/);
  await bad({receipt: {webFlagEnabledInProduction: true}}, /E2E_RECEIPT_INVALID.*flags/);
  await bad({receipt: {webFlagEnabledInTest: false}}, /E2E_RECEIPT_INVALID.*flags/);
  await bad({receipt: {runId: '61'}}, /E2E_RECEIPT_INVALID.*run/);
});

test('E2E runner commit pin is unset by default, keeping Production blocked, and must be an isolated READY deployment', async () => {
  const plan = wPlan(WF, 'production');
  const env = {WEB_EVIDENCE_TOKEN: 't', TEST_ACTIVATION_RUN_ID: '11'};
  assert.equal(WEARABLES_WEB.e2eRunnerSha, null);
  // the registry pin (used by the workflow) fails closed even with otherwise perfect evidence
  await assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher()), /E2E_RUNNER_PIN_UNSET/);
  await assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher(), {...E2E_PIN, e2eRunnerSha: 'main'}), /E2E_RUNNER_PIN_UNSET/);
  await assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher(), {...E2E_PIN, e2eRunnerSha: WEARABLES_WEB.stagingSha}), /E2E_RUNNER_PIN_UNSET/);
  const bad = (o, re) => assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher(o), E2E_PIN), re);
  // runner commit must descend from the tested commit
  for (const compare of ['diverged', 'behind', 'identical']) await bad({compare}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  // ...and add nothing but runner files: no application, SQL, dependency, workflow-other or traversal path
  for (const filename of ['src/app/page.tsx', 'package.json', 'pnpm-lock.yaml', 'supabase/migrations/x.sql', '.github/workflows/other.yml',
    '.github/workflows/wearables-e2e-test.yml.bak', 'e2e/other/x.ts', 'e2e/wearables/../../src/x.ts', 'next.config.ts']) {
    await bad({files: [{filename: 'e2e/wearables/ok.ts'}, {filename}]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  }
  await bad({files: [{filename: 'e2e/wearables/ok.ts', previous_filename: 'src/old.ts'}]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  await bad({files: []}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  await bad({files: Array.from({length: 101}, (_, i) => ({filename: `e2e/wearables/f${i}.ts`}))}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  // the deployed runner commit must be READY, in a non-Production environment
  await bad({deployments: []}, /E2E_RUNNER_DEPLOYMENT_NOT_READY/);
  await bad({deployState: 'failure'}, /E2E_RUNNER_DEPLOYMENT_NOT_READY/);
  await bad({deployments: [{id: 5, sha: RUNNER, environment: 'Production'}]}, /E2E_RUNNER_DEPLOYMENT_NOT_READY/);
});

const checkKeys = query => [...query.matchAll(/'([a-z_]+)', \(/g)].map(m => m[1]);
const allTrue = query => Object.fromEntries(checkKeys(query).map(k => [k, true]));

test('Wearables preflight validates installed definitions before any migration and fails closed', () => {
  const run = (cid, mutate) => runWearablesPreflight(getCandidate(cid), query => {
    assert.match(query, /^BEGIN READ ONLY; SET LOCAL statement_timeout = '15s';/);
    assert.match(query, /COMMIT;$/);
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT)\b/i);
    return JSON.stringify(mutate(allTrue(query)));
  });
  const keysOf = cid => { let k; run(cid, o => (k = Object.keys(o), o)); return k; };
  const foundationKeys = keysOf(WF);
  for (const key of ['session_baseline', 'wearables_absent', 'category_clean', 'phone_objects', 'accessories_installed', 'session_recovery']) assert.ok(foundationKeys.includes(key), key);
  for (const key of foundationKeys) assert.throws(() => run(WF, o => ({...o, [key]: false})), new RegExp(`WEARABLES_PREFLIGHT_FAILED: ${key}`));
  for (const key of keysOf(WA)) assert.throws(() => run(WA, o => ({...o, [key]: false})), new RegExp(`WEARABLES_PREFLIGHT_FAILED: ${key}`));
  assert.throws(() => run(WF, o => ({...o, extra: true})), /unexpected:extra/);
  assert.throws(() => run(WF, o => ({...o, session_baseline: null})), /WEARABLES_PREFLIGHT_FAILED/);
  assert.throws(() => runWearablesPreflight(getCandidate(WF), () => 'not json'), /WEARABLES_PREFLIGHT_INVALID_RESPONSE/);
  assert.throws(() => runWearablesPreflight(getCandidate(WF), () => '[]'), /WEARABLES_PREFLIGHT_INVALID_RESPONSE/);
  // Stage 1 never names a relation that only exists after the foundation (PostgreSQL resolves relations at parse time)
  let foundationSql = '';
  run(WF, o => o) && runWearablesPreflight(getCandidate(WF), q => ((foundationSql = q), JSON.stringify(allTrue(q))));
  assert.doesNotMatch(foundationSql.replace(/to_regclass\('public\.wearable_release_v1'\)/g, ''), /public\.wearable_release_v1/);
  assert.match(foundationSql, /NOT LIKE '%wearable%'/);
});

test('Wearables postflight is a strict read-only RLS, ACL, ownership and moderation check', () => {
  const sqlOf = stage => { let sql; runWearablesPostflight(getCandidate(stage), q => ((sql = q), JSON.stringify(allTrue(q)))); return sql; };
  const foundation = sqlOf(WF);
  const activation = sqlOf(WA);
  for (const sql of [foundation, activation]) {
    assert.match(sql, /^BEGIN READ ONLY;/);
    assert.doesNotMatch(sql, /\b(INSERT INTO|UPDATE public|DELETE FROM|CREATE|DROP|ALTER|GRANT|REVOKE)\b/);
    for (const needle of ['relforcerowsecurity', 'has_function_privilege', 'session_core_isolation', 'session_ownership', 'moderation_guard', 'moderation_flags',
      'zz_wearable_listing_guard_v1', 'is_active_staff_aal2', 'impl_posting_session_core_v1', 'wearables_v1_catalogue', 'search_wearables_v1']) assert.ok(sql.includes(needle), needle);
  }
  assert.match(foundation, /r\.enabled = false/);
  assert.match(activation, /r\.enabled = true/);
  assert.ok(checkKeys(foundation).includes('no_wearable_rows'));
  assert.ok(!checkKeys(activation).includes('no_wearable_rows'));
  assert.deepEqual(Object.keys(wearablesPostflightChecks('activation')), checkKeys(activation));
  for (const stage of [WF, WA]) {
    for (const key of checkKeys(sqlOf(stage))) {
      assert.throws(() => runWearablesPostflight(getCandidate(stage), q => JSON.stringify({...allTrue(q), [key]: false})), new RegExp(`WEARABLES_POSTFLIGHT_FAILED: ${key}`));
      assert.throws(() => runWearablesPostflight(getCandidate(stage), q => { const o = allTrue(q); delete o[key]; return JSON.stringify(o); }), /WEARABLES_POSTFLIGHT_FAILED/);
    }
    assert.throws(() => runWearablesPostflight(getCandidate(stage), q => JSON.stringify({...allTrue(q), surprise: true})), /unexpected:surprise/);
  }
});

test('W-AZ-1: only the activation stage requires the pinned Azure finalizer (pre) and the wrapper (post); every key fails closed; the pin is derived from the pinned Azure file', () => {
  const sqlOf = (fn, stage) => { let sql; fn(getCandidate(stage), q => ((sql = q), JSON.stringify(allTrue(q)))); return sql; };
  const preF = sqlOf(runWearablesPreflight, WF), preA = sqlOf(runWearablesPreflight, WA);
  const postF = sqlOf(runWearablesPostflight, WF), postA = sqlOf(runWearablesPostflight, WA);
  assert.ok(!checkKeys(preF).includes('azure_finalizer_baseline') && checkKeys(preA).includes('azure_finalizer_baseline'));
  assert.ok(!checkKeys(postF).includes('azure_finalizer_wearable_routing') && checkKeys(postA).includes('azure_finalizer_wearable_routing'));
  for (const sql of [preA, postA]) {
    assert.match(sql, /^BEGIN READ ONLY;/);
    assert.ok(sql.includes(AZURE_FINALIZER_BODY_SHA256));
    assert.doesNotMatch(sql, /\b(INSERT INTO|UPDATE public|DELETE FROM|CREATE|DROP|ALTER|GRANT|REVOKE)\b/);
  }
  for (const [fn, stage, key] of [[runWearablesPreflight, WA, 'azure_finalizer_baseline'], [runWearablesPostflight, WA, 'azure_finalizer_wearable_routing']]) {
    assert.throws(() => fn(getCandidate(stage), q => JSON.stringify({...allTrue(q), [key]: false})), new RegExp(`WEARABLES_(PRE|POST)FLIGHT_FAILED: ${key}`));
    assert.throws(() => fn(getCandidate(stage), q => { const o = allTrue(q); delete o[key]; return JSON.stringify(o); }), /FAILED/);
  }
  // the pin equals the sha256 of the Azure finalizer body in the reviewed (and SHA-pinned) Azure migration, and the activation SQL embeds the same pin
  const azure = readFileSync(join(process.cwd(), getCandidate('moderation-azure-v1').path), 'utf8');
  const start = azure.indexOf('AS $$\n', azure.indexOf('CREATE OR REPLACE FUNCTION app_security.impl_finalize_moderation_result(')) + 5;
  const body = azure.slice(start, azure.indexOf('\n$$;', start) + 1);
  assert.equal(createHash('sha256').update(body).digest('hex'), AZURE_FINALIZER_BODY_SHA256);
  assert.ok(readFileSync(join(process.cwd(), getCandidate(WA).path), 'utf8').includes(AZURE_FINALIZER_BODY_SHA256));
  assert.equal(verifyCandidateSha('moderation-azure-v1', process.cwd()).sha256, getCandidate('moderation-azure-v1').sha256);
});

function wearablesMock(environment, candidateId, {extraBefore = [], failKey, ledgerSha = 'a'.repeat(64), accessoriesSha, activationSha, noActivationRow = false} = {}) {
  const candidate = getCandidate(candidateId);
  const names = {'20261102164135': 'accessories_v1', '20261102164137': 'activate_accessories_v1', '20261104120000': 'posting_v2_wearables', '20261104113705': 'azure_moderation_finalizer', [candidate.version]: candidate.filename.slice(15, -4)};
  for (const h of MOBILE_PHONES_HISTORY[environment]) names[h.version] = h.name;
  const required = candidate.requiredLedgerVersions;
  // both hosted environments have Accessories foundation AND activation installed (activated)
  const accessoriesActivation = noActivationRow ? [] : ['20261102164137'];
  const before = [...new Set([...baseHistory, ...MOBILE_PHONES_HISTORY[environment].map(h => h.version), ...required, ...accessoriesActivation, ...extraBefore])].sort();
  const after = [...before, candidate.version].sort();
  const entry = version => ({version, name: names[version] ?? 'historical', hasStatements: true,
    statementsSha256: environment === 'FairSwapProd' && version === '20261102164135' ? (accessoriesSha ?? ADOPTED_SHA)
      : environment === 'FairSwapProd' && version === '20261102164137' ? (activationSha ?? OBSERVED.activation) : ledgerSha});
  let reads = 0;
  return {
    before, after,
    sql: query => {
      assert.match(query, /^BEGIN READ ONLY;/);
      if (query.includes('supabase_migrations.schema_migrations')) return (++reads < 3 ? before : after).map(entry);
      const result = allTrue(query);
      if (failKey && failKey in result) result[failKey] = false;
      return result;
    }
  };
}

const wRelease = (environment, candidateId, o = {}, env = {}) => release(candidateId, environment, {...wearablesMock(environment, candidateId, o), env: {
  ...wInputs, WEB_STAGING_SHA: wInputs.web_staging_sha, WEB_PRODUCTION_SHA: wInputs.web_production_sha, TEST_FOUNDATION_RUN_ID: '10', TEST_ACTIVATION_RUN_ID: '11',
  PROD_FOUNDATION_RUN_ID: '12', ACCESSORIES_PROD_FOUNDATION_RUN_ID: '50', TEST_E2E_RUN_ID: '60',
  TABLETS_FOUNDATION_LEDGER_SHA: 'a'.repeat(64), TABLETS_CANDIDATE_LEDGER_SHA: 'a'.repeat(64), ...env
}});

test('Wearables Test foundation installs through the existing pipeline and writes a receipt', async () => {
  const {receipt, calls, dir} = await wRelease('FairSwapTest', WF);
  try {
    assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.equal(receipt.candidateId, WF);
    assert.equal(receipt.stage, 'foundation');
    assert.equal(receipt.environment, 'FairSwapTest');
    assert.equal(receipt.ledgerStatementsSha256, 'a'.repeat(64));
    assert.equal(receipt.postflightScope, 'sql-integrity-smoke-not-e2e');
    assert.equal(receipt.e2eRunId, undefined);
    assert.equal(calls.filter(c => c.startsWith('supabase db push ')).length, 2);
    assert.equal(receipt.priorRuns.length, 0);
    const sums = readFileSync(join(dir, 'SHA256SUMS_fairswaptest'), 'utf8');
    assert.match(sums, new RegExp(`^[a-f0-9]{64}  ${WF}-fairswaptest\\.json\\n$`));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Wearables Test activation and Production stages require their evidence and record it', async () => {
  const act = await wRelease('FairSwapTest', WA);
  try {
    assert.equal(act.receipt.stage, 'activation');
    assert.equal(act.receipt.webStagingSha, WEARABLES_WEB.stagingSha);
    assert.deepEqual(act.receipt.priorRuns, [{key: 'test_foundation_run_id', runId: '10'}]);
  } finally { rmSync(act.dir, {recursive: true, force: true}); }
  const prod = await wRelease('FairSwapProd', WF);
  try {
    assert.equal(prod.receipt.environment, 'FairSwapProd');
    assert.equal(prod.receipt.e2eRunId, '60');
    assert.equal(prod.receipt.accessoriesProdFoundationRunId, '50');
    assert.deepEqual(prod.receipt.priorRuns.map(r => r.key), ['test_foundation_run_id', 'test_activation_run_id']);
  } finally { rmSync(prod.dir, {recursive: true, force: true}); }
  const prodActivation = await wRelease('FairSwapProd', WA);
  try {
    assert.equal(prodActivation.receipt.webProductionSha, 'e'.repeat(40));
    assert.deepEqual(prodActivation.receipt.priorRuns.map(r => r.key), ['test_activation_run_id', 'prod_foundation_run_id']);
  } finally { rmSync(prodActivation.dir, {recursive: true, force: true}); }
  // Production fails before any database work without Accessories Production or E2E evidence
  for (const missing of ['ACCESSORIES_PROD_FOUNDATION_RUN_ID', 'TEST_E2E_RUN_ID']) {
    const calls = [];
    const mock = wearablesMock('FairSwapProd', WF);
    const runner = makeRunner({...mock, filename: getCandidate(WF).filename, calls});
    await assert.rejects(releaseReusable({environment: 'FairSwapProd', candidateId: WF, context: {...baseEnv, ...wInputs, WEB_STAGING_SHA: wInputs.web_staging_sha,
      TEST_FOUNDATION_RUN_ID: '10', TEST_ACTIVATION_RUN_ID: '11', ACCESSORIES_PROD_FOUNDATION_RUN_ID: '50', TEST_E2E_RUN_ID: '60', [missing]: ''}, runner}), /EVIDENCE_RUN_REQUIRED/);
    assert.equal(calls.length, 0);
  }
});

test('Wearables release fails closed on history, drift, ledger and postflight problems and never pushes', async () => {
  // calls hold the dry-run (1) and the apply (2) as `supabase db push`; zero means nothing was attempted
  const pushes = calls => calls.filter(c => c.startsWith('supabase db push ')).length;
  const attempt = async (environment, candidateId, o, env, re) => {
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), 'fs-test-receipts-'));
    const mock = wearablesMock(environment, candidateId, o);
    const runner = makeRunner({...mock, filename: getCandidate(candidateId).filename, calls});
    const context = {...baseEnv, ...wInputs, WEB_STAGING_SHA: wInputs.web_staging_sha, WEB_PRODUCTION_SHA: wInputs.web_production_sha, TEST_FOUNDATION_RUN_ID: '10',
      TEST_ACTIVATION_RUN_ID: '11', PROD_FOUNDATION_RUN_ID: '12', ACCESSORIES_PROD_FOUNDATION_RUN_ID: '50', TEST_E2E_RUN_ID: '60',
      TABLETS_FOUNDATION_LEDGER_SHA: 'a'.repeat(64), TABLETS_CANDIDATE_LEDGER_SHA: 'a'.repeat(64), ...env};
    try {
      await assert.rejects(releaseReusable({environment, candidateId, context, runner, receiptDir: dir}), re);
      assert.equal(existsSync(join(dir, `${candidateId}-${environment.toLowerCase()}.json`)), false);
    } finally { rmSync(dir, {recursive: true, force: true}); }
    return calls;
  };
  // a ledger carrying the other environment's Mobile Phones history is mixed; one without any is missing
  let calls = await attempt('FairSwapTest', WF, {extraBefore: MOBILE_PHONES_HISTORY.FairSwapProd.map(h => h.version)}, {}, /WEARABLES_MOBILE_HISTORY_MIXED/);
  assert.equal(pushes(calls), 0);
  // hosted ledger already ahead of the candidate version
  calls = await attempt('FairSwapTest', WF, {extraBefore: ['20261104130000']}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/);
  assert.equal(pushes(calls), 0);
  // a pre-existing candidate row has no trusted receipt
  calls = await attempt('FairSwapTest', WA, {extraBefore: ['20261104120100']}, {}, /WEARABLES_ALREADY_RECORDED/);
  assert.equal(pushes(calls), 0);
  // Production must carry the Test statements hash; a different installed hash is rejected
  calls = await attempt('FairSwapProd', WF, {ledgerSha: 'b'.repeat(64)}, {}, /WEARABLES_TEST_LEDGER_MISMATCH/);
  assert.equal(pushes(calls), 2);
  // Production Accessories must be the exact adopted installation
  calls = await attempt('FairSwapProd', WF, {accessoriesSha: 'c'.repeat(64)}, {}, /WEARABLES_ACCESSORIES_ADOPTION_LEDGER_MISMATCH/);
  assert.equal(pushes(calls), 0);
  calls = await attempt('FairSwapProd', WF, {activationSha: 'c'.repeat(64)}, {}, /WEARABLES_ACCESSORIES_ADOPTION_LEDGER_MISMATCH/);
  assert.equal(pushes(calls), 0);
  calls = await attempt('FairSwapProd', WF, {noActivationRow: true}, {}, /WEARABLES_ACCESSORIES_ADOPTION_LEDGER_MISMATCH/);
  assert.equal(pushes(calls), 0);
  calls = await attempt('FairSwapProd', WF, {}, {TABLETS_CANDIDATE_LEDGER_SHA: ''}, /WEARABLES_TEST_LEDGER_EVIDENCE_REQUIRED/);
  assert.equal(pushes(calls), 0);
  calls = await attempt('FairSwapTest', WA, {ledgerSha: 'b'.repeat(64)}, {}, /WEARABLES_FOUNDATION_EVIDENCE_MISMATCH/);
  assert.equal(pushes(calls), 0);
  // live preflight drift blocks before any push (the migration's own guard would also abort)
  for (const key of ['session_baseline', 'wearables_absent', 'category_clean']) {
    calls = await attempt('FairSwapTest', WF, {failKey: key}, {}, new RegExp(`WEARABLES_PREFLIGHT_FAILED: ${key}`));
    assert.equal(pushes(calls), 0);
  }
  // postflight failure after apply is fatal and writes no receipt
  calls = await attempt('FairSwapTest', WA, {failKey: 'session_ownership'}, {}, /WEARABLES_POSTFLIGHT_FAILED: session_ownership/);
  assert.equal(pushes(calls), 2);
});

test('Wearables uses the existing reusable workflow only, with no new secrets and ordered gates', () => {
  const yaml = readFileSync(join(process.cwd(), '.github/workflows/reusable-supabase-release.yml'), 'utf8');
  for (const id of [WF, WA]) assert.ok(yaml.includes(`- ${id}`));
  for (const input of ['accessories_prod_foundation_run_id:', 'test_e2e_run_id:']) assert.ok(yaml.includes(input));
  assert.equal(readdirSync(join(process.cwd(), '.github/workflows')).filter(f => /wearable/i.test(f)).length, 0);
  assert.ok(yaml.includes('requirePriorCommitEvidence'));
  assert.ok(yaml.includes('usesLedgerHash'));
  const jobs = yaml.split(/\n  (?=test:|production:)/).slice(1);
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.ok(job.indexOf('verifyE2eEvidence(plan, e)') > job.indexOf('verifyWebDeployments(plan, e)'));
    assert.ok(job.indexOf('verifyE2eEvidence') < job.indexOf('Execute '), 'E2E evidence must precede the database release step');
    assert.ok(job.includes('ACCESSORIES_PROD_FOUNDATION_RUN_ID') && job.includes('TEST_E2E_RUN_ID'));
  }
  assert.deepEqual([...new Set([...yaml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]))].sort(),
    ['CHAT_DATABASE_PASSWORD', 'CHAT_DB_SSL_ROOT_CERT_PEM', 'CHAT_RELEASE_AUDIT_TOKEN', 'FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN', 'FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN']);
});

// ---- Existing-installation adoption (Accessories Production: foundation + activation, ACTIVATED) --------------------

const AF = 'accessories-v1-foundation';
const AA = 'accessories-v1-activation';
const OBSERVED = {foundation: ADOPTED_SHA, activation: '389d6ee5fcfb047057c9243570661cf4b5096030a2ebb1cbcabb2e26ad11b3bd'};
// sha256 of the single hosted statement text of the activation row (pinned; equals the reviewed activation source file digest)
const STORED_SQL = '3fe0647b33ad914efca86b5a9aa91590be1d2d42ac20eb42cdc5d38ee3baabcd';
const hist = sha => ({hasStatements: true, statementsSha256: sha});
const foundationRow = over => ({version: '20261102164135', name: 'accessories_v1', ...hist(OBSERVED.foundation), ...over});
const activationRow = over => ({version: '20261102164137', name: 'activate_accessories_v1', ...hist(OBSERVED.activation), ...over});
const historyRows = () => baseHistory.map(version => ({version, name: 'historical', ...hist('a'.repeat(64))}));
const activatedLedger = () => [...historyRows(), foundationRow(), activationRow()];

function adoptionRunner({ledger = activatedLedger(), counts = {'20261102164135': 58, '20261102164137': 1}, storedSql = {'20261102164137': STORED_SQL}, post, tabletsPost, calls = [], changeAfter = false} = {}) {
  let reads = 0;
  const good = goodPost('activation');
  return (cmd, args) => {
    calls.push(cmd);
    assert.equal(cmd, 'psql', 'adoption must never invoke the Supabase CLI or any writer');
    const q = args[args.length - 1];
    assert.match(q, /^(BEGIN READ ONLY;|-- accessories-postflight activation\nBEGIN READ ONLY;)/);
    assert.doesNotMatch(q, /\b(INSERT INTO|UPDATE |DELETE FROM|CREATE |DROP |ALTER |GRANT |REVOKE )/);
    const count = q.match(/SELECT cardinality\(statements\) FROM .* WHERE version = '(\d+)'/);
    if (count) return String(counts[count[1]]);
    const text = q.match(/SELECT encode\(sha256\(convert_to\(statements\[1\], 'UTF8'\)\), 'hex'\) FROM supabase_migrations\.schema_migrations WHERE version = '(\d+)'/);
    if (text) return String(storedSql[text[1]]);
    if (q.includes('supabase_migrations.schema_migrations')) {
      return JSON.stringify(changeAfter && ++reads > 1 ? [...ledger, {version: '20261104999999', name: 'x', ...hist('a'.repeat(64))}] : ledger);
    }
    if (q.includes('tablets_v1_catalogue()')) return JSON.stringify(tabletsPost ?? TABLETS_GOOD);
    return JSON.stringify(post ?? good);
  };
}
const TABLETS_GOOD = Object.fromEntries(['release_state', 'catalogue', 'forced_rls', 'client_permissions', 'function_permissions', 'listing_guard', 'phone_contract'].map(k => [k, true]));
const tabletsFoundationRow = over => ({version: '20261102165946', name: 'posting_v2_tablets', ...hist('b'.repeat(64)), ...over});
const tabletsActivationRow = over => ({version: '20261102170611', name: 'activate_tablets_v1', ...hist('c'.repeat(64)), ...over});
const postTabletsLedger = () => [...activatedLedger(), tabletsFoundationRow(), tabletsActivationRow()];
const EXEMPT = ['mobile_wrappers_extended', 'tablets_not_wrapped'];
const postTabletsPost = () => ({...goodPost('activation'), mobile_wrappers_extended: false, tablets_not_wrapped: false});
const adoptCtx = {...baseEnv, GITHUB_SHA: A40, GITHUB_RUN_ID: '50'};
const adoptFailing = async (o, re, {environment = 'FairSwapProd', candidateId = AF, context = adoptCtx} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-adopt-'));
  try {
    await assert.rejects(adoptExistingInstallation({environment, candidateId, context, runner: adoptionRunner(o), receiptDir: dir}), re);
    assert.equal(existsSync(join(dir, `${candidateId}-${environment.toLowerCase()}.json`)), false);
    assert.equal(existsSync(join(dir, 'SHA256SUMS_fairswapprod')), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
};

// Embedded Supabase-CLI-compatible statement splitter, used ONLY to prove the registry's source-derived digests.
function splitStatements(src) {
  const out = []; let cur = ''; let i = 0; let dollar = null;
  while (i < src.length) {
    const c = src[i];
    if (dollar) { if (src.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; } else { cur += c; i++; } continue; }
    if (c === '-' && src[i + 1] === '-') { let j = src.indexOf('\n', i); if (j < 0) j = src.length; cur += src.slice(i, j); i = j; continue; }
    if (c === "'") { let j = i + 1; while (j < src.length) { if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } break; } j++; } cur += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === '$') { const m = /^\$[A-Za-z_0-9]*\$/.exec(src.slice(i, i + 40)); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (c === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
const pgDigest = statements => createHash('sha256').update('[' + statements.map(x => JSON.stringify(x)).join(', ') + ']').digest('hex');

test('adoption registry pins the observed digests; the activation row is ONE stored statement whose text equals the reviewed source', () => {
  const record = EXISTING_INSTALLATIONS[`${AF}|FairSwapProd`];
  assert.deepEqual(Object.keys(EXISTING_INSTALLATIONS), [`${AF}|FairSwapProd`]);
  assert.equal(record.observedState, 'activated');
  assert.deepEqual(record.entries.map(e => [e.role, e.ledgerVersion, e.ledgerName, e.statementCount, e.statementsSha256, e.storedSqlSha256]), [
    ['foundation', '20261102164135', 'accessories_v1', 58, '70f752d5484a4e5a85680e4b2fd8ef5c257fef2f74979bd803fa4db1bf43f772', null],
    ['activation', '20261102164137', 'activate_accessories_v1', 1, '389d6ee5fcfb047057c9243570661cf4b5096030a2ebb1cbcabb2e26ad11b3bd', STORED_SQL]
  ]);
  const [foundation, activation] = record.entries;
  for (const entry of record.entries) {
    const candidate = getCandidate(entry.candidateId);
    assert.equal(candidate.version, entry.ledgerVersion);
    assert.equal(candidate.filename.slice(15, -4), entry.ledgerName);
  }
  // foundation: source-verifiable by the CLI statement split (58 statements, digest equal)
  const foundationStatements = splitStatements(readFileSync(join(process.cwd(), getCandidate(AF).path), 'utf8'));
  assert.equal(foundationStatements.length, 58);
  assert.equal(pgDigest(foundationStatements), foundation.reviewedSourceStatementsSha256);
  assert.equal(foundation.statementsSha256, foundation.reviewedSourceStatementsSha256);
  // activation: the stored text is the whole reviewed file (533 bytes, one statement): its SHA-256 is the registered source hash
  const activationBytes = readFileSync(join(process.cwd(), getCandidate(AA).path));
  assert.equal(activationBytes.length, 533);
  assert.equal(createHash('sha256').update(activationBytes).digest('hex'), STORED_SQL);
  assert.equal(getCandidate(AA).sha256, STORED_SQL);
  assert.equal(activation.storedSqlSha256, getCandidate(AA).sha256);
  assert.equal(activation.reviewedSourceStatementsSha256, null, 'the CLI-split digest of the file is not what the hosted ledger holds and is no longer attested');
  assert.equal('matchesReviewedSource' in activation, false, 'provenance is computed, never a registry boolean');
  assert.deepEqual(record.forbiddenLedgerVersions, ['20261104120000', '20261104120100']);
  assert.deepEqual(record.postTabletsLedger.map(e => [e.ledgerVersion, e.ledgerName]), [['20261102165946', 'posting_v2_tablets'], ['20261102170611', 'activate_tablets_v1']]);
  for (const e of record.postTabletsLedger) assert.equal(getCandidate(e.candidateId).filename.slice(15, -4), e.ledgerName);
  assert.deepEqual(record.postTabletsExemptKeys, EXEMPT);
});

test('adoption is registered only for the Accessories Production foundation and needs no fabricated evidence', () => {
  const plan = planDispatch({candidateId: AF, target: 'adopt'});
  assert.deepEqual(plan.priorRuns, []);
  assert.equal(plan.adoption.observedState, 'activated');
  for (const id of [AA, 'tablets-v1-foundation', 'tablets-v1-activation', WF, WA, 'moderation-analytics-v1', 'moderation-azure-v1']) {
    assert.throws(() => planDispatch({candidateId: id, target: 'adopt'}), /ADOPTION_NOT_REGISTERED/);
  }
  assert.throws(() => planDispatch({candidateId: AF, target: 'sideways'}), /INVALID_TARGET/);
  assert.throws(() => getAdoption(AF, 'FairSwapTest'), /ADOPTION_NOT_REGISTERED/);
});

test('adoption attests the ACTIVATED installation read-only and says it was not installed by this workflow', async () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'fs-adopt-'));
  try {
    const receipt = await adoptExistingInstallation({environment: 'FairSwapProd', candidateId: AF, context: adoptCtx, runner: adoptionRunner({calls}), receiptDir: dir});
    assert.ok(calls.length >= 5 && calls.every(c => c === 'psql'));
    assert.equal(receipt.status, ADOPTED_STATUS);
    assert.equal(receipt.environment, 'FairSwapProd');
    assert.equal(receipt.projectRef, REFS.FairSwapProd);
    assert.equal(receipt.candidateId, AF);
    assert.deepEqual(receipt.priorRuns, []);
    assert.deepEqual(receipt.dryRunPending, []);
    assert.equal(receipt.webStagingSha, null);
    assert.equal(receipt.adoption.installedByThisWorkflow, false);
    assert.equal(receipt.adoption.originalReleaseRun, null);
    assert.equal(receipt.adoption.observedState, 'activated');
    assert.deepEqual(receipt.adoption.entries.map(e => [e.role, e.ledgerVersion, e.ledgerName, e.statementCount, e.ledgerStatementsSha256, e.sourceSha256, e.matchesReviewedSource]), [
      ['foundation', '20261102164135', 'accessories_v1', 58, OBSERVED.foundation, getCandidate(AF).sha256, true],
      ['activation', '20261102164137', 'activate_accessories_v1', 1, OBSERVED.activation, getCandidate(AA).sha256, true]
    ]);
    // run-time provenance: the activation entry carries the digest READ from the hosted ledger and it equals the reviewed source
    assert.equal(receipt.adoption.entries[1].storedSqlSha256, STORED_SQL);
    assert.equal(receipt.adoption.entries[1].storedSqlSha256, receipt.adoption.entries[1].sourceSha256);
    assert.equal(receipt.adoption.entries[0].storedSqlSha256, null);
    assert.ok(calls.length >= 6);
    assert.deepEqual(receipt.adoption, adoptionAttestation(getAdoption(AF, 'FairSwapProd')));
    const body = readFileSync(join(dir, `${AF}-fairswapprod.json`), 'utf8');
    assert.equal(readFileSync(join(dir, 'SHA256SUMS_fairswapprod'), 'utf8'), `${createHash('sha256').update(body).digest('hex')}  ${AF}-fairswapprod.json\n`);
    assert.doesNotMatch(body, /APPLIED_CLI|"originalReleaseRun": "/);
    const name = `${AF}-fairswapprod.json`;
    const files = new Map([[name, Buffer.from(body)], ['SHA256SUMS_fairswapprod', Buffer.from(`${createHash('sha256').update(body).digest('hex')}  ${name}\n`)]]);
    assert.equal(validateCrossCommitReceipt('50', xRun(), files).status, ADOPTED_STATUS);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('adoption rejects disabled, foundation-only, partial, missing, tampered and drifted installations', async () => {
  const noRow = version => activatedLedger().filter(r => r.version !== version);
  const withRow = row => [...activatedLedger(), row];
  const tamper = (version, over) => activatedLedger().map(r => (r.version === version ? {...r, ...over} : r));
  // disabled / foundation-only / partial / missing
  await adoptFailing({post: {...goodPost('activation'), release_state: false, category_state: false, catalogue_rpc: false}}, /POSTFLIGHT_VERIFICATION_FAILED/);
  await adoptFailing({ledger: noRow('20261102164137')}, /ADOPTION_LEDGER_ENTRY_MISSING/);
  await adoptFailing({ledger: noRow('20261102164135')}, /ADOPTION_LEDGER_ENTRY_MISSING/);
  await adoptFailing({ledger: noRow('20261102164135').filter(r => r.version !== '20261102164137')}, /ADOPTION_LEDGER_ENTRY_MISSING/);
  await adoptFailing({ledger: historyRows()}, /ADOPTION_LEDGER_ENTRY_MISSING/);
  await adoptFailing({ledger: activatedLedger().slice(-10)}, /ADOPTION_UNEXPECTED_HISTORY_COUNT/);
  // tampered digests, names, statements, counts
  for (const version of ['20261102164135', '20261102164137']) {
    await adoptFailing({ledger: tamper(version, {statementsSha256: 'f'.repeat(64)})}, /ADOPTION_STATEMENTS_HASH_MISMATCH/);
    await adoptFailing({ledger: tamper(version, {statementsSha256: version === '20261102164135' ? OBSERVED.activation : OBSERVED.foundation})}, /ADOPTION_STATEMENTS_HASH_MISMATCH/);
    await adoptFailing({ledger: tamper(version, {name: 'renamed'})}, /ADOPTION_LEDGER_ENTRY_MISMATCH/);
    await adoptFailing({ledger: tamper(version, {hasStatements: false})}, /ADOPTION_LEDGER_ENTRY_MISMATCH/);
  }
  // a 7-statement (CLI-split) activation row is a different installation from the observed single stored statement
  await adoptFailing({ledger: tamper('20261102164137', {statementsSha256: '74b17db9c649efdc9b7208fd4e077c0e664b1cc269099efc11924013cff3aeff'})}, /ADOPTION_STATEMENTS_HASH_MISMATCH/);
  await adoptFailing({counts: {'20261102164135': 57, '20261102164137': 1}}, /ADOPTION_STATEMENT_COUNT_MISMATCH/);
  await adoptFailing({counts: {'20261102164135': 58, '20261102164137': 7}}, /ADOPTION_STATEMENT_COUNT_MISMATCH/);
  await adoptFailing({counts: {'20261102164135': 58, '20261102164137': 0}}, /ADOPTION_STATEMENT_COUNT_MISMATCH/);
  await adoptFailing({counts: {'20261102164135': 58, '20261102164137': 'NaN'}}, /ADOPTION_STATEMENT_COUNT_MISMATCH/);
  // stored SQL text provenance is verified at run time against the pin AND the reviewed source file
  await adoptFailing({storedSql: {'20261102164137': 'f'.repeat(64)}}, /ADOPTION_STORED_SQL_HASH_MISMATCH/);
  await adoptFailing({storedSql: {'20261102164137': '74b17db9c649efdc9b7208fd4e077c0e664b1cc269099efc11924013cff3aeff'}}, /ADOPTION_STORED_SQL_HASH_MISMATCH/);
  await adoptFailing({storedSql: {'20261102164137': ''}}, /ADOPTION_STORED_SQL_HASH_MISMATCH/);
  await adoptFailing({storedSql: {'20261102164137': STORED_SQL.toUpperCase()}}, /ADOPTION_STORED_SQL_HASH_MISMATCH/);
  // later chain stages recorded
  for (const version of ['20261104120000', '20261104120100']) {
    await adoptFailing({ledger: withRow({version, name: 'later', ...hist('a'.repeat(64))})}, /ADOPTION_LATER_STAGE_RECORDED/);
  }
  // installed-state drift in every class the active postflight covers
  for (const key of postflightKeys('activation')) {
    await adoptFailing({post: {...goodPost('activation'), [key]: false}}, /POSTFLIGHT_VERIFICATION_FAILED/);
  }
  await adoptFailing({post: {...goodPost('activation'), surprise: true}}, /POSTFLIGHT_VERIFICATION_FAILED/);
  await adoptFailing({post: (() => { const p = goodPost('activation'); delete p.rls_policies; return p; })()}, /POSTFLIGHT_VERIFICATION_FAILED/);
  await adoptFailing({changeAfter: true}, /ADOPTION_LEDGER_CHANGED/);
});

test('adoption exception is not broadened to other candidates, environments or credentials', async () => {
  await adoptFailing({}, /ADOPTION_ENVIRONMENT_NOT_ALLOWED/, {environment: 'FairSwapTest'});
  await adoptFailing({}, /ADOPTION_ENVIRONMENT_NOT_ALLOWED/, {environment: 'Other'});
  for (const candidateId of [AA, 'tablets-v1-foundation', WF, WA, 'moderation-analytics-v1']) {
    await adoptFailing({}, /ADOPTION_NOT_REGISTERED/, {candidateId});
  }
  await adoptFailing({}, /MISSING_CREDENTIALS/, {context: {...adoptCtx, CHAT_DATABASE_PASSWORD: ''}});
  await adoptFailing({}, /INVALID_POOLER_HOST/, {context: {...adoptCtx, CHAT_DB_POOLER_HOST: 'evil.example.com'}});
  // adoption never grants same-commit evidence: the normal evidence path still rejects an adoption receipt
  const body = JSON.stringify({...receiptFor(AF, 'prod', '50', {reviewedCommit: SHA_C}), status: ADOPTED_STATUS}, null, 2) + '\n';
  const name = `${AF}-fairswapprod.json`;
  const zip = makeZip({[name]: body, SHA256SUMS_fairswapprod: `${createHash('sha256').update(body).digest('hex')}  ${name}\n`});
  await assert.rejects(requireStageEvidence([{key: 'prod_foundation_run_id', runId: '50', candidateId: AF, environment: 'prod'}], ctx,
    evidenceFetcher({runId: '50', candidateId: AF, env: 'prod', zip})), /RECEIPT_CONTENT_INVALID/);
});

test('Wearables Production accepts an adoption receipt only when it matches the registry attestation exactly', async () => {
  const plan = wPlan(WF, 'production');
  const expected = adoptionAttestation(getAdoption(AF, 'FairSwapProd'));
  const good = {
    environment: 'FairSwapProd', projectRef: REFS.FairSwapProd, candidateId: AF, migrationVersion: getCandidate(AF).version, migrationFile: getCandidate(AF).filename,
    migrationSha256: getCandidate(AF).sha256, reviewedCommit: A40, releaseWorkflowRun: '50', status: ADOPTED_STATUS, dryRunPending: [], postflightVerified: true,
    stage: 'foundation', webStagingSha: null, webProductionSha: null, priorRuns: [], adoption: expected
  };
  const fetcher = (receipt, o = {}) => {
    const art = `https://api.github.com/repos/${GH}/actions/artifacts/9/zip`;
    const body = JSON.stringify(receipt, null, 2) + '\n';
    const name = `${AF}-fairswapprod.json`;
    const zip = makeZip({[name]: body, SHA256SUMS_fairswapprod: `${createHash('sha256').update(body).digest('hex')}  ${name}\n`});
    const base = `https://api.github.com/repos/${GH}/actions/runs`;
    const ok = json => ({ok: true, status: 200, json: async () => json});
    return async u => {
      if (u === art) return {ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length)};
      if (u === `${base}/50`) return ok(xRun(o.run));
      if (u === `${base}/50/artifacts?per_page=100`) return ok({artifacts: [{name: 'reusable-prod-accessories-v1-foundation-50-1', expired: false, workflow_run: {id: 50}, archive_download_url: art}]});
      if (u === `https://api.github.com/repos/${GH}/compare/${A40}...${C40}`) return ok({status: 'ahead'});
      throw new Error(`unexpected ${u}`);
    };
  };
  assert.equal((await requirePriorCommitEvidence(plan, xCtx, fetcher(good))).accessories_prod_foundation_run_id.basis, 'adopted-existing-installation');
  const bad = (over, re = /CROSS_COMMIT_RECEIPT_INVALID/) => assert.rejects(requirePriorCommitEvidence(plan, xCtx, fetcher({...good, ...over})), re);
  const block = over => ({adoption: {...expected, ...over}});
  const entry = (i, over) => ({adoption: {...expected, entries: expected.entries.map((e, n) => (n === i ? {...e, ...over} : e))}});
  await bad(block({installedByThisWorkflow: true}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(block({originalReleaseRun: '41495160097'}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(block({observedState: 'foundation'}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(block({entries: expected.entries.slice(0, 1)}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(block({entries: [...expected.entries].reverse()}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(0, {ledgerStatementsSha256: 'f'.repeat(64)}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(1, {ledgerStatementsSha256: 'f'.repeat(64)}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(1, {statementCount: 7}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(1, {storedSqlSha256: 'f'.repeat(64)}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(1, {storedSqlSha256: null}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(1, {reviewedSourceStatementsSha256: '74b17db9c649efdc9b7208fd4e077c0e664b1cc269099efc11924013cff3aeff'}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(1, {matchesReviewedSource: false}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(entry(0, {sourceSha256: 'f'.repeat(64)}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad(block({extra: 'claim'}), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad({adoption: undefined}, /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
  await bad({priorRuns: [{key: 'test_foundation_run_id', runId: '10'}]}, /CROSS_COMMIT_RECEIPT_INVALID.*chain/);
  await bad({webStagingSha: ACCESSORIES_WEB.stagingSha}, /CROSS_COMMIT_RECEIPT_INVALID.*web/);
  await bad({environment: 'FairSwapTest', projectRef: REFS.FairSwapTest}, /CROSS_COMMIT_RECEIPT_INVALID.*environment/);
  await bad({migrationSha256: 'f'.repeat(64)}, /CROSS_COMMIT_RECEIPT_INVALID.*hash/);
  await bad({postflightVerified: false}, /CROSS_COMMIT_RECEIPT_INVALID.*postflight/);
  await bad({reviewedCommit: 'd'.repeat(40)}, /CROSS_COMMIT_RECEIPT_INVALID.*commit/);
  // a normal release receipt must not carry an adoption block
  await assert.rejects(requirePriorCommitEvidence(plan, xCtx, xFetcher({receipt: {adoption: expected}})), /CROSS_COMMIT_RECEIPT_INVALID.*adoption/);
});

test('workflow exposes adoption only as a protected, Accessories-foundation-only Production job step', () => {
  const yaml = readFileSync(join(process.cwd(), '.github/workflows/reusable-supabase-release.yml'), 'utf8');
  assert.ok(yaml.includes('- adopt'));
  assert.ok(yaml.includes("inputs.target == 'adopt' && inputs.candidate == 'accessories-v1-foundation' && needs.test.result == 'skipped'"));
  const prod = yaml.slice(yaml.indexOf('\n  production:'));
  assert.ok(prod.includes('environment: FairSwapProd'));
  assert.ok(prod.includes("TARGET: ${{ inputs.target }}"));
  assert.ok(prod.includes("process.env.TARGET === 'adopt'") && prod.includes('adoptExistingInstallation(options)'));
  const test = yaml.slice(yaml.indexOf('\n  test:'), yaml.indexOf('\n  verify_test:'));
  assert.ok(!test.includes('adopt'));
  assert.ok(/test:\n    needs: verify\n    if: .*inputs\.target == 'test'/.test(yaml));
});

// ---- Tablets V2 catalogue --------------------------------------------------------------------
const TV2 = 'tablets-v2-catalogue';
const TV2_WEB = '2'.repeat(40);
const tv2Inputs = {test_catalogue_run_id:'90', web_staging_sha:TV2_WEB};
const tv2Plan = () => planDispatch({candidateId:TV2,target:'production',inputs:tv2Inputs});

test('Tablets V2 registers the reviewed catalogue and requires all installed V1 stages', () => {
  const candidate = verifyCandidateSha(TV2).candidate;
  assert.equal(candidate.version,'20261104215253');
  assert.equal(candidate.sha256,'42bcab058e68e5cb4352a92212f4bbe836cf2ae28626950cf54574c57508ed95');
  assert.equal(candidate.autoPromote,false);
  assert.equal(candidate.stage,'catalogue');
  assert.equal(candidate.strict,true);
  for(const version of candidate.requiredLedgerVersions) {
    assert.throws(()=>assertLedgerOrdering(candidate,ledger(candidate.requiredLedgerVersions.filter(v=>v!==version))),/PREREQUISITE_MIGRATION_MISSING/);
  }
  assert.equal(assertLedgerOrdering(candidate,ledger(candidate.requiredLedgerVersions)).state,'absent');
  assert.throws(()=>planDispatch({candidateId:TV2,target:'adopt'}),/ADOPTION_NOT_REGISTERED/);
});

test('Tablets V2 Production cannot be planned without a Test catalogue run and reviewed staging SHA', () => {
  const plan=tv2Plan();
  assert.deepEqual(plan.priorRuns,[{key:'test_catalogue_run_id',runId:'90',candidateId:TV2,environment:'test'}]);
  assert.equal(plan.webStagingSha,TV2_WEB);
  assert.equal(plan.webProductionSha,null);
  const testPlan=planDispatch({candidateId:TV2,target:'test'});
  assert.deepEqual(testPlan.priorRuns,[]);
  assert.equal(testPlan.webStagingSha,null);
  for(const inputs of [{},{...tv2Inputs,test_catalogue_run_id:''},{...tv2Inputs,web_staging_sha:''},{...tv2Inputs,web_staging_sha:'unreviewed'}]) {
    assert.throws(()=>planDispatch({candidateId:TV2,target:'production',inputs}),/EVIDENCE_RUN_REQUIRED|WEB_STAGING_VERIFICATION_REQUIRED/);
  }
});

const tv2Before={active:true,intact:true,v1_catalogue:true,references:{brands:[{id:'old-brand',name:'Apple'}],models:[{id:'old-model',brand_id:'old-brand',name:'iPad'}]},metadata:{functions:'stable',tables:'stable'}};
const tv2Post=()=>({...tv2Before,catalogue:true,fallbacks:true,indexes:true,functions:true,v1_catalogue:undefined});
const tv2Response=sql=>sql.includes("'v1_catalogue', (") ? tv2Before : tv2Post();

test('Tablets V2 preflight and postflight fail closed on catalogue, reference and security drift', async () => {
  const {runTabletsV2Preflight,runTabletsV2Postflight}=await import('../../scripts/release/tablets-v2-release.mjs');
  const execute=state=>sql=>{
    assert.match(sql,/^BEGIN READ ONLY;/);
    return JSON.stringify(Object.fromEntries(Object.keys(tv2Response(sql)).filter(key=>tv2Response(sql)[key]!==undefined).map(key=>[key,state[key]])));
  };
  assert.deepEqual(runTabletsV2Preflight(execute(tv2Before)),tv2Before);
  assert.deepEqual(runTabletsV2Postflight(tv2Before,execute(tv2Post())),{verified:true});
  for(const key of ['active','intact','v1_catalogue'])assert.throws(()=>runTabletsV2Preflight(execute({...tv2Before,[key]:false})),/PREFLIGHT_FAILED/);
  for(const key of ['active','intact','catalogue','fallbacks','indexes','functions'])assert.throws(()=>runTabletsV2Postflight(tv2Before,execute({...tv2Post(),[key]:false})),/POSTFLIGHT_FAILED/);
  for(const state of [{...tv2Post(),metadata:{changed:true}},{...tv2Post(),references:{brands:[],models:[]}}]) {
    assert.throws(()=>runTabletsV2Postflight(tv2Before,execute(state)),/EXISTING_CONTRACT_CHANGED/);
  }
  assert.throws(()=>runTabletsV2Postflight(undefined,execute(tv2Post())),/PREFLIGHT_REQUIRED/);
  assert.throws(()=>runTabletsV2Preflight(()=>'{}'),/INVALID_RESPONSE/);
});

function tv2WebFetcher(over={}) {
  const sha=TV2_WEB,repository=ACCESSORIES_WEB.repository;
  return async url=>{
    let data;
    if(url.includes('/deployments?'))data=[{id:100,sha,environment:'Preview',created_at:'2026-11-05T01:00:00Z',...over.deployment}];
    else if(url.includes('/statuses?'))data=[{state:over.state??'success'}];
    else if(url.includes('/actions/runs?'))data={workflow_runs:[{id:110,head_sha:sha,head_branch:'staging',head_repository:{full_name:repository},path:'.github/workflows/ci.yml',event:'push',status:'completed',conclusion:'success',...over.run}]};
    else throw Error('Unexpected Web evidence query');
    return {ok:true,status:200,json:async()=>data};
  };
}

test('Tablets V2 Production requires successful staging CI and a READY deployment after Test', async()=>{
  const {verifyTabletsV2Web}=await import('../../scripts/release/tablets-v2-release.mjs');
  const context={WEB_EVIDENCE_TOKEN:'mock'},receipt={timestamp:'2026-11-05T00:00:00Z'};
  assert.deepEqual(await verifyTabletsV2Web(tv2Plan(),context,tv2WebFetcher(),receipt),{stagingDeploymentId:100,stagingCiRunId:110});
  for(const over of [{state:'failure'},{deployment:{environment:'Production'}},{deployment:{sha:'3'.repeat(40)}},{run:{conclusion:'failure'}},{run:{head_branch:'main'}},{run:{path:'.github/workflows/other.yml'}},{run:{head_sha:'3'.repeat(40)}},{run:{head_repository:{full_name:'fork/Web'}}},{deployment:{created_at:'2026-11-04T00:00:00Z'}}]) {
    await assert.rejects(verifyTabletsV2Web(tv2Plan(),context,tv2WebFetcher(over),receipt),/STAGING/);
  }
  await assert.rejects(verifyTabletsV2Web(tv2Plan(),{},tv2WebFetcher(),receipt),/WEB_EVIDENCE_UNAVAILABLE/);
  await assert.rejects(verifyTabletsV2Web(tv2Plan(),context,tv2WebFetcher(),{}),/STAGING_MUST_FOLLOW_TEST/);
});

const tv2Ledger=candidate=>{
  const names=Object.fromEntries(Object.values(CANDIDATES).map(c=>[c.version,c.filename.slice(15,-4)]));
  return version=>({version,name:names[version]??'historical',hasStatements:true,statementsSha256:'a'.repeat(64)});
};
function tv2Mock(change) {
  const candidate=getCandidate(TV2),before=[...baseHistory,...candidate.requiredLedgerVersions],after=[...before,candidate.version];
  let reads=0;
  return {before,after,sql:sql=>{
    if(sql.includes('supabase_migrations.schema_migrations')) {
      const rows=(++reads<3?before:after).map(tv2Ledger(candidate));
      if(change==='history'&&reads===2)rows[0].statementsSha256='b'.repeat(64);
      return rows;
    }
    const state=tv2Response(sql);
    if(change==='postflight'&&sql.includes("'catalogue', ("))state.catalogue=false;
    return state;
  }};
}

test('Tablets V2 Test release requires automated postflight before producing a hashed receipt',async()=>{
  const {receipt,dir}=await release(TV2,'FairSwapTest',{...tv2Mock(),env:{GITHUB_RUN_ID:'90',GITHUB_SHA:'a'.repeat(40)}});
  try{
    assert.equal(receipt.postflightVerified,true);
    assert.equal(receipt.stage,'catalogue');
    assert.equal(receipt.ledgerStatementsSha256,'a'.repeat(64));
    assert.equal(receipt.webStagingSha,null);
    assert.deepEqual(receipt.dryRunPending,[getCandidate(TV2).filename]);
    const name=`${TV2}-fairswaptest.json`;
    const files=new Map([[name,readFileSync(join(dir,name))],['SHA256SUMS_fairswaptest',readFileSync(join(dir,'SHA256SUMS_fairswaptest'))]]);
    const proof=tv2Plan().priorRuns[0];
    assert.equal(validateReceipt(proof,{...baseEnv,GITHUB_SHA:receipt.reviewedCommit},files).candidateId,TV2);
  }finally{rmSync(dir,{recursive:true,force:true});}
  for(const change of ['history','postflight']){
    const dir=mkdtempSync(join(tmpdir(),'tv2-fail-'));
    try{
      const runner=makeRunner({...tv2Mock(change),filename:getCandidate(TV2).filename});
      await assert.rejects(releaseReusable({environment:'FairSwapTest',candidateId:TV2,context:baseEnv,runner,receiptDir:dir}),/TABLETS_LEDGER_CHANGED|POSTFLIGHT_FAILED/);
      assert.deepEqual(readdirSync(dir),[]);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});

test('Tablets V2 executable Production boundary rejects unverified Test evidence before tools run',async()=>{
  const calls=[];
  const context={...baseEnv,TEST_CATALOGUE_RUN_ID:'90',WEB_STAGING_SHA:TV2_WEB,TABLETS_CANDIDATE_LEDGER_SHA:'a'.repeat(64),GITHUB_TOKEN:'mock',WEB_EVIDENCE_TOKEN:'mock'};
  await assert.rejects(releaseReusable({environment:'FairSwapProd',candidateId:TV2,context,runner:()=>calls.push('tool'),fetcher:async()=>({ok:true,json:async()=>({status:'completed',conclusion:'failure'})})}),/EVIDENCE_RUN_NOT_VERIFIED/);
  assert.deepEqual(calls,[]);
});

test('Tablets V2 workflow exposes a separate Test run, carries its ledger hash, and preserves automatic postflight',()=>{
  const yaml=readFileSync('.github/workflows/reusable-supabase-release.yml','utf8');
  assert.match(yaml,/\n          - tablets-v2-catalogue\n/);
  assert.match(yaml,/test_catalogue_run_id:/);
  assert.equal((yaml.match(/test_catalogue_run_id: e.TEST_CATALOGUE_RUN_ID/g)??[]).length,3);
  assert.equal((yaml.match(/await verifyTabletsV2Web\(plan, e\)/g)??[]).length,2);
  assert.ok(yaml.includes('receipts[`test_${stage}_run_id`]'));
  assert.ok(yaml.includes('candidate_ledger_sha=${testCandidate.ledgerStatementsSha256}'));
});

test('real PostgreSQL: Tablets V2 migration passes the release postflight and preserves its V1 contracts',
 {skip:pgBin?false:'no local PostgreSQL binaries; enforced when REQUIRE_REAL_PG=1'},async()=>{
  const {runTabletsV2Preflight,runTabletsV2Postflight}=await import('../../scripts/release/tablets-v2-release.mjs');
  const {installPostingFixture}=await import('../../scripts/ci/posting-v2-fixture.mjs');
  const pg=startPg(pgBin);
  try{
    await installPostingFixture({exec:async sql=>pg.run(sql)});
    for(const path of [
      'posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql',
      'posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql',
      getCandidate('accessories-v1-foundation').path.replace('supabase/forward-migrations/',''),
      getCandidate('accessories-v1-activation').path.replace('supabase/forward-migrations/',''),
      getCandidate('tablets-v1-foundation').path.replace('supabase/forward-migrations/',''),
      getCandidate('tablets-v1-activation').path.replace('supabase/forward-migrations/','')
    ])pg.run(readFileSync(join('supabase/forward-migrations',path),'utf8'));
    const before=runTabletsV2Preflight(pg.run);
    pg.run(readFileSync(getCandidate(TV2).path,'utf8'));
    assert.deepEqual(runTabletsV2Postflight(before,pg.run),{verified:true});
    pg.run("update public.tablet_brands_v1 set name='Wrong' where name='Apple'");
    assert.throws(()=>runTabletsV2Postflight(before,pg.run),/EXISTING_CONTRACT_CHANGED/);
  }finally{pg.stop();}
 });

function tv2ProductionEvidence(over={}) {
  const runId='90';
  const record=receiptFor(TV2,'test',runId,{ledgerStatementsSha256:'a'.repeat(64),priorRuns:[],webStagingSha:null,...over.receipt});
  const name=`${TV2}-fairswaptest.json`,body=JSON.stringify(record,null,2)+'\n';
  const zip=makeZip({[name]:body,SHA256SUMS_fairswaptest:`${createHash('sha256').update(body).digest('hex')}  ${name}\n`});
  const url=`https://api.github.com/repos/${GH}/actions/artifacts/9/zip`;
  const run={...goodRun,id:90,workflow_id:404601811,head_repository:{full_name:GH},actor:{login:'vivek2310sharma'},triggering_actor:{login:'vivek2310sharma'},run_attempt:1,...over.run};
  const art=[{id:9,name:`reusable-test-${TV2}-90-1`,expired:false,workflow_run:{id:90,head_sha:SHA_C},digest:`sha256:${createHash('sha256').update(zip).digest('hex')}`,archive_download_url:url,...over.artifact}];
  const fetchEvidence=evidenceFetcher({run,runId,candidateId:TV2,env:'test',zip,art});
  const fetchWeb=tv2WebFetcher(over.web);
  return url=>url.includes(`/repos/${ACCESSORIES_WEB.repository}/`)?fetchWeb(url):fetchEvidence(url);
}

test('Tablets V2 Production rechecks immutable Test and staging evidence before applying and binds the ledger digest',async()=>{
  const candidate=getCandidate(TV2),dir=mkdtempSync(join(tmpdir(),'tv2-prod-'));
  const context={...baseEnv,...ctx,TEST_CATALOGUE_RUN_ID:'90',WEB_STAGING_SHA:TV2_WEB,TABLETS_CANDIDATE_LEDGER_SHA:'a'.repeat(64),WEB_EVIDENCE_TOKEN:'mock'};
  try{
    const runner=makeRunner({...tv2Mock(),filename:candidate.filename});
    const receipt=await releaseReusable({environment:'FairSwapProd',candidateId:TV2,context,runner,receiptDir:dir,fetcher:tv2ProductionEvidence()});
    assert.equal(receipt.postflightVerified,true);
    assert.equal(receipt.ledgerStatementsSha256,'a'.repeat(64));
    assert.equal(receipt.webStagingSha,TV2_WEB);
    assert.deepEqual(receipt.webStagingEvidence,{stagingDeploymentId:100,stagingCiRunId:110});
    assert.deepEqual(receipt.priorRuns,[{key:'test_catalogue_run_id',runId:'90'}]);
  }finally{rmSync(dir,{recursive:true,force:true});}
  for(const over of [
    {receipt:{postflightVerified:false}},{receipt:{ledgerStatementsSha256:'b'.repeat(64)}},
    {receipt:{migrationSha256:'b'.repeat(64)}},{receipt:{candidateId:'tablets-v1-foundation'}},
    {run:{head_sha:'b'.repeat(40)}},{run:{run_attempt:2}},{run:{conclusion:'failure'}},
    {artifact:{digest:'sha256:'+'b'.repeat(64)}},{artifact:{expired:true}},
    {web:{run:{conclusion:'failure'}}},{web:{deployment:{created_at:'2026-11-02T00:00:00Z'}}}
  ]){
    let tools=0;
    await assert.rejects(releaseReusable({environment:'FairSwapProd',candidateId:TV2,context,runner:()=>{tools++;},fetcher:tv2ProductionEvidence(over)}),/EVIDENCE|RECEIPT|STAGING/);
    assert.equal(tools,0);
  }
});

// ---- Accessories read-only adoption in the known post-Tablets state ----------------------------------------------------

test('post-Tablets adoption succeeds, runs the active Tablets postflight and exempts only the two obsolete wrapper assertions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-adopt-'));
  try {
    const calls = [];
    const runner = adoptionRunner({ledger: postTabletsLedger(), post: postTabletsPost(), calls});
    const receipt = await adoptExistingInstallation({environment: 'FairSwapProd', candidateId: AF, context: adoptCtx, runner, receiptDir: dir});
    assert.equal(receipt.adoption.kind, 'existing-installation');
    assert.equal(receipt.postflightVerified, true);
    assert.ok(calls.every(c => c === 'psql'));
    // the pre-Tablets state is still accepted unchanged
    await adoptExistingInstallation({environment: 'FairSwapProd', candidateId: AF, context: adoptCtx, runner: adoptionRunner(), receiptDir: dir});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('post-Tablets adoption stays strict: partial/renamed Tablets rows, Tablets postflight drift, Wearables and any other Accessories drift all fail', async () => {
  const ok = postTabletsPost();
  const tl = postTabletsLedger;
  // partial Tablets pair or mismatched rows
  await adoptFailing({ledger: [...activatedLedger(), tabletsFoundationRow()], post: ok}, /ADOPTION_TABLETS_LEDGER_MISMATCH/);
  await adoptFailing({ledger: [...activatedLedger(), tabletsActivationRow()], post: ok}, /ADOPTION_TABLETS_LEDGER_MISMATCH/);
  await adoptFailing({ledger: [...activatedLedger(), tabletsFoundationRow({name: 'renamed'}), tabletsActivationRow()], post: ok}, /ADOPTION_TABLETS_LEDGER_MISMATCH/);
  await adoptFailing({ledger: [...activatedLedger(), tabletsFoundationRow(), tabletsActivationRow({hasStatements: false})], post: ok}, /ADOPTION_TABLETS_LEDGER_MISMATCH/);
  // Tablets security postflight drift
  for (const key of Object.keys(TABLETS_GOOD)) {
    await adoptFailing({ledger: tl(), post: ok, tabletsPost: {...TABLETS_GOOD, [key]: false}}, /TABLETS_POSTFLIGHT_FAILED/);
  }
  // already-installed Wearables migrations are still rejected, with or without Tablets
  for (const version of ['20261104120000', '20261104120100']) {
    await adoptFailing({ledger: [...tl(), {version, name: 'w', ...hist('a'.repeat(64))}], post: ok}, /ADOPTION_LATER_STAGE_RECORDED/);
  }
  // every non-exempt Accessories assertion is still enforced in the post-Tablets path
  for (const key of postflightKeys('activation').filter(k => !EXEMPT.includes(k))) {
    await adoptFailing({ledger: tl(), post: {...ok, [key]: false}}, /POSTFLIGHT_VERIFICATION_FAILED/);
  }
  await adoptFailing({ledger: tl(), post: {...ok, surprise: true}}, /POSTFLIGHT_VERIFICATION_FAILED/);
  await adoptFailing({ledger: tl(), post: (() => { const p = {...ok}; delete p.mobile_wrappers_extended; return p; })()}, /POSTFLIGHT_VERIFICATION_FAILED/);
  // existing provenance checks still apply
  await adoptFailing({ledger: tl().map(r => (r.version === '20261102164137' ? {...r, statementsSha256: 'f'.repeat(64)} : r)), post: ok}, /ADOPTION_STATEMENTS_HASH_MISMATCH/);
  // without Tablets, the exemption is NOT granted
  await adoptFailing({post: ok}, /POSTFLIGHT_VERIFICATION_FAILED/);
});

test('the wrapper exemption is limited to the two named keys and is unavailable to other callers by default', () => {
  const f = getCandidate('accessories-v1-activation');
  const post = postTabletsPost();
  assert.throws(() => runAccessoriesPostflight(f, JSON.stringify(post)), /POSTFLIGHT_VERIFICATION_FAILED/);
  assert.doesNotThrow(() => runAccessoriesPostflight(f, JSON.stringify(post), {exemptKeys: EXEMPT}));
  assert.throws(() => runAccessoriesPostflight(f, JSON.stringify({...post, rls_forced: false}), {exemptKeys: EXEMPT}), /rls_forced/);
  assert.throws(() => runAccessoriesPostflight(f, JSON.stringify(post), {exemptKeys: ['rls_forced']}), /EXEMPTION_NOT_ALLOWED/);
});
