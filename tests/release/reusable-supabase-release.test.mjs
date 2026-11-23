import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {deflateRawSync, crc32 as zlibCrc32} from 'node:zlib';
import {join, resolve as resolvePath} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rootCertificates} from 'node:tls';
import {X509Certificate, createHash} from 'node:crypto';
import {getCandidate, verifyCandidateSha, CANDIDATES, MOBILE_CATALOGUE_CANDIDATE, LISTING_VALIDITY_CANDIDATE, V3_PRODUCTION_BATCH, V3_PRODUCTION_SEQUENCE, V3_IDENTITY_PREREQUISITE, planDispatch, ACCESSORIES_WEB, WEARABLES_WEB, WEARABLES_E2E_WAIVER, WEB_PINS, EXISTING_INSTALLATIONS, adoptionAttestation, getAdoption} from '../../scripts/release/reusable-candidates.mjs';
import {
  ADOPTED_STATUS, MOBILE_PHONES_HISTORY, WEARABLES_E2E, assertLedgerTail, assertMobilePhonesProvenance, requirePriorCommitEvidence, runWearablesPostflight,
  WEARABLES_ANCESTOR_EVIDENCE, WEARABLES_OUT_OF_ORDER, TABLETS_V2_LEDGER, MODERATION_SWITCHING_LEDGER, assertSwitchingPrerequisite, assertCliSupportsIncludeAll, runWearablesPreflight, validateCrossCommitReceipt, verifyE2eEvidence, wearablesPostflightChecks, AZURE_FINALIZER_BODY_SHA256, SWITCHING_FINALIZER_BODY_SHA256
} from '../../scripts/release/wearables-v1-release.mjs';
import {readTabletsLedger, verifyTabletsLedger} from '../../scripts/release/tablets-v1-release.mjs';
import {assertLedgerOrdering, assertPreflight, parseLedgerVersions, postflightKeys, postflightQuery, preflightEnabledQuery, preflightQuery, readZipEntries, recoveredFoundationSha, requireStageEvidence, runAccessoriesPostflight, runLivePreflight, validateReceipt, verifyAccessoriesLedger, verifyHistoryPreserved, verifyWebDeployments} from '../../scripts/release/accessories-v1-release.mjs';
import {adoptExistingInstallation, parsePendingDryRun, verifyLedgerVersion, verifyRemotePostflight, assertAccountSecurityEmailTail, releaseReusable, releaseV3ProductionBatch, subprocessFailure, REFS, readMobileCatalogueSnapshot, verifyMobileCataloguePostflight, verifyMobileCatalogueTestReceipt} from '../../scripts/release/reusable-supabase-release.mjs';
import {
  IDV_DIGILOCKER_CANDIDATE, IDV_DIGILOCKER_FUNCTIONS, IDV_DIGILOCKER_POSTFLIGHT, IDV_DIGILOCKER_PREFLIGHT, IDV_DIGILOCKER_SCOPE, IDV_DIGILOCKER_TAIL,
  IDV_DIGILOCKER_PRODUCTION_TAIL, idvDigilockerTail,
  IDV_FOUNDATION_LEDGER, assertIdvDigilockerLedger, snapshotSql as idvSnapshotSql, verifyIdvDigilockerTestReceipt,
  IDV_DIGILOCKER_INSTALLED, IDV_DIGILOCKER_INSTALLED_SCOPE, IDV_DIGILOCKER_V2_CANDIDATE, IDV_DIGILOCKER_V2_FUNCTIONS, IDV_DIGILOCKER_V2_POSTFLIGHT,
  IDV_DIGILOCKER_V2_PREFLIGHT, IDV_DIGILOCKER_V2_SCOPE, assertIdvDigilockerTestInstalled, idvDigilockerV2SnapshotSql,
  IDV_DIGILOCKER_PRODUCTION_PREFLIGHT, IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT, idvDigilockerInstalledChecks
} from '../../scripts/release/idv-digilocker-v1-release.mjs';

import {verifyV3ProductionEvidence, v3ProductionState} from '../../scripts/release/v3-production-evidence.mjs';
import {setupOrdinaryGoodsFixture} from '../ordinary-goods/fixture.mjs';

test('Account Security Email V2 candidate pins its exact migration and Test-to-Production plan', () => {
  const candidate = getCandidate('account-security-email-v2');
  assert.equal(candidate.version, '20261122213000');
  assert.equal(candidate.filename, '20261122213000_account_security_digilocker_email_outbox.sql');
  assert.equal(verifyCandidateSha(candidate.id).sha256, 'fd22fbe3ee453b70dc99436a4cabe984705141001cfe927ece2e682a0e752bd6');
  assert.equal(candidate.autoPromote, true);
  assert.equal(candidate.accountSecurityEmail, true);
  assert.equal(planDispatch({candidateId:candidate.id,target:'test'}).priorRuns.length, 0);
  assert.equal(planDispatch({candidateId:candidate.id,target:'production'}).target, 'production');
  assert.throws(() => planDispatch({candidateId:candidate.id,target:'adopt'}), /ACCOUNT_SECURITY_EMAIL_ADOPTION_FORBIDDEN/);
});

test('Account Security Email V2 accepts only immutable, later V3 ledger row in Test and Production', () => {
  const candidate = getCandidate('account-security-email-v2');
  const prior = {version:'20261120000000',name:'google_cloud_moderation_v1',
    hasStatements:true,statementCount:1,statementsSha256:'0'.repeat(64)};
  const ahead = {version:'20261122213157',name:'v3_provider_neutral_activation',
    hasStatements:true,statementCount:9,
    statementsSha256:'0d9b556c102a7a5ce57c72d7009a73bfa3fb510c3185d40a3a2b18dcea2a8853'};
  const ledger = [prior, ahead];
  const remote = new Set(ledger.map(row => row.version));
  assert.deepEqual(assertAccountSecurityEmailTail(candidate, ledger, remote),
    {includeAll:true, ahead:['20261122213157']});
  for (const altered of [
    {...ahead, version:'20261122213158'},
    {...ahead, name:'different_migration'},
    {...ahead, hasStatements:false},
    {...ahead, statementCount:8},
    {...ahead, statementsSha256:'1'.repeat(64)}
  ]) {
    assert.throws(() => assertAccountSecurityEmailTail(candidate,[prior,altered],
      new Set([prior.version, altered.version])), /ACCOUNT_SECURITY_EMAIL_UNEXPECTED_LEDGER_TAIL/);
  }
  assert.throws(() => assertAccountSecurityEmailTail(candidate,ledger,new Set([prior.version])),
    /ACCOUNT_SECURITY_EMAIL_UNEXPECTED_LEDGER_TAIL/);
  assert.throws(() => assertAccountSecurityEmailTail(candidate,
    [...ledger,{...ahead,version:'20261122213159'}],new Set([prior.version,ahead.version,'20261122213159'])),
    /ACCOUNT_SECURITY_EMAIL_UNEXPECTED_LEDGER_TAIL/);
  assert.throws(() => assertAccountSecurityEmailTail(candidate,[prior],new Set([prior.version])),
    /ACCOUNT_SECURITY_EMAIL_UNEXPECTED_LEDGER_TAIL/);
});

test('Account Security Email V2 postflight rejects failed authorization, trigger or history checks', async () => {
  const healthy = {
    queue_rls:true, clients_denied:true, service_can_claim:true,
    confirmation_trigger:true, rpc_permissions:true, legacy_queue:true,
    scheduler:true, migration_record:true, event_integrity:true
  };
  const runner = (_cmd,args) => {
    assert.ok(args.at(-1).includes('trg_auth_user_signup_security_email'));
    return JSON.stringify(healthy);
  };
  const verified = await verifyRemotePostflight('FairSwapTest','account-security-email-v2','postgresql://local',{},runner);
  assert.equal(verified.status,'PASS');
  for (const key of Object.keys(healthy)) {
    const broken = {...healthy,[key]:false};
    await assert.rejects(
      verifyRemotePostflight('FairSwapTest','account-security-email-v2','postgresql://local',{},() => JSON.stringify(broken)),
      /ACCOUNT_SECURITY_EMAIL_POSTFLIGHT_FAILED/
    );
  }
  await assert.rejects(
    verifyRemotePostflight('FairSwapTest','account-security-email-v2','postgresql://local',{},() => 'not json'),
    /ACCOUNT_SECURITY_EMAIL_POSTFLIGHT_UNREADABLE/
  );
});

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

test('candidate registry correctly registers moderation-google-cloud-v1', () => {
  const c = getCandidate('moderation-google-cloud-v1');
  assert.equal(c.version, '20261120000000');
  assert.equal(c.filename, '20261120000000_google_cloud_moderation_v1.sql');
  assert.equal(c.sha256, 'f4b8ea81c84c3f9addb2283a4d4757e517238698e8a1d407b7d3bacf2e6c09d1');
  assert.equal(c.autoPromote, true);
});

test('Google Cloud moderation candidate SHA matches the verified forward migration', () => {
  const c = verifyCandidateSha('moderation-google-cloud-v1');
  assert.equal(c.sha256, 'f4b8ea81c84c3f9addb2283a4d4757e517238698e8a1d407b7d3bacf2e6c09d1');
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

test('Google Cloud moderation postflight query is evaluated for moderation-google-cloud-v1 candidate', async () => {
  const {verifyRemotePostflight} = await import('../../scripts/release/reusable-supabase-release.mjs');
  const validCheck = {
    system_settings_google_exists: true,
    system_settings_azure_exists: true,
    system_settings_automation_exists: true,
    registrar_search_path: true,
    finalizer_search_path: true,
    registrar_service_role: true,
    finalizer_service_role: true,
    finalizer_contains_google_cloud_logic: true,
    scan_receipts_table_rls: true,
    verified_hashes_table_rls: true,
    migration_version_applied: true
  };

  const mockRunner = (cmd, args) => {
    if (cmd === 'psql') {
      return JSON.stringify(validCheck);
    }
    return '';
  };

  const res = await verifyRemotePostflight('FairSwapTest', 'moderation-google-cloud-v1', 'postgres://mock', {}, mockRunner);
  assert.equal(res.system_settings_google_exists, true);
  assert.equal(res.finalizer_contains_google_cloud_logic, true);
  assert.equal(res.scan_receipts_table_rls, true);
  assert.equal(res.migration_version_applied, true);

  // Negative tests: fails closed on missing/false checks
  for (const key of Object.keys(validCheck)) {
    const badCheck = {...validCheck, [key]: false};
    const badRunner = (cmd, args) => (cmd === 'psql' ? JSON.stringify(badCheck) : '');
    await assert.rejects(
      () => verifyRemotePostflight('FairSwapTest', 'moderation-google-cloud-v1', 'postgres://mock', {}, badRunner),
      /REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED/
    );
  }
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

test('Google Cloud moderation candidate is correctly sequenced after all installed Test and Production migrations', () => {
  const google = getCandidate('moderation-google-cloud-v1');
  const idvV2 = getCandidate('idv-digilocker-oidc-v2');
  const listingValidity = getCandidate(LISTING_VALIDITY_CANDIDATE);

  assert(BigInt(google.version) > BigInt('20261119200000'), 'Google Cloud V1 version must be later than hosted 20261119200000');
  assert(BigInt(google.version) > BigInt(idvV2.version), 'Google Cloud V1 must be sequenced after IDV DigiLocker OIDC V2');
  assert(BigInt(google.version) > BigInt(listingValidity.version), 'Google Cloud V1 must be sequenced after listing validity 365');

  assert.equal(google.filename, `${google.version}_google_cloud_moderation_v1.sql`);
  assert.equal(google.path, `supabase/forward-migrations/moderation-google-cloud-v1/${google.filename}`);
  assert.equal(google.autoPromote, true);
});

test('migration ordering: candidate predating installed hosted migrations fails closed in dry run', () => {
  const google = getCandidate('moderation-google-cloud-v1');
  const olderTimestamp = '20261119130000';
  const installedTimestamp = '20261119200000';

  assert(BigInt(olderTimestamp) < BigInt(installedTimestamp), 'Old version predates already installed migration');
  assert(BigInt(google.version) > BigInt(installedTimestamp), 'Reissued version correctly postdates installed migration');

  const failedResult = {
    status: 1,
    stderr: `Error: migration ${olderTimestamp}_google_cloud_moderation_v1.sql is out of order with remote ${installedTimestamp}`,
    error: null,
  };
  const err = subprocessFailure(failedResult, 'dry_run');
  assert.equal(err.message, 'REUSABLE_SUBPROCESS_DRY_RUN_EXIT_FAILED');

  assert.throws(
    () => parsePendingDryRun(`Applying migration ${olderTimestamp}_google_cloud_moderation_v1.sql...`, google.filename),
    /REUSABLE_RELEASE_DRY_RUN_MISMATCH/
  );
});

test('unrecognized or non-strict candidates can never pass through a NO_SPECIFIC_POSTFLIGHT fallback', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/release/reusable-supabase-release.mjs'), 'utf8');
  assert(!/return\s*\{\s*status:\s*'NO_SPECIFIC_POSTFLIGHT'/.test(src));
  assert(src.includes('REUSABLE_RELEASE_NO_POSTFLIGHT_IMPLEMENTED'));
  assert.deepEqual(Object.values(CANDIDATES).filter(candidate => !candidate.unifiedPublishingV3).map(candidate => candidate.id).sort(), ['accessories-v1-activation', 'accessories-v1-foundation', 'account-security-email-v2', 'canonical-family-chooser-v1', 'idv-digilocker-aadhaar-acr', 'idv-digilocker-acr-request-only', 'idv-digilocker-oidc-v2', 'idv-digilocker-required-gate', 'idv-digilocker-v1', 'listing-validity-365', 'mobile-catalogue-india-v1', 'moderation-analytics-v1', 'moderation-azure-v1', 'moderation-google-cloud-v1', 'moderation-switching-v1', 'tablets-v1-activation', 'tablets-v1-foundation', 'tablets-v2-catalogue', 'taxonomy-v2-catalogue', 'taxonomy-v2-foundation', V3_IDENTITY_PREREQUISITE, 'v3-provider-neutral-activation', 'wearables-v1-activation', 'wearables-v1-foundation', 'wearables-v11-catalogue']);
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
  // Credential-bearing steps receive the existing read-only Web token only for candidates
  // that recheck immutable Web evidence in their runner, including the two V3 leaves.
  const v3Web = "startsWith(inputs.candidate, 'v3-books-') || startsWith(inputs.candidate, 'v3-tables-chairs-') || startsWith(inputs.candidate, 'v3-goods-batch-')";
  for (const m of yaml.matchAll(/- name: Execute [^\n]*\n[\s\S]*?(?=\n      - |\n  \w|$)/g)) {
    if (!m[0].includes('WEB_EVIDENCE_TOKEN')) continue;
    const candidates = m[0].includes('Execute Test') ? v3Web : "inputs.candidate == 'tablets-v2-catalogue' || inputs.candidate == 'wearables-v11-catalogue' || " + v3Web;
    assert(m[0].includes("WEB_EVIDENCE_TOKEN: ${{ (" + candidates + ") && secrets.CHAT_RELEASE_AUDIT_TOKEN || '' }}"));
  }
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
  for (const [id, version, filename] of [[WF, '20261104120000', '20261104120000_posting_v2_wearables.sql'], [WA, '20261104230000', '20261104230000_activate_wearables_v1.sql']]) {
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
  // W-AZ-1: activation wraps the provider-switching finalizer, so the strict order is Azure -> foundation -> switching -> activation
  assert.throws(() => assertLedgerOrdering(a, l('20261102164135', f.version)), /PREREQUISITE_MIGRATION_MISSING.*20261104113705/);
  assert.throws(() => assertLedgerOrdering(a, l('20261102164135', '20261104113705')), /PREREQUISITE_MIGRATION_MISSING/);
  assert.throws(() => assertLedgerOrdering(a, l('20261102164135', '20261104113705', f.version)), /PREREQUISITE_MIGRATION_MISSING.*20261104223000/);
  assert.equal(assertLedgerOrdering(a, l('20261102164135', '20261104113705', f.version, '20261104223000')).state, 'absent');
  assert.deepEqual([...a.requiredLedgerVersions], ['20261102164135', '20261104113705', '20261104120000', '20261104223000']);
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

const waiverDispatch = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'vivek2310sharma/FairSwap-Backend',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_ACTOR: 'vivek2310sharma',
  GITHUB_TRIGGERING_ACTOR: 'vivek2310sharma',
  GITHUB_ACTOR_ID: '59019804',
  GITHUB_REPOSITORY_OWNER_ID: '59019804',
  GITHUB_WORKFLOW_REF: 'vivek2310sharma/FairSwap-Backend/.github/workflows/reusable-supabase-release.yml@refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '99'
};
const waiverInput = WEARABLES_E2E_WAIVER.input;
const waiverPlan = (candidateId, target = 'production', context = waiverDispatch, overrides = {}) =>
  planDispatch({candidateId, target, context, inputs: {...wInputs, test_e2e_run_id: waiverInput, ...overrides}});

test('only an explicit Wearables Production dispatch by the verified owner can waive authenticated Test E2E', async () => {
  for (const [id, target] of [[WF, 'test'], [WA, 'test'], [FOUNDATION, 'production'], [FOUNDATION, 'adopt'],
    ['tablets-v2-catalogue', 'production'], ['moderation-switching-v1', 'test']]) {
    assert.throws(() => waiverPlan(id, target), /E2E_WAIVER_SCOPE_INVALID/);
  }
  for (const key of Object.keys(waiverDispatch)) {
    assert.throws(() => waiverPlan(WF, 'production', {...waiverDispatch, [key]: 'invalid'}), /E2E_WAIVER_OWNER_DISPATCH_REQUIRED/);
  }
  for (const id of [WF, WA]) {
    const plan = waiverPlan(id);
    assert.deepEqual(plan.priorRuns, wPlan(id, 'production').priorRuns);
    assert.deepEqual(plan.crossCommitRuns, wPlan(id, 'production').crossCommitRuns);
    assert.equal(plan.e2eRunId, undefined);
    assert.equal(plan.e2eWaiver.status, 'WAIVED_BY_OWNER');
    assert.equal(plan.e2eWaiver.testExecuted, false);
    assert.equal(plan.e2eWaiver.dispatchRunId, '99');
    assert.equal(await verifyE2eEvidence(plan, waiverDispatch, () => assert.fail('waiver must not look up E2E artifacts')), plan.e2eWaiver);
    for (const key of ['test_activation_run_id', 'accessories_prod_foundation_run_id', id === WF ? 'test_foundation_run_id' : 'prod_foundation_run_id']) {
      assert.throws(() => waiverPlan(id, 'production', waiverDispatch, {[key]: ''}), /EVIDENCE_RUN_REQUIRED/);
    }
  }
});

test('Wearables waiver activation requires the pinned selective tree, Production base, current READY deployment and main ancestry', async () => {
  const plan = waiverPlan(WA);
  const {webBaseSha, webTreeSha} = WEARABLES_E2E_WAIVER;
  const sha = plan.webProductionSha;
  const staging = wDep(1, plan.webStagingSha, 'Preview');
  const prod = wDep(2, sha, 'Production');
  const check = (o = {}) => verifyWebDeployments(plan, {WEB_EVIDENCE_TOKEN: 'mock'}, async u => {
    let data;
    if (u.includes('/deployments?environment=Production')) data = [o.live ?? prod];
    else if (u.includes(`/deployments?sha=${sha}`)) data = [prod];
    else if (u.includes(`/deployments?sha=${plan.webStagingSha}`)) data = [staging];
    else if (u.includes('/deployments/1/statuses')) data = [{state: o.staging ?? 'success'}];
    else if (u.includes('/deployments/2/statuses')) data = [{state: o.production ?? 'success'}];
    else if (u.includes(`/compare/${webBaseSha}...${sha}`)) data = {status: o.base ?? 'ahead', merge_base_commit: {sha: webBaseSha}};
    else if (u.endsWith(`/git/commits/${sha}`)) data = {sha, tree: {sha: o.tree ?? webTreeSha}};
    else if (u.endsWith(`/compare/${sha}...main`)) data = {status: o.main ?? 'ahead'};
    else assert.fail(`unexpected URL ${u}`);
    return {ok: true, json: async () => data};
  });
  assert.deepEqual(await check(), {stagingDeploymentId: 1, productionDeploymentId: 2});
  await assert.rejects(check({tree: '0'.repeat(40)}), /WEB_PRODUCTION_SELECTIVE_RELEASE_NOT_VERIFIED/);
  await assert.rejects(check({base: 'diverged'}), /WEB_PRODUCTION_SELECTIVE_RELEASE_NOT_VERIFIED/);
  await assert.rejects(check({live: {...prod, sha: webBaseSha}}), /WEB_PRODUCTION_NOT_CURRENT_DEPLOYMENT/);
  await assert.rejects(check({production: 'pending'}), /WEB_PRODUCTION_DEPLOYMENT_NOT_READY/);
  await assert.rejects(check({staging: 'pending'}), /WEB_STAGING_DEPLOYMENT_NOT_READY/);
  await assert.rejects(check({main: 'diverged'}), /WEB_PRODUCTION_NOT_ON_MAIN/);
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
const RUNNER = 'c0f2d7fcdb9614a5d762df46b8121ce596267594';
const E2E_PIN = Object.freeze({...WEARABLES_WEB, e2eRunnerSha: RUNNER});
const REPO_API = `https://api.github.com/repos/${WEARABLES_WEB.repository}`;
// Exact git diff --name-status at the two reviewed Web commits.
const REVIEWED_RUNNER_FILES = [
  {filename: '.github/workflows/ci.yml', status: 'modified'},
  {filename: '.github/workflows/wearables-e2e-test.yml', status: 'added'},
  {filename: 'docs/operations/TABLETS_POST_AD_V2.md', status: 'added'},
  {filename: 'e2e/wearables/cleanup.mjs', status: 'added'},
  {filename: 'e2e/wearables/cleanup.selftest.mjs', status: 'added'},
  {filename: 'e2e/wearables/contract.mjs', status: 'added'},
  {filename: 'e2e/wearables/helpers.ts', status: 'added'},
  {filename: 'e2e/wearables/playwright.config.ts', status: 'added'},
  {filename: 'e2e/wearables/preflight.mjs', status: 'added'},
  {filename: 'e2e/wearables/preflight.selftest.mjs', status: 'added'},
  {filename: 'e2e/wearables/wearables-v1.journey.ts', status: 'added'},
  {filename: 'e2e/wearables/write-evidence.mjs', status: 'added'},
  {filename: 'src/app/api/post-ad/tablets/submit/route.ts', status: 'modified'},
  {filename: 'src/components/listings/TabletForm.tsx', status: 'modified'},
  {filename: 'src/components/listings/posting/SearchCombobox.tsx', status: 'modified'},
  {filename: 'src/components/listings/posting/tablet-wizard.ts', status: 'modified'},
  {filename: 'src/lib/listings/tablets/contract.ts', status: 'modified'},
  {filename: 'src/lib/listings/tablets/public.ts', status: 'modified'},
  {filename: 'tests/browser/tablets-v1.spec.ts', status: 'modified'},
  {filename: 'tests/unit/tablet-public-details.test.tsx', status: 'modified'},
  {filename: 'tests/unit/tablet-submit-boundary.test.ts', status: 'modified'},
  {filename: 'tests/unit/tablets-v1.test.ts', status: 'modified'},
  {filename: 'tools/tablets-v1/verify.mjs', status: 'modified'},
];

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
  const files = o.files ?? REVIEWED_RUNNER_FILES;
  const deployments = o.deployments ?? [{id: 5, sha: RUNNER, environment: 'Preview'}];
  return async u => {
    if (u === art) return {ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length)};
    if (u === `${REPO_API}/compare/${WEARABLES_WEB.stagingSha}...${RUNNER}`) return ok({status: o.compare ?? 'ahead', base_commit: {sha: WEARABLES_WEB.stagingSha},
      merge_base_commit: {sha: WEARABLES_WEB.stagingSha}, commits: [{sha: RUNNER}], files, ...(o.source ?? {})});
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

test('reviewed E2E runner pin requires the exact 23-file comparison and a READY deployment', async () => {
  const plan = wPlan(WF, 'production');
  const env = {WEB_EVIDENCE_TOKEN: 't', TEST_ACTIVATION_RUN_ID: '11'};
  assert.equal(WEARABLES_WEB.e2eRunnerSha, RUNNER);
  assert.equal(WEARABLES_WEB.stagingSha, 'e37e28df1d387a02bcbea19487dfe0f82d198f74');
  assert.equal(WEARABLES_E2E.maxRunnerFiles, 23);
  assert.deepEqual(WEARABLES_E2E.runnerPaths, REVIEWED_RUNNER_FILES.map(f => f.filename));
  // Exercise the production registry lookup without the test seam.
  assert.deepEqual(await verifyE2eEvidence(plan, env, e2eFetcher()), {
    runId: '60', webStagingSha: WEARABLES_WEB.stagingSha, runnerSha: RUNNER
  });
  assert.deepEqual(await verifyE2eEvidence(plan, env, e2eFetcher({files: [...REVIEWED_RUNNER_FILES].reverse()})), {
    runId: '60', webStagingSha: WEARABLES_WEB.stagingSha, runnerSha: RUNNER
  });
  await assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher(), {...E2E_PIN, e2eRunnerSha: null}), /E2E_RUNNER_PIN_UNSET/);
  await assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher(), {...E2E_PIN, e2eRunnerSha: 'main'}), /E2E_RUNNER_PIN_UNSET/);
  await assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher(), {...E2E_PIN, e2eRunnerSha: WEARABLES_WEB.stagingSha}), /E2E_RUNNER_PIN_UNSET/);
  const bad = (o, re) => assert.rejects(verifyE2eEvidence(plan, env, e2eFetcher(o), E2E_PIN), re);
  // runner commit must descend from the tested commit
  for (const compare of ['diverged', 'behind', 'identical']) await bad({compare}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  // Nothing outside the exact reviewed set, including new E2E files or similarly named CI paths.
  for (const filename of ['src/app/page.tsx', 'package.json', 'pnpm-lock.yaml', 'supabase/migrations/x.sql', '.github/workflows/other.yml',
    '.github/workflows/wearables-e2e-test.yml.bak', '.github/workflows/ci.yml.bak', 'e2e/wearables/unreviewed.ts', 'e2e/other/x.ts', 'e2e/wearables/../../src/x.ts', 'next.config.ts']) {
    await bad({files: [...REVIEWED_RUNNER_FILES.slice(1), {filename, status: 'modified'}]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  }
  // Removed, renamed, copied, missing, duplicated and malformed entries all fail closed.
  for (const status of ['removed', 'renamed', 'copied', 'changed', undefined]) {
    await bad({files: [{...REVIEWED_RUNNER_FILES[0], status}, ...REVIEWED_RUNNER_FILES.slice(1)]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  }
  for (const previous_filename of ['src/old.ts', REVIEWED_RUNNER_FILES[1].filename]) {
    await bad({files: [{...REVIEWED_RUNNER_FILES[0], previous_filename}, ...REVIEWED_RUNNER_FILES.slice(1)]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  }
  // Each reviewed path is mandatory; even a valid 22-path subset is rejected.
  for (let i = 0; i < REVIEWED_RUNNER_FILES.length; i++) {
    await bad({files: REVIEWED_RUNNER_FILES.filter((_, j) => i !== j)}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  }
  await bad({files: [REVIEWED_RUNNER_FILES[1], ...REVIEWED_RUNNER_FILES.slice(1)]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  await bad({files: [null, ...REVIEWED_RUNNER_FILES.slice(1)]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  for (const source of [
    {base_commit: {sha: 'f'.repeat(40)}}, {merge_base_commit: {sha: 'f'.repeat(40)}},
    {commits: [{sha: WEARABLES_WEB.stagingSha}]}, {base_commit: null}, {merge_base_commit: null}, {commits: []}, {commits: null}
  ]) await bad({source}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  await bad({files: []}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  await bad({files: [...REVIEWED_RUNNER_FILES, {filename: 'e2e/wearables/extra.ts', status: 'added'}]}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  await bad({files: Array.from({length: 101}, (_, i) => ({filename: `e2e/wearables/f${i}.ts`}))}, /E2E_RUNNER_COMMIT_NOT_ISOLATED/);
  // the deployed runner commit must be READY, in a non-Production environment
  await bad({deployments: []}, /E2E_RUNNER_DEPLOYMENT_NOT_READY/);
  await bad({deployments: [{id: 5, sha: WEARABLES_WEB.stagingSha, environment: 'Preview'}]}, /E2E_RUNNER_DEPLOYMENT_NOT_READY/);
  await bad({deployState: 'failure'}, /E2E_RUNNER_DEPLOYMENT_NOT_READY/);
  await bad({deployments: [{id: 5, sha: RUNNER, environment: 'Production'}]}, /E2E_RUNNER_DEPLOYMENT_NOT_READY/);
});

test('moderation-switching-v1 without E2E evidence returns null, while actual Wearables E2E evidence still undergoes strict validation', async () => {
  const modPlan = planDispatch({candidateId: 'moderation-switching-v1', target: 'test', inputs: {}});
  assert.equal(await verifyE2eEvidence(modPlan, {}), null);

  const wearablesPlan = wPlan(WF, 'production');
  const env = {WEB_EVIDENCE_TOKEN: 't', TEST_ACTIVATION_RUN_ID: '11'};
  // Strict validation still active: missing token throws fail-closed error
  await assert.rejects(verifyE2eEvidence(wearablesPlan, {}, e2eFetcher(), E2E_PIN), /E2E_EVIDENCE_UNAVAILABLE/);
  // The reviewed registry pin still rejects invalid evidence without a test seam.
  await assert.rejects(verifyE2eEvidence(wearablesPlan, env, e2eFetcher({receipt: {runnerSha: 'f'.repeat(40)}})), /E2E_RECEIPT_INVALID.*web/);
  // Valid evidence with seam passes
  assert.deepEqual(await verifyE2eEvidence(wearablesPlan, env, e2eFetcher(), E2E_PIN), {
    runId: '60',
    webStagingSha: WEARABLES_WEB.stagingSha,
    runnerSha: RUNNER
  });
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
    // activation is sequenced after moderation switching: only the switching body is accepted, never the Azure-only body
    assert.ok(sql.includes(SWITCHING_FINALIZER_BODY_SHA256));
    assert.ok(!sql.includes(AZURE_FINALIZER_BODY_SHA256));
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
  const activationSqlText = readFileSync(join(process.cwd(), getCandidate(WA).path), 'utf8');
  assert.ok(activationSqlText.includes(SWITCHING_FINALIZER_BODY_SHA256) && !activationSqlText.includes(AZURE_FINALIZER_BODY_SHA256));
  assert.equal(verifyCandidateSha('moderation-azure-v1', process.cwd()).sha256, getCandidate('moderation-azure-v1').sha256);
});

function wearablesMock(environment, candidateId, {extraBefore = [], extraLedgerRows = [], tabletsSha, failKey, ledgerSha = 'a'.repeat(64), accessoriesSha, activationSha, noActivationRow = false, switchingSha, switchingCount, omit = []} = {}) {
  const candidate = getCandidate(candidateId);
  const names = {'20261102164135': 'accessories_v1', '20261102164137': 'activate_accessories_v1', '20261104120000': 'posting_v2_wearables', '20261104113705': 'azure_moderation_finalizer', '20261104215253': 'tablets_v2_india_catalogue', '20261104223000': 'moderation_provider_switching', [candidate.version]: candidate.filename.slice(15, -4)};
  for (const h of MOBILE_PHONES_HISTORY[environment]) names[h.version] = h.name;
  const required = candidate.requiredLedgerVersions;
  // both hosted environments have Accessories foundation AND activation installed (activated)
  const accessoriesActivation = noActivationRow ? [] : ['20261102164137'];
  const before = [...new Set([...baseHistory, ...MOBILE_PHONES_HISTORY[environment].map(h => h.version), ...required, ...accessoriesActivation,
    ...extraBefore, ...extraLedgerRows.map(row => row.version)])].filter(v => !omit.includes(v)).sort();
  const after = [...before, candidate.version].sort();
  const entry = version => extraLedgerRows.find(row => row.version === version) ?? ({version, name: names[version] ?? 'historical', hasStatements: true,
    statementCount: version === '20261104215253' ? TABLETS_V2_LEDGER.statementCount : version === '20261104223000' ? (switchingCount ?? MODERATION_SWITCHING_LEDGER.statementCount) : 1,
    statementsSha256: version === '20261104215253' ? (tabletsSha ?? TABLETS_V2_LEDGER.statementsSha256)
      : version === '20261104223000' ? (switchingSha ?? MODERATION_SWITCHING_LEDGER.statementsSha256)
      : environment === 'FairSwapProd' && version === '20261102164135' ? (accessoriesSha ?? ADOPTED_SHA)
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

test('Wearables Production receipt records an owner waiver separately from SQL postflight', async () => {
  const {receipt, dir} = await wRelease('FairSwapProd', WF, {}, {...waiverDispatch, TEST_E2E_RUN_ID: waiverInput});
  try {
    assert.deepEqual(receipt.e2eWaiver, waiverPlan(WF).e2eWaiver);
    assert.equal(receipt.e2eRunId, undefined);
    assert.equal(receipt.postflightScope, 'sql-integrity-smoke-not-e2e');
    assert.equal(receipt.postflightVerified, true);
    assert.equal(receipt.accessoriesProdFoundationRunId, '50');
    assert.deepEqual(receipt.priorRuns.map(r => r.key), ['test_foundation_run_id', 'test_activation_run_id']);
  } finally { rmSync(dir, {recursive: true, force: true}); }
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
  calls = await attempt('FairSwapTest', WA, {extraBefore: ['20261104230000']}, {}, /WEARABLES_ALREADY_RECORDED/);
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
  assert.deepEqual(record.forbiddenLedgerVersions, ['20261104120000', '20261104230000']);
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
  for (const version of ['20261104120000', '20261104230000']) {
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
  for (const version of ['20261104120000', '20261104230000']) {
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

// ---- Wearables ancestral stage evidence ---------------------------------------------------------
const WPOLICY = {ancestorPolicy: WEARABLES_ANCESTOR_EVIDENCE};
const WLEDGER = 'e'.repeat(64);
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const WCHAIN = {
  'wearables-v1-activation|test': [['test_foundation_run_id', '10']],
  'wearables-v1-foundation|prod': [['test_foundation_run_id', '10'], ['test_activation_run_id', '11']]
};
const wTestFoundation = {key: 'test_foundation_run_id', runId: '10', candidateId: WF, environment: 'test', commit: COMMIT_A};
const wTestActivation = {key: 'test_activation_run_id', runId: '11', candidateId: WA, environment: 'test', commit: COMMIT_B};
const wProdFoundation = {key: 'prod_foundation_run_id', runId: '12', candidateId: WF, environment: 'prod', commit: COMMIT_B};
const wEntries = () => ({'10': wTestFoundation, '11': wTestActivation, '12': wProdFoundation});

function wearablesReceipt(candidateId, environment, runId, commit, over = {}) {
  const cand = getCandidate(candidateId);
  const full = environment === 'test' ? 'FairSwapTest' : 'FairSwapProd';
  return {
    environment: full, projectRef: REFS[full], candidateId, migrationVersion: cand.version, migrationFile: cand.filename,
    migrationSha256: cand.sha256, ledgerStatementsSha256: WLEDGER, reviewedCommit: commit, releaseWorkflowRun: runId,
    status: 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED', dryRunPending: [cand.filename], postflightVerified: true, stage: cand.stage,
    webStagingSha: cand.stage === 'activation' || environment === 'prod' ? WEARABLES_WEB.stagingSha : null, webProductionSha: null,
    priorRuns: (WCHAIN[`${candidateId}|${environment}`] ?? []).map(([key, id]) => ({key, runId: id})),
    timestamp: '2026-11-05T00:00:00.000Z', ...over
  };
}

function wearablesFetcher(entries, over = {}) {
  const ok = value => ({ok: true, json: async () => value});
  return async raw => {
    const u = new URL(raw);
    const compare = u.pathname.match(/\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
    if (compare) {
      const [, previous] = compare;
      return ok(over.comparison?.(previous) ?? {status: 'ahead', behind_by: 0, base_commit: {sha: previous}, merge_base_commit: {sha: previous}});
    }
    if (u.pathname.includes('/contents/')) {
      const candidate = Object.values(CANDIDATES).find(x => u.pathname.endsWith('/' + x.path));
      const bytes = over.source ?? readFileSync(candidate.path);
      return ok({type: 'file', path: candidate.path, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length});
    }
    const m = u.pathname.match(/\/(runs|artifacts)\/(\d+)(?:\/(artifacts|zip))?$/);
    assert(m, raw);
    const [, kind, id, suffix] = m;
    const entry = entries[id];
    if (!entry) return {ok: false, status: 404};
    const {candidateId, environment, commit, receipt = {}} = entry;
    const full = (environment === 'test' ? 'fairswaptest' : 'fairswapprod');
    const body = JSON.stringify(wearablesReceipt(candidateId, environment, id, commit, receipt), null, 2) + '\n';
    const digest = over.sums ?? createHash('sha256').update(body).digest('hex');
    const zip = makeZip({[`${candidateId}-${full}.json`]: body, [`SHA256SUMS_${full}`]: `${digest}  ${candidateId}-${full}.json\n`});
    if (kind === 'artifacts') return {ok: true, arrayBuffer: async () => zip};
    if (!suffix) return ok({...goodRun, id: Number(id), head_sha: commit, run_attempt: 1, workflow_id: 404601811,
      head_repository: {full_name: GH}, actor: {login: 'vivek2310sharma'}, triggering_actor: {login: 'vivek2310sharma'}, ...over.run});
    const artifact = {id: Number(id), name: `reusable-${environment}-${candidateId}-${id}-1`, expired: false,
      workflow_run: {id: Number(id), head_sha: commit}, archive_download_url: `https://api.github.com/repos/${GH}/actions/artifacts/${id}/zip`,
      digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`, ...over.artifact};
    return ok({artifacts: over.missing ? [] : [artifact]});
  };
}

const wRequire = (priors, over, entries = wEntries(), options = WPOLICY) =>
  requireStageEvidence(priors, ctx, wearablesFetcher(entries, over), options);

test('Wearables Test activation accepts the verified ancestor Test foundation run', async () => {
  assert(WEARABLES_ANCESTOR_EVIDENCE.size === 3);
  const plan = planDispatch({candidateId: WA, target: 'test', inputs: {web_staging_sha: WEARABLES_WEB.stagingSha, test_foundation_run_id: '10'}});
  const receipts = await wRequire(plan.priorRuns);
  assert.equal(receipts.test_foundation_run_id.reviewedCommit, COMMIT_A);
  assert.equal(receipts.test_foundation_run_id.ledgerStatementsSha256, WLEDGER);
});

test('Wearables Production foundation and activation verify historical Test and Production chains across commits', async () => {
  const foundation = planDispatch({candidateId: WF, target: 'production', inputs: {
    web_staging_sha: WEARABLES_WEB.stagingSha, test_foundation_run_id: '10', test_activation_run_id: '11',
    accessories_prod_foundation_run_id: '90', test_e2e_run_id: '91'}});
  const f = await wRequire(foundation.priorRuns);
  assert.deepEqual([f.test_foundation_run_id.reviewedCommit, f.test_activation_run_id.reviewedCommit], [COMMIT_A, COMMIT_B]);
  const activation = planDispatch({candidateId: WA, target: 'production', inputs: {
    web_staging_sha: WEARABLES_WEB.stagingSha, web_production_sha: 'f'.repeat(40), test_activation_run_id: '11', prod_foundation_run_id: '12',
    accessories_prod_foundation_run_id: '90', test_e2e_run_id: '91'}});
  const a = await wRequire(activation.priorRuns);
  assert.deepEqual([a.test_activation_run_id.reviewedCommit, a.prod_foundation_run_id.reviewedCommit], [COMMIT_B, COMMIT_B]);
});

test('Wearables ancestral evidence rejects tampered, divergent, changed-SQL, expired, wrong-actor and wrong-stage evidence', async () => {
  const check = (over, p = wTestFoundation, entries) => wRequire([p], over, entries);
  for (const [over, error] of [
    [{run: {workflow_id: 5}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {actor: {login: 'someone-else'}}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {triggering_actor: {login: 'someone-else'}}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {head_repository: {full_name: 'someone/else'}}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {head_branch: 'feature'}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {event: 'push'}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {conclusion: 'failure'}}, /EVIDENCE_RUN_NOT_VERIFIED/],
    [{run: {run_attempt: 2}}, /EVIDENCE_RECEIPT_MISSING/],
    [{missing: true}, /EVIDENCE_RECEIPT_MISSING/],
    [{artifact: {expired: true}}, /EVIDENCE_RECEIPT_MISSING/],
    [{artifact: {digest: 'sha256:' + '0'.repeat(64)}}, /artifact digest/],
    [{artifact: {workflow_run: {id: 10, head_sha: SHA_C}}}, /RECEIPT_CONTENT_INVALID: .*url/],
    [{sums: '0'.repeat(64)}, /checksum/],
    [{source: Buffer.from('select 1;')}, /EVIDENCE_SOURCE_MISMATCH/],
    [{comparison: () => ({status: 'diverged'})}, /EVIDENCE_ANCESTRY_NOT_VERIFIED/],
    [{comparison: () => ({status: 'behind', behind_by: 1})}, /EVIDENCE_ANCESTRY_NOT_VERIFIED/],
    [{comparison: p => ({status: 'ahead', behind_by: 0, base_commit: {sha: p}, merge_base_commit: {sha: SHA_C}})}, /EVIDENCE_ANCESTRY_NOT_VERIFIED/]
  ]) await assert.rejects(check(over), error);
  const withReceipt = receipt => ({'10': {...wTestFoundation, receipt}});
  for (const [receipt, error] of [
    [{reviewedCommit: SHA_C}, /RECEIPT_CONTENT_INVALID: .*commit/],
    [{migrationSha256: '0'.repeat(64)}, /RECEIPT_CONTENT_INVALID: .*hash/],
    [{ledgerStatementsSha256: 'nothex'}, /RECEIPT_CONTENT_INVALID: .*hash/],
    [{environment: 'FairSwapProd'}, /RECEIPT_CONTENT_INVALID: .*environment/],
    [{stage: 'activation'}, /RECEIPT_CONTENT_INVALID: .*stage/],
    [{webStagingSha: 'f'.repeat(40)}, /RECEIPT_CONTENT_INVALID: .*web/],
    [{postflightVerified: false}, /RECEIPT_CONTENT_INVALID: .*postflight/],
    [{releaseWorkflowRun: '99'}, /RECEIPT_CONTENT_INVALID: .*run/],
    [{recoveredFoundationCommit: COMMIT_B}, /RECEIPT_CONTENT_INVALID: .*release result/],
    [{webProductionSha: 'f'.repeat(40)}, /RECEIPT_CONTENT_INVALID: .*release result/]
  ]) await assert.rejects(check({}, wTestFoundation, withReceipt(receipt)), error);
  // wrong stage / environment evidence under a Wearables key
  await assert.rejects(check({}, {...wTestFoundation, candidateId: WA}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(check({}, {...wTestFoundation, environment: 'prod'}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(check({}, {...wTestFoundation, key: 'prod_foundation_run_id'}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(check({}, {...wTestActivation, key: 'test_foundation_run_id'}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(check({}, {...wTestFoundation, runId: '11'}, {'11': {...wTestFoundation, candidateId: WA, environment: 'test', commit: COMMIT_A}}),
    /EVIDENCE_RECEIPT_MISSING|EVIDENCE_RUN_NOT_VERIFIED/);
});

test('Wearables chain recursion verifies each recorded prior run and its ledger identity', async () => {
  const prodFoundation = () => requireStageEvidence([wProdFoundation], ctx, wearablesFetcher(entries), WPOLICY);
  let entries = wEntries();
  assert.equal((await prodFoundation()).prod_foundation_run_id.reviewedCommit, COMMIT_B);
  entries = {...wEntries(), '10': {...wTestFoundation, commit: SHA_C}};      // prior not an ancestor of the Production commit
  await assert.rejects(requireStageEvidence([wProdFoundation], ctx, wearablesFetcher(entries, {comparison: p => p === SHA_C ? {status: 'diverged'} : undefined}), WPOLICY), /EVIDENCE_ANCESTRY_NOT_VERIFIED|EVIDENCE_RUN_NOT_VERIFIED/);
  entries = {...wEntries(), '11': {...wTestActivation, receipt: {priorRuns: [{key: 'test_foundation_run_id', runId: '99'}]}}};
  await assert.rejects(prodFoundation(), /EVIDENCE_LOOKUP_FAILED: 404/);
  entries = {...wEntries(), '12': {...wProdFoundation, receipt: {priorRuns: [{key: 'test_foundation_run_id', runId: '10'}, {key: 'test_foundation_run_id', runId: '11'}]}}};
  await assert.rejects(prodFoundation(), /RECEIPT_CONTENT_INVALID: .*chain/);
  entries = {...wEntries(), '12': {...wProdFoundation, receipt: {priorRuns: [{key: 'test_foundation_run_id', runId: '10'}, {key: 'test_activation_run_id', runId: '12'}]}}};
  await assert.rejects(prodFoundation(), /EVIDENCE_RUN_NOT_VERIFIED/);                // recorded run repeats the Production run
  entries = {...wEntries(), '12': {...wProdFoundation, receipt: {ledgerStatementsSha256: 'd'.repeat(64)}}};
  await assert.rejects(prodFoundation(), /RECEIPT_CONTENT_INVALID: .*ledger hash/);
  entries = {...wEntries(), '10': {...wTestFoundation, receipt: {stage: 'activation'}}};   // wrong-stage evidence in the chain
  await assert.rejects(prodFoundation(), /RECEIPT_CONTENT_INVALID: .*stage/);
  entries = wEntries();
  delete entries['10'];
  await assert.rejects(prodFoundation(), /EVIDENCE_LOOKUP_FAILED: 404/);
});

test('ancestor evidence stays closed for Wearables without the policy and for Accessories and Tablets with it', async () => {
  // upstream (#106) keeps the Test foundation link open by default; every other Wearables link needs the policy
  await assert.rejects(wRequire([wTestActivation], {}, wEntries(), {}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(wRequire([wProdFoundation], {}, wEntries(), {}), /EVIDENCE_RUN_NOT_VERIFIED/);
  await assert.rejects(wRequire([wProdFoundation], {}, wEntries(), {allowFoundationAncestors: true}), /EVIDENCE_RUN_NOT_VERIFIED/);
  const accessories = {key: 'test_foundation_run_id', runId: '10', candidateId: FOUNDATION, environment: 'test', commit: COMMIT_A};
  await assert.rejects(wRequire([accessories], {}, {'10': accessories}), /EVIDENCE_RUN_NOT_VERIFIED/);
  const tablets = {...accessories, candidateId: 'tablets-v1-foundation'};
  await assert.rejects(wRequire([tablets], {}, {'10': tablets}), /EVIDENCE_RUN_NOT_VERIFIED/);
  for (const key of WEARABLES_ANCESTOR_EVIDENCE) assert.match(key, /^wearables-v1-(foundation|activation)\|(test|prod)\|(test|prod)_(foundation|activation)_run_id$/);
});

test('workflow grants the Wearables ancestor policy only to wearables-v1 candidates', () => {
  const yaml = readFileSync(join(process.cwd(), '.github/workflows/reusable-supabase-release.yml'), 'utf8');
  assert(yaml.includes("const wearables = plan.candidate.id.startsWith('wearables-v1-');"));
  assert(yaml.includes('ancestorPolicy: wearables ? WEARABLES_ANCESTOR_EVIDENCE : null'));
  assert(yaml.includes('allowFoundationAncestors: accessories,'));
});

// ---- Wearables activation resequenced after moderation switching ----------------------------------------------
const TABLETS_V2_VERSION = '20261104215253';
const SWITCHING_VERSION = '20261104223000';
const ACTIVATION_VERSION = '20261104230000';
const ACTIVATION_SHA = 'ec102db34e4414a713aed950b756ea617888209515031c5a615306d30e08ac54';
const swRow = (over = {}) => ({version: SWITCHING_VERSION, name: 'moderation_provider_switching', hasStatements: true,
  statementCount: MODERATION_SWITCHING_LEDGER.statementCount, statementsSha256: MODERATION_SWITCHING_LEDGER.statementsSha256, ...over});
const tvRow = (over = {}) => ({version: TABLETS_V2_VERSION, name: 'tablets_v2_india_catalogue', hasStatements: true,
  statementCount: TABLETS_V2_LEDGER.statementCount, statementsSha256: TABLETS_V2_LEDGER.statementsSha256, ...over});

test('Wearables activation is resequenced after moderation switching with a unique version and the switching-only baseline', () => {
  const f = getCandidate(WF);
  const a = getCandidate(WA);
  assert.equal(getCandidate('tablets-v2-catalogue').version, TABLETS_V2_VERSION);
  assert.equal(getCandidate('moderation-switching-v1').version, SWITCHING_VERSION);
  assert.equal(a.version, ACTIVATION_VERSION);
  assert.ok(a.version > SWITCHING_VERSION);
  assert.equal(a.filename, `${ACTIVATION_VERSION}_activate_wearables_v1.sql`);
  assert.equal(a.sha256, ACTIVATION_SHA);
  assert.equal(verifyCandidateSha(WA).sha256, a.sha256);
  assert.deepEqual([f.version, f.filename, f.sha256], ['20261104120000', '20261104120000_posting_v2_wearables.sql', '41122396afe11952126eaf474d272e88e81444863e97d0b2e646ee4cbac48b06']);
  assert.equal(getCandidate('moderation-switching-v1').sha256, '1e75154d50333e94aa80894f0c59a507d0ab3ebad34e99f2e909506d64b94a7d');
  const versions = Object.values(CANDIDATES).map(c => c.version);
  assert.equal(new Set(versions).size, versions.length, 'candidate versions are collision-free');
  const dir = join(process.cwd(), 'supabase/forward-migrations/wearables-v1/activation/supabase/migrations');
  assert.deepEqual(readdirSync(dir), [a.filename]);
  const sums = readFileSync(join(process.cwd(), 'supabase/forward-migrations/wearables-v1/SHA256SUMS'), 'utf8');
  assert.ok(sums.includes(`${a.sha256}  activation/supabase/migrations/${a.filename}\n`));
  for (const old of ['20261104220000', '20261104120100', 'c5a50f11df325a9743f39b13d7aa536a1b7b12cca9467fc318da8f659527b10b']) assert.ok(!sums.includes(old));
  assert.deepEqual([...f.incompatibleLedgerVersions], [a.version]);
  assert.ok(a.requiredLedgerVersions.includes(SWITCHING_VERSION));
  assert.ok(!f.requiredLedgerVersions.includes(SWITCHING_VERSION), 'the installed foundation stays independent of switching');
  assert.deepEqual([...EXISTING_INSTALLATIONS[`accessories-v1-foundation|FairSwapProd`].forbiddenLedgerVersions], ['20261104120000', a.version]);
  // the baseline accepts exactly the reviewed switching finalizer body and never the Azure-only body
  const sql = readFileSync(join(process.cwd(), a.path), 'utf8');
  assert.ok(sql.includes(SWITCHING_FINALIZER_BODY_SHA256) && !sql.includes(AZURE_FINALIZER_BODY_SHA256));
  assert.equal([...sql.matchAll(/[0-9a-f]{64}/g)].length, 1);
});

test('hosted pins for Tablets V2 and moderation switching equal the CLI statement digests of the reviewed sources', () => {
  for (const [id, pin] of [['tablets-v2-catalogue', TABLETS_V2_LEDGER], ['moderation-switching-v1', MODERATION_SWITCHING_LEDGER]]) {
    const statements = splitStatements(readFileSync(join(process.cwd(), getCandidate(id).path), 'utf8'));
    assert.equal(statements.length, pin.statementCount, id);
    assert.equal(pgDigest(statements), pin.statementsSha256, id);
  }
  assert.deepEqual([TABLETS_V2_LEDGER.statementCount, MODERATION_SWITCHING_LEDGER.statementCount], [15, 9]);
});

test('ledger with Tablets V2, the foundation and moderation switching admits only the resequenced activation', () => {
  const f = getCandidate(WF);
  const a = getCandidate(WA);
  const rows = (...v) => ledger(v);
  const versions = ['20261102164135', '20261102164137', '20261102165946', '20261102170611', '20261104113705', f.version, TABLETS_V2_VERSION, SWITCHING_VERSION];
  const full = [...versions.map(version => ({version})).filter(r => r.version !== SWITCHING_VERSION && r.version !== TABLETS_V2_VERSION), tvRow(), swRow()];
  assert.deepEqual(assertLedgerTail(a, full, 'FairSwapTest'), {includeAll: false, ahead: []});
  assert.deepEqual(assertLedgerTail(a, full, 'FairSwapProd'), {includeAll: false, ahead: []});
  assert.doesNotThrow(() => assertSwitchingPrerequisite(a, full));
  assert.equal(assertLedgerOrdering(a, rows(...versions)).state, 'absent');
  // switching is a required prerequisite
  assert.throws(() => assertLedgerOrdering(a, rows(...versions.filter(v => v !== SWITCHING_VERSION))), /PREREQUISITE_MIGRATION_MISSING.*20261104223000/);
  assert.throws(() => assertSwitchingPrerequisite(a, full.filter(r => r.version !== SWITCHING_VERSION)), /WEARABLES_SWITCHING_PREREQUISITE_MISMATCH/);
  for (const over of [{statementsSha256: 'f'.repeat(64)}, {statementCount: 8}, {statementCount: 10}, {name: 'renamed'}, {hasStatements: false}, {statementCount: undefined}]) {
    assert.throws(() => assertSwitchingPrerequisite(a, [...full.filter(r => r.version !== SWITCHING_VERSION), swRow(over)]), /WEARABLES_SWITCHING_PREREQUISITE_MISMATCH/, JSON.stringify(over));
  }
  assertSwitchingPrerequisite(f, []);   // only activation depends on switching
  // a recorded activation (or any newer row) is refused, and an unapplied foundation stays refused outside the reviewed exception
  assert.throws(() => assertLedgerTail(a, [...full, {version: a.version}]), /WEARABLES_LEDGER_TAIL_AHEAD/);
  assert.throws(() => assertLedgerTail(a, [...full, {version: '20261104235900'}]), /WEARABLES_LEDGER_TAIL_AHEAD/);
  assert.throws(() => assertLedgerTail(f, full.filter(r => r.version !== f.version), 'FairSwapTest'), /WEARABLES_LEDGER_TAIL_AHEAD/);
});

test('Wearables activation releases through Test and Production after moderation switching', async () => {
  for (const environment of ['FairSwapTest', 'FairSwapProd']) {
    const {receipt, calls, dir} = await wRelease(environment, WA, {extraBefore: [TABLETS_V2_VERSION, SWITCHING_VERSION]}, {});
    try {
      assert.equal(receipt.migrationVersion, ACTIVATION_VERSION);
      assert.equal(receipt.migrationSha256, ACTIVATION_SHA);
      assert.equal(receipt.postflightVerified, true);
      assert.equal(receipt.outOfOrderInstall, undefined);
      assert.equal(calls.filter(c => c.startsWith('supabase db push ')).length, 2);
      assert.ok(calls.every(c => !c.includes('--include-all')));
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('Wearables activation fails before any push without the exact switching migration or with the Azure-only finalizer', async () => {
  const attempt = async (o, re) => {
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), 'fs-test-receipts-'));
    const mock = wearablesMock('FairSwapTest', WA, o);
    const runner = makeRunner({...mock, filename: getCandidate(WA).filename, calls});
    const context = {...baseEnv, ...wInputs, WEB_STAGING_SHA: wInputs.web_staging_sha, WEB_PRODUCTION_SHA: wInputs.web_production_sha, TEST_FOUNDATION_RUN_ID: '10',
      TEST_ACTIVATION_RUN_ID: '11', PROD_FOUNDATION_RUN_ID: '12', ACCESSORIES_PROD_FOUNDATION_RUN_ID: '50', TEST_E2E_RUN_ID: '60',
      TABLETS_FOUNDATION_LEDGER_SHA: 'a'.repeat(64), TABLETS_CANDIDATE_LEDGER_SHA: 'a'.repeat(64)};
    try {
      await assert.rejects(releaseReusable({environment: 'FairSwapTest', candidateId: WA, context, runner, receiptDir: dir}), re);
      assert.equal(existsSync(join(dir, `${WA}-fairswaptest.json`)), false);
    } finally { rmSync(dir, {recursive: true, force: true}); }
    assert.equal(calls.filter(c => c.startsWith('supabase db push ')).length, 0);
  };
  await attempt({omit: [SWITCHING_VERSION]}, /PREREQUISITE_MIGRATION_MISSING.*20261104223000/);   // missing switching migration
  await attempt({switchingSha: 'f'.repeat(64)}, /WEARABLES_SWITCHING_PREREQUISITE_MISMATCH/);     // modified hosted digest
  await attempt({switchingCount: 8}, /WEARABLES_SWITCHING_PREREQUISITE_MISMATCH/);                // modified statement count
  await attempt({failKey: 'azure_finalizer_baseline'}, /WEARABLES_PREFLIGHT_FAILED: azure_finalizer_baseline/);   // unexpected Azure-only / drifted finalizer state
});

// ---- Production Wearables foundation installed out of order (Tablets V2 and moderation switching already on the ledger) --------------------
const TV2_ROW = '20261104215253';
const SW_ROW = '20261104223000';

test('assertLedgerTail admits only the two approved newer rows, only for the Production Wearables foundation', () => {
  const f = getCandidate(WF);
  const a = getCandidate(WA);
  const base = [{version: '20261104113705'}];
  assert.deepEqual(WEARABLES_OUT_OF_ORDER.ahead.map(p => p.candidateId), ['tablets-v2-catalogue', 'moderation-switching-v1']);
  assert.deepEqual(assertLedgerTail(f, [...base, tvRow(), swRow()], 'FairSwapProd'), {includeAll: true, ahead: [TV2_ROW, SW_ROW]});
  assert.deepEqual(assertLedgerTail(f, base, 'FairSwapProd'), {includeAll: false, ahead: []});
  const refused = (candidate, rows, env) => assert.throws(() => assertLedgerTail(candidate, rows, env), /WEARABLES_LEDGER_TAIL_AHEAD/);
  const both = [tvRow(), swRow()];
  refused(f, [...base, ...both], 'FairSwapTest');                       // Test is never exempt
  refused(f, [...base, ...both]);                                       // environment is mandatory
  refused(a, [...base, ...both, {version: '20261104235900'}], 'FairSwapProd');
  refused(f, [...base, tvRow()], 'FairSwapProd');                       // switching missing: foundation cannot be inserted behind it by the old rule
  refused(f, [...base, swRow()], 'FairSwapProd');                       // Tablets V2 missing
  refused(f, [...base, swRow(), tvRow()], 'FairSwapProd');              // wrong order
  refused(f, [...base, tvRow(), swRow(), {version: '20261104235900'}], 'FairSwapProd');   // additional newer row
  refused(f, [...base, tvRow(), swRow(), {version: a.version}], 'FairSwapProd');          // activation recorded before foundation
  for (const over of [{statementsSha256: 'f'.repeat(64)}, {name: 'renamed'}, {hasStatements: false}, {statementCount: 14}, {statementCount: undefined}, {version: '20261104215254'}]) {
    refused(f, [...base, tvRow(over), swRow()], 'FairSwapProd');
  }
  for (const over of [{statementsSha256: 'f'.repeat(64)}, {name: 'renamed'}, {hasStatements: false}, {statementCount: 8}, {statementCount: undefined}, {version: '20261104223001'}]) {
    refused(f, [...base, tvRow(), swRow(over)], 'FairSwapProd');
  }
  assert.throws(() => assertCliSupportsIncludeAll('Flags: --dry-run'), /WEARABLES_CLI_INCLUDE_ALL_UNSUPPORTED/);
  assert.throws(() => assertCliSupportsIncludeAll('Flags: --include-all'), /WEARABLES_CLI_INCLUDE_ALL_UNSUPPORTED/);
  assert.doesNotThrow(() => assertCliSupportsIncludeAll('Flags:\n      --dry-run   x\n      --include-all   y'));
});

async function wOutOfOrderRun(o = {}, {help = '--dry-run --include-all', dryOutput} = {}, candidateId = WF, environment = 'FairSwapProd') {
  const mock = wearablesMock(environment, candidateId, o);
  const calls = [];
  const full = [];
  const base = makeRunner({...mock, filename: getCandidate(candidateId).filename, calls});
  const runner = (cmd, args, ...rest) => {
    full.push([cmd, ...args]);
    if (cmd === 'supabase' && args.includes('--help')) return help;
    if (cmd === 'supabase' && args.includes('--dry-run') && dryOutput) return dryOutput;
    return base(cmd, args, ...rest);
  };
  const dir = mkdtempSync(join(tmpdir(), 'fs-test-receipts-'));
  const context = {...baseEnv, ...wInputs, WEB_STAGING_SHA: wInputs.web_staging_sha, WEB_PRODUCTION_SHA: wInputs.web_production_sha, TEST_FOUNDATION_RUN_ID: '10',
    TEST_ACTIVATION_RUN_ID: '11', PROD_FOUNDATION_RUN_ID: '12', ACCESSORIES_PROD_FOUNDATION_RUN_ID: '50', TEST_E2E_RUN_ID: '60',
    TABLETS_FOUNDATION_LEDGER_SHA: 'a'.repeat(64), TABLETS_CANDIDATE_LEDGER_SHA: 'a'.repeat(64)};
  const result = releaseReusable({environment, candidateId, context, runner, receiptDir: dir}).then(receipt => ({receipt, full, dir}));
  return {result, full, dir};
}
const pushes = full => full.filter(c => c[1] === 'db' && c[2] === 'push' && !c.includes('--help'));

test('Production Wearables foundation installs out of order with --include-all on dry run and apply only, after the CLI check', async () => {
  const {result, full, dir} = await wOutOfOrderRun({extraBefore: [TV2_ROW, SW_ROW]});
  try {
    const {receipt} = await result;
    assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.equal(receipt.migrationVersion, '20261104120000');
    assert.equal(receipt.migrationSha256, getCandidate(WF).sha256);
    assert.deepEqual(receipt.dryRunPending, [getCandidate(WF).filename]);
    assert.deepEqual(receipt.outOfOrderInstall, {includeAll: true, aheadVersions: [TV2_ROW, SW_ROW]});
    assert.equal(receipt.ledgerStatementsSha256, 'a'.repeat(64));
    const help = full.findIndex(c => c.includes('--help'));
    const [dry, apply] = pushes(full);
    assert.ok(help >= 0 && help < full.indexOf(dry) && full.indexOf(dry) < full.indexOf(apply));
    assert.ok(dry.includes('--dry-run') && dry.includes('--include-all'));
    assert.ok(apply.includes('--yes') && apply.includes('--include-all') && !apply.includes('--dry-run'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
  // the ordinary ledger (no newer row) never uses the flag or the CLI probe
  const normal = await wOutOfOrderRun({});
  try {
    await normal.result;
    assert.ok(normal.full.every(c => !c.includes('--include-all') && !c.includes('--help')));
  } finally { rmSync(normal.dir, {recursive: true, force: true}); }
});

test('out-of-order Production foundation fails closed before any push on every deviation', async () => {
  const attempt = async (o, opts, re, env = 'FairSwapProd') => {
    const run = await wOutOfOrderRun(o, opts, WF, env);
    try { await assert.rejects(run.result, re); assert.equal(pushes(run.full).filter(c => !c.includes('--dry-run')).length, 0); return run.full; }
    finally { rmSync(run.dir, {recursive: true, force: true}); }
  };
  await attempt({extraBefore: [TV2_ROW, SW_ROW], tabletsSha: 'f'.repeat(64)}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/);   // changed Tablets V2 history
  await attempt({extraBefore: [TV2_ROW, SW_ROW], switchingSha: 'f'.repeat(64)}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/);   // changed switching history
  await attempt({extraBefore: [TV2_ROW, SW_ROW], switchingCount: 8}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/);              // changed switching statement count
  await attempt({extraBefore: [TV2_ROW]}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/);                                         // switching row missing
  await attempt({extraBefore: [SW_ROW]}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/);                                          // Tablets V2 row missing
  await attempt({extraBefore: [TV2_ROW, SW_ROW, '20261104235900']}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/);               // unexpected newer migration
  await attempt({extraBefore: [TV2_ROW, SW_ROW]}, {}, /WEARABLES_LEDGER_TAIL_AHEAD/, 'FairSwapTest');                 // Test never uses the exception
  const unsupported = await attempt({extraBefore: [TV2_ROW, SW_ROW]}, {help: 'Flags: --dry-run'}, /WEARABLES_CLI_INCLUDE_ALL_UNSUPPORTED/);
  assert.equal(pushes(unsupported).length, 0);                                                                // not even a dry run
  const two = `Would push: ${getCandidate(WF).filename} and 20261104215253_tablets_v2_india_catalogue.sql`;
  await attempt({extraBefore: [TV2_ROW, SW_ROW]}, {dryOutput: two}, /DRY_RUN_MISMATCH/);                             // unexpected pending SQL
  await attempt({extraBefore: [TV2_ROW, SW_ROW]}, {dryOutput: 'Would push: 20261104215253_tablets_v2_india_catalogue.sql'}, /DRY_RUN_MISMATCH/);
  // the original postflight still decides: a failed RLS/ACL/moderation check after the push yields no receipt
  const post = await wOutOfOrderRun({extraBefore: [TV2_ROW, SW_ROW], failKey: Object.keys(wearablesPostflightChecks('foundation'))[0]});
  try { await assert.rejects(post.result, /POSTFLIGHT/); } finally { rmSync(post.dir, {recursive: true, force: true}); }
});

const mobileCatalogueRow = Object.freeze({
  version: '20261105213015',
  name: 'posting_v2_mobile_catalogue_india',
  hasStatements: true,
  statementCount: 23,
  statementsSha256: '088443b1e15c6b302b52e84f75a5b8547a9c46c21477fe65228e64a6754363b4'
});

test('Production Wearables activation uses --include-all for the exact Mobile Catalogue tail', async () => {
  const {result, full, dir} = await wOutOfOrderRun({extraLedgerRows: [mobileCatalogueRow]}, {}, WA);
  try {
    const {receipt} = await result;
    assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.deepEqual(receipt.outOfOrderInstall, {includeAll: true, aheadVersions: [mobileCatalogueRow.version]});
    assert.deepEqual(receipt.dryRunPending, [getCandidate(WA).filename]);
    const help = full.findIndex(c => c.includes('--help'));
    const commands = pushes(full);
    assert.equal(commands.length, 2);
    const [dry, apply] = commands;
    assert.ok(help >= 0 && help < full.indexOf(dry) && full.indexOf(dry) < full.indexOf(apply));
    assert.ok(dry.includes('--dry-run') && dry.includes('--include-all'));
    assert.ok(apply.includes('--yes') && apply.includes('--include-all') && !apply.includes('--dry-run'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('Wearables activation tail exception refuses any other candidate, environment or newer ledger', () => {
  const a = getCandidate(WA);
  const rejected = /WEARABLES_LEDGER_TAIL_AHEAD/;
  assert.deepEqual(assertLedgerTail(a, [], 'FairSwapProd'), {includeAll: false, ahead: []});
  assert.throws(() => assertLedgerTail(a, [mobileCatalogueRow], 'FairSwapTest'), rejected);
  assert.throws(() => assertLedgerTail(getCandidate(WF), [mobileCatalogueRow], 'FairSwapProd'), rejected);
  assert.throws(() => assertLedgerTail(a, [mobileCatalogueRow, {version: '20261105213016'}], 'FairSwapProd'), rejected);
  assert.throws(() => assertLedgerTail(a, [mobileCatalogueRow, mobileCatalogueRow], 'FairSwapProd'), rejected);
  for (const change of [
    {version: '20261105213016'}, {name: 'renamed'}, {hasStatements: false},
    {statementCount: 22}, {statementCount: undefined}, {statementsSha256: 'f'.repeat(64)}, {statementsSha256: undefined}
  ]) {
    assert.throws(() => assertLedgerTail(a, [{...mobileCatalogueRow, ...change}], 'FairSwapProd'), rejected);
  }
});

test('the exact Mobile Catalogue tail cannot bypass activation prerequisites or CLI checks', async () => {
  const extraLedgerRows = [mobileCatalogueRow];
  for (const [options, cli, error] of [
    ...getCandidate(WA).requiredLedgerVersions.map(version =>
      [{omit: [version]}, {}, new RegExp(`PREREQUISITE_MIGRATION_MISSING.*${version}`)]),
    [{switchingSha: 'f'.repeat(64)}, {}, /WEARABLES_SWITCHING_PREREQUISITE_MISMATCH/],
    [{}, {help: '--dry-run'}, /WEARABLES_CLI_INCLUDE_ALL_UNSUPPORTED/]
  ]) {
    const {result, full, dir} = await wOutOfOrderRun({extraLedgerRows, ...options}, cli, WA);
    try {
      await assert.rejects(result, error);
      assert.deepEqual(pushes(full), []);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

// Disposable PostgreSQL (PGlite): the real foundation SQL installed after Tablets V2 with the ledger row inserted out of order.
async function loadPglite() {
  for (const p of [process.env.FSW_PGLITE_MODULE, 'tests/ratings/node_modules/@electric-sql/pglite/dist/index.js', '../FairSwap-Web/node_modules/@electric-sql/pglite/dist/index.js']) {
    if (p && existsSync(resolvePath(p))) return (await import(pathToFileURL(resolvePath(p)).href)).PGlite;
  }
  return null;
}
const PGlite = await loadPglite();
if (!PGlite && process.env.REQUIRE_REAL_PG === '1') {
  test('PGlite is required for the out-of-order install test in release CI', () => assert.fail('no PGlite module found'));
}

test('disposable PostgreSQL: Wearables foundation installs after Tablets V2 out of order and rolls back cleanly on failure',
  {skip: PGlite ? false : 'no PGlite module', timeout: 240000}, async () => {
    const {installPostingFixture} = await import(pathToFileURL(resolvePath('scripts/ci/posting-v2-fixture.mjs')).href);
    const src = path => readFileSync(join(process.cwd(), path), 'utf8');
    const fm = 'supabase/forward-migrations/';
    const db = new PGlite();
    await installPostingFixture(db);
    await db.exec(`alter table public.listings add column if not exists slug text,add column if not exists created_at timestamptz default now(),add column if not exists published_at timestamptz,add column if not exists expires_at timestamptz,add column if not exists search_vector tsvector;
      alter table public.categories add column if not exists icon text;
      alter table public.cities add column if not exists name text default 'Bengaluru',add column if not exists state text default 'Karnataka';
      alter table public.localities add column if not exists name text default 'Koramangala';
      create table if not exists public.user_accounts(user_id uuid primary key,account_status text);
      create or replace function app_security.is_listing_publicly_visible(target uuid) returns boolean language sql stable security definer set search_path='' as $f$select exists(select 1 from public.listings l join public.user_accounts ua on ua.user_id=l.seller_id where l.id=target and l.status='active' and ua.account_status='active')$f$;
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);`);
    const record = async (candidateOrNull, version, name, text) => db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3)', [version, name, splitStatements(text)]);
    const install = async (path, version, name) => { const text = src(path); await db.exec(text); await record(null, version, name, text); };
    await install(`${fm}posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql`, '20261101234604', 'posting_v212_session_recovery');
    await install(getCandidate('accessories-v1-foundation').path, '20261102164135', 'accessories_v1');
    await install(`${fm}posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql`, '20261025135152', 'activate_posting_v2_mobiles');
    await install(`${fm}tablets-v1/supabase/migrations/20261102165946_posting_v2_tablets.sql`, '20261102165946', 'posting_v2_tablets');
    await install(getCandidate('tablets-v2-catalogue').path, TV2_ROW, 'tablets_v2_india_catalogue');
    // moderation switching is recorded with its real stored statements (its SQL needs the moderation schema, which this fixture lacks)
    await record(null, SW_ROW, 'moderation_provider_switching', src(getCandidate('moderation-switching-v1').path));

    const rows = async sql => (await db.query(sql)).rows;
    const snapshot = async () => {
      const tables = (await rows("select tablename from pg_tables where schemaname='public' and tablename like 'tablet%' order by 1")).map(r => r.tablename);
      const data = {};
      for (const t of tables) data[t] = (await rows(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h, count(*)::int n from public.${t} x`))[0];
      const columns = (await rows("select md5(string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable, ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema='public' and table_name like 'tablet%'"))[0].h;
      const functions = (await rows("select md5(string_agg(p.oid::regprocedure::text||md5(p.prosrc)||p.proacl::text, '|' order by p.oid::regprocedure::text)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like '%tablet%' and n.nspname in ('public','app_security')"))[0].h;
      const policies = (await rows("select md5(coalesce(string_agg(tablename||policyname||cmd||coalesce(qual,''), '|' order by tablename, policyname), '')) h from pg_policies where tablename like 'tablet%'"))[0].h;
      return {tables, data, columns, functions, policies};
    };
    const readLedger = async () => {
      let query;
      try { readTabletsLedger(sql => { query = sql; throw new Error('capture'); }); } catch (e) { assert.equal(e.message, 'capture'); }
      const results = await db.exec(query);
      return JSON.parse(results.find(r => r.rows?.length)?.rows[0] && Object.values(results.find(r => r.rows?.length).rows[0])[0]);
    };
    assert.ok((await snapshot()).tables.length > 0);
    const ledgerBefore = await readLedger();
    // the registry's Tablets V2 identity is the real stored-statements digest of the installed row
    for (const [version, pin] of [[TV2_ROW, TABLETS_V2_LEDGER], [SW_ROW, MODERATION_SWITCHING_LEDGER]]) {
      const row = ledgerBefore.find(r => r.version === version);
      assert.equal(row.statementsSha256, pin.statementsSha256);   // the registry identity is the real stored-statements digest
      assert.equal(row.statementCount, pin.statementCount);
      assert.equal(row.hasStatements, true);
    }
    assert.deepEqual(assertLedgerTail(getCandidate(WF), ledgerBefore, 'FairSwapProd'), {includeAll: true, ahead: [TV2_ROW, SW_ROW]});
    assert.throws(() => assertLedgerTail(getCandidate(WF), ledgerBefore, 'FairSwapTest'), /WEARABLES_LEDGER_TAIL_AHEAD/);
    const before = await snapshot();
    const sessionBody = async () => (await rows("select md5(prosrc) h from pg_proc where oid='app_security.impl_posting_v2_session(uuid,text,uuid)'::regprocedure"))[0].h;
    const sessionBefore = await sessionBody();

    // failure inside the foundation transaction: nothing of it survives and no ledger row is written
    const foundationSql = src(getCandidate(WF).path);
    const lastCommit = foundationSql.lastIndexOf('commit;');
    assert.ok(lastCommit > 0);
    await assert.rejects(db.exec(foundationSql.slice(0, lastCommit) + 'select 1/0;\ncommit;'), /division by zero/);
    await db.exec('rollback');
    assert.equal((await rows("select to_regclass('public.wearable_release_v1') is null as gone"))[0].gone, true);
    assert.equal(await sessionBody(), sessionBefore);
    assert.deepEqual(await readLedger(), ledgerBefore);
    assert.deepEqual(await snapshot(), before);

    // out-of-order install of the unchanged foundation, ledger row recorded behind Tablets V2
    assert.equal(createHash('sha256').update(foundationSql).digest('hex'), getCandidate(WF).sha256);
    await db.exec(foundationSql);
    await record(null, '20261104120000', 'posting_v2_wearables', foundationSql);
    const ledgerAfter = await readLedger();
    assert.deepEqual(ledgerAfter.map(r => r.version), [...ledgerAfter.map(r => r.version)].sort());
    assert.ok(ledgerAfter.findIndex(r => r.version === '20261104120000') < ledgerAfter.findIndex(r => r.version === TV2_ROW));
    assert.equal(verifyTabletsLedger(ledgerBefore, ledgerAfter, getCandidate(WF)), ledgerAfter.find(r => r.version === '20261104120000').statementsSha256);
    // Tablets V2 data, columns, RLS policies and tablet function bodies/ACLs are untouched
    assert.deepEqual(await snapshot(), before);
    assert.equal((await rows("select to_regclass('public.wearable_release_v1') is not null as present"))[0].present, true);
    assert.equal((await rows('select enabled from public.wearable_release_v1'))[0].enabled, false);   // installed disabled
    assert.notEqual(await sessionBody(), sessionBefore);                                             // reviewed session-core wrapper only
    await db.close();
  });

// Disposable PostgreSQL (PGlite): the REAL moderation-switching finalizer definition and the REAL activation compatibility block.
// Both migrations are executed from their reviewed source (switching: only its finalizer DO block, because the rest needs the
// full moderation schema; activation: its W-AZ-1 DO block). Only the inner implementation is stubbed for the routing behaviour.
test('disposable PostgreSQL: activation after moderation switching wraps the switching finalizer; the Azure-only finalizer is refused',
  {skip: PGlite ? false : 'no PGlite module', timeout: 120000}, async () => {
    const root = process.cwd();
    const switching = readFileSync(join(root, getCandidate('moderation-switching-v1').path), 'utf8');
    const switchingBlock = switching.slice(switching.indexOf('DO $$', switching.indexOf('-- 3. Core Provider-Switchable Finalizer Definition')),
      switching.indexOf('END $$;', switching.indexOf('-- 3. Core Provider-Switchable Finalizer Definition')) + 'END $$;'.length);
    const activation = readFileSync(join(root, getCandidate(WA).path), 'utf8');
    const compat = activation.slice(activation.indexOf('do $$\ndeclare'), activation.indexOf('\nupdate public.categories'));
    const azureFile = readFileSync(join(root, getCandidate('moderation-azure-v1').path), 'utf8');
    const azureStart = azureFile.indexOf('AS $$\n', azureFile.indexOf('CREATE OR REPLACE FUNCTION app_security.impl_finalize_moderation_result(')) + 5;
    const azureBody = azureFile.slice(azureStart, azureFile.indexOf('\n$$;', azureStart) + 1);
    assert.ok(switchingBlock.startsWith('DO $$') && switchingBlock.includes('v_target_func') && compat.startsWith('do $$') && compat.includes('WEARABLES_AZURE_BASELINE_DRIFT'));
    const FIN = 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)';
    const INNER = 'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)';
    const sig = 'p_request_id uuid,p_claim_token uuid,p_outcome text,p_ruleset_version text,p_scope text,p_completed_rules text[],p_failed_rules text[],p_flags jsonb,p_errors jsonb default \'[]\'::jsonb';
    const hash = async oid => (await db.query(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid='${oid}'::regprocedure`)).rows[0].h;
    const priv = async (role, oid) => (await db.query(`select has_function_privilege('${role}','${oid}','EXECUTE') p`)).rows[0].p;
    const db = new PGlite();
    await db.exec(`set check_function_bodies = off;
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
      create schema app_security;
      create table public.listings(id uuid primary key);
      create table public.listing_moderation_requests(id uuid primary key, listing_id uuid);
      create table public.listing_wearable_risk_flags_v1(listing_id uuid);
      create table app_security.listing_moderation_scan_receipts(id uuid);`);
    const tampered = body => `drop function if exists ${FIN};create function app_security.impl_finalize_moderation_result(${sig}) returns jsonb language plpgsql volatile security definer set search_path='' as $t$${body}$t$;`;

    // 1. real switching finalizer on an unwrapped database: its body hash is the pin used by the activation SQL and the release scripts
    await db.exec(switchingBlock);
    assert.equal(await hash(FIN), SWITCHING_FINALIZER_BODY_SHA256);
    assert.notEqual(SWITCHING_FINALIZER_BODY_SHA256, AZURE_FINALIZER_BODY_SHA256);
    const switchingBody = (await db.query(`select prosrc from pg_proc where oid='${FIN}'::regprocedure`)).rows[0].prosrc;

    // 2. unexpected Azure-only finalizer state and any drift are refused (nothing is renamed or created)
    await db.exec(tampered(azureBody));
    assert.equal(await hash(FIN), AZURE_FINALIZER_BODY_SHA256);
    await assert.rejects(db.exec(compat), /WEARABLES_AZURE_BASELINE_DRIFT/);
    await db.exec(tampered('begin return null::jsonb; end'));
    await assert.rejects(db.exec(compat), /WEARABLES_AZURE_BASELINE_DRIFT/);
    assert.equal((await db.query(`select to_regprocedure('${INNER}') is null n`)).rows[0].n, true);

    // 3. restore the real switching body and run the real activation block
    await db.exec(tampered(switchingBody));
    assert.equal(await hash(FIN), SWITCHING_FINALIZER_BODY_SHA256);
    await db.exec(compat);
    assert.equal(await hash(INNER), SWITCHING_FINALIZER_BODY_SHA256);      // the renamed inner finalizer retains the switching body
    assert.notEqual(await hash(FIN), SWITCHING_FINALIZER_BODY_SHA256);     // the outer function is the Wearables wrapper
    const wrapper = (await db.query(`select prosrc, prosecdef from pg_proc where oid='${FIN}'::regprocedure`)).rows[0];
    assert.ok(wrapper.prosecdef && wrapper.prosrc.includes('listing_wearable_risk_flags_v1') && wrapper.prosrc.includes('needs_review') && wrapper.prosrc.includes('impl_finalize_moderation_result_azure_v1'));
    // permissions: only service_role can call the wrapper; no role can call the inner implementation directly
    assert.equal(await priv('service_role', FIN), true);
    for (const role of ['public', 'anon', 'authenticated']) assert.equal(await priv(role, FIN), false, role);
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) assert.equal(await priv(role, INNER), false, role);
    await assert.rejects(db.exec(compat), /WEARABLES_AZURE_FINALIZER_ALREADY_WRAPPED/);   // cannot wrap twice

    // 4. routing: a flagged wearable can never finalize as auto-approved; everything else is passed through unchanged
    await db.exec(`drop function ${INNER};create function ${INNER.split('(')[0]}(${sig}) returns jsonb language sql as $s$select jsonb_build_object('outcome', p_outcome)$s$;
      insert into public.listings values('00000000-0000-0000-0000-0000000000a1'),('00000000-0000-0000-0000-0000000000a2');
      insert into public.listing_moderation_requests values('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1'),('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000a2');
      insert into public.listing_wearable_risk_flags_v1 values('00000000-0000-0000-0000-0000000000a1');`);
    const call = async (req, outcome) => (await db.query(`select (${FIN.split('(')[0]}('${req}','00000000-0000-0000-0000-0000000000c1','${outcome}','r','s',array[]::text[],array[]::text[],'[]'::jsonb,'[]'::jsonb))->>'outcome' o`)).rows[0].o;
    assert.equal(await call('00000000-0000-0000-0000-0000000000b1', 'no_review_flags'), 'needs_review');   // flagged -> staff review
    assert.equal(await call('00000000-0000-0000-0000-0000000000b2', 'no_review_flags'), 'no_review_flags'); // unflagged unchanged
    assert.equal(await call('00000000-0000-0000-0000-0000000000b1', 'blocked'), 'blocked');
    await db.close();
  });

test('Mobile Catalogue is checksum-pinned and dispatches only through Test with automatic promotion', () => {
  const {candidate, sha256} = verifyCandidateSha(MOBILE_CATALOGUE_CANDIDATE);
  assert.equal(candidate.version, '20261105213015');
  assert.equal(sha256, '4bb663e766876f34136620651308c41293cce1e9411c7247bd87801a7cd9f360');
  assert.equal(candidate.autoPromote, true);
  const plan = target => planDispatch({candidateId: candidate.id, target});
  assert.deepEqual(plan('test').priorRuns, []);
  assert.equal(plan('test').webStagingSha, null);
  assert.throws(() => plan('production'), /TARGET_NOT_SUPPORTED/);
  assert.throws(() => plan('adopt'), /ADOPTION_NOT_REGISTERED/);
  const yaml = readFileSync('.github/workflows/reusable-supabase-release.yml', 'utf8');
  assert.match(yaml, /- mobile-catalogue-india-v1\n/);
  assert.ok(yaml.indexOf('sha256sum --check --status') < yaml.indexOf('Verify Mobile Catalogue Test postflight receipt'));
  assert.ok(yaml.includes("needs.test.result == 'success' && needs.verify_test.result == 'success' &&"));
  assert.ok(yaml.includes("inputs.candidate != 'mobile-catalogue-india-v1' || needs.verify_test.outputs.mobile_catalogue_ledger_sha != ''"));
  assert.ok(yaml.includes("inputs.target == 'production' && needs.test.result == 'skipped' && needs.verify_test.result == 'skipped' && inputs.candidate != 'v3-provider-neutral-activation' && inputs.candidate != 'mobile-catalogue-india-v1'"));
});

const mobileContext = {...baseEnv, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '119', GITHUB_RUN_ATTEMPT: '1', TARGET: 'test'};
const mobileLedgerDigest = 'b'.repeat(64);
function mobileSnapshotOutput({brands, models, ...over}) {
  const fingerprints = (count, prefix) => Array.from({length: count},
    (_, i) => createHash('sha256').update(prefix + i).digest('hex'));
  return [
    JSON.stringify({
      brands: fingerprints(brands, 'brand'), models: fingerprints(models, 'model'),
      listingReferences: [], fallbacks: true, referencesValid: true,
      visibleBrands: brands, visibleModels: models, sellerPermissions: true, security: 'c'.repeat(64), ...over
    }),
    JSON.stringify({
      version: 2, enabled: true, brands, models,
      selection: {category: 'mobiles', subcategory: 'mobile-phones', version: 2}
    })
  ].join('\n');
}

test('Mobile Catalogue verifies both stages, refuses invalid Test proof and withholds receipts on drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-release-receipt-'));
  const candidate = getCandidate(MOBILE_CATALOGUE_CANDIDATE);
  const execute = (environment, env = {}, options = {}) => {
    const history = [...baseHistory.map(version => ({version, name: 'historical', hasStatements: true,
      statementsSha256: mobileLedgerDigest})), ...mobileRows(environment).map(row => ({...row, statementsSha256: mobileLedgerDigest}))];
    const before = history.map(row => row.version);
    const after = [...before, candidate.version];
    let ledgerReads = 0;
    let snapshots = 0;
    const runner = makeRunner({before, after, filename: candidate.filename, sql: () => [
      ...history, ...(++ledgerReads === 3 ? [{version: candidate.version, name: candidate.filename.slice(15, -4),
        hasStatements: true, statementsSha256: options.ledgerDigest ?? mobileLedgerDigest}] : [])
    ]});
    return releaseReusable({environment, candidateId: candidate.id, receiptDir: dir, context: {...mobileContext, ...env},
      runner: (cmd, args, ...rest) => {
        if (cmd === 'psql' && args.at(-1).startsWith('-- mobile-catalogue-integrity')) {
          return ++snapshots === 1 ? mobileSnapshotOutput({brands: 21, models: 100}) :
            mobileSnapshotOutput({brands: 27, models: 1473, ...options.postflight});
        }
        options.calls?.push([cmd, ...args]);
        return runner(cmd, args, ...rest);
      }});
  };

  try {
    const calls = [];
    await assert.rejects(execute('FairSwapProd', {}, {calls}), /TEST_EVIDENCE_REQUIRED/);
    await assert.rejects(execute('FairSwapProd', {TARGET: 'production', MOBILE_CATALOGUE_TEST_LEDGER_SHA: mobileLedgerDigest},
      {calls}), /TEST_EVIDENCE_REQUIRED/);
    assert.deepEqual(calls, []);

    const testReceipt = await execute('FairSwapTest');
    const digest = verifyMobileCatalogueTestReceipt(testReceipt, mobileContext);
    assert.equal(digest, mobileLedgerDigest);
    for (const invalid of [{environment: 'FairSwapProd'}, {releaseWorkflowRun: '120'}, {releaseWorkflowAttempt: '2'},
      {reviewedCommit: 'f'.repeat(40)}, {migrationSha256: 'd'.repeat(64)}, {postflightVerified: false},
      {ledgerStatementsSha256: 'invalid'}, {postflightScope: ''}]) {
      assert.throws(() => verifyMobileCatalogueTestReceipt({...testReceipt, ...invalid}, mobileContext), /TEST_RECEIPT_INVALID/);
    }
    const env = {MOBILE_CATALOGUE_TEST_LEDGER_SHA: digest};
    await assert.rejects(execute('FairSwapProd', env, {ledgerDigest: 'a'.repeat(64)}), /TEST_LEDGER_MISMATCH/);
    await assert.rejects(execute('FairSwapProd', env, {postflight: {fallbacks: false}}), /AFTER_INVALID/);
    assert.ok(!existsSync(join(dir, `${candidate.id}-fairswapprod.json`)));
    const production = await execute('FairSwapProd', env);
    assert.equal(production.testLedgerStatementsSha256, digest);
    assert.equal(production.postflightVerified, true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('real PostgreSQL: Mobile Catalogue verifies IDs, listing references, fallbacks, seller ACLs and RLS',
  {skip: pgBin ? false : 'no local PostgreSQL binaries; enforced when REQUIRE_REAL_PG=1'}, async () => {
    const {installPostingFixture} = await import('../../scripts/ci/posting-v2-fixture.mjs');
    const pg = startPg(pgBin);
    try {
      await installPostingFixture({exec: async sql => pg.run(sql)});
      pg.run('grant select on public.categories to anon, authenticated');
      pg.run(readFileSync('supabase/forward-migrations/posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql', 'utf8'));
      const addListing = `
        WITH listing AS (
          INSERT INTO public.listings (id, category_id)
          SELECT gen_random_uuid(), listing_category_id FROM public.posting_category_definitions RETURNING id, category_id
        )
        INSERT INTO public.listing_mobile_contexts (listing_id, category_id, brand_id, model_id, brand_name, model_name, storage)
        SELECT l.id, l.category_id, b.id, m.id, b.name, m.name, '128 GB'
        FROM listing l, public.phone_brands b JOIN public.phone_models m ON m.brand_id = b.id
        WHERE b.name = 'Apple' AND m.name = 'iPhone 15';
      `;
      pg.run(addListing);
      const before = readMobileCatalogueSnapshot(pg.run, 'before');
      const catalogueSql = readFileSync(getCandidate(MOBILE_CATALOGUE_CANDIDATE).path, 'utf8');
      pg.run(catalogueSql);
      const statements = JSON.stringify(splitStatements(catalogueSql)).replaceAll("'", "''");
      pg.run(`CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, name text, statements text[]);
        INSERT INTO supabase_migrations.schema_migrations VALUES (
          '${mobileCatalogueRow.version}', '${mobileCatalogueRow.name}',
          ARRAY(SELECT json_array_elements_text('${statements}'::json))); `);
      const readLedger = () => readTabletsLedger(pg.run);
      assert.deepEqual(readLedger(), [mobileCatalogueRow]);
      assert.deepEqual(assertLedgerTail(getCandidate(WA), readLedger(), 'FairSwapProd'),
        {includeAll: true, ahead: [mobileCatalogueRow.version]});
      pg.run("UPDATE supabase_migrations.schema_migrations SET statements[1] = 'select 1'");
      assert.throws(() => assertLedgerTail(getCandidate(WA), readLedger(), 'FairSwapProd'), /WEARABLES_LEDGER_TAIL_AHEAD/);
      assert.deepEqual(verifyMobileCataloguePostflight(before, pg.run), {verified: true});
      pg.run(addListing);
      assert.deepEqual(verifyMobileCataloguePostflight(before, pg.run), {verified: true});
      const detectAndRestore = (change, restore, error) => {
        pg.run(change);
        try { assert.throws(() => verifyMobileCataloguePostflight(before, pg.run), error); }
        finally { pg.run(restore); }
      };
      detectAndRestore("update public.phone_models set name = 'iPhone altered' where name = 'iPhone 15'",
        "update public.phone_models set name = 'iPhone 15' where name = 'iPhone altered'", /EXISTING_ROWS_CHANGED: models/);
      detectAndRestore("update public.listing_mobile_contexts set model_id = (select id from public.phone_models where name = 'iPhone 16')",
        "update public.listing_mobile_contexts set model_id = (select id from public.phone_models where name = 'iPhone 15')",
        /EXISTING_ROWS_CHANGED: listingReferences/);
      detectAndRestore("update public.phone_models set other = false where other and brand_id = (select id from public.phone_brands where name = 'CMF')",
        "update public.phone_models set other = true where name = 'Other model' and brand_id = (select id from public.phone_brands where name = 'CMF')",
        /AFTER_INVALID/);
      detectAndRestore('create policy extra_phone_read on public.phone_models for select to anon using (true)',
        'drop policy extra_phone_read on public.phone_models', /PERMISSIONS_CHANGED/);
      detectAndRestore('grant update (name) on public.phone_models to authenticated',
        'revoke update (name) on public.phone_models from authenticated', /AFTER_INVALID/);
    } finally { pg.stop(); }
  });
// Catalogue updates reuse the same ledger, receipt and staging Web evidence gates.
test('Wearables V1.1 registry hash and Test-to-Production evidence fail closed', () => {
 const candidate=getCandidate('wearables-v11-catalogue');
 assert.equal(verifyCandidateSha(candidate.id).sha256,candidate.sha256);
 assert.equal(candidate.strict,true);assert.equal(candidate.autoPromote,false);
 assert.deepEqual(candidate.requiredLedgerVersions,['20261104120000','20261104230000']);
 assert.equal(planDispatch({candidateId:candidate.id,target:'test'}).priorRuns.length,0);
 assert.throws(()=>planDispatch({candidateId:candidate.id,target:'production'}),/EVIDENCE_RUN_REQUIRED/);
 assert.throws(()=>planDispatch({candidateId:candidate.id,target:'production',inputs:{test_catalogue_run_id:'123'}}),/WEB_STAGING_VERIFICATION_REQUIRED/);
 const plan=planDispatch({candidateId:candidate.id,target:'production',inputs:{test_catalogue_run_id:'123',web_staging_sha:'a'.repeat(40)}});
 assert.equal(plan.priorRuns[0].candidateId,candidate.id);assert.equal(plan.priorRuns[0].environment,'test');
 assert.throws(()=>planDispatch({candidateId:candidate.id,target:'production',inputs:{test_e2e_run_id:WEARABLES_E2E_WAIVER.input}}),/E2E_WAIVER_SCOPE_INVALID/);
});

test('Wearables V1.1 postflight rejects catalogue, enabled-state and security metadata drift', async () => {
 const {runWearablesV11Preflight,runWearablesV11Postflight}=await import('../../scripts/release/wearables-v11-release.mjs');
 const m=JSON.parse(readFileSync('supabase/forward-migrations/wearables-v11/catalogue-manifest.json'));
 const before={revision:m.oldRevision,digest:m.oldDigest,enabled:true,intact:true,metadata:{functions:['unchanged']}};
 const after={...before,revision:m.revision,digest:m.digest};const exec=value=>()=>JSON.stringify(value);
 assert.deepEqual(runWearablesV11Preflight(exec(before)),before);
 assert.deepEqual(runWearablesV11Postflight(before,exec(after)),{verified:true,revision:m.revision});
 assert.throws(()=>runWearablesV11Preflight(exec({...before,digest:'changed'})),/BASELINE_DRIFT/);
 for(const patch of [{revision:'old'},{digest:'changed'},{enabled:false},{intact:false},{metadata:{functions:['drift']}}])
  assert.throws(()=>runWearablesV11Postflight(before,exec({...after,...patch})),/WEARABLES_V11/);
 assert.throws(()=>runWearablesV11Postflight(undefined,exec(after)),/PREFLIGHT_REQUIRED/);
});

// ---------------------------------------------------------------------------------------------
// IDV DigiLocker V1 (dark): exact reviewed migration, environment-specific foundation, out-of-order install
// ---------------------------------------------------------------------------------------------
const idvContext = {...baseEnv, GITHUB_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '131', GITHUB_RUN_ATTEMPT: '1', TARGET: 'test'};
const idvByVersion = (a, b) => a.version.localeCompare(b.version);
const idvTailRows = (environment = 'FairSwapTest') => idvDigilockerTail(environment).map(pin => {
  const c = getCandidate(pin.candidateId);
  return {version: c.version, name: c.filename.slice(15, -4), hasStatements: true, statementCount: pin.statementCount, statementsSha256: pin.statementsSha256};
});
const idvLedger = (environment, {extra = [], tail = idvTailRows(environment), foundation = IDV_FOUNDATION_LEDGER[environment]} = {}) => [
  ...baseHistory.map(version => ({version, name: 'historical', hasStatements: true, statementCount: 1, statementsSha256: 'e'.repeat(64)})),
  ...(foundation ? [{...foundation, hasStatements: true, statementCount: 1, statementsSha256: 'd'.repeat(64)}] : []),
  ...extra, ...tail
].sort(idvByVersion);
const idvChecks = (checks, over = {}) => ({checks: {...Object.fromEntries(Object.keys(checks).map(k => [k, true])), ...over}, preserved: 'f'.repeat(64)});

function idvRun(environment, {ledger = idvLedger(environment), env = {}, ledgerDigest = 'b'.repeat(64), pre = {}, post = {}, preserved,
  installed = {}, dryOutput, help = 'Flags:\n      --dry-run\n      --include-all\n', candidateId = IDV_DIGILOCKER_CANDIDATE} = {}) {
  const c = getCandidate(candidateId);
  const dir = mkdtempSync(join(tmpdir(), 'idv-release-'));
  const full = [];
  const before = ledger.map(row => row.version);
  let ledgerReads = 0;
  const base = makeRunner({before, after: before.includes(c.version) ? before : [...before, c.version], filename: c.filename, sql: q => {
    if (q.startsWith('-- idv-digilocker-v2-preflight')) return idvChecks(IDV_DIGILOCKER_V2_PREFLIGHT, pre);
    if (q.startsWith('-- idv-digilocker-v2-postflight')) return {...idvChecks(IDV_DIGILOCKER_V2_POSTFLIGHT, post), ...(preserved ? {preserved} : {})};
    if (q.startsWith('-- idv-digilocker-installed')) {
      const acr = ledger.some(row => row.version === '20261123120000') ? 'applied' : 'absent';   // the exact ACR row selects its checks
      return idvChecks(idvDigilockerInstalledChecks('historical', acr), installed);
    }
    if (q.startsWith('-- idv-digilocker-preflight')) return idvChecks(environment === 'FairSwapProd' ? IDV_DIGILOCKER_PRODUCTION_PREFLIGHT : IDV_DIGILOCKER_PREFLIGHT, pre);
    if (q.startsWith('-- idv-digilocker-postflight')) return {...idvChecks(environment === 'FairSwapProd' ? IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT : IDV_DIGILOCKER_POSTFLIGHT, post), ...(preserved ? {preserved} : {})};
    return [...ledger, ...(++ledgerReads === 3 ? [{version: c.version, name: c.filename.slice(15, -4), hasStatements: true,
      statementCount: 92, statementsSha256: ledgerDigest}] : [])].sort(idvByVersion);
  }});
  const runner = (cmd, args, ...rest) => {
    full.push([cmd, ...args]);
    if (cmd === 'supabase' && args.includes('--help')) return help;
    if (cmd === 'supabase' && args.includes('--dry-run') && dryOutput) return dryOutput;
    return base(cmd, args, ...rest);
  };
  const result = releaseReusable({environment, candidateId: c.id, receiptDir: dir, context: {...idvContext, ...env}, runner});
  return {result, full, dir};
}
const idvApplies = full => pushes(full).filter(c => !c.includes('--dry-run'));

test('IDV DigiLocker V1 is pinned to the reviewed migration and reaches Production only by automatic promotion after Test', () => {
  const {candidate, sha256} = verifyCandidateSha(IDV_DIGILOCKER_CANDIDATE);
  assert.deepEqual([candidate.version, candidate.filename, candidate.path, sha256], ['20261117090000', '20261117090000_idv_digilocker_direct_v1.sql',
    'supabase/forward-migrations/idv/20261117090000_idv_digilocker_direct_v1.sql', 'c51fbc4f24d6085d3c1b022d2fea114e59b911c2aea772f125b4e798f304b62d']);
  assert.equal(candidate.autoPromote, true);
  assert.equal(candidate.testOnly, undefined);
  assert.equal(candidate.strict, undefined);
  assert.equal(candidate.requiredLedgerVersions, undefined);   // the foundation prerequisite is environment specific
  const plan = target => planDispatch({candidateId: candidate.id, target});
  assert.deepEqual(plan('test').priorRuns, []);
  assert.throws(() => plan('production'), /TARGET_NOT_SUPPORTED/);   // never a manual Production dispatch
  assert.throws(() => plan('adopt'), /ADOPTION_NOT_REGISTERED/);
  const v2 = verifyCandidateSha(IDV_DIGILOCKER_V2_CANDIDATE);
  assert.deepEqual([v2.candidate.version, v2.candidate.filename, v2.candidate.path, v2.sha256, v2.candidate.autoPromote, v2.candidate.testOnly],
    ['20261119200000', '20261119200000_idv_digilocker_oidc_v2_badge.sql', 'supabase/forward-migrations/idv/20261119200000_idv_digilocker_oidc_v2_badge.sql',
      v2.candidate.sha256, true, undefined]);
  assert.deepEqual(v2.candidate.requiredLedgerVersions, [candidate.version]);
  assert.throws(() => planDispatch({candidateId: v2.candidate.id, target: 'production'}), /TARGET_NOT_SUPPORTED/);
  assert.throws(() => planDispatch({candidateId: 'idv-digilocker-v2', target: 'test'}), /UNKNOWN_CANDIDATE/);
  const yaml = readFileSync('.github/workflows/reusable-supabase-release.yml', 'utf8');
  assert.match(yaml, /- idv-digilocker-v1\n {10}- idv-digilocker-oidc-v2\n/);
  assert.ok(yaml.indexOf('sha256sum --check --status') < yaml.indexOf('Verify IDV DigiLocker V1 Test postflight receipt'));
  assert.ok(yaml.includes("inputs.candidate != 'idv-digilocker-v1' || needs.verify_test.outputs.idv_digilocker_ledger_sha != ''"));
  assert.ok(yaml.includes("inputs.candidate != 'idv-digilocker-oidc-v2' || needs.verify_test.outputs.idv_digilocker_ledger_sha != ''"));
  assert.ok(yaml.includes("inputs.target == 'production' && needs.test.result == 'skipped' && needs.verify_test.result == 'skipped' && inputs.candidate != 'v3-provider-neutral-activation' && inputs.candidate != 'mobile-catalogue-india-v1' && inputs.candidate != 'idv-digilocker-v1' && inputs.candidate != 'idv-digilocker-oidc-v2'"));
  assert.ok(yaml.includes('IDV_DIGILOCKER_TEST_LEDGER_SHA: ${{ needs.verify_test.outputs.idv_digilocker_ledger_sha }}'));
  assert.ok(yaml.includes("test-evidence/${process.env.CANDIDATE}-fairswaptest.json"));
  // Existing credentials and environments only; no feature flag, provider secret or Edge deployment in this workflow.
  assert.deepEqual([...new Set(yaml.match(/secrets\.[A-Z0-9_]+/g))].sort(), ['secrets.CHAT_DATABASE_PASSWORD', 'secrets.CHAT_DB_SSL_ROOT_CERT_PEM',
    'secrets.CHAT_RELEASE_AUDIT_TOKEN', 'secrets.FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN', 'secrets.FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN']);
  assert.deepEqual([...new Set(yaml.match(/^ {4}environment: \S+$/gm))].sort(), ['    environment: FairSwapProd', '    environment: FairSwapTest']);
  assert.doesNotMatch(yaml, /DIGILOCKER_ENABLED|identity_verification_required|functions deploy|secrets set/i);
});

test('IDV DigiLocker checks cover every function in the reviewed SQL, the gate stays default OFF, and the tail is pinned to reviewed CLI digests', () => {
  const sql = readFileSync(join(process.cwd(), getCandidate(IDV_DIGILOCKER_CANDIDATE).path), 'utf8');
  const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(m => m[1]).sort();
  assert.equal(created.length, 26);
  assert.deepEqual(Object.values(IDV_DIGILOCKER_FUNCTIONS).flat().map(sig => sig.split('(')[0]).sort(), created);
  assert.match(sql, /VALUES \('identity_verification_required', 'false',[\s\S]*?ON CONFLICT \(setting_key\) DO NOTHING;/);
  for (const pin of IDV_DIGILOCKER_TAIL) {
    const statements = splitStatements(readFileSync(join(process.cwd(), getCandidate(pin.candidateId).path), 'utf8'));
    assert.equal(statements.length, pin.statementCount, pin.candidateId);
    assert.equal(pgDigest(statements), pin.statementsSha256, pin.candidateId);
  }
  assert.deepEqual(IDV_DIGILOCKER_TAIL.map(pin => getCandidate(pin.candidateId).version), ['20261117185218', '20261118092010']);
  assert.deepEqual(JSON.parse(JSON.stringify(IDV_FOUNDATION_LEDGER)), {
    FairSwapTest: {version: '20261028091220', name: 'idv_digilocker_foundation_v1'},
    FairSwapProd: {version: '20261028095605', name: 'idv_digilocker_foundation_v1'}
  });
  for (const [checks, label] of [[IDV_DIGILOCKER_PREFLIGHT, 'preflight'], [IDV_DIGILOCKER_POSTFLIGHT, 'postflight']]) {
    const text = idvSnapshotSql(checks, label);
    assert.ok(text.startsWith(`-- idv-digilocker-${label}\nBEGIN READ ONLY;\n`) && text.endsWith('COMMIT;'), label);
    assert.equal(text.split(';').length - 1, 4, label);   // BEGIN READ ONLY, SET LOCAL, one SELECT, COMMIT
  }
});

test('IDV DigiLocker ledger guard requires the environment foundation row and exactly the reviewed newer tail', () => {
  const ok = assertIdvDigilockerLedger('FairSwapTest', idvLedger('FairSwapTest'));
  assert.deepEqual(ok, {includeAll: true, ahead: ['20261117185218', '20261118092010']});
  assert.deepEqual(assertIdvDigilockerLedger('FairSwapProd', idvLedger('FairSwapProd')),
    {includeAll: true, ahead: IDV_DIGILOCKER_PRODUCTION_TAIL.map(pin => getCandidate(pin.candidateId).version)});
  const fails = (environment, ledger, re) => assert.throws(() => assertIdvDigilockerLedger(environment, ledger), re);
  fails('FairSwapTest', idvLedger('FairSwapProd'), /FOUNDATION_PREREQUISITE_MISMATCH/);   // other environment's history
  fails('FairSwapProd', idvLedger('FairSwapTest'), /FOUNDATION_PREREQUISITE_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {foundation: null}), /FOUNDATION_PREREQUISITE_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {foundation: {...IDV_FOUNDATION_LEDGER.FairSwapTest, name: 'idv_foundation'}}), /FOUNDATION_PREREQUISITE_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest').map(r => r.name === 'idv_digilocker_foundation_v1' ? {...r, hasStatements: false} : r), /FOUNDATION_PREREQUISITE_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {extra: [{version: '20261026183000', name: 'idv_digilocker_foundation', hasStatements: true}]}), /FOUNDATION_HISTORY_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {extra: [{version: '20261117090000', name: 'idv_digilocker_direct_v1', hasStatements: true}]}), /ALREADY_RECORDED/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {extra: [{version: '20261101000000', name: 'idv_digilocker_direct_v1', hasStatements: true}]}), /ALREADY_RECORDED/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {extra: [{version: '20261118100000', name: 'unreviewed', hasStatements: true, statementCount: 1, statementsSha256: 'a'.repeat(64)}]}), /LEDGER_TAIL_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {tail: idvTailRows().slice(1)}), /LEDGER_TAIL_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {tail: idvTailRows().slice(0, 1)}), /LEDGER_TAIL_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {tail: idvTailRows().map((r, i) => i ? {...r, statementsSha256: 'f'.repeat(64)} : r)}), /LEDGER_TAIL_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {tail: idvTailRows().map((r, i) => i ? r : {...r, statementCount: 46})}), /LEDGER_TAIL_MISMATCH/);
  fails('FairSwapTest', idvLedger('FairSwapTest', {tail: []}), /LEDGER_TAIL_MISMATCH/);
  fails('FairSwapStaging', idvLedger('FairSwapTest'), /ENVIRONMENT_INVALID/);
});

test('IDV DigiLocker releases to Test out of order with a verified, sanitized receipt and can never release to Production', async () => {
  const c = getCandidate(IDV_DIGILOCKER_CANDIDATE);
  const test = idvRun('FairSwapTest');
  let testReceipt;
  try {
    testReceipt = await test.result;
    assert.equal(testReceipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.deepEqual([testReceipt.projectRef, testReceipt.migrationVersion, testReceipt.migrationFile, testReceipt.migrationSha256],
      [REFS.FairSwapTest, c.version, c.filename, c.sha256]);
    assert.deepEqual(testReceipt.dryRunPending, [c.filename]);
    assert.deepEqual(testReceipt.outOfOrderInstall, {includeAll: true, aheadVersions: ['20261117185218', '20261118092010']});
    assert.deepEqual(testReceipt.prerequisiteLedger, IDV_FOUNDATION_LEDGER.FairSwapTest);
    assert.equal(testReceipt.identityVerificationRequired, false);
    assert.equal(testReceipt.edgeFunctionsDeployedByThisWorkflow, false);
    assert.equal(testReceipt.postflightScope, IDV_DIGILOCKER_SCOPE);
    const bytes = readFileSync(join(test.dir, 'idv-digilocker-v1-fairswaptest.json'), 'utf8');
    assert.equal(readFileSync(join(test.dir, 'SHA256SUMS_fairswaptest'), 'utf8'),
      `${createHash('sha256').update(bytes).digest('hex')}  idv-digilocker-v1-fairswaptest.json\n`);
    for (const secret of ['sbp_mock_token', 'mock_password', 'pooler.supabase.com', 'BEGIN CERTIFICATE', 'f'.repeat(64)]) assert.ok(!bytes.includes(secret), secret);
    const help = test.full.findIndex(cmd => cmd.includes('--help'));
    const [dry, apply] = pushes(test.full);
    assert.ok(help >= 0 && help < test.full.indexOf(dry) && test.full.indexOf(dry) < test.full.indexOf(apply));
    assert.ok(dry.includes('--dry-run') && dry.includes('--include-all'));
    assert.ok(apply.includes('--yes') && apply.includes('--include-all') && !apply.includes('--dry-run'));
    const at = label => test.full.findIndex(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith(`-- idv-digilocker-${label}`));
    assert.ok(at('preflight') >= 0 && at('preflight') < test.full.indexOf(dry) && at('postflight') > test.full.indexOf(apply));
  } finally { rmSync(test.dir, {recursive: true, force: true}); }

  const digest = verifyIdvDigilockerTestReceipt(testReceipt, idvContext);
  assert.equal(digest, 'b'.repeat(64));
  for (const invalid of [{environment: 'FairSwapProd'}, {projectRef: REFS.FairSwapProd}, {releaseWorkflowRun: '132'}, {releaseWorkflowAttempt: '2'},
    {reviewedCommit: 'f'.repeat(40)}, {migrationSha256: 'd'.repeat(64)}, {postflightVerified: false}, {postflightScope: 'listing-validity-365-integrity'},
    {identityVerificationRequired: true}, {edgeFunctionsDeployedByThisWorkflow: true}, {prerequisiteLedger: IDV_FOUNDATION_LEDGER.FairSwapProd},
    {outOfOrderInstall: {includeAll: true, aheadVersions: ['20261118092010']}}, {outOfOrderInstall: undefined},
    {dryRunPending: [c.filename, '20261118092010_taxonomy_v2_catalogue.sql']}, {ledgerStatementsSha256: 'invalid'}]) {
    assert.throws(() => verifyIdvDigilockerTestReceipt({...testReceipt, ...invalid}, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
  }

  // Production runs only as the automatic promotion of this Test run: without the verified Test digest, or as a manual
  // production/adopt target, no tool runs against Production.
  for (const env of [{}, {TARGET: 'production', IDV_DIGILOCKER_TEST_LEDGER_SHA: digest}, {TARGET: 'adopt', IDV_DIGILOCKER_TEST_LEDGER_SHA: digest}]) {
    const run = idvRun('FairSwapProd', {env});
    try {
      await assert.rejects(run.result, /IDV_DIGILOCKER_TEST_EVIDENCE_REQUIRED/);
      assert.deepEqual(run.full, []);
      assert.ok(!existsSync(join(run.dir, 'idv-digilocker-v1-fairswapprod.json')));
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  }
  // With it, Production installs out of order behind the exact reviewed tail and must reproduce the Test digest.
  const prod = idvRun('FairSwapProd', {env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: digest}});
  try {
    const receipt = await prod.result;
    assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.equal(receipt.projectRef, REFS.FairSwapProd);
    assert.equal(receipt.testLedgerStatementsSha256, digest);
    assert.deepEqual(receipt.prerequisiteLedger, IDV_FOUNDATION_LEDGER.FairSwapProd);
    assert.deepEqual(receipt.outOfOrderInstall, {includeAll: true, aheadVersions: PROD_IDV_TAIL_VERSIONS});
    assert.equal(idvApplies(prod.full).length, 1);
  } finally { rmSync(prod.dir, {recursive: true, force: true}); }
  const mismatch = idvRun('FairSwapProd', {env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: 'a'.repeat(64)}});
  try {
    await assert.rejects(mismatch.result, /IDV_DIGILOCKER_TEST_LEDGER_MISMATCH/);
    assert.ok(!existsSync(join(mismatch.dir, 'idv-digilocker-v1-fairswapprod.json')));
  } finally { rmSync(mismatch.dir, {recursive: true, force: true}); }
  await assert.rejects(adoptExistingInstallation({environment: 'FairSwapProd', candidateId: IDV_DIGILOCKER_CANDIDATE, context: idvContext,
    runner: () => assert.fail('no tool may run')}), /ADOPTION_NOT_REGISTERED/);
});

// Minimal evaluator for the production job's GitHub expression (subset used by this workflow), so the real condition is tested.
function productionJobRuns(yaml, {candidate, target, autoPromote, test = 'success', verifyTest = 'success', outputs = {}}) {
  const block = yaml.slice(yaml.indexOf('\n  production:\n'));
  const expr = block.slice(block.indexOf('if: >-') + 6, block.indexOf('\n    environment: FairSwapProd')).trim()
    .replace(/^\$\{\{/, '').replace(/\}\}$/, '').replace(/\s+/g, ' ');
  const ctx = {
    inputs: {candidate, target},
    github: {actor: 'vivek2310sharma', triggering_actor: 'vivek2310sharma'},
    needs: {verify: {result: 'success', outputs: {auto_promote: String(autoPromote)}}, test: {result: test},
      verify_test: {result: verifyTest, outputs: {idv_digilocker_ledger_sha: '', mobile_catalogue_ledger_sha: '', listing_validity_ledger_sha: '',
        taxonomy_ledger_sha: '', correction_ledger_sha: '', ...outputs}}}
  };
  const js = expr.replace(/always\(\)/g, 'true').replace(/==/g, '===').replace(/!===/g, '!==');
  assert.match(js, /^[\w\s.'()=!&|-]+$/);
  return new Function('inputs', 'github', 'needs', `return (${js});`)(ctx.inputs, ctx.github, ctx.needs);
}

test('IDV DigiLocker V1 and V2: Production starts only after a verified Test receipt, never from a manual Production or adopt dispatch', () => {
  const yaml = readFileSync('.github/workflows/reusable-supabase-release.yml', 'utf8');
  const digest = {idv_digilocker_ledger_sha: 'b'.repeat(64)};
  for (const id of [IDV_DIGILOCKER_CANDIDATE, IDV_DIGILOCKER_V2_CANDIDATE]) {
    assert.equal(planDispatch({candidateId: id, target: 'test'}).candidate.autoPromote, true);
    assert.equal(productionJobRuns(yaml, {candidate: id, target: 'test', autoPromote: true, outputs: digest}), true);
    assert.equal(productionJobRuns(yaml, {candidate: id, target: 'test', autoPromote: true}), false);   // no verified receipt digest
    assert.equal(productionJobRuns(yaml, {candidate: id, target: 'test', autoPromote: true, verifyTest: 'failure', outputs: digest}), false);
    assert.equal(productionJobRuns(yaml, {candidate: id, target: 'test', autoPromote: false, outputs: digest}), false);
    assert.equal(productionJobRuns(yaml, {candidate: id, target: 'production', autoPromote: true, test: 'skipped', verifyTest: 'skipped'}), false);
    assert.equal(productionJobRuns(yaml, {candidate: id, target: 'adopt', autoPromote: true, test: 'skipped', verifyTest: 'skipped'}), false);
  }
  // Other candidates keep their existing behaviour under the same evaluator.
  assert.equal(productionJobRuns(yaml, {candidate: 'mobile-catalogue-india-v1', target: 'test', autoPromote: true, outputs: {mobile_catalogue_ledger_sha: 'b'.repeat(64)}}), true);
  assert.equal(productionJobRuns(yaml, {candidate: 'moderation-analytics-v1', target: 'test', autoPromote: true}), true);
  assert.equal(productionJobRuns(yaml, {candidate: 'tablets-v1-foundation', target: 'production', autoPromote: false, test: 'skipped', verifyTest: 'skipped'}), true);
  assert.equal(productionJobRuns(yaml, {candidate: 'accessories-v1-foundation', target: 'adopt', autoPromote: false, test: 'skipped', verifyTest: 'skipped'}), true);
  assert.equal(productionJobRuns(yaml, {candidate: 'v3-test-remaining-batch', target: 'test', autoPromote: true}), false);
  assert.match(yaml, /\n  test:\n    needs: verify\n    if: \$\{\{ needs\.verify\.result == 'success' && inputs\.target == 'test'/);
  assert.ok(yaml.includes("if: ${{ inputs.candidate == 'idv-digilocker-v1' || inputs.candidate == 'idv-digilocker-oidc-v2' }}"));
  // Non-V3 Test-only candidates remain restricted to DigiLocker releases.
  assert.deepEqual(Object.values(CANDIDATES).filter(c => c.testOnly && !c.unifiedPublishingV3).map(c => c.id), ['idv-digilocker-required-gate', 'idv-digilocker-aadhaar-acr', 'idv-digilocker-acr-request-only']);
  assert.deepEqual(Object.values(CANDIDATES).filter(c => c.autoPromote === true).map(c => c.id).sort(), ['account-security-email-v2', 'idv-digilocker-oidc-v2', 'idv-digilocker-v1',
    'listing-validity-365', 'mobile-catalogue-india-v1', 'moderation-analytics-v1', 'moderation-azure-v1', 'moderation-google-cloud-v1', 'moderation-switching-v1', 'taxonomy-v2-catalogue',
    'taxonomy-v2-foundation', 'v3-provider-neutral-activation']);
});

test('IDV DigiLocker fails closed before any apply on unsupported state, extra pending migrations and preflight drift, and withholds receipts on postflight drift', async () => {
  const attempt = async (environment, options, re, {dryRuns = 0} = {}) => {
    const run = idvRun(environment, {env: environment === 'FairSwapProd' ? {IDV_DIGILOCKER_TEST_LEDGER_SHA: 'b'.repeat(64)} : {}, ...options});
    try {
      await assert.rejects(run.result, re);
      assert.equal(idvApplies(run.full).length, 0);
      assert.equal(pushes(run.full).length, dryRuns);
      assert.ok(!existsSync(join(run.dir, `idv-digilocker-v1-${environment.toLowerCase()}.json`)));
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  };
  const c = getCandidate(IDV_DIGILOCKER_CANDIDATE);
  await attempt('FairSwapTest', {ledger: idvLedger('FairSwapProd')}, /FOUNDATION_PREREQUISITE_MISMATCH/);
  await attempt('FairSwapProd', {env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: ''}}, /IDV_DIGILOCKER_TEST_EVIDENCE_REQUIRED/);
  await attempt('FairSwapProd', {ledger: idvLedger('FairSwapTest')}, /FOUNDATION_PREREQUISITE_MISMATCH/);
  await attempt('FairSwapTest', {ledger: idvLedger('FairSwapTest', {extra: [{version: '20261118100000', name: 'unreviewed', hasStatements: true, statementCount: 1, statementsSha256: 'a'.repeat(64)}]})}, /LEDGER_TAIL_MISMATCH/);
  // Production never attests: an existing Production row has no reviewed Test-to-Production receipt chain.
  await attempt('FairSwapProd', {ledger: idvLedger('FairSwapProd', {extra: [{version: c.version, name: 'idv_digilocker_direct_v1', hasStatements: true,
    statementCount: 92, statementsSha256: 'b'.repeat(64)}]})}, /IDV_DIGILOCKER_ALREADY_RECORDED/);
  await attempt('FairSwapTest', {pre: {gate_setting_not_on: false}}, /IDV_DIGILOCKER_PREFLIGHT_FAILED/);
  await attempt('FairSwapTest', {pre: {digilocker_tables_absent: false}}, /IDV_DIGILOCKER_PREFLIGHT_FAILED/);
  await attempt('FairSwapTest', {pre: {unexpected_key: true}}, /IDV_DIGILOCKER_PREFLIGHT_FAILED/);
  await attempt('FairSwapTest', {help: 'Flags:\n      --dry-run\n'}, /CLI_INCLUDE_ALL_UNSUPPORTED/);
  await attempt('FairSwapTest', {dryOutput: `Would push these migrations:\n • ${c.filename}\n • 20261118120000_unreviewed.sql`}, /DRY_RUN_MISMATCH/, {dryRuns: 1});
  await attempt('FairSwapTest', {dryOutput: 'Would push these migrations:\n • 20261118120000_unreviewed.sql'}, /DRY_RUN_MISMATCH/, {dryRuns: 1});
  await attempt('FairSwapTest', {dryOutput: 'Remote database is up to date.'}, /DRY_RUN_MISMATCH/, {dryRuns: 1});
  await assert.rejects(releaseReusable({environment: 'FairSwapTest', candidateId: 'idv-digilocker-v2', context: idvContext, runner: () => assert.fail('no tool may run')}),
    /UNKNOWN_CANDIDATE/);

  // After apply, every postflight key and the preserved-objects digest are binding: no receipt is written.
  for (const options of [{post: {gate_setting_off: false}}, {post: {gate_function_off: false}}, {post: {tables_no_client_privileges: false}},
    {post: {service_only_execute: false}}, {post: {tables_empty: false}}, {preserved: 'a'.repeat(64)}]) {
    const run = idvRun('FairSwapTest', options);
    try {
      await assert.rejects(run.result, /IDV_DIGILOCKER_(POSTFLIGHT_FAILED|EXISTING_OBJECTS_CHANGED)/);
      assert.equal(idvApplies(run.full).length, 1);
      assert.ok(!existsSync(join(run.dir, 'idv-digilocker-v1-fairswaptest.json')));
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  }
});

test('disposable PostgreSQL: IDV DigiLocker preflight and postflight pass on the reviewed SQL and fail on gate, grant and drift changes',
  {skip: PGlite ? false : 'no PGlite module', timeout: 240000}, async () => {
    const src = path => readFileSync(join(process.cwd(), path), 'utf8');
    const db = new PGlite();
    for (const path of ['tests/idv-pg17/fixture.sql', 'tests/idv-pg17/fixture-digilocker.sql',
      'supabase/forward-migrations/idv/20261026183000_idv_digilocker_foundation.sql']) await db.exec(src(path));
    const snapshot = async (checks, label) => {
      const results = await db.exec(idvSnapshotSql(checks, label));
      return JSON.parse(Object.values(results.find(r => r.rows?.length).rows[0])[0]);
    };
    const allTrue = value => Object.values(value.checks).every(v => v === true);
    const pre = await snapshot(IDV_DIGILOCKER_PREFLIGHT, 'preflight');
    assert.ok(allTrue(pre), JSON.stringify(pre.checks));
    await db.exec("insert into public.app_system_settings (setting_key, setting_value, description) values ('identity_verification_required', 'true', 'x')");
    assert.equal((await snapshot(IDV_DIGILOCKER_PREFLIGHT, 'preflight')).checks.gate_setting_not_on, false);
    await db.exec("delete from public.app_system_settings where setting_key = 'identity_verification_required'");

    await db.exec(src(getCandidate(IDV_DIGILOCKER_CANDIDATE).path));
    const post = await snapshot(IDV_DIGILOCKER_POSTFLIGHT, 'postflight');
    assert.ok(allTrue(post), JSON.stringify(post.checks));
    assert.equal(post.preserved, pre.preserved);
    const after = await snapshot(IDV_DIGILOCKER_PREFLIGHT, 'preflight');
    assert.equal(after.checks.digilocker_tables_absent, false);   // a second install attempt is refused before any push

    const broken = async (sql, key, undo) => {
      await db.exec(sql);
      const value = await snapshot(IDV_DIGILOCKER_POSTFLIGHT, 'postflight');
      await db.exec(undo);
      return key ? value.checks[key] : value.preserved;
    };
    assert.equal(await broken("update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required'",
      'gate_setting_off', "update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required'"), false);
    assert.equal(await broken('grant select on app_security.idv_digilocker_bindings to authenticated', 'tables_no_client_privileges',
      'revoke select on app_security.idv_digilocker_bindings from authenticated'), false);
    assert.equal(await broken('grant execute on function public.server_idv_dl_complete(uuid,uuid,text,text,text[]) to authenticated', 'service_only_execute',
      'revoke execute on function public.server_idv_dl_complete(uuid,uuid,text,text,text[]) from authenticated'), false);
    assert.equal(await broken('alter table app_security.idv_digilocker_attempts no force row level security', 'tables_rls_forced',
      'alter table app_security.idv_digilocker_attempts force row level security'), false);
    assert.equal(await broken('alter table public.messages disable trigger trg_identity_gate', 'gate_triggers',
      'alter table public.messages enable trigger trg_identity_gate'), false);
    assert.notEqual(await broken("create function public.idv_release_probe() returns integer language sql as 'select 1'", null,
      'drop function public.idv_release_probe()'), pre.preserved);   // any other public/app_security change is detected
    assert.equal((await snapshot(IDV_DIGILOCKER_POSTFLIGHT, 'postflight')).preserved, pre.preserved);
  });

test('IDV DigiLocker Production preflight/postflight are Production-only, pinned to the V3 prerequisite and keep the Test guard strict', async () => {
  const prod = idvRun('FairSwapProd', {env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: 'b'.repeat(64)}});
  try {
    await prod.result;
    const sqls = prod.full.filter(cmd => cmd[0] === 'psql').map(cmd => cmd.at(-1));
    const pre = sqls.find(q => q.startsWith('-- idv-digilocker-preflight'));
    const postflight = sqls.find(q => q.startsWith('-- idv-digilocker-postflight'));
    for (const key of ['v3_functions_exact', 'v3_function_grants_exact', 'v3_triggers_exact']) assert.ok(pre.includes(`'${key}'`), key);
    assert.ok(!pre.includes("'digilocker_triggers_absent'"));
    for (const key of ['v3_function_bodies_preserved', 'v3_triggers_preserved']) assert.ok(postflight.includes(`'${key}'`), key);
  } finally { rmSync(prod.dir, {recursive: true, force: true}); }
  // Production fails closed when any V3 pin is missing from the preflight result; Test never sees the Production checks.
  for (const key of ['v3_functions_exact', 'v3_function_grants_exact', 'v3_triggers_exact', 'digilocker_functions_absent']) {
    const run = idvRun('FairSwapProd', {env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: 'b'.repeat(64)}, pre: {[key]: false}});
    try { await assert.rejects(run.result, /IDV_DIGILOCKER_PREFLIGHT_FAILED/); assert.equal(idvApplies(run.full).length, 0); }
    finally { rmSync(run.dir, {recursive: true, force: true}); }
  }
  const post = idvRun('FairSwapProd', {env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: 'b'.repeat(64)}, post: {v3_function_bodies_preserved: false}});
  try { await assert.rejects(post.result, /IDV_DIGILOCKER_POSTFLIGHT_FAILED/); assert.ok(!existsSync(join(post.dir, 'idv-digilocker-v1-fairswapprod.json'))); }
  finally { rmSync(post.dir, {recursive: true, force: true}); }
  assert.ok(Object.keys(IDV_DIGILOCKER_PREFLIGHT).includes('digilocker_triggers_absent'));
  assert.ok(!Object.keys(IDV_DIGILOCKER_PRODUCTION_PREFLIGHT).includes('digilocker_triggers_absent'));
});

test('IDV V3 identity function pins equal the V3 SQL bodies, and V1 re-creates every one of them byte-identically', () => {
  const body = (sql, name) => {
    const m = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION app_security\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`, 'i'));
    assert.ok(m, name);
    return createHash('md5').update(m[2]).digest('hex');
  };
  const v3 = readFileSync(join(process.cwd(), getCandidate('v3-production-identity-prerequisite').path), 'utf8');
  const v1 = readFileSync(join(process.cwd(), getCandidate(IDV_DIGILOCKER_CANDIDATE).path), 'utf8');
  const pre = IDV_DIGILOCKER_PRODUCTION_PREFLIGHT.v3_functions_exact;
  const names = ['is_identity_verified', 'identity_gate_enabled', 'idv_request_role', 'identity_gate_system_write', 'enforce_verified_actor',
    'trg_identity_gate_listings', 'trg_identity_gate_by_listing', 'trg_identity_gate_posting_session', 'trg_identity_gate_staged_media'];
  for (const name of names) {
    const md5 = body(v3, name);
    assert.equal(body(v1, name), md5, name);
    assert.ok(pre.includes(`md5(p.prosrc) = '${md5}'`), `${name} pin`);
  }
});

test('disposable PostgreSQL (PGlite): FairSwapProd V3 prerequisite -> DigiLocker V1 passes the Production guards and rejects tampered functions, grants and triggers',
  {skip: PGlite ? false : 'no PGlite module', timeout: 240000}, async () => {
    const {runProdV3ToV1Scenarios, setupSql} = await import('../idv-pg17/prod-v3-to-v1-scenarios.mjs');
    const db = new PGlite();
    await db.exec(setupSql());
    await runProdV3ToV1Scenarios(async sql => {
      const rows = (await db.exec(sql)).filter(r => r.rows?.length);
      return rows.length ? String(Object.values(rows.at(-1).rows[0])[0]) : '';
    });
  });

test('V3 candidates are digest-pinned, Test-only and ordered against the full preceding V3 chain', async () => {
  const expected = [
    '20261119092042', '20261119100640', '20261119102359', '20261119103516',
    '20261119105021', '20261119111559', '20261119114512',
  ];
  const v3 = Object.values(CANDIDATES).filter(candidate => candidate.unifiedPublishingV3);
  assert.deepEqual(v3.map(candidate => candidate.version), expected);
  const {assertLedgerOrdering} = await import('../../scripts/release/accessories-v1-release.mjs');
  const {verifyRemotePostflight} = await import('../../scripts/release/reusable-supabase-release.mjs');
  for (const [index, candidate] of v3.entries()) {
    assert.equal(verifyCandidateSha(candidate.id).sha256, candidate.sha256);
    assert.equal(candidate.autoPromote, false);
    assert.deepEqual(candidate.requiredLedgerVersions, ['20261118092010', ...expected.slice(0, index)]);
    assert.throws(() => planDispatch({candidateId: candidate.id, target: 'production'}), /TEST_ONLY_CANDIDATE/);
    assert.equal(planDispatch({candidateId: candidate.id, target: 'test'}).candidate, candidate);
    const header = 'Local | Remote | Time (UTC)';
    const rows = candidate.requiredLedgerVersions.map(version => `${version} | ${version} |`);
    const ledger = [header, ...rows].join('\n');
    assert.equal(assertLedgerOrdering(candidate, ledger).state, 'absent');
    assert.throws(() => assertLedgerOrdering(candidate, [header, ...rows.slice(1)].join('\n')), /PREREQUISITE_MIGRATION_MISSING/);
    const count = candidate.unifiedPublishingV3.count;
    const counts = {contracts: count, disabled: count};
    assert.deepEqual(await verifyRemotePostflight('FairSwapTest', candidate.id, 'url', {}, (_, args) => {
      assert.match(args.at(-1), /BEGIN READ ONLY/);
      return JSON.stringify(counts);
    }), counts);
    await assert.rejects(verifyRemotePostflight('FairSwapTest', candidate.id, 'url', {},
      () => JSON.stringify({...counts, disabled: count - 1})), /V3_DISABLED_CONTRACT_MISMATCH/);
  }
});

const v3Diagnostic = {
  version: '20261119113557', name: '20261119120000_idv_digilocker_oidc_diag_test_only',
  hasStatements: true, statementCount: 1, statementsSha256: 'a'.repeat(64),
};

async function v3OrderingRun(candidate, {
  diagnostic = v3Diagnostic, extra = [], omit, dryOutput, mutateAt, help = '--dry-run --include-all',
  environment = 'FairSwapTest',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fs-v3-ordering-'));
  const calls = [];
  const ledgerRow = (version, name) => ({version, name, hasStatements: true, statementCount: 1, statementsSha256: 'b'.repeat(64)});
  const initial = [
    ...baseHistory.map(version => ledgerRow(version, 'baseline')),
    ...candidate.requiredLedgerVersions.filter(version => version !== omit).map(version => ledgerRow(
      version, Object.values(CANDIDATES).find(c => c.version === version).filename.slice(15, -4))),
    ...(diagnostic ? [diagnostic] : []),
    ...extra,
  ].sort(idvByVersion);
  const installed = ledgerRow(candidate.version, candidate.filename.slice(15, -4));
  let reads = 0;
  let applied = false;
  const base = makeRunner({before: initial.map(row => row.version), after: [...initial, installed].map(row => row.version),
    filename: candidate.filename, sql: query => {
      if (query.includes('ordinary_goods_contracts_v3')) {
        const count = applied ? candidate.unifiedPublishingV3.count : candidate.unifiedPublishingV3.previousCount;
        return {contracts: count, disabled: count};
      }
      const snapshot = [...initial, ...(applied ? [installed] : [])].sort(idvByVersion);
      if (++reads === mutateAt) snapshot[0] = {...snapshot[0], statementsSha256: 'c'.repeat(64)};
      return snapshot;
    }});
  const runner = (cmd, args, ...rest) => {
    calls.push([cmd, ...args]);
    if (cmd === 'supabase' && args.includes('--help')) return help;
    if (cmd === 'supabase' && args.includes('--dry-run') && dryOutput) return dryOutput;
    if (cmd === 'supabase' && args.includes('--yes')) applied = true;
    return base(cmd, args, ...rest);
  };
  try {
    const receipt = await releaseReusable({environment, candidateId: candidate.id, context: baseEnv, runner, receiptDir: dir});
    return {receipt, calls};
  } catch (error) {
    return {error, calls};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('V3 Test uses the pinned CLI out-of-order flag only for the first six candidates with the exact diagnostic tail', async () => {
  const v3 = Object.values(CANDIDATES).filter(c => c.unifiedPublishingV3);
  for (const [index, candidate] of v3.entries()) {
    const {receipt, calls, error} = await v3OrderingRun(candidate);
    assert.ifError(error);
    assert.deepEqual(receipt.dryRunPending, [candidate.filename]);
    const includeAll = index < 6;
    const [dry, apply] = pushes(calls);
    assert.ok(dry.includes('--dry-run') && apply.includes('--yes'));
    assert.equal(dry.includes('--include-all'), includeAll);
    assert.equal(apply.includes('--include-all'), includeAll);
    assert.equal(calls.some(call => call.includes('--help')), includeAll);
    assert.deepEqual(receipt.outOfOrderInstall, includeAll ? {includeAll: true, aheadVersions: [v3Diagnostic.version]} : undefined);
  }
  const ordinary = await v3OrderingRun(v3[0], {diagnostic: null});
  assert.ifError(ordinary.error);
  assert.ok(ordinary.calls.every(call => !call.includes('--include-all')));
});

test('V3 Test denies unsafe out-of-order state and checks ledger fingerprints before and after apply', async () => {
  const [first, second] = Object.values(CANDIDATES).filter(c => c.unifiedPublishingV3);
  for (const [candidate, options, expected] of [
    [first, {diagnostic: {...v3Diagnostic, name: 'unexpected'}}, /V3_DIAGNOSTIC_LEDGER_MISMATCH/],
    [first, {diagnostic: {...v3Diagnostic, hasStatements: false, statementCount: 0}}, /V3_DIAGNOSTIC_LEDGER_MISMATCH/],
    [first, {extra: [{...v3Diagnostic, version: '20261119113600'}]}, /V3_LEDGER_MISMATCH/],
    [second, {omit: first.version}, /PREREQUISITE_MIGRATION_MISSING/],
    [first, {help: '--dry-run'}, /CLI_INCLUDE_ALL_UNSUPPORTED/],
    [first, {dryOutput: `${first.filename}\n20261119113557_unexpected.sql`}, /DRY_RUN_MISMATCH/],
    [first, {mutateAt: 2}, /V3_LEDGER_CHANGED/],
    [first, {environment: 'FairSwapProd'}, /TEST_ONLY_CANDIDATE/],
  ]) {
    const result = await v3OrderingRun(candidate, options);
    assert.match(result.error?.message ?? '', expected);
    assert.equal(idvApplies(result.calls).length, 0);
  }
  const drift = await v3OrderingRun(first, {mutateAt: 3});
  assert.match(drift.error?.message ?? '', /TABLETS_LEDGER_CHANGED/);
  assert.equal(idvApplies(drift.calls).length, 1);
  assert.equal(drift.receipt, undefined);
});

test('native PostgreSQL: V3 property lifecycle accepts LF and CRLF but rejects missing or repeated blocks',
  {skip: pgBin ? false : 'no local PostgreSQL binaries'}, () => {
    const {fullPath} = verifyCandidateSha('property-intake-v3');
    const migration = readFileSync(fullPath, 'utf8');
    const blockStart = migration.indexOf('do $$\ndeclare def text; item_terms');
    assert.notEqual(blockStart, -1);
    const lifecycle = migration.slice(blockStart, migration.lastIndexOf('commit;'));
    const terms = /\$terms\$([\s\S]+?)\$terms\$/.exec(lifecycle)[1];
    const source = readFileSync('supabase/migrations/20261011092234_test_family_submission_v1.sql', 'utf8');
    const functionStart = source.indexOf('CREATE OR REPLACE FUNCTION app_security.impl_seller_submit_listing(');
    assert.notEqual(functionStart, -1);
    const terminator = '\n$function$\n;';
    const functionEnd = source.indexOf(terminator, functionStart);
    assert.ok(functionEnd > functionStart);
    const seller = source.slice(functionStart, functionEnd + terminator.length);
    assert.ok(seller.includes(terms));
    assert.ok(seller.includes('app_security.submission_family('));

    const pg = startPg(pgBin);
    try {
      pg.run('CREATE SCHEMA app_security');
      const readDefinition = () => pg.run("SELECT pg_get_functiondef('app_security.impl_seller_submit_listing(uuid)'::regprocedure)");
      pg.run(seller);
      assert.ok(!readDefinition().includes('\r'));
      pg.run(lifecycle);
      const expected = readDefinition();
      assert.match(expected, /app_security\.submission_family\(/);
      assert.ok(expected.includes(terms));
      assert.match(expected, /s\.owner_id=v_caller_id AND s\.state='finalizing'/);

      pg.run(seller.replaceAll('\n', '\r\n'));
      assert.ok(readDefinition().includes('\r\n'));
      pg.run(lifecycle);
      assert.equal(readDefinition(), expected);

      for (const changed of ['', `${terms}\n\n  ${terms}`]) {
        pg.run(seller.replace(terms, changed).replaceAll('\n', '\r\n'));
        const before = readDefinition();
        assert.throws(() => pg.run(lifecycle), /PROPERTY_SELLER_LIFECYCLE_DRIFT/);
        assert.equal(readDefinition(), before);
      }
    } finally {
      pg.stop();
    }
  });

const v3Manifest = 'bebcdecc9e2ec72ece06f2c05b5ee12c09183c15bcf9f47a03450ed6bc0461ae';

test('V3 Production requires the full pinned manifest, seven Test receipts, and a trusted batch dispatch', async () => {
  const evidence = verifyV3ProductionEvidence(process.cwd(), v3Manifest);
  assert.deepEqual([...evidence.keys()], V3_PRODUCTION_SEQUENCE.slice(1));
  assert.throws(() => verifyV3ProductionEvidence(process.cwd(), 'a'.repeat(64)), /MANIFEST_MISMATCH/);
  assert.throws(() => planDispatch({candidateId: V3_IDENTITY_PREREQUISITE}), /BATCH_REQUIRED/);
  await assert.rejects(releaseV3ProductionBatch({
    candidateId: V3_PRODUCTION_BATCH, environment: 'FairSwapProd', context: {},
  }), /CONTEXT_REQUIRED/);
  await assert.rejects(releaseReusable({
    candidateId: V3_IDENTITY_PREREQUISITE, environment: 'FairSwapProd', context: {},
  }), /BATCH_REQUIRED/);
});

test('native PostgreSQL: Production V3 installs dark with the existing seller lifecycle, RLS and identity checks',
  {skip: pgBin ? false : 'no local PostgreSQL binaries'}, async () => {
    const pg = startPg(pgBin);
    const seller = '9df867d3-6751-425f-8b41-14bbc4cceb01';
    const other = '9df867d3-6751-425f-8b41-14bbc4cceb02';
    const legacy = '9df867d3-6751-425f-8b41-14bbc4cceb03';
    const replayGate = "update public.app_system_settings set setting_value='true' where setting_key='identity_verification_required'";
    const actor = `set role authenticated; set "request.user"='${seller}';`;
    let before;
    try {
      await setupOrdinaryGoodsFixture(pg.run, {beforeV3() {
        pg.run(`
          create table public.user_identity_verifications(
            user_id uuid primary key, verification_status text, badge_issued boolean, revoked_at timestamptz, valid_until timestamptz);
          insert into public.categories(slug,name,is_active,new_listing_enabled)
            values ('legacy-v3-fixture','Legacy fixture',true,true);
          insert into auth.users values ('${seller}'), ('${other}');
        `);
        before = v3ProductionState(pg.run, {beforePrerequisite: true, beforeProperty: true});
        assert.throws(() => pg.run(`begin;
          insert into public.app_system_settings values ('identity_verification_required','true',null);
          ${readFileSync(verifyCandidateSha(V3_IDENTITY_PREREQUISITE).fullPath, 'utf8')}
        `), /V3_PRODUCTION_IDENTITY_GATE_MUST_BE_OFF/);
        assert.deepEqual(v3ProductionState(pg.run, {beforePrerequisite: true, beforeProperty: true}), before);
        pg.run(readFileSync(verifyCandidateSha(V3_IDENTITY_PREREQUISITE).fullPath, 'utf8'));
        assert.deepEqual(v3ProductionState(pg.run, {beforeProperty: true}), before);
      }});
      assert.deepEqual(v3ProductionState(pg.run), before);
      assert.deepEqual(await verifyRemotePostflight('FairSwapProd', 'v3-require-active-seller-identity',
        'test-socket', {}, (_, args) => pg.run(args.at(-1))), {contracts: 58, disabled: 58});
      assert.equal(pg.run(`${actor} select public.ordinary_goods_v3()::text;`).trim(), '{}');
      assert.throws(() => pg.run(`${actor} select * from app_security.ordinary_goods_contracts_v3;`), /permission denied/);
      assert.throws(() => pg.run(`${actor} select app_security.enforce_verified_actor('${other}',true);`), /permission denied/);
      assert.throws(() => pg.run(`${actor} insert into public.listings(seller_id, category_id)
        select '${other}', id from public.categories where slug='legacy-v3-fixture';`), /row-level security/);
      pg.run(`${actor} insert into public.listings(id,seller_id,category_id)
        select '${legacy}', '${seller}', id from public.categories where slug='legacy-v3-fixture';`);
      assert.equal(pg.run(`select count(*) from public.listings where id='${legacy}';`).trim(), '1');
      assert.throws(() => pg.run(`${actor} select app_security.impl_seller_submit_listing('${legacy}');`),
        /description is required|condition is required|description must be/);
      assert.throws(() => pg.run(`${replayGate}; ${actor}
        insert into public.listings(seller_id,category_id)
          select '${seller}',id from public.categories where slug='legacy-v3-fixture';`), /IDENTITY_VERIFICATION_REQUIRED/);
      assert.deepEqual(v3ProductionState(pg.run), before);
      assert.throws(() => pg.run(`${replayGate};
        insert into public.user_identity_verifications values ('${seller}','verified',true,now(),null);
        ${actor}
        insert into public.listings(seller_id,category_id)
          select '${seller}',id from public.categories where slug='legacy-v3-fixture';`), /IDENTITY_VERIFICATION_REQUIRED/);
      assert.throws(() => pg.run(`${replayGate};
        insert into public.user_identity_verifications values ('${seller}','verified',true,null,null);
        ${actor} set request.account='suspended';
        insert into public.listings(seller_id,category_id)
          select '${seller}',id from public.categories where slug='legacy-v3-fixture';`), /IDENTITY_VERIFICATION_REQUIRED/);
      assert.deepEqual(v3ProductionState(pg.run), before);
      pg.run(`
        insert into public.cities values ('9df867d3-6751-425f-8b41-14bbc4cceb04',true,'City','State');
        update public.listings set title='Legacy listing', description='Legacy item with a ready photo',
          city_id='9df867d3-6751-425f-8b41-14bbc4cceb04',
          pin_code='560001', condition='good', price_type='fixed', price_paise=100
        where id='${legacy}';
        insert into public.listing_media (id,listing_id,processing_status)
          values ('9df867d3-6751-425f-8b41-14bbc4cceb05','${legacy}','ready');
      `);
      assert.throws(() => pg.run(`set role authenticated; set "request.user"='${other}';
        select app_security.impl_seller_submit_listing('${legacy}');`), /does not own/);
      const legacySubmission = JSON.parse(pg.run(`${actor} select app_security.impl_seller_submit_listing('${legacy}');`));
      assert.equal(legacySubmission.status, 'pending_review');
      assert.equal(legacySubmission.revision, 1);
    } finally {
      pg.stop();
    }
  });

test('V3 Production dry-runs one migration at a time, verifies Test ledger statements, and stops at first drift', async () => {
  const evidence = verifyV3ProductionEvidence(process.cwd(), v3Manifest);
  const context = {...baseEnv, EXPECTED_SHA: v3Manifest, TARGET: 'production',
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'vivek2310sharma/FairSwap-Backend',
    GITHUB_WORKFLOW_REF: 'vivek2310sharma/FairSwap-Backend/.github/workflows/reusable-supabase-release.yml@refs/heads/main',
    GITHUB_ACTOR: 'vivek2310sharma', GITHUB_TRIGGERING_ACTOR: 'vivek2310sharma'};
  for (const fault of [null, 'extra pending', 'wrong statements', 'enabled contract', 'existing V3']) {
    const receiptDir = mkdtempSync(join(tmpdir(), 'fs-v3-production-receipts-'));
    const taxonomy = getCandidate('taxonomy-v2-catalogue');
    const row = (version, name, digest = 'b'.repeat(64)) =>
      ({version, name, hasStatements: true, statementCount: 1, statementsSha256: digest});
    const candidateRow = (c, digest = evidence.get(c.id)) => row(c.version, c.filename.slice(15, -4), digest);
    const ledgerRows = [...baseHistory.map(v => row(v, 'baseline')), candidateRow(taxonomy)];
    if (fault === 'existing V3') ledgerRows.push(candidateRow(getCandidate(V3_PRODUCTION_SEQUENCE[1])));
    let index = 0;
    let current;
    let applied;
    const appliedIds = [];
    const runner = (cmd, args) => {
      if (cmd === 'supabase' && args.includes('--version')) {
        const c = getCandidate(V3_PRODUCTION_SEQUENCE[index++]);
        applied = false;
        const before = ledgerRows.map(r => r.version);
        current = makeRunner({before, after: [...before, c.version], filename: c.filename,
          sql: q => {
            if (q.includes("'identity'")) return {identity: true, lifecycle: true, categories: 'categories', policies: 'policies'};
            if (q.includes('ordinary_goods_contracts_v3')) {
              const count = applied ? c.unifiedPublishingV3.count : c.unifiedPublishingV3.previousCount;
              return {contracts: count, disabled: fault === 'enabled contract' && applied ? count - 1 : count, security: true};
            }
            return ledgerRows;
          }});
      }
      assert.ok(!args.includes('--include-all'));
      if (args.includes('--dry-run') && fault === 'extra pending') {
        return `${getCandidate(V3_PRODUCTION_SEQUENCE[0]).filename}\n20261119000000_unexpected.sql`;
      }
      if (args.includes('--yes')) {
        const id = V3_PRODUCTION_SEQUENCE[index - 1];
        const c = getCandidate(id);
        appliedIds.push(id);
        ledgerRows.push(candidateRow(c, fault === 'wrong statements' && c.unifiedPublishingV3 ? 'c'.repeat(64) : undefined));
        applied = true;
      }
      return current(cmd, args);
    };
    try {
      const release = releaseV3ProductionBatch({environment: 'FairSwapProd', candidateId: V3_PRODUCTION_BATCH,
        context, runner, receiptDir});
      if (fault) {
        await assert.rejects(release, /DRY_RUN_MISMATCH|TEST_LEDGER_MISMATCH|DISABLED_CONTRACT_MISMATCH|V3_LEDGER_MISMATCH/);
        assert.equal(appliedIds.length, ['wrong statements', 'enabled contract'].includes(fault) ? 2 : 0);
        assert.ok(!existsSync(join(receiptDir, 'v3-require-active-seller-identity-fairswapprod.json')));
      } else {
        await release;
        assert.deepEqual(appliedIds, V3_PRODUCTION_SEQUENCE);
        const last = JSON.parse(readFileSync(join(receiptDir, 'v3-require-active-seller-identity-fairswapprod.json')));
        assert.equal(last.disabledContractCount, 58);
        assert.equal(last.identityEnforcement, 'off');
        assert.equal(last.ledgerStatementsSha256, last.testLedgerStatementsSha256);
        assert.equal(readFileSync(join(receiptDir, 'SHA256SUMS_fairswapprod'), 'utf8').trim().split('\n').length, 8);
      }
    } finally {
      rmSync(receiptDir, {recursive: true, force: true});
    }
  }
});

// ---------------------------------------------------------------------------------------------
// IDV DigiLocker: read-only FairSwapTest attestation of V1, then guarded V1 -> V2 Production sequence
// ---------------------------------------------------------------------------------------------
const idvV1Row = (over = {}) => ({version: '20261117090000', name: 'idv_digilocker_direct_v1', hasStatements: true, statementCount: 92,
  statementsSha256: 'b'.repeat(64), ...over});
const idvTestInstalledLedger = (over = {}, extra = []) => idvLedger('FairSwapTest', {extra: [idvV1Row(over), ...extra]});

test('IDV DigiLocker V1: FairSwapTest already records V1, so its Test stage is a read-only attestation that feeds Production', async () => {
  const c = getCandidate(IDV_DIGILOCKER_CANDIDATE);
  const run = idvRun('FairSwapTest', {ledger: idvTestInstalledLedger()});
  let receipt;
  try {
    receipt = await run.result;
    assert.equal(receipt.status, 'ALREADY_INSTALLED_VERIFIED');
    assert.equal(receipt.postflightScope, IDV_DIGILOCKER_INSTALLED_SCOPE);
    assert.equal(receipt.installedBeforeThisWorkflow, true);
    assert.equal(receipt.ledgerStatementsSha256, 'b'.repeat(64));
    assert.deepEqual(receipt.dryRunPending, []);
    assert.equal(receipt.outOfOrderInstall, undefined);
    assert.equal(receipt.identityVerificationRequired, false);
    assert.deepEqual(pushes(run.full), []);   // no dry run, no apply, nothing written to the database
    assert.ok(run.full.some(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith('-- idv-digilocker-installed\nBEGIN READ ONLY;')));
    assert.ok(!run.full.some(cmd => cmd[0] === 'psql' && /-- idv-digilocker-(preflight|postflight)/.test(cmd.at(-1))));
  } finally { rmSync(run.dir, {recursive: true, force: true}); }
  assert.equal(verifyIdvDigilockerTestReceipt(receipt, {...idvContext, CANDIDATE: c.id}), 'b'.repeat(64));
  for (const invalid of [{installedBeforeThisWorkflow: undefined}, {postflightScope: IDV_DIGILOCKER_SCOPE}, {dryRunPending: [c.filename]},
    {outOfOrderInstall: {includeAll: true, aheadVersions: []}}, {ledgerStatementsSha256: 'x'}, {environment: 'FairSwapProd'}, {identityVerificationRequired: true}]) {
    assert.throws(() => verifyIdvDigilockerTestReceipt({...receipt, ...invalid}, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
  }
  assert.throws(() => verifyIdvDigilockerTestReceipt(receipt, {...idvContext, CANDIDATE: IDV_DIGILOCKER_V2_CANDIDATE}), /TEST_RECEIPT_INVALID/);

  // The attested digest is exactly what the Production install must reproduce.
  const prod = idvRun('FairSwapProd', {env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: receipt.ledgerStatementsSha256}});
  try { assert.equal((await prod.result).testLedgerStatementsSha256, 'b'.repeat(64)); } finally { rmSync(prod.dir, {recursive: true, force: true}); }
});

test('IDV DigiLocker V1 attestation fails closed on ledger or installed-state drift and writes no receipt', async () => {
  const fails = async (options, re) => {
    const run = idvRun('FairSwapTest', options);
    try {
      await assert.rejects(run.result, re);
      assert.deepEqual(pushes(run.full), []);
      assert.ok(!existsSync(join(run.dir, 'idv-digilocker-v1-fairswaptest.json')));
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  };
  await fails({ledger: idvTestInstalledLedger(), installed: {gate_setting_off: false}}, /IDV_DIGILOCKER_INSTALLED_FAILED/);
  await fails({ledger: idvTestInstalledLedger(), installed: {service_only_execute: false}}, /IDV_DIGILOCKER_INSTALLED_FAILED/);
  await fails({ledger: idvTestInstalledLedger(), installed: {unexpected: true}}, /IDV_DIGILOCKER_INSTALLED_FAILED/);
  await fails({ledger: idvTestInstalledLedger({name: 'idv_direct'})}, /INSTALLED_LEDGER_MISMATCH/);
  await fails({ledger: idvTestInstalledLedger({hasStatements: false, statementCount: 0})}, /INSTALLED_LEDGER_MISMATCH/);
  await fails({ledger: idvLedger('FairSwapTest', {foundation: null, extra: [idvV1Row()]})}, /FOUNDATION_PREREQUISITE_MISMATCH/);
  assert.throws(() => assertIdvDigilockerTestInstalled('FairSwapProd', idvLedger('FairSwapProd', {extra: [idvV1Row()]})), /ENVIRONMENT_INVALID/);
  assert.throws(() => assertIdvDigilockerTestInstalled('FairSwapTest', idvTestInstalledLedger({}, [idvV1Row({version: '20261101000000'})])), /INSTALLED_LEDGER_MISMATCH/);
  assert.equal(assertIdvDigilockerTestInstalled('FairSwapTest', idvTestInstalledLedger()), 'b'.repeat(64));
  assert.deepEqual(Object.keys(IDV_DIGILOCKER_INSTALLED).sort(), Object.keys(IDV_DIGILOCKER_POSTFLIGHT).filter(k => k !== 'tables_empty').sort());
});

test('IDV DigiLocker OIDC V2: in-order Test apply with V2 postflight, then Production only after V1 is recorded there and digests match', async () => {
  const c = getCandidate(IDV_DIGILOCKER_V2_CANDIDATE);
  const v2Ledger = environment => idvLedger(environment, {extra: [idvV1Row()]});
  const test = idvRun('FairSwapTest', {candidateId: c.id, ledger: v2Ledger('FairSwapTest'), ledgerDigest: 'c'.repeat(64)});
  let receipt;
  try {
    receipt = await test.result;
    assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.equal(receipt.postflightScope, IDV_DIGILOCKER_V2_SCOPE);
    assert.deepEqual(receipt.dryRunPending, [c.filename]);
    assert.equal(receipt.outOfOrderInstall, undefined);
    const [dry, apply] = pushes(test.full);
    assert.ok(!dry.includes('--include-all') && !apply.includes('--include-all'));
    const at = label => test.full.findIndex(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith(`-- idv-digilocker-${label}`));
    assert.ok(at('v2-preflight') >= 0 && at('v2-preflight') < test.full.indexOf(dry) && at('v2-postflight') > test.full.indexOf(apply));
  } finally { rmSync(test.dir, {recursive: true, force: true}); }
  const digest = verifyIdvDigilockerTestReceipt(receipt, {...idvContext, CANDIDATE: c.id});
  assert.equal(digest, 'c'.repeat(64));
  for (const invalid of [{postflightScope: IDV_DIGILOCKER_SCOPE}, {status: 'ALREADY_INSTALLED_VERIFIED'}, {dryRunPending: []},
    {outOfOrderInstall: {includeAll: true, aheadVersions: []}}, {migrationSha256: 'd'.repeat(64)}]) {
    assert.throws(() => verifyIdvDigilockerTestReceipt({...receipt, ...invalid}, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
  }

  const prod = idvRun('FairSwapProd', {candidateId: c.id, ledger: v2Ledger('FairSwapProd'), ledgerDigest: 'c'.repeat(64),
    env: {IDV_DIGILOCKER_TEST_LEDGER_SHA: digest}});
  try {
    const r = await prod.result;
    assert.equal(r.projectRef, REFS.FairSwapProd);
    assert.equal(r.testLedgerStatementsSha256, digest);
  } finally { rmSync(prod.dir, {recursive: true, force: true}); }

  const fails = async (environment, options, re, applies = 0) => {
    const run = idvRun(environment, {candidateId: c.id, ledgerDigest: 'c'.repeat(64),
      env: environment === 'FairSwapProd' ? {IDV_DIGILOCKER_TEST_LEDGER_SHA: digest} : {}, ...options});
    try {
      await assert.rejects(run.result, re);
      assert.equal(idvApplies(run.full).length, applies);
      assert.ok(!existsSync(join(run.dir, `${c.id}-${environment.toLowerCase()}.json`)));
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  };
  // Production before its V1 install: refused before any database work.
  await fails('FairSwapProd', {ledger: idvLedger('FairSwapProd')}, /PREREQUISITE_MIGRATION_MISSING/);
  await fails('FairSwapProd', {ledger: v2Ledger('FairSwapProd'), env: {}}, /IDV_DIGILOCKER_TEST_EVIDENCE_REQUIRED/);
  await fails('FairSwapProd', {ledger: v2Ledger('FairSwapProd'), env: {TARGET: 'production', IDV_DIGILOCKER_TEST_LEDGER_SHA: digest}}, /IDV_DIGILOCKER_TEST_EVIDENCE_REQUIRED/);
  await fails('FairSwapProd', {ledger: v2Ledger('FairSwapProd'), ledgerDigest: 'e'.repeat(64)}, /IDV_DIGILOCKER_V2_TEST_LEDGER_MISMATCH/, 1);
  await fails('FairSwapTest', {ledger: idvLedger('FairSwapTest', {extra: [idvV1Row({name: 'other'})]})}, /PREREQUISITE_LEDGER_MISMATCH/);
  await fails('FairSwapTest', {ledger: v2Ledger('FairSwapTest'), pre: {gate_setting_off: false}}, /IDV_DIGILOCKER_V2_PREFLIGHT_FAILED/);
  await fails('FairSwapTest', {ledger: v2Ledger('FairSwapTest'), pre: {v2_functions_absent: false}}, /IDV_DIGILOCKER_V2_PREFLIGHT_FAILED/);
  await fails('FairSwapTest', {ledger: idvLedger('FairSwapTest', {extra: [idvV1Row(), {version: c.version, name: 'idv_digilocker_oidc_v2_badge',
    hasStatements: true, statementCount: 1, statementsSha256: 'c'.repeat(64)}]})}, /IDV_DIGILOCKER_V2_ALREADY_RECORDED/);
  await fails('FairSwapTest', {ledger: idvLedger('FairSwapTest', {extra: [idvV1Row(), {version: '20261120000000', name: 'newer', hasStatements: true,
    statementCount: 1, statementsSha256: 'a'.repeat(64)}]})}, /IDV_DIGILOCKER_V2_LEDGER_MISMATCH/);
  for (const post of [{projection_execute: false}, {service_only_execute: false}, {functions_exact: false}, {gate_setting_off: false}, {provenance_columns: false}]) {
    await fails('FairSwapTest', {ledger: v2Ledger('FairSwapTest'), post}, /IDV_DIGILOCKER_V2_POSTFLIGHT_FAILED/, 1);
  }
  await fails('FairSwapTest', {ledger: v2Ledger('FairSwapTest'), preserved: 'a'.repeat(64)}, /IDV_DIGILOCKER_EXISTING_OBJECTS_CHANGED/, 1);
});

test('IDV DigiLocker OIDC V2 checks cover every function in the reviewed SQL and are single read-only statements', () => {
  const sql = readFileSync(join(process.cwd(), getCandidate(IDV_DIGILOCKER_V2_CANDIDATE).path), 'utf8');
  const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(m => m[1]).sort();
  assert.deepEqual(Object.values(IDV_DIGILOCKER_V2_FUNCTIONS).flat().map(sig => sig.split('(')[0]).sort(), created);
  assert.doesNotMatch(sql, /identity_verification_required'\s*,\s*'true'|UPDATE public\.app_system_settings/i);
  for (const [checks, label] of [[IDV_DIGILOCKER_V2_PREFLIGHT, 'v2-preflight'], [IDV_DIGILOCKER_V2_POSTFLIGHT, 'v2-postflight']]) {
    const text = idvDigilockerV2SnapshotSql(checks, label);
    assert.ok(text.startsWith(`-- idv-digilocker-${label}\nBEGIN READ ONLY;\n`) && text.endsWith('COMMIT;'), label);
    assert.equal(text.split(';').length - 1, 4, label);
  }
});

test('disposable PostgreSQL: IDV V1 installed check and V2 preflight/postflight pass on the reviewed SQL and detect grant and provenance drift',
  {skip: PGlite ? false : 'no PGlite module', timeout: 240000}, async () => {
    const src = path => readFileSync(join(process.cwd(), path), 'utf8');
    const db = new PGlite();
    for (const path of ['tests/idv-pg17/fixture.sql', 'tests/idv-pg17/fixture-digilocker.sql',
      'supabase/forward-migrations/idv/20261026183000_idv_digilocker_foundation.sql', getCandidate(IDV_DIGILOCKER_CANDIDATE).path]) await db.exec(src(path));
    const snapshot = async (checks, label, v2 = false) => {
      const results = await db.exec(v2 ? idvDigilockerV2SnapshotSql(checks, label) : idvSnapshotSql(checks, label));
      return JSON.parse(Object.values(results.find(r => r.rows?.length).rows[0])[0]);
    };
    const allTrue = value => Object.values(value.checks).every(v => v === true);
    // An installation with live rows (as in FairSwapTest) still passes the installed-state check.
    await db.exec(`insert into auth.users (id, email) values ('d7d7d7d7-d7d7-4000-8000-0000000000d7', 'x@fairswap.test');
      insert into public.user_accounts (user_id, account_status) values ('d7d7d7d7-d7d7-4000-8000-0000000000d7', 'active');
      select app_security.impl_idv_dl_start_attempt('d7d7d7d7-d7d7-4000-8000-0000000000d7', repeat('7', 64), 600, 'p', true, 'dl-v1.0');`);
    const installed = await snapshot(IDV_DIGILOCKER_INSTALLED, 'installed');
    assert.ok(allTrue(installed), JSON.stringify(installed.checks));
    const pre = await snapshot(IDV_DIGILOCKER_V2_PREFLIGHT, 'v2-preflight', true);
    assert.ok(allTrue(pre), JSON.stringify(pre.checks));
    await db.exec(src(getCandidate(IDV_DIGILOCKER_V2_CANDIDATE).path));
    const post = await snapshot(IDV_DIGILOCKER_V2_POSTFLIGHT, 'v2-postflight', true);
    assert.ok(allTrue(post), JSON.stringify(post.checks));
    assert.equal(post.preserved, pre.preserved);
    assert.equal((await snapshot(IDV_DIGILOCKER_V2_PREFLIGHT, 'v2-preflight', true)).checks.v2_functions_absent, false);   // no re-install
    assert.ok(allTrue(await snapshot(IDV_DIGILOCKER_INSTALLED, 'installed')));   // V1 grants and structure untouched by V2
    const broken = async (sql, key, undo) => {
      await db.exec(sql);
      const value = await snapshot(IDV_DIGILOCKER_V2_POSTFLIGHT, 'v2-postflight', true);
      await db.exec(undo);
      return key ? value.checks[key] : value.preserved;
    };
    assert.equal(await broken('revoke execute on function public.get_digilocker_badges(uuid[]) from anon', 'projection_execute',
      'grant execute on function public.get_digilocker_badges(uuid[]) to anon'), false);
    assert.equal(await broken('grant execute on function public.get_digilocker_badges(uuid[]) to public', 'projection_execute',
      'revoke execute on function public.get_digilocker_badges(uuid[]) from public'), false);
    assert.equal(await broken('grant execute on function app_security.has_digilocker_badge(uuid) to authenticated', 'service_only_execute',
      'revoke execute on function app_security.has_digilocker_badge(uuid) from authenticated'), false);
    assert.equal(await broken("alter function public.get_digilocker_badges(uuid[]) set search_path = public", 'functions_exact',
      "alter function public.get_digilocker_badges(uuid[]) set search_path = ''"), false);
    assert.equal(await broken('grant select on app_security.idv_digilocker_bindings to anon', 'tables_no_client_privileges',
      'revoke select on app_security.idv_digilocker_bindings from anon'), false);
    assert.notEqual(await broken("create function public.idv_v2_probe() returns integer language sql as 'select 1'", null,
      'drop function public.idv_v2_probe()'), pre.preserved);
    assert.equal((await snapshot(IDV_DIGILOCKER_V2_POSTFLIGHT, 'v2-postflight', true)).preserved, pre.preserved);
  });

const PROD_IDV_TAIL_VERSIONS = ['20261117185218', '20261118092010', '20261119090000', '20261119092042', '20261119100640', '20261119102359',
  '20261119103516', '20261119105021', '20261119111559', '20261119114512'];

test('IDV DigiLocker V1 Production tail is exactly the reviewed Taxonomy V2 + disabled V3 Production history, pinned to verified digests', () => {
  assert.deepEqual(IDV_DIGILOCKER_PRODUCTION_TAIL.map(pin => getCandidate(pin.candidateId).version), PROD_IDV_TAIL_VERSIONS);
  assert.deepEqual(IDV_DIGILOCKER_PRODUCTION_TAIL.slice(0, 2), [...IDV_DIGILOCKER_TAIL]);
  assert.deepEqual(IDV_DIGILOCKER_PRODUCTION_TAIL.slice(2).map(pin => pin.candidateId), [...V3_PRODUCTION_SEQUENCE]);
  assert.deepEqual(IDV_DIGILOCKER_PRODUCTION_TAIL.map(pin => getCandidate(pin.candidateId).filename.slice(15, -4)), ['taxonomy_v2_foundation',
    'taxonomy_v2_catalogue', 'v3_production_identity_prerequisite', 'ordinary_goods_v3', 'bounded_goods_v3', 'pedal_and_parts_v3', 'property_intake_v3',
    'regulated_vehicle_drafts_v3', 'specialist_vehicle_draft_binding_v3', 'v3_require_active_seller_identity']);
  // Every pin is the CLI split of the SHA-pinned reviewed source...
  for (const pin of IDV_DIGILOCKER_PRODUCTION_TAIL) {
    verifyCandidateSha(pin.candidateId);
    const statements = splitStatements(readFileSync(join(process.cwd(), getCandidate(pin.candidateId).path), 'utf8'));
    assert.equal(statements.length, pin.statementCount, pin.candidateId);
    assert.equal(pgDigest(statements), pin.statementsSha256, pin.candidateId);
  }
  // ...and the seven V3 schema digests equal the signed FairSwapTest receipts the V3 Production batch must reproduce.
  const receipts = JSON.parse(readFileSync('supabase/forward-migrations/unified-publishing-v3/TEST_RECEIPTS.json', 'utf8'));
  assert.deepEqual(IDV_DIGILOCKER_PRODUCTION_TAIL.slice(3).map(pin => [pin.candidateId, pin.statementsSha256]),
    receipts.map(r => [r.candidateId, r.ledgerStatementsSha256]));
  assert.equal(idvDigilockerTail('FairSwapTest'), IDV_DIGILOCKER_TAIL);
  assert.equal(idvDigilockerTail('FairSwapStaging'), null);
});

test('IDV DigiLocker V1 Production guard fails closed on any deviation from the reviewed Production history', () => {
  const rows = idvTailRows('FairSwapProd');
  const fails = (ledger, re = /LEDGER_TAIL_MISMATCH/) => assert.throws(() => assertIdvDigilockerLedger('FairSwapProd', ledger), re);
  assert.deepEqual(assertIdvDigilockerLedger('FairSwapProd', idvLedger('FairSwapProd')).ahead, PROD_IDV_TAIL_VERSIONS);
  fails(idvLedger('FairSwapProd', {tail: idvTailRows('FairSwapTest')}));                                  // Test history in Production
  fails(idvLedger('FairSwapProd', {tail: rows.slice(0, -1)}));                                            // V3 batch incomplete
  fails(idvLedger('FairSwapProd', {tail: rows.filter((_, i) => i !== 2)}));                               // identity prerequisite missing
  fails(idvLedger('FairSwapProd', {tail: [...rows, {version: '20261119120000', name: 'unreviewed', hasStatements: true, statementCount: 1, statementsSha256: 'a'.repeat(64)}]}));
  fails(idvLedger('FairSwapProd', {tail: [...rows, {version: '20261119113557', name: '20261119120000_idv_digilocker_oidc_diag_test_only', hasStatements: true,
    statementCount: 1, statementsSha256: 'a'.repeat(64)}].sort(idvByVersion)}));                          // Test-only diagnostic row
  fails(idvLedger('FairSwapProd', {tail: [...rows, {version: '20261119200000', name: 'idv_digilocker_oidc_v2_badge', hasStatements: true,
    statementCount: 1, statementsSha256: 'a'.repeat(64)}]}));                                              // V2 recorded before V1: unsafe order
  for (const i of rows.keys()) {
    fails(idvLedger('FairSwapProd', {tail: rows.map((r, j) => j === i ? {...r, statementsSha256: 'f'.repeat(64)} : r)}));
    fails(idvLedger('FairSwapProd', {tail: rows.map((r, j) => j === i ? {...r, statementCount: r.statementCount + 1} : r)}));
    fails(idvLedger('FairSwapProd', {tail: rows.map((r, j) => j === i ? {...r, name: 'renamed'} : r)}));
    fails(idvLedger('FairSwapProd', {tail: rows.map((r, j) => j === i ? {...r, hasStatements: false} : r)}));
  }
  fails(idvLedger('FairSwapProd', {foundation: null}), /FOUNDATION_PREREQUISITE_MISMATCH/);
  fails(idvLedger('FairSwapProd', {extra: [{version: '20261117090000', name: 'idv_digilocker_direct_v1', hasStatements: true}]}), /ALREADY_RECORDED/);
  // The Test fresh-install guard is unchanged: the Production history is not accepted in FairSwapTest.
  assert.throws(() => assertIdvDigilockerLedger('FairSwapTest', idvLedger('FairSwapTest', {tail: rows})), /LEDGER_TAIL_MISMATCH/);
});

// ---------------------------------------------------------------------------------------------
// IDV DigiLocker mandatory-gate predicate (20261122100000): FairSwapTest ONLY, never promoted, gate stays OFF
// ---------------------------------------------------------------------------------------------
const {
  IDV_DIGILOCKER_REQUIRED_CANDIDATE, IDV_DIGILOCKER_REQUIRED_SCOPE, IDV_DIGILOCKER_REQUIRED_PREREQUISITES, IDV_DIGILOCKER_REQUIRED_PREFLIGHT,
  IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, ENFORCE_VERIFIED_ACTOR_STATES, assertIdvDigilockerRequiredLedger, enforceVerifiedActorState,
  idvDigilockerEvolvedVariant, idvDigilockerRequiredSnapshotSql, verifyIdvDigilockerRequiredTestReceipt, runIdvDigilockerInstalledCheck
} = await import('../../scripts/release/idv-digilocker-v1-release.mjs');
const REQ_PIN = ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.ledger;
const reqRow = (over = {}) => ({version: REQ_PIN.version, name: REQ_PIN.name, hasStatements: true, statementCount: REQ_PIN.statementCount,
  statementsSha256: REQ_PIN.statementsSha256, ...over});
const reqV2Row = (over = {}) => ({version: '20261119200000', name: 'idv_digilocker_oidc_v2_badge', hasStatements: true,
  statementCount: IDV_DIGILOCKER_REQUIRED_PREREQUISITES[1].statementCount, statementsSha256: IDV_DIGILOCKER_REQUIRED_PREREQUISITES[1].statementsSha256, ...over});
const reqLedger = ({v1 = idvV1Row(), v2 = reqV2Row(), extra = [], ...rest} = {}) =>
  idvLedger('FairSwapTest', {extra: [...(v1 ? [v1] : []), ...(v2 ? [v2] : []), ...extra], ...rest});
const enforceBodyMd5 = path => {
  const m = readFileSync(join(process.cwd(), path), 'utf8')
    .match(/CREATE (?:OR REPLACE )?FUNCTION app_security\.enforce_verified_actor\(([\s\S]*?)\$\$([\s\S]*?)\$\$;/i);
  assert.ok(m, path);
  return createHash('md5').update(m[2]).digest('hex');
};

function reqRun(environment = 'FairSwapTest', {ledger = reqLedger(), env = {}, recorded = {}, pre = {}, post = {}, preserved, dryOutput} = {}) {
  const c = getCandidate(IDV_DIGILOCKER_REQUIRED_CANDIDATE);
  const dir = mkdtempSync(join(tmpdir(), 'idv-required-'));
  const full = [];
  const before = ledger.map(row => row.version);
  let reads = 0;
  const base = makeRunner({before, after: [...before, c.version], filename: c.filename, sql: q => {
    if (q.startsWith('-- idv-digilocker-required-preflight')) return idvChecks(IDV_DIGILOCKER_REQUIRED_PREFLIGHT, pre);
    if (q.startsWith('-- idv-digilocker-required-postflight')) return {...idvChecks(IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, post), ...(preserved ? {preserved} : {})};
    if (q.startsWith('-- idv-digilocker')) assert.fail(`unexpected IDV query ${q.split('\n')[0]}`);
    return [...ledger, ...(++reads === 3 ? [reqRow(recorded)] : [])].sort(idvByVersion);
  }});
  const runner = (cmd, args, ...rest) => {
    full.push([cmd, ...args]);
    if (cmd === 'supabase' && args.includes('--dry-run') && dryOutput) return dryOutput;
    return base(cmd, args, ...rest);
  };
  const result = releaseReusable({environment, candidateId: c.id, receiptDir: dir, context: {...idvContext, ...env}, runner});
  return {result, full, dir};
}

test('IDV required gate: exact Test-only registry entry, source-derived pins, and Production impossible from every dispatch target', () => {
  const {candidate, sha256} = verifyCandidateSha(IDV_DIGILOCKER_REQUIRED_CANDIDATE);
  assert.deepEqual([candidate.version, candidate.filename, candidate.path, sha256], ['20261122100000', '20261122100000_idv_digilocker_required_gate.sql',
    'supabase/forward-migrations/idv/20261122100000_idv_digilocker_required_gate.sql', '2fa2064dcf19317ab7347cd78db6362e4f7810d078c79ec3d0465b6e5d609961']);
  assert.equal(candidate.testOnly, true);
  assert.equal(candidate.autoPromote, false);
  assert.equal(candidate.strict, undefined);
  assert.equal(candidate.allowedProjectRef, 'wpppxlnbzqynvhpeuavd');
  assert.equal(candidate.allowedProjectRef, REFS.FairSwapTest);
  assert.notEqual(candidate.allowedProjectRef, REFS.FairSwapProd);
  assert.deepEqual(candidate.requiredLedgerVersions, [getCandidate(IDV_DIGILOCKER_CANDIDATE).version, getCandidate(IDV_DIGILOCKER_V2_CANDIDATE).version]);
  assert.equal(planDispatch({candidateId: candidate.id, target: 'test'}).candidate, candidate);
  assert.throws(() => planDispatch({candidateId: candidate.id, target: 'production'}), /TEST_ONLY_CANDIDATE/);
  assert.throws(() => planDispatch({candidateId: candidate.id, target: 'adopt'}), /TEST_ONLY_CANDIDATE/);
  assert.equal(EXISTING_INSTALLATIONS[`${candidate.id}|FairSwapProd`], undefined);

  // Ledger and body pins are derived from the SHA-pinned sources, never typed in independently.
  const statements = splitStatements(readFileSync(join(process.cwd(), candidate.path), 'utf8'));
  assert.deepEqual([REQ_PIN.version, REQ_PIN.name, REQ_PIN.statementCount, REQ_PIN.statementsSha256],
    [candidate.version, candidate.filename.slice(15, -4), statements.length, pgDigest(statements)]);
  assert.equal(ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5, enforceBodyMd5(candidate.path));
  assert.equal(ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5, enforceBodyMd5(getCandidate(IDV_DIGILOCKER_CANDIDATE).path));
  assert.equal(ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5, enforceBodyMd5(getCandidate(V3_IDENTITY_PREREQUISITE).path));
  assert.notEqual(ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5, ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5);
  const [v1Pin, v2Pin] = IDV_DIGILOCKER_REQUIRED_PREREQUISITES;
  for (const pin of [v1Pin, v2Pin]) {
    const c = getCandidate(pin.candidateId);
    assert.deepEqual([pin.version, pin.name], [c.version, c.filename.slice(15, -4)]);
  }
  const v2Statements = splitStatements(readFileSync(join(process.cwd(), getCandidate(IDV_DIGILOCKER_V2_CANDIDATE).path), 'utf8'));
  assert.deepEqual([v2Pin.statementCount, v2Pin.statementsSha256], [v2Statements.length, pgDigest(v2Statements)]);
  // Production keeps the unchanged historical V3 pin; the evolved body is never accepted by a Production check.
  for (const checks of [IDV_DIGILOCKER_PRODUCTION_PREFLIGHT, IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT]) {
    const text = JSON.stringify(checks);
    assert.ok(text.includes(ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5));
    assert.ok(!text.includes(ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5));
  }

  const yaml = readFileSync('.github/workflows/reusable-supabase-release.yml', 'utf8');
  assert.match(yaml, /- idv-digilocker-oidc-v2\n(?: {10}#[^\n]*\n)? {10}- idv-digilocker-required-gate\n/);
  assert.ok(yaml.includes("inputs.candidate != 'v3-test-remaining-batch' && inputs.candidate != 'idv-digilocker-required-gate' &&"));
  assert.ok(yaml.includes("if: ${{ inputs.candidate == 'idv-digilocker-required-gate' }}"));
  assert.ok(yaml.includes('verifyIdvDigilockerRequiredTestReceipt'));
  assert.equal((yaml.match(/idv-digilocker-required-gate/g) ?? []).length, 4);   // option, receipt step (2), production exclusion
  assert.doesNotMatch(yaml, /identity_verification_required/i);
});

test('IDV required gate: the production job is skipped for every input combination, so the candidate can never auto-promote', () => {
  const yaml = readFileSync('.github/workflows/reusable-supabase-release.yml', 'utf8');
  const id = IDV_DIGILOCKER_REQUIRED_CANDIDATE;
  const digests = {idv_digilocker_ledger_sha: 'b'.repeat(64), mobile_catalogue_ledger_sha: 'b'.repeat(64), listing_validity_ledger_sha: 'b'.repeat(64),
    taxonomy_ledger_sha: 'b'.repeat(64)};
  for (const target of ['test', 'production', 'adopt']) {
    for (const autoPromote of [false, true]) {   // true is impossible for this candidate, but the job must still not run
      for (const [testResult, verifyTest] of [['success', 'success'], ['skipped', 'skipped'], ['failure', 'skipped']]) {
        for (const outputs of [{}, digests]) {
          assert.equal(productionJobRuns(yaml, {candidate: id, target, autoPromote, test: testResult, verifyTest, outputs}), false,
            JSON.stringify({target, autoPromote, testResult, verifyTest, outputs}));
        }
      }
    }
  }
  assert.equal(planDispatch({candidateId: id, target: 'test'}).candidate.autoPromote, false);   // verify job emits auto_promote=false
});

test('IDV required gate: in-order FairSwapTest apply with exact ledger, preflight/postflight, gate OFF and a sanitized receipt', async () => {
  const c = getCandidate(IDV_DIGILOCKER_REQUIRED_CANDIDATE);
  const run = reqRun();
  let receipt;
  try {
    receipt = await run.result;
    assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.deepEqual([receipt.environment, receipt.projectRef, receipt.migrationVersion, receipt.migrationFile, receipt.migrationSha256],
      ['FairSwapTest', 'wpppxlnbzqynvhpeuavd', c.version, c.filename, c.sha256]);
    assert.deepEqual(receipt.dryRunPending, [c.filename]);
    assert.equal(receipt.outOfOrderInstall, undefined);
    assert.equal(receipt.ledgerStatementsSha256, REQ_PIN.statementsSha256);
    assert.equal(receipt.postflightScope, IDV_DIGILOCKER_REQUIRED_SCOPE);
    assert.equal(receipt.identityVerificationRequired, false);
    assert.equal(receipt.edgeFunctionsDeployedByThisWorkflow, false);
    assert.equal(receipt.testOnly, true);
    assert.equal(receipt.autoPromote, false);
    assert.equal(receipt.testLedgerStatementsSha256, undefined);
    assert.deepEqual(receipt.requiredLedger, [{version: '20261117090000', name: 'idv_digilocker_direct_v1'},
      {version: '20261119200000', name: 'idv_digilocker_oidc_v2_badge'}]);
    assert.deepEqual(receipt.enforceVerifiedActorTransition, {from: {state: 'historical', bodyMd5: ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5},
      to: {state: 'requiredGate', bodyMd5: ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5}});
    assert.deepEqual(readdirSync(run.dir).sort(), ['SHA256SUMS_fairswaptest', 'idv-digilocker-required-gate-fairswaptest.json']);
    const bytes = readFileSync(join(run.dir, 'idv-digilocker-required-gate-fairswaptest.json'), 'utf8');
    assert.equal(readFileSync(join(run.dir, 'SHA256SUMS_fairswaptest'), 'utf8'),
      `${createHash('sha256').update(bytes).digest('hex')}  idv-digilocker-required-gate-fairswaptest.json\n`);
    for (const secret of ['sbp_mock_token', 'mock_password', 'pooler.supabase.com', 'BEGIN CERTIFICATE', 'f'.repeat(64)]) assert.ok(!bytes.includes(secret), secret);
    // CLI links only the FairSwapTest ref; no --include-all; preflight before dry run, postflight after apply.
    const link = run.full.find(cmd => cmd[0] === 'supabase' && cmd.includes('link'));
    assert.equal(link[link.indexOf('--project-ref') + 1], 'wpppxlnbzqynvhpeuavd');
    assert.ok(!run.full.flat().some(arg => String(arg).includes(REFS.FairSwapProd)));
    const [dry, apply] = pushes(run.full);
    assert.ok(dry.includes('--dry-run') && !dry.includes('--include-all') && apply.includes('--yes') && !apply.includes('--include-all'));
    assert.ok(!run.full.some(cmd => cmd.includes('--help')));
    const at = label => run.full.findIndex(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith(`-- idv-digilocker-${label}\nBEGIN READ ONLY;`));
    assert.ok(at('required-preflight') >= 0 && at('required-preflight') < run.full.indexOf(dry) && at('required-postflight') > run.full.indexOf(apply));
    const sql = run.full.filter(cmd => cmd[0] === 'psql').map(cmd => cmd.at(-1));
    assert.ok(sql.find(q => q.startsWith('-- idv-digilocker-required-preflight')).includes(`md5(p.prosrc) = '${ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5}'`));
    assert.ok(sql.find(q => q.startsWith('-- idv-digilocker-required-postflight')).includes(`md5(p.prosrc) = '${ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5}'`));
    assert.ok(!sql.some(q => /identity_verification_required'\s*,\s*'true'|UPDATE |INSERT |DELETE /i.test(q)));
  } finally { rmSync(run.dir, {recursive: true, force: true}); }

  const ctx = {...idvContext, CANDIDATE: c.id};
  assert.equal(verifyIdvDigilockerRequiredTestReceipt(receipt, ctx), REQ_PIN.statementsSha256);
  for (const invalid of [{environment: 'FairSwapProd'}, {projectRef: REFS.FairSwapProd}, {releaseWorkflowRun: '132'}, {releaseWorkflowAttempt: '2'},
    {reviewedCommit: 'f'.repeat(40)}, {migrationSha256: 'd'.repeat(64)}, {postflightVerified: false}, {postflightScope: IDV_DIGILOCKER_V2_SCOPE},
    {identityVerificationRequired: true}, {edgeFunctionsDeployedByThisWorkflow: true}, {testOnly: false}, {autoPromote: true},
    {ledgerStatementsSha256: 'b'.repeat(64)}, {testLedgerStatementsSha256: REQ_PIN.statementsSha256}, {status: 'ALREADY_APPLIED_VERIFIED'},
    {dryRunPending: []}, {outOfOrderInstall: {includeAll: true, aheadVersions: []}}, {requiredLedger: []},
    {enforceVerifiedActorTransition: {from: {state: 'historical', bodyMd5: 'x'}, to: {state: 'requiredGate', bodyMd5: 'y'}}},
    {prerequisiteLedger: IDV_FOUNDATION_LEDGER.FairSwapProd}]) {
    assert.throws(() => verifyIdvDigilockerRequiredTestReceipt({...receipt, ...invalid}, ctx), /IDV_DIGILOCKER_REQUIRED_TEST_RECEIPT_INVALID/, JSON.stringify(invalid));
  }
  assert.throws(() => verifyIdvDigilockerRequiredTestReceipt(receipt, {...ctx, CANDIDATE: IDV_DIGILOCKER_V2_CANDIDATE}), /REQUIRED_TEST_RECEIPT_INVALID/);
  // It is never accepted as V1/V2 promotion evidence.
  assert.throws(() => verifyIdvDigilockerTestReceipt(receipt, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
});

test('IDV required gate: Production is refused before any tool, credential or SQL runs, whatever the target or Test evidence', async () => {
  const c = getCandidate(IDV_DIGILOCKER_REQUIRED_CANDIDATE);
  for (const env of [{}, {TARGET: 'production'}, {TARGET: 'adopt'}, {TARGET: 'test', IDV_DIGILOCKER_TEST_LEDGER_SHA: REQ_PIN.statementsSha256}]) {
    const run = reqRun('FairSwapProd', {env});
    try {
      await assert.rejects(run.result, /REUSABLE_RELEASE_TEST_ONLY_CANDIDATE/);
      assert.deepEqual(run.full, []);
      assert.deepEqual(readdirSync(run.dir), []);
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  }
  // A FairSwapTest call that is not a target=test dispatch is refused too.
  for (const TARGET of ['production', 'adopt', '']) {
    const run = reqRun('FairSwapTest', {env: {TARGET}});
    try { await assert.rejects(run.result, /IDV_DIGILOCKER_REQUIRED_TEST_ONLY/); assert.deepEqual(run.full, []); }
    finally { rmSync(run.dir, {recursive: true, force: true}); }
  }
  await assert.rejects(verifyRemotePostflight('FairSwapProd', c.id, 'url', {}, () => assert.fail('no SQL may run')), /REQUIRED_TEST_ONLY/);
  await assert.rejects(adoptExistingInstallation({environment: 'FairSwapProd', candidateId: c.id, context: idvContext,
    runner: () => assert.fail('no tool may run')}), /ADOPTION_NOT_REGISTERED/);
  await assert.rejects(releaseV3ProductionBatch({environment: 'FairSwapProd', candidateId: c.id, context: idvContext,
    runner: () => assert.fail('no tool may run')}), /V3_PRODUCTION_BATCH_CONTEXT_REQUIRED/);
  assert.ok(!V3_PRODUCTION_SEQUENCE.includes(c.id));
  assert.throws(() => assertIdvDigilockerRequiredLedger('FairSwapProd', idvLedger('FairSwapProd')), /REQUIRED_GATE_TEST_ONLY/);
});

test('IDV required gate fails closed before any apply on ledger, prerequisite or preflight drift, and withholds receipts after apply', async () => {
  const attempt = async (options, re, {dryRuns = 0, applies = 0} = {}) => {
    const run = reqRun('FairSwapTest', options);
    try {
      await assert.rejects(run.result, re);
      assert.equal(idvApplies(run.full).length, applies);
      assert.equal(pushes(run.full).length, dryRuns);
      assert.ok(!existsSync(join(run.dir, 'idv-digilocker-required-gate-fairswaptest.json')));
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  };
  const c = getCandidate(IDV_DIGILOCKER_REQUIRED_CANDIDATE);
  await attempt({ledger: reqLedger({v2: null})}, /PREREQUISITE_MIGRATION_MISSING/);
  await attempt({ledger: reqLedger({v1: null})}, /PREREQUISITE_MIGRATION_MISSING/);
  await attempt({ledger: reqLedger({v2: reqV2Row({statementsSha256: 'a'.repeat(64)})})}, /REQUIRED_GATE_PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: reqLedger({v2: reqV2Row({statementCount: 22})})}, /REQUIRED_GATE_PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: reqLedger({v2: reqV2Row({name: 'renamed'})})}, /PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: reqLedger({v1: idvV1Row({name: 'renamed'})})}, /PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: reqLedger({v1: idvV1Row({hasStatements: false, statementCount: 0})})}, /PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: reqLedger({foundation: null})}, /FOUNDATION_PREREQUISITE_MISMATCH/);
  await attempt({ledger: reqLedger({foundation: IDV_FOUNDATION_LEDGER.FairSwapProd})}, /FOUNDATION_PREREQUISITE_MISMATCH/);
  await attempt({ledger: reqLedger({extra: [reqRow()]})}, /IDV_DIGILOCKER_REQUIRED_ALREADY_RECORDED/);
  await attempt({ledger: reqLedger({extra: [reqRow({version: '20261121000000'})]})}, /REQUIRED_GATE_LEDGER_MISMATCH/);   // name reused elsewhere
  await attempt({ledger: reqLedger({extra: [{version: '20261123000000', name: 'newer', hasStatements: true, statementCount: 1,
    statementsSha256: 'a'.repeat(64)}]})}, /IDV_DIGILOCKER_REQUIRED_LEDGER_MISMATCH/);
  for (const key of ['gate_setting_off', 'gate_function_off', 'enforce_state_exact', 'enforce_server_only', 'v1_structure', 'provenance_columns', 'unexpected_key']) {
    await attempt({pre: {[key]: false}}, /IDV_DIGILOCKER_REQUIRED_PREFLIGHT_FAILED/);
  }
  await attempt({dryOutput: `Would push these migrations:\n • ${c.filename}\n • 20261123000000_unreviewed.sql`}, /DRY_RUN_MISMATCH/, {dryRuns: 1});
  await attempt({dryOutput: 'Remote database is up to date.'}, /DRY_RUN_MISMATCH/, {dryRuns: 1});
  // After apply: ledger row and every postflight key are binding; no receipt is written.
  for (const recorded of [{statementsSha256: 'a'.repeat(64)}, {hasStatements: false, statementCount: 0}, {name: 'other'}]) {
    await attempt({recorded}, /IDV_DIGILOCKER_REQUIRED_LEDGER_MISMATCH|TABLETS_LEDGER_CHANGED/, {dryRuns: 2, applies: 1});
  }
  for (const key of ['gate_setting_off', 'gate_function_off', 'enforce_state_exact', 'enforce_single_overload', 'enforce_server_only',
    'v1_grants_unchanged', 'service_only_execute', 'projection_execute']) {
    await attempt({post: {[key]: false}}, /IDV_DIGILOCKER_REQUIRED_POSTFLIGHT_FAILED/, {dryRuns: 2, applies: 1});
  }
  await attempt({preserved: 'a'.repeat(64)}, /IDV_DIGILOCKER_EXISTING_OBJECTS_CHANGED/, {dryRuns: 2, applies: 1});
  for (const [checks, label] of [[IDV_DIGILOCKER_REQUIRED_PREFLIGHT, 'required-preflight'], [IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, 'required-postflight']]) {
    const text = idvDigilockerRequiredSnapshotSql(checks, label);
    assert.ok(text.startsWith(`-- idv-digilocker-${label}\nBEGIN READ ONLY;\n`) && text.endsWith('COMMIT;'), label);
    assert.equal(text.split(';').length - 1, 4, label);
  }
  assert.deepEqual(Object.keys(IDV_DIGILOCKER_REQUIRED_PREFLIGHT), Object.keys(IDV_DIGILOCKER_REQUIRED_POSTFLIGHT));
});

test('enforce_verified_actor evolution is explicit and ledger-bound; the historical state stays valid; Production may only be historical', async () => {
  assert.equal(enforceVerifiedActorState('FairSwapTest', reqLedger()), 'historical');
  assert.equal(enforceVerifiedActorState('FairSwapTest', reqLedger({extra: [reqRow()]})), 'requiredGate');
  assert.equal(enforceVerifiedActorState('FairSwapProd', idvLedger('FairSwapProd')), 'historical');
  for (const over of [{statementsSha256: 'a'.repeat(64)}, {statementCount: 9}, {hasStatements: false}, {name: 'renamed'}, {version: '20261122100001'}]) {
    assert.throws(() => enforceVerifiedActorState('FairSwapTest', reqLedger({extra: [reqRow(over)]})), /REQUIRED_GATE_LEDGER_MISMATCH/, JSON.stringify(over));
  }
  assert.throws(() => enforceVerifiedActorState('FairSwapTest', reqLedger({extra: [reqRow(), reqRow({version: '20261123000000'})]})), /REQUIRED_GATE_LEDGER_MISMATCH/);
  assert.throws(() => enforceVerifiedActorState('FairSwapProd', idvLedger('FairSwapProd', {extra: [reqRow()]})), /REQUIRED_GATE_PRODUCTION_FORBIDDEN/);
  assert.throws(() => enforceVerifiedActorState('FairSwapStaging', reqLedger()), /ENFORCE_STATE_ENVIRONMENT_INVALID/);
  // The V1 Production ledger guard independently rejects the row (unreviewed tail).
  assert.throws(() => assertIdvDigilockerLedger('FairSwapProd', idvLedger('FairSwapProd', {extra: [reqRow()]})), /LEDGER_TAIL_MISMATCH/);

  // V1 FairSwapTest attestation, historical: unchanged receipt shape, body bound to the historical pin.
  const historical = idvRun('FairSwapTest', {ledger: idvTestInstalledLedger()});
  let receipt;
  try {
    receipt = await historical.result;
    assert.equal(receipt.installedStateVariant, undefined);
    const q = historical.full.find(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith('-- idv-digilocker-installed')).at(-1);
    assert.ok(q.includes(`md5(p.prosrc) = '${ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5}'`) && q.includes("'enforce_verified_actor_state'"));
    assert.ok(!q.includes(ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5));
  } finally { rmSync(historical.dir, {recursive: true, force: true}); }
  assert.equal(verifyIdvDigilockerTestReceipt(receipt, idvContext), 'b'.repeat(64));
  // V1 FairSwapTest attestation after 20261122100000: an explicit evolved variant, never silently "historical".
  const evolved = idvRun('FairSwapTest', {ledger: reqLedger({extra: [reqRow()]})});
  let evolvedReceipt;
  try {
    evolvedReceipt = await evolved.result;
    assert.equal(evolvedReceipt.status, 'ALREADY_INSTALLED_VERIFIED');
    assert.deepEqual(evolvedReceipt.installedStateVariant, idvDigilockerEvolvedVariant());
    assert.deepEqual(evolvedReceipt.installedStateVariant, {state: 'requiredGate', ledger: {...REQ_PIN},
      enforceVerifiedActorBodyMd5: ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5});
    assert.deepEqual(pushes(evolved.full), []);
    const q = evolved.full.find(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith('-- idv-digilocker-installed')).at(-1);
    assert.ok(q.includes(`md5(p.prosrc) = '${ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5}'`));
    assert.ok(!q.includes(`md5(p.prosrc) = '${ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5}'`));
  } finally { rmSync(evolved.dir, {recursive: true, force: true}); }
  assert.equal(verifyIdvDigilockerTestReceipt(evolvedReceipt, idvContext), 'b'.repeat(64));
  for (const installedStateVariant of [{...idvDigilockerEvolvedVariant(), state: 'historical'}, {...idvDigilockerEvolvedVariant(), enforceVerifiedActorBodyMd5: 'x'},
    {...idvDigilockerEvolvedVariant(), ledger: {...REQ_PIN, statementsSha256: 'a'.repeat(64)}}, null, 'requiredGate']) {
    assert.throws(() => verifyIdvDigilockerTestReceipt({...evolvedReceipt, installedStateVariant}, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
  }
  // A partially matching evolution row is refused before the installed-state SQL runs; body drift is refused by the SQL.
  const partial = idvRun('FairSwapTest', {ledger: reqLedger({extra: [reqRow({statementsSha256: 'a'.repeat(64)})]})});
  try {
    await assert.rejects(partial.result, /REQUIRED_GATE_LEDGER_MISMATCH/);
    assert.ok(!partial.full.some(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith('-- idv-digilocker-installed')));
  } finally { rmSync(partial.dir, {recursive: true, force: true}); }
  const drift = idvRun('FairSwapTest', {ledger: reqLedger({extra: [reqRow()]}), installed: {enforce_verified_actor_state: false}});
  try { await assert.rejects(drift.result, /IDV_DIGILOCKER_INSTALLED_FAILED/); } finally { rmSync(drift.dir, {recursive: true, force: true}); }
  assert.equal(runIdvDigilockerInstalledCheck(() => JSON.stringify(idvChecks(idvDigilockerInstalledChecks('requiredGate')))).enforceVerifiedActorState, 'historical');
});

test('disposable PostgreSQL (PGlite, not native PG17): required-gate preflight/postflight and the enforce_verified_actor states on the reviewed SQL chain',
  {skip: PGlite ? false : 'no PGlite module', timeout: 240000}, async () => {
    const src = path => readFileSync(join(process.cwd(), path), 'utf8');
    const db = new PGlite();
    for (const path of ['tests/idv-pg17/fixture.sql', 'tests/idv-pg17/fixture-digilocker.sql',
      'supabase/forward-migrations/idv/20261026183000_idv_digilocker_foundation.sql', getCandidate(IDV_DIGILOCKER_CANDIDATE).path,
      getCandidate(IDV_DIGILOCKER_V2_CANDIDATE).path]) await db.exec(src(path));
    const snapshot = async (checks, label, required = true) => {
      const results = await db.exec(required ? idvDigilockerRequiredSnapshotSql(checks, label) : idvSnapshotSql(checks, label));
      return JSON.parse(Object.values(results.find(r => r.rows?.length).rows[0])[0]);
    };
    const allTrue = value => Object.values(value.checks).every(v => v === true);
    const pre = await snapshot(IDV_DIGILOCKER_REQUIRED_PREFLIGHT, 'required-preflight');
    assert.ok(allTrue(pre), JSON.stringify(pre.checks));
    assert.ok(allTrue(await snapshot(idvDigilockerInstalledChecks('historical'), 'installed', false)));
    assert.equal((await snapshot(idvDigilockerInstalledChecks('requiredGate'), 'installed', false)).checks.enforce_verified_actor_state, false);
    assert.equal((await snapshot(IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, 'required-postflight')).checks.enforce_state_exact, false);

    await db.exec(src(getCandidate(IDV_DIGILOCKER_REQUIRED_CANDIDATE).path));
    const post = await snapshot(IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, 'required-postflight');
    assert.ok(allTrue(post), JSON.stringify(post.checks));
    assert.equal(post.preserved, pre.preserved);
    assert.equal((await snapshot(IDV_DIGILOCKER_REQUIRED_PREFLIGHT, 'required-preflight')).checks.enforce_state_exact, false);   // no re-run
    assert.ok(allTrue(await snapshot(idvDigilockerInstalledChecks('requiredGate'), 'installed', false)));
    assert.equal((await snapshot(idvDigilockerInstalledChecks('historical'), 'installed', false)).checks.enforce_verified_actor_state, false);

    const broken = async (sql, key, undo) => {
      await db.exec(sql);
      const value = await snapshot(IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, 'required-postflight');
      await db.exec(undo);
      return key ? value.checks[key] : value.preserved;
    };
    // Activating the gate is owner-run and out of scope: the postflight reports it as drift by design.
    assert.equal(await broken("update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required'",
      'gate_setting_off', "update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required'"), false);
    assert.equal(await broken('grant execute on function app_security.enforce_verified_actor(uuid,boolean) to authenticated', 'enforce_server_only',
      'revoke execute on function app_security.enforce_verified_actor(uuid,boolean) from authenticated'), false);
    assert.equal(await broken('revoke execute on function app_security.enforce_verified_actor(uuid,boolean) from service_role', 'enforce_server_only',
      'grant execute on function app_security.enforce_verified_actor(uuid,boolean) to service_role'), false);
    assert.equal(await broken("alter function app_security.enforce_verified_actor(uuid,boolean) set search_path = public", 'enforce_state_exact',
      "alter function app_security.enforce_verified_actor(uuid,boolean) set search_path = ''"), false);
    assert.equal(await broken('grant execute on function app_security.has_digilocker_badge(uuid) to authenticated', 'service_only_execute',
      'revoke execute on function app_security.has_digilocker_badge(uuid) from authenticated'), false);
    assert.notEqual(await broken("create function public.idv_required_probe() returns integer language sql as 'select 1'", null,
      'drop function public.idv_required_probe()'), pre.preserved);
    assert.equal((await snapshot(IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, 'required-postflight')).preserved, pre.preserved);
  });

// ---------------------------------------------------------------------------------------------
// IDV DigiLocker Aadhaar ACR evidence (20261123120000): FairSwapTest ONLY, never promoted, live gate ON before AND after
// ---------------------------------------------------------------------------------------------
const {
  IDV_DIGILOCKER_ACR_CANDIDATE, IDV_DIGILOCKER_ACR_SCOPE, IDV_DIGILOCKER_ACR_LEDGER, IDV_DIGILOCKER_ACR_BODIES, IDV_DIGILOCKER_ACR_PREFLIGHT,
  IDV_DIGILOCKER_ACR_POSTFLIGHT, assertIdvDigilockerAcrLedger, idvAcrLedgerState, idvDigilockerAcrSnapshotSql, verifyIdvDigilockerAcrTestReceipt
} = await import('../../scripts/release/idv-digilocker-v1-release.mjs');
const acrRow = (over = {}) => ({version: IDV_DIGILOCKER_ACR_LEDGER.version, name: IDV_DIGILOCKER_ACR_LEDGER.name, hasStatements: true,
  statementCount: IDV_DIGILOCKER_ACR_LEDGER.statementCount, statementsSha256: IDV_DIGILOCKER_ACR_LEDGER.statementsSha256, ...over});
// Every historical prerequisite receipt as pinned: V1 (version/name), V2 (count/digest) and the required gate (count/digest).
const acrLedger = ({gate = reqRow(), ...rest} = {}) => reqLedger({extra: [...(gate ? [gate] : []), ...(rest.extra ?? [])], ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'extra'))});
const fnBodyMd5 = (path, signature) => {
  const text = readFileSync(join(process.cwd(), path), 'utf8');
  const at = text.indexOf(`FUNCTION ${signature}(`);
  assert.ok(at >= 0, `${path} ${signature}`);
  const start = text.indexOf('$$', at) + 2;
  return createHash('md5').update(text.slice(start, text.indexOf('$$', start))).digest('hex');
};

function acrRun(environment = 'FairSwapTest', {ledger = acrLedger(), env = {}, recorded = {}, pre = {}, post = {}, preserved, dryOutput} = {}) {
  const c = getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE);
  const dir = mkdtempSync(join(tmpdir(), 'idv-acr-'));
  const full = [];
  const before = ledger.map(row => row.version);
  let reads = 0;
  const base = makeRunner({before, after: [...before, c.version], filename: c.filename, sql: q => {
    if (q.startsWith('-- idv-digilocker-acr-preflight')) return idvChecks(IDV_DIGILOCKER_ACR_PREFLIGHT, pre);
    if (q.startsWith('-- idv-digilocker-acr-postflight')) return {...idvChecks(IDV_DIGILOCKER_ACR_POSTFLIGHT, post), ...(preserved ? {preserved} : {})};
    if (q.startsWith('-- idv-digilocker')) assert.fail(`unexpected IDV query ${q.split('\n')[0]}`);
    return [...ledger, ...(++reads === 3 ? [acrRow(recorded)] : [])].sort(idvByVersion);
  }});
  const runner = (cmd, args, ...rest) => {
    full.push([cmd, ...args]);
    if (cmd === 'supabase' && args.includes('--dry-run') && dryOutput) return dryOutput;
    return base(cmd, args, ...rest);
  };
  const result = releaseReusable({environment, candidateId: c.id, receiptDir: dir, context: {...idvContext, ...env}, runner});
  return {result, full, dir};
}

test('IDV Aadhaar ACR: exact Test-only registry entry, source-derived pins, and Production impossible from every dispatch target', () => {
  const {candidate, sha256} = verifyCandidateSha(IDV_DIGILOCKER_ACR_CANDIDATE);
  assert.deepEqual([candidate.version, candidate.filename, candidate.path, sha256], ['20261123120000', '20261123120000_idv_digilocker_aadhaar_acr.sql',
    'supabase/forward-migrations/idv/20261123120000_idv_digilocker_aadhaar_acr.sql', '4e2b5ed60d4e799a69114e5ba445e27e7bb37ab9eace268608f414718649d79d']);
  assert.equal(candidate.testOnly, true);
  assert.equal(candidate.autoPromote, false);
  assert.equal(candidate.strict, undefined);
  assert.equal(candidate.allowedProjectRef, 'wpppxlnbzqynvhpeuavd');
  assert.equal(candidate.allowedProjectRef, REFS.FairSwapTest);
  assert.notEqual(candidate.allowedProjectRef, REFS.FairSwapProd);
  assert.deepEqual(candidate.requiredLedgerVersions, ['20261117090000', '20261119200000', '20261122100000']);
  assert.equal(planDispatch({candidateId: candidate.id, target: 'test'}).candidate, candidate);
  assert.throws(() => planDispatch({candidateId: candidate.id, target: 'production'}), /TEST_ONLY_CANDIDATE/);
  assert.throws(() => planDispatch({candidateId: candidate.id, target: 'adopt'}), /TEST_ONLY_CANDIDATE/);
  assert.equal(EXISTING_INSTALLATIONS[`${candidate.id}|FairSwapProd`], undefined);
  assert.ok(!V3_PRODUCTION_SEQUENCE.includes(candidate.id));

  // Ledger and body pins are derived from the SHA-pinned sources, never typed in independently.
  const statements = splitStatements(readFileSync(join(process.cwd(), candidate.path), 'utf8'));
  assert.deepEqual([IDV_DIGILOCKER_ACR_LEDGER.version, IDV_DIGILOCKER_ACR_LEDGER.name, IDV_DIGILOCKER_ACR_LEDGER.statementCount, IDV_DIGILOCKER_ACR_LEDGER.statementsSha256],
    [candidate.version, candidate.filename.slice(15, -4), statements.length, pgDigest(statements)]);
  const v2 = getCandidate(IDV_DIGILOCKER_V2_CANDIDATE).path;
  assert.equal(IDV_DIGILOCKER_ACR_BODIES.before.badge, fnBodyMd5(v2, 'app_security.has_digilocker_badge'));
  assert.equal(IDV_DIGILOCKER_ACR_BODIES.before.complete, fnBodyMd5(v2, 'app_security.impl_idv_dl_complete_v2'));
  assert.equal(IDV_DIGILOCKER_ACR_BODIES.after.badge, fnBodyMd5(candidate.path, 'app_security.has_digilocker_badge'));
  assert.equal(IDV_DIGILOCKER_ACR_BODIES.after.complete, fnBodyMd5(candidate.path, 'app_security.impl_idv_dl_complete_v2'));
  assert.equal(IDV_DIGILOCKER_ACR_BODIES.wrapper, fnBodyMd5(v2, 'public.server_idv_dl_complete_v2'));   // unchanged wrapper
  assert.notEqual(IDV_DIGILOCKER_ACR_BODIES.before.badge, IDV_DIGILOCKER_ACR_BODIES.after.badge);
  assert.notEqual(IDV_DIGILOCKER_ACR_BODIES.before.complete, IDV_DIGILOCKER_ACR_BODIES.after.complete);

  // Gate: ON before and after (never OFF, never written); the OFF assertions of earlier releases are absent from this candidate.
  assert.deepEqual(Object.keys(IDV_DIGILOCKER_ACR_PREFLIGHT), Object.keys(IDV_DIGILOCKER_ACR_POSTFLIGHT));
  for (const checks of [IDV_DIGILOCKER_ACR_PREFLIGHT, IDV_DIGILOCKER_ACR_POSTFLIGHT]) {
    assert.ok('gate_setting_on' in checks && 'gate_function_on' in checks && !('gate_setting_off' in checks) && !('gate_function_off' in checks));
    assert.ok(checks.gate_setting_on.includes("setting_value = 'true'") && checks.gate_function_on.includes('IS TRUE'));
  }
  const text = readFileSync(join(process.cwd(), candidate.path), 'utf8');
  assert.doesNotMatch(text.split('\n').filter(line => !line.startsWith('--')).join('\n'), /app_system_settings|identity_verification_required/i);   // never touches the switch

  const yaml = readFileSync('.github/workflows/reusable-supabase-release.yml', 'utf8');
  assert.match(yaml, /- idv-digilocker-required-gate\n(?: {10}#[^\n]*\n)? {10}- idv-digilocker-aadhaar-acr\n/);
  assert.ok(yaml.includes("inputs.candidate != 'idv-digilocker-required-gate' && inputs.candidate != 'idv-digilocker-aadhaar-acr' &&"));
  assert.ok(yaml.includes("if: ${{ inputs.candidate == 'idv-digilocker-aadhaar-acr' }}"));
  assert.ok(yaml.includes('verifyIdvDigilockerAcrTestReceipt'));
  assert.equal((yaml.match(/idv-digilocker-aadhaar-acr/g) ?? []).length, 4);   // option, receipt step condition, receipt path, production exclusion
  assert.doesNotMatch(yaml, /identity_verification_required/i);
});

test('IDV Aadhaar ACR: a candidate whose bytes differ from the pinned SHA-256 is rejected before anything runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-acr-root-'));
  try {
    const c = getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE);
    mkdirSync(join(root, c.path, '..'), {recursive: true});
    writeFileSync(join(root, c.path), readFileSync(join(process.cwd(), c.path), 'utf8') + '\n-- extra');
    assert.throws(() => verifyCandidateSha(c.id, root), /REUSABLE_RELEASE_CANDIDATE_HASH_MISMATCH/);
  } finally { rmSync(root, {recursive: true, force: true}); }
  const registry = readFileSync('scripts/release/reusable-candidates.mjs', 'utf8');
  assert.equal(getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE).sha256.length, 64);   // pinned: an unpinned entry cannot exist
  assert.ok(registry.includes('4e2b5ed60d4e799a69114e5ba445e27e7bb37ab9eace268608f414718649d79d'));
});

test('IDV Aadhaar ACR: the production job is skipped for every input combination, so the candidate can never auto-promote', () => {
  const yaml = readFileSync('.github/workflows/reusable-supabase-release.yml', 'utf8');
  const id = IDV_DIGILOCKER_ACR_CANDIDATE;
  const digests = {idv_digilocker_ledger_sha: 'b'.repeat(64), mobile_catalogue_ledger_sha: 'b'.repeat(64), listing_validity_ledger_sha: 'b'.repeat(64),
    taxonomy_ledger_sha: 'b'.repeat(64)};
  for (const target of ['test', 'production', 'adopt']) {
    for (const autoPromote of [false, true]) {   // true is impossible for this candidate, but the job must still not run
      for (const [testResult, verifyTest] of [['success', 'success'], ['skipped', 'skipped'], ['failure', 'skipped']]) {
        for (const outputs of [{}, digests]) {
          assert.equal(productionJobRuns(yaml, {candidate: id, target, autoPromote, test: testResult, verifyTest, outputs}), false,
            JSON.stringify({target, autoPromote, testResult, verifyTest, outputs}));
        }
      }
    }
  }
  assert.equal(planDispatch({candidateId: id, target: 'test'}).candidate.autoPromote, false);
});

test('IDV Aadhaar ACR: in-order FairSwapTest apply with exact prerequisite receipts, gate ON before/after, and a sanitized receipt', async () => {
  const c = getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE);
  const run = acrRun();
  let receipt;
  try {
    receipt = await run.result;
    assert.equal(receipt.status, 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED');
    assert.deepEqual([receipt.environment, receipt.projectRef, receipt.migrationVersion, receipt.migrationFile, receipt.migrationSha256],
      ['FairSwapTest', 'wpppxlnbzqynvhpeuavd', c.version, c.filename, c.sha256]);
    assert.deepEqual(receipt.dryRunPending, [c.filename]);
    assert.equal(receipt.outOfOrderInstall, undefined);
    assert.equal(receipt.ledgerStatementsSha256, IDV_DIGILOCKER_ACR_LEDGER.statementsSha256);
    assert.equal(receipt.postflightScope, IDV_DIGILOCKER_ACR_SCOPE);
    assert.equal(receipt.identityVerificationRequired, true);   // the live Test gate; never written by this release
    assert.equal(receipt.edgeFunctionsDeployedByThisWorkflow, false);
    assert.equal(receipt.testOnly, true);
    assert.equal(receipt.autoPromote, false);
    assert.equal(receipt.testLedgerStatementsSha256, undefined);
    assert.deepEqual(receipt.requiredLedger, [{version: '20261117090000', name: 'idv_digilocker_direct_v1'},
      {version: '20261119200000', name: 'idv_digilocker_oidc_v2_badge'}, {version: REQ_PIN.version, name: REQ_PIN.name}]);
    assert.deepEqual(receipt.bodyTransition, {
      hasDigilockerBadge: {from: IDV_DIGILOCKER_ACR_BODIES.before.badge, to: IDV_DIGILOCKER_ACR_BODIES.after.badge},
      completeV2: {from: IDV_DIGILOCKER_ACR_BODIES.before.complete, to: IDV_DIGILOCKER_ACR_BODIES.after.complete}});
    assert.deepEqual(readdirSync(run.dir).sort(), ['SHA256SUMS_fairswaptest', 'idv-digilocker-aadhaar-acr-fairswaptest.json']);
    const bytes = readFileSync(join(run.dir, 'idv-digilocker-aadhaar-acr-fairswaptest.json'), 'utf8');
    assert.equal(readFileSync(join(run.dir, 'SHA256SUMS_fairswaptest'), 'utf8'),
      `${createHash('sha256').update(bytes).digest('hex')}  idv-digilocker-aadhaar-acr-fairswaptest.json\n`);
    for (const secret of ['sbp_mock_token', 'mock_password', 'pooler.supabase.com', 'BEGIN CERTIFICATE', 'f'.repeat(64)]) assert.ok(!bytes.includes(secret), secret);
    const link = run.full.find(cmd => cmd[0] === 'supabase' && cmd.includes('link'));
    assert.equal(link[link.indexOf('--project-ref') + 1], 'wpppxlnbzqynvhpeuavd');
    assert.ok(!run.full.flat().some(arg => String(arg).includes(REFS.FairSwapProd)));
    const [dry, apply] = pushes(run.full);
    assert.ok(dry.includes('--dry-run') && !dry.includes('--include-all') && apply.includes('--yes') && !apply.includes('--include-all'));
    const at = label => run.full.findIndex(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith(`-- idv-digilocker-${label}\nBEGIN READ ONLY;`));
    assert.ok(at('acr-preflight') >= 0 && at('acr-preflight') < run.full.indexOf(dry) && at('acr-postflight') > run.full.indexOf(apply));
    const sql = run.full.filter(cmd => cmd[0] === 'psql').map(cmd => cmd.at(-1));
    const preSql = sql.find(q => q.startsWith('-- idv-digilocker-acr-preflight'));
    const postSql = sql.find(q => q.startsWith('-- idv-digilocker-acr-postflight'));
    assert.ok(preSql.includes(IDV_DIGILOCKER_ACR_BODIES.before.badge) && preSql.includes(IDV_DIGILOCKER_ACR_BODIES.before.complete));
    assert.ok(postSql.includes(IDV_DIGILOCKER_ACR_BODIES.after.badge) && postSql.includes(IDV_DIGILOCKER_ACR_BODIES.after.complete));
    assert.ok(!preSql.includes(IDV_DIGILOCKER_ACR_BODIES.after.badge) && !postSql.includes(IDV_DIGILOCKER_ACR_BODIES.before.badge));
    for (const q of [preSql, postSql]) assert.ok(q.includes("setting_value = 'true'") && !q.includes("setting_value = 'false'") && q.includes('IS TRUE'));
    // Read-only SQL only: nothing in this release can write (let alone lower) the gate setting.
    assert.ok(!sql.some(q => /UPDATE |INSERT |DELETE |app_system_settings'\s*,/i.test(q.replace(/FROM public\.app_system_settings/g, ''))));
  } finally { rmSync(run.dir, {recursive: true, force: true}); }

  const ctx = {...idvContext, CANDIDATE: c.id};
  assert.equal(verifyIdvDigilockerAcrTestReceipt(receipt, ctx), IDV_DIGILOCKER_ACR_LEDGER.statementsSha256);
  for (const invalid of [{environment: 'FairSwapProd'}, {projectRef: REFS.FairSwapProd}, {releaseWorkflowRun: '132'}, {releaseWorkflowAttempt: '2'},
    {reviewedCommit: 'f'.repeat(40)}, {migrationSha256: 'd'.repeat(64)}, {postflightVerified: false}, {postflightScope: IDV_DIGILOCKER_REQUIRED_SCOPE},
    {identityVerificationRequired: false}, {edgeFunctionsDeployedByThisWorkflow: true}, {testOnly: false}, {autoPromote: true},
    {ledgerStatementsSha256: 'b'.repeat(64)}, {testLedgerStatementsSha256: IDV_DIGILOCKER_ACR_LEDGER.statementsSha256}, {status: 'ALREADY_APPLIED_VERIFIED'},
    {dryRunPending: []}, {outOfOrderInstall: {includeAll: true, aheadVersions: []}}, {requiredLedger: []},
    {bodyTransition: {hasDigilockerBadge: {from: 'x', to: 'y'}, completeV2: {from: 'x', to: 'y'}}},
    {prerequisiteLedger: IDV_FOUNDATION_LEDGER.FairSwapProd}]) {
    assert.throws(() => verifyIdvDigilockerAcrTestReceipt({...receipt, ...invalid}, ctx), /IDV_DIGILOCKER_ACR_TEST_RECEIPT_INVALID/, JSON.stringify(invalid));
  }
  assert.throws(() => verifyIdvDigilockerAcrTestReceipt(receipt, {...ctx, CANDIDATE: IDV_DIGILOCKER_REQUIRED_CANDIDATE}), /ACR_TEST_RECEIPT_INVALID/);
  // It is never accepted as V1/V2/required-gate evidence.
  assert.throws(() => verifyIdvDigilockerTestReceipt(receipt, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
  assert.throws(() => verifyIdvDigilockerRequiredTestReceipt(receipt, idvContext), /REQUIRED_TEST_RECEIPT_INVALID/);
});

test('IDV Aadhaar ACR: Production, a wrong target or wrong project is refused before any tool, credential or SQL runs', async () => {
  const c = getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE);
  for (const env of [{}, {TARGET: 'production'}, {TARGET: 'adopt'}, {TARGET: 'test', IDV_DIGILOCKER_TEST_LEDGER_SHA: IDV_DIGILOCKER_ACR_LEDGER.statementsSha256}]) {
    const run = acrRun('FairSwapProd', {env});
    try {
      await assert.rejects(run.result, /REUSABLE_RELEASE_TEST_ONLY_CANDIDATE/);
      assert.deepEqual(run.full, []);
      assert.deepEqual(readdirSync(run.dir), []);
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  }
  for (const TARGET of ['production', 'adopt', '']) {   // FairSwapTest, but not a target=test dispatch
    const run = acrRun('FairSwapTest', {env: {TARGET}});
    try { await assert.rejects(run.result, /IDV_DIGILOCKER_ACR_TEST_ONLY/); assert.deepEqual(run.full, []); }
    finally { rmSync(run.dir, {recursive: true, force: true}); }
  }
  // The registry binds the project ref: a tampered binding (other ref, not test-only, auto-promote) is refused before any tool runs.
  for (const tampered of [{allowedProjectRef: REFS.FairSwapProd}, {testOnly: false}, {autoPromote: true}]) {
    const entry = CANDIDATES[c.id];
    const saved = {...entry};
    try {
      Object.defineProperty(CANDIDATES, c.id, {value: {...entry, ...tampered}, configurable: true, writable: true, enumerable: true});
      const run = acrRun('FairSwapTest');
      try { await assert.rejects(run.result, /PROJECT_REF_NOT_ALLOWED|TEST_ONLY/); assert.deepEqual(run.full, []); }
      finally { rmSync(run.dir, {recursive: true, force: true}); }
    } catch (error) {
      if (error instanceof TypeError) continue;   // frozen registry: the entry itself cannot be tampered with at runtime
      throw error;
    } finally {
      try { Object.defineProperty(CANDIDATES, c.id, {value: saved, configurable: true, writable: true, enumerable: true}); } catch { /* frozen */ }
    }
  }
  await assert.rejects(verifyRemotePostflight('FairSwapProd', c.id, 'url', {}, () => assert.fail('no SQL may run')), /ACR_TEST_ONLY/);
  await assert.rejects(adoptExistingInstallation({environment: 'FairSwapProd', candidateId: c.id, context: idvContext,
    runner: () => assert.fail('no tool may run')}), /ADOPTION_NOT_REGISTERED/);
  await assert.rejects(releaseV3ProductionBatch({environment: 'FairSwapProd', candidateId: c.id, context: idvContext,
    runner: () => assert.fail('no tool may run')}), /V3_PRODUCTION_BATCH_CONTEXT_REQUIRED/);
  assert.throws(() => assertIdvDigilockerAcrLedger('FairSwapProd', idvLedger('FairSwapProd')), /ACR_TEST_ONLY/);
  assert.throws(() => idvAcrLedgerState('FairSwapProd', idvLedger('FairSwapProd', {extra: [acrRow()]})), /ACR_PRODUCTION_FORBIDDEN/);
  assert.equal(idvAcrLedgerState('FairSwapProd', idvLedger('FairSwapProd')), 'absent');
  // The Production V1 guard still rejects the row as an unreviewed tail; Production assertions are not loosened.
  assert.throws(() => assertIdvDigilockerLedger('FairSwapProd', idvLedger('FairSwapProd', {extra: [acrRow()]})), /LEDGER_TAIL_MISMATCH/);
});

test('IDV Aadhaar ACR fails closed before any apply on prerequisite, gate or schema drift, double apply, and withholds receipts after apply', async () => {
  const attempt = async (options, re, {dryRuns = 0, applies = 0} = {}) => {
    const run = acrRun('FairSwapTest', options);
    try {
      await assert.rejects(run.result, re);
      assert.equal(idvApplies(run.full).length, applies);
      assert.equal(pushes(run.full).length, dryRuns);
      assert.ok(!existsSync(join(run.dir, 'idv-digilocker-aadhaar-acr-fairswaptest.json')));
    } finally { rmSync(run.dir, {recursive: true, force: true}); }
  };
  const c = getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE);
  // Missing or tampered historical receipts: V1, V2 and the required gate must each be exactly as pinned.
  await attempt({ledger: acrLedger({v1: null})}, /PREREQUISITE_MIGRATION_MISSING/);
  await attempt({ledger: acrLedger({v2: null})}, /PREREQUISITE_MIGRATION_MISSING/);
  await attempt({ledger: acrLedger({gate: null})}, /PREREQUISITE_MIGRATION_MISSING/);
  await attempt({ledger: acrLedger({v2: reqV2Row({statementsSha256: 'a'.repeat(64)})})}, /ACR_PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: acrLedger({v2: reqV2Row({statementCount: 22})})}, /ACR_PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: acrLedger({v1: idvV1Row({name: 'renamed'})})}, /PREREQUISITE_LEDGER_MISMATCH/);
  await attempt({ledger: acrLedger({v1: idvV1Row({hasStatements: false, statementCount: 0})})}, /PREREQUISITE_LEDGER_MISMATCH/);
  for (const over of [{statementsSha256: 'a'.repeat(64)}, {statementCount: 9}, {hasStatements: false}, {name: 'renamed'}]) {
    await attempt({ledger: acrLedger({gate: reqRow(over)})}, /PREREQUISITE_LEDGER_MISMATCH|PREREQUISITE_MIGRATION_MISSING/);
  }
  await attempt({ledger: acrLedger({foundation: null})}, /FOUNDATION_PREREQUISITE_MISMATCH/);
  await attempt({ledger: acrLedger({foundation: IDV_FOUNDATION_LEDGER.FairSwapProd})}, /FOUNDATION_PREREQUISITE_MISMATCH/);
  // Double apply / partial recording: the exact row, a renamed or re-versioned row, and a newer unreviewed row all stop the run.
  await attempt({ledger: acrLedger({extra: [acrRow()]})}, /IDV_DIGILOCKER_ACR_ALREADY_RECORDED/);
  await attempt({ledger: acrLedger({extra: [acrRow({statementsSha256: 'a'.repeat(64)})]})}, /ACR_ALREADY_RECORDED|ACR_LEDGER_MISMATCH/);
  await attempt({ledger: acrLedger({extra: [acrRow({version: '20261123120001'})]})}, /ACR_LEDGER_MISMATCH|ALREADY_RECORDED/);
  await attempt({ledger: acrLedger({extra: [{version: '20261124000000', name: 'newer', hasStatements: true, statementCount: 1,
    statementsSha256: 'a'.repeat(64)}]})}, /IDV_DIGILOCKER_ACR_LEDGER_MISMATCH/);
  // Preflight: the gate must already be ON (OFF, missing or duplicated switch is refused), and the current schema must be exact.
  for (const key of ['gate_setting_on', 'gate_function_on', 'acr_bodies_exact', 'acr_evidence_constraint', 'enforce_state_exact', 'enforce_server_only',
    'v1_structure', 'provenance_columns', 'service_only_execute', 'unexpected_key']) {
    await attempt({pre: {[key]: false}}, /IDV_DIGILOCKER_ACR_PREFLIGHT_FAILED/);
  }
  await attempt({dryOutput: `Would push these migrations:\n • ${c.filename}\n • 20261124000000_unreviewed.sql`}, /DRY_RUN_MISMATCH/, {dryRuns: 1});
  await attempt({dryOutput: 'Remote database is up to date.'}, /DRY_RUN_MISMATCH/, {dryRuns: 1});
  // After apply: the ledger row and every postflight key are binding; no receipt is written.
  for (const recorded of [{statementsSha256: 'a'.repeat(64)}, {hasStatements: false, statementCount: 0}, {name: 'other'}]) {
    await attempt({recorded}, /IDV_DIGILOCKER_ACR_LEDGER_MISMATCH|TABLETS_LEDGER_CHANGED/, {dryRuns: 2, applies: 1});
  }
  for (const key of ['gate_setting_on', 'gate_function_on', 'acr_bodies_exact', 'acr_evidence_constraint', 'enforce_state_exact', 'enforce_single_overload',
    'enforce_server_only', 'v1_grants_unchanged', 'service_only_execute', 'projection_execute']) {
    await attempt({post: {[key]: false}}, /IDV_DIGILOCKER_ACR_POSTFLIGHT_FAILED/, {dryRuns: 2, applies: 1});
  }
  await attempt({preserved: 'a'.repeat(64)}, /IDV_DIGILOCKER_EXISTING_OBJECTS_CHANGED/, {dryRuns: 2, applies: 1});
  for (const [checks, label] of [[IDV_DIGILOCKER_ACR_PREFLIGHT, 'acr-preflight'], [IDV_DIGILOCKER_ACR_POSTFLIGHT, 'acr-postflight']]) {
    const text = idvDigilockerAcrSnapshotSql(checks, label);
    assert.ok(text.startsWith(`-- idv-digilocker-${label}\nBEGIN READ ONLY;\n`) && text.endsWith('COMMIT;'), label);
    assert.equal(text.split(';').length - 1, 4, label);
  }
});

test('IDV Aadhaar ACR: the installed-state attestation accepts the new state only with the exact ledger row; historical and Production stay strict', async () => {
  assert.equal(idvAcrLedgerState('FairSwapTest', acrLedger()), 'absent');
  assert.equal(idvAcrLedgerState('FairSwapTest', acrLedger({extra: [acrRow()]})), 'applied');
  for (const over of [{statementsSha256: 'a'.repeat(64)}, {statementCount: 14}, {hasStatements: false}, {name: 'renamed'}, {version: '20261123120001'}]) {
    assert.throws(() => idvAcrLedgerState('FairSwapTest', acrLedger({extra: [acrRow(over)]})), /ACR_LEDGER_MISMATCH/, JSON.stringify(over));
  }
  // The row without the required-gate row is not a valid state.
  assert.throws(() => idvAcrLedgerState('FairSwapTest', acrLedger({gate: null, extra: [acrRow()]})), /ACR_LEDGER_MISMATCH/);
  assert.throws(() => idvAcrLedgerState('FairSwapStaging', acrLedger()), /ACR_STATE_ENVIRONMENT_INVALID/);

  // V1 FairSwapTest attestation, ACR state: ledger-bound variant, gate ON, pinned bodies and constraint.
  const applied = idvRun('FairSwapTest', {ledger: acrLedger({extra: [acrRow()]}), installed: {}});
  let receipt;
  try {
    receipt = await applied.result;
    assert.equal(receipt.status, 'ALREADY_INSTALLED_VERIFIED');
    assert.equal(receipt.identityVerificationRequired, true);
    assert.deepEqual(receipt.installedStateVariant, idvDigilockerEvolvedVariant('applied'));
    assert.deepEqual(receipt.installedStateVariant.aadhaarAcr, {ledger: {...IDV_DIGILOCKER_ACR_LEDGER},
      hasDigilockerBadgeBodyMd5: IDV_DIGILOCKER_ACR_BODIES.after.badge, completeV2BodyMd5: IDV_DIGILOCKER_ACR_BODIES.after.complete});
    assert.deepEqual(pushes(applied.full), []);
    const q = applied.full.find(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith('-- idv-digilocker-installed')).at(-1);
    assert.ok(q.includes("'gate_setting_on'") && q.includes("'acr_bodies_exact'") && q.includes(IDV_DIGILOCKER_ACR_BODIES.after.badge));
    assert.ok(!q.includes("'gate_setting_off'") && !q.includes(IDV_DIGILOCKER_ACR_BODIES.before.badge));
  } finally { rmSync(applied.dir, {recursive: true, force: true}); }
  assert.equal(verifyIdvDigilockerTestReceipt(receipt, idvContext), 'b'.repeat(64));
  for (const invalid of [{identityVerificationRequired: false}, {installedStateVariant: idvDigilockerEvolvedVariant()},
    {installedStateVariant: {...idvDigilockerEvolvedVariant('applied'), aadhaarAcr: {...idvDigilockerEvolvedVariant('applied').aadhaarAcr, completeV2BodyMd5: 'x'}}},
    {installedStateVariant: {...idvDigilockerEvolvedVariant('applied'), aadhaarAcr: {...idvDigilockerEvolvedVariant('applied').aadhaarAcr, ledger: {...IDV_DIGILOCKER_ACR_LEDGER, statementsSha256: 'a'.repeat(64)}}}}]) {
    assert.throws(() => verifyIdvDigilockerTestReceipt({...receipt, ...invalid}, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/, JSON.stringify(invalid));
  }
  // The ACR claim never rescues a non-attestation receipt, and a gate-true claim without the ACR variant is refused.
  assert.throws(() => verifyIdvDigilockerTestReceipt({...receipt, status: 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED'}, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
  assert.throws(() => verifyIdvDigilockerTestReceipt({...receipt, installedStateVariant: undefined}, idvContext), /IDV_DIGILOCKER_TEST_RECEIPT_INVALID/);
  // Body or gate drift in the ACR state is refused by the SQL; a partially matching row never reaches it.
  for (const key of ['acr_bodies_exact', 'acr_evidence_constraint', 'gate_setting_on', 'gate_function_on']) {
    const drift = idvRun('FairSwapTest', {ledger: acrLedger({extra: [acrRow()]}), installed: {[key]: false}});
    try { await assert.rejects(drift.result, /IDV_DIGILOCKER_INSTALLED_FAILED/, key); } finally { rmSync(drift.dir, {recursive: true, force: true}); }
  }
  const partial = idvRun('FairSwapTest', {ledger: acrLedger({extra: [acrRow({statementsSha256: 'a'.repeat(64)})]})});
  try {
    await assert.rejects(partial.result, /ACR_LEDGER_MISMATCH/);
    assert.ok(!partial.full.some(cmd => cmd[0] === 'psql' && cmd.at(-1).startsWith('-- idv-digilocker-installed')));
  } finally { rmSync(partial.dir, {recursive: true, force: true}); }
  // Historical / required-gate-only states keep their gate-OFF assertions unchanged.
  assert.ok('gate_setting_off' in idvDigilockerInstalledChecks('requiredGate') && !('gate_setting_on' in idvDigilockerInstalledChecks('requiredGate')));
  assert.ok('gate_setting_off' in idvDigilockerInstalledChecks('historical', 'absent'));
});

test('disposable PostgreSQL (PGlite, not native PG17): ACR preflight/postflight on the reviewed SQL chain with the live gate ON throughout',
  {skip: PGlite ? false : 'no PGlite module', timeout: 240000}, async () => {
    const src = path => readFileSync(join(process.cwd(), path), 'utf8');
    const db = new PGlite();
    for (const path of ['tests/idv-pg17/fixture.sql', 'tests/idv-pg17/fixture-digilocker.sql',
      'supabase/forward-migrations/idv/20261026183000_idv_digilocker_foundation.sql', getCandidate(IDV_DIGILOCKER_CANDIDATE).path,
      getCandidate(IDV_DIGILOCKER_V2_CANDIDATE).path, getCandidate(IDV_DIGILOCKER_REQUIRED_CANDIDATE).path]) await db.exec(src(path));
    // FairSwapTest runs with the identity gate ON (owner decision); the disposable database mirrors that before the ACR preflight.
    const setGate = value => db.exec(`update public.app_system_settings set setting_value = '${value}' where setting_key = 'identity_verification_required'`);
    const gateValue = async () => (await db.query("select setting_value from public.app_system_settings where setting_key = 'identity_verification_required'")).rows[0].setting_value;
    await setGate('true');
    const snapshot = async (checks, label, acr = true) => {
      const results = await db.exec(acr ? idvDigilockerAcrSnapshotSql(checks, label) : idvSnapshotSql(checks, label));
      return JSON.parse(Object.values(results.find(r => r.rows?.length).rows[0])[0]);
    };
    const allTrue = value => Object.values(value.checks).every(v => v === true);
    const pre = await snapshot(IDV_DIGILOCKER_ACR_PREFLIGHT, 'acr-preflight');
    assert.ok(allTrue(pre), JSON.stringify(pre.checks));
    assert.equal((await snapshot(IDV_DIGILOCKER_ACR_POSTFLIGHT, 'acr-postflight')).checks.acr_bodies_exact, false);
    assert.equal((await snapshot(IDV_DIGILOCKER_ACR_POSTFLIGHT, 'acr-postflight')).checks.acr_evidence_constraint, false);
    // Gate OFF at preflight is refused: the candidate demands the live ON state.
    await setGate('false');
    const off = await snapshot(IDV_DIGILOCKER_ACR_PREFLIGHT, 'acr-preflight');
    assert.deepEqual([off.checks.gate_setting_on, off.checks.gate_function_on], [false, false]);
    await setGate('true');

    await db.exec(src(getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE).path));
    assert.equal(await gateValue(), 'true');   // the migration never touches the switch
    const post = await snapshot(IDV_DIGILOCKER_ACR_POSTFLIGHT, 'acr-postflight');
    assert.ok(allTrue(post), JSON.stringify(post.checks));
    assert.equal(post.preserved, pre.preserved);
    assert.equal((await snapshot(IDV_DIGILOCKER_ACR_PREFLIGHT, 'acr-preflight')).checks.acr_bodies_exact, false);   // no re-run
    assert.ok(allTrue(await snapshot(idvDigilockerInstalledChecks('requiredGate', 'applied'), 'installed', false)));
    assert.equal((await snapshot(idvDigilockerInstalledChecks('requiredGate', 'absent'), 'installed', false)).checks.gate_setting_off, false);

    const broken = async (sql, key, undo) => {
      await db.exec(sql);
      const value = await snapshot(IDV_DIGILOCKER_ACR_POSTFLIGHT, 'acr-postflight');
      await db.exec(undo);
      return key ? value.checks[key] : value.preserved;
    };
    assert.equal(await broken("update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required'",
      'gate_setting_on', "update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required'"), false);
    assert.equal(await broken('grant execute on function app_security.has_digilocker_badge(uuid) to authenticated', 'service_only_execute',
      'revoke execute on function app_security.has_digilocker_badge(uuid) from authenticated'), false);
    assert.equal(await broken('grant execute on function public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text) to anon', 'service_only_execute',
      'revoke execute on function public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text) from anon'), false);
    assert.equal(await broken("alter function app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text) set search_path = public", 'acr_bodies_exact',
      "alter function app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text) set search_path = ''"), false);
    assert.equal(await broken('alter function app_security.has_digilocker_badge(uuid) security invoker', 'acr_bodies_exact',
      'alter function app_security.has_digilocker_badge(uuid) security definer'), false);
    assert.equal(await broken("create function app_security.has_digilocker_badge(text) returns boolean language sql as 'select true'", 'acr_bodies_exact',
      'drop function app_security.has_digilocker_badge(text)'), false);   // extra overload
    assert.equal(await broken('alter table app_security.idv_digilocker_bindings drop constraint chk_idv_dl_evidence_method', 'acr_evidence_constraint',
      "alter table app_security.idv_digilocker_bindings add constraint chk_idv_dl_evidence_method check (evidence_method in ('legacy_account_link','oidc_v2_signed_id_token','oidc_v2_signed_aadhaar_acr') and ((evidence_method <> 'legacy_account_link') = (evidence_verified_at is not null)))"), false);
    assert.notEqual(await broken("create function public.idv_acr_probe() returns integer language sql as 'select 1'", null,
      'drop function public.idv_acr_probe()'), pre.preserved);
    assert.equal((await snapshot(IDV_DIGILOCKER_ACR_POSTFLIGHT, 'acr-postflight')).preserved, pre.preserved);
    assert.equal(await gateValue(), 'true');
  });

// Additive hook: keep independent V3 operator tests in the existing release/security CI suite.
import './v3-leaf-release.test.mjs';

import "./v3-hosted-e2e.test.mjs";

// ---- V3 goods batch: execute the workflow's real inline steps with real input-to-env propagation ----
import {spawnSync as wfSpawn} from 'node:child_process';
import {mkdtempSync as wfTmp, readFileSync as wfRead, rmSync as wfRm} from 'node:fs';
import {tmpdir as wfTmpdir} from 'node:os';
import {join as wfJoin} from 'node:path';

function wfStep(job, name) {
  const yaml = wfRead('.github/workflows/reusable-supabase-release.yml', 'utf8');
  const start = yaml.search(new RegExp(`^  ${job}:`, 'm'));
  assert(start >= 0, `job ${job}`);
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n  [a-z_]+:\n/);
  const body = end < 0 ? rest : rest.slice(0, end);
  const at = body.indexOf(`- name: ${name}`);
  assert(at >= 0, `step ${name} in ${job}`);
  const after = body.slice(at + 1);
  const next = after.search(/\n      - name:/);
  const step = next < 0 ? after : after.slice(0, next);
  const script = /<<'NODE'\n([\s\S]*?)\n\s+NODE\s*$/.exec(step)[1].replace(/^ {10}/gm, '');
  const env = {};
  for (const m of step.slice(0, step.indexOf('run: |')).matchAll(/^ {10}([A-Z0-9_]+): (.*)$/gm)) env[m[1]] = m[2];
  return {script, env};
}

function wfRun({job, name, inputs}) {
  const {script, env} = wfStep(job, name);
  const dir = wfTmp(wfJoin(wfTmpdir(), 'wf-'));
  const out = wfJoin(dir, 'out');
  try {
    const resolved = {};
    for (const [k, v] of Object.entries(env)) {
      const m = /^\$\{\{ inputs\.([a-z0-9_]+) \}\}$/.exec(v);
      if (m) resolved[k] = inputs[m[1]] ?? '';       // propagation exactly as the workflow declares it
      else if (/secrets\.|github\.token|needs\./.test(v)) resolved[k] = '';
    }
    const r = wfSpawn(process.execPath, ['--input-type=module', '-'], {input: script, encoding: 'utf8', cwd: process.cwd(),
      env: {PATH: process.env.PATH, GITHUB_OUTPUT: out, ...resolved}});
    return {...r, output: (() => { try { return wfRead(out, 'utf8'); } catch { return ''; } })()};
  } finally { wfRm(dir, {recursive: true, force: true}); }
}

const WF_SHA = 'a'.repeat(40);
const wfBatch = op => JSON.stringify([{candidateId: `v3-air-conditioners-${op}`}, {candidateId: `v3-laptops-${op}`}]);

test('workflow input propagation: every step that plans a V3 batch declares v3_batch → V3_BATCH_JSON', () => {
  for (const [job, name] of [['verify', 'Plan stage'], ['test', 'Verify deployed Web release'], ['production', 'Verify deployed Web release']]) {
    const {script, env} = wfStep(job, name);
    assert.equal(env.V3_BATCH_JSON, '${{ inputs.v3_batch }}', `${job}/${name}`);
    assert(script.includes('v3_batch: e.V3_BATCH_JSON'), `${job}/${name}`);
  }
  assert(wfStep('verify', 'Plan stage').script.includes('plan.candidate.v3Operation || plan.candidate.v3Batch'));
});

for (const target of ['test', 'production']) for (const op of ['activate', 'deactivate']) {
  const id = `v3-goods-batch-${op}`;
  const inputs = {candidate: id, target, v3_batch: wfBatch(op), web_staging_sha: WF_SHA, web_production_sha: WF_SHA,
    test_e2e_run_id: '123', test_activation_run_id: '100'};

  test(`verify job plans ${id} on ${target} through the workflow script`, () => {
    const real = wfRun({job: 'verify', name: 'Plan stage', inputs});
    assert.doesNotMatch(real.stderr, /V3_BATCH_JSON_REQUIRED|STAGE_EVIDENCE|EVIDENCE_RUN_REQUIRED/);
    if (target === 'production' && op === 'activate') {
      // Reaches the batch evidence branch (hosted E2E + token required) instead of the single-leaf/stage path.
      assert.match(real.stderr, /V3_LEAF_HOSTED_TEST_E2E_EVIDENCE_UNAVAILABLE/);
    } else {
      assert.equal(real.status, 0, real.stderr);
      assert.match(real.output, /auto_promote=false/);
    }
  });

  test(`${target} job web verification receives the batch for ${id}`, () => {
    const real = wfRun({job: target, name: 'Verify deployed Web release', inputs});
    assert.doesNotMatch(real.stderr, /V3_BATCH_JSON_REQUIRED/);
    if (op === 'activate') assert.match(real.stderr, /V3_LEAF_WEB_EVIDENCE_REQUIRED/);
    else assert.equal(real.status, 0, real.stderr);
  });
}

test('workflow rejects an over-sized V3 batch and bounds the batch job timeout', () => {
  const ids = V3_GOODS_FOR_WORKFLOW_TEST();
  const r = wfRun({job: 'verify', name: 'Plan stage', inputs: {candidate: 'v3-goods-batch-activate', target: 'test', web_staging_sha: WF_SHA,
    v3_batch: JSON.stringify(ids.map(candidateId => ({candidateId})))}});
  assert.match(r.stderr, /V3_BATCH_SIZE_INVALID/);
  const yaml = wfRead('.github/workflows/reusable-supabase-release.yml', 'utf8');
  assert.equal(yaml.match(/startsWith\(inputs\.candidate, 'v3-goods-batch-'\) && 30 \|\| 20/g)?.length, 2);
});

function V3_GOODS_FOR_WORKFLOW_TEST() {
  return JSON.parse(wfRead('scripts/release/v3-goods-allowlist.json', 'utf8')).slice(0, 6).map(g => `v3-${g.slug.slice(3)}-activate`);
}

test('V3 correction delivery pins version/source, requires history and rejects failed function postflight',async()=>{
  const {V3_ACTIVATION_CORRECTION: pin}=await import('../../scripts/release/reusable-candidates.mjs');
  const {verifyCorrectionTestReceipt}=await import('../../scripts/release/reusable-supabase-release.mjs');
  const c=verifyCandidateSha('v3-provider-neutral-activation').candidate;
  assert.equal(c.version,'20261122213157'); assert.equal(c.sha256,pin.sha256);
  assert.ok(c.autoPromote); assert.ok(!V3_PRODUCTION_SEQUENCE.includes(c.id));
  const history=['Local | Remote | Time (UTC)',...c.requiredLedgerVersions.map(v=>`${v} | ${v} |`)];
  assert.equal(assertLedgerOrdering(c,history.join('\n')).state,'absent');
  for(let i=1;i<history.length;i++) assert.throws(()=>assertLedgerOrdering(c,history.filter((_,j)=>i!==j).join('\n')),/PREREQUISITE/);
  assert.throws(()=>verifyLedgerVersion('Local | Remote | Time (UTC)\n20261122213158 | 20261122213158 |',c.version),/LEDGER/);
  await assert.rejects(verifyRemotePostflight('FairSwapTest',c.id,'mock',{},()=> 'false'),/CORRECTION_POSTFLIGHT_FAILED/);
  assert.deepEqual(await verifyRemotePostflight('FairSwapTest',c.id,'mock',{},(_,args)=>{
    for(const [,digest] of pin.functions) assert.ok(args.at(-1).includes(digest));
    assert.ok(args.at(-1).startsWith('BEGIN READ ONLY'));return 'true';
  }),{status:'PASS'});
  const context={GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'119',GITHUB_RUN_ATTEMPT:'1'};
  const receipt={environment:'FairSwapTest',projectRef:REFS.FairSwapTest,candidateId:c.id,migrationVersion:c.version,
    migrationFile:c.filename,migrationSha256:c.sha256,reviewedCommit:context.GITHUB_SHA,releaseWorkflowRun:'119',
    releaseWorkflowAttempt:'1',status:'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED',postflightVerified:true,
    postflightScope:'v3-correction-integrity',dryRunPending:[c.filename],ledgerStatementsSha256:'b'.repeat(64)};
  assert.equal(verifyCorrectionTestReceipt(receipt,context),'b'.repeat(64));
  for(const change of [{migrationVersion:'20261122213158'},{postflightVerified:false},{migrationSha256:'f'.repeat(64)},{releaseWorkflowAttempt:'2'}])
    assert.throws(()=>verifyCorrectionTestReceipt({...receipt,...change},context),/TEST_RECEIPT_INVALID/);
  const yaml=readFileSync('.github/workflows/reusable-supabase-release.yml','utf8');
  assert.equal(productionJobRuns(yaml,{candidate:c.id,target:'test',autoPromote:true,outputs:{correction_ledger_sha:'b'.repeat(64)}}),true);
  assert.equal(productionJobRuns(yaml,{candidate:c.id,target:'test',autoPromote:true}),false);
  assert.equal(productionJobRuns(yaml,{candidate:c.id,target:'test',autoPromote:true,verifyTest:'failure'}),false);
  await assert.rejects(releaseReusable({candidateId:c.id,environment:'FairSwapProd',context:{TARGET:'production'},runner:()=>assert.fail('no tools')}),/TEST_EVIDENCE_REQUIRED/);
});

test('canonical family chooser pins additive SQL and requires Test evidence before Production',()=>{
 const id='canonical-family-chooser-v1',candidate=verifyCandidateSha(id).candidate;
 assert.equal(candidate.autoPromote,false);assert.equal(candidate.canonicalFamilyChooser,true);
 assert.equal(candidate.statementsSha256,'b82b92828af061aad9924795979c9e07fa0b0072f761660bf1f456d49702102e');
 assert.equal(planDispatch({candidateId:id,target:'test'}).priorRuns.length,0);
 assert.throws(()=>planDispatch({candidateId:id,target:'production'}),/FAMILY_CHOOSER_TEST_EVIDENCE_REQUIRED/);
 assert.throws(()=>planDispatch({candidateId:id,target:'adopt'}),/FAMILY_CHOOSER_INVALID_TARGET/);
 assert.equal(planDispatch({candidateId:id,target:'production',inputs:{test_catalogue_run_id:'123'}}).priorRuns[0].candidateId,id);
 const sql=readFileSync(candidate.path,'utf8');
 assert.doesNotMatch(sql,/update public\.categories|alter table|create policy|create or replace function app_security\.(impl_submit|impl_moderate)/i);
 assert.match(sql,/exception when others then return false/);
});

test('canonical chooser postflight requires private helper, disabled direct writes and catalogue guard',async()=>{
 const checks={environment_lifecycle:true,private_helper:true,no_direct_writes:true,positive_readiness:true};
 const call=value=>verifyRemotePostflight('FairSwapTest','canonical-family-chooser-v1','postgres://mock',{},(_cmd,args)=>{
  assert.match(args.at(-1),/begin read only/i);assert.match(args.at(-1),/canonical_family_chooser_v1/);
  return JSON.stringify(value);
 });
 assert.deepEqual(await call(checks),checks);
 for(const key of Object.keys(checks)){
  await assert.rejects(()=>call({...checks,[key]:false}),/FAMILY_CHOOSER_POSTFLIGHT_FAILED/);
  const missing={...checks};delete missing[key];await assert.rejects(()=>call(missing),/FAMILY_CHOOSER_POSTFLIGHT_FAILED/);
 }
});

test('canonical chooser Test receipt records its stage, ledger digest and empty evidence chain',()=>{
 const candidate=getCandidate('canonical-family-chooser-v1');
 const p={key:'test_catalogue_run_id',runId:'123',candidateId:candidate.id,environment:'test'};
 const c={GITHUB_SHA:'a'.repeat(40)};
 const receipt={candidateId:candidate.id,migrationVersion:candidate.version,migrationFile:candidate.filename,
  migrationSha256:candidate.sha256,ledgerStatementsSha256:'b'.repeat(64),environment:'FairSwapTest',
  projectRef:REFS.FairSwapTest,reviewedCommit:c.GITHUB_SHA,releaseWorkflowRun:p.runId,
  postflightVerified:true,status:'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED',stage:'catalogue',
  webStagingSha:null,priorRuns:[]};
 const files=value=>{
  const name=candidate.id+'-fairswaptest.json',body=Buffer.from(JSON.stringify(value));
  return new Map([[name,body],['SHA256SUMS_fairswaptest',Buffer.from(createHash('sha256').update(body).digest('hex')+'  '+name+'\n')]]);
 };
 assert.equal(validateReceipt(p,c,files(receipt)).candidateId,candidate.id);
 for(const override of [{ledgerStatementsSha256:null},{stage:null},{priorRuns:null},{projectRef:'foreign'}])
  assert.throws(()=>validateReceipt(p,c,files({...receipt,...override})),/RECEIPT_CONTENT_INVALID/);
});

test('canonical chooser positively verifies the real existing Test lifecycle without Production authorization',
 {skip:PGlite?false:'Pinned PGlite unavailable in auxiliary CI job'},async()=>{
 const {verifyExistingTestLifecycle}=await import('../canonical-family-chooser/test-lifecycle.mjs');
 await verifyExistingTestLifecycle(PGlite,getCandidate('canonical-family-chooser-v1').path);
});

test('canonical family receipt recovery guards pinned Test and Production history',()=>{
 const source=readFileSync('scripts/release/reusable-supabase-release.mjs','utf8');
 assert.match(source,/FAMILY_CHOOSER_RECORDED_LEDGER_MISMATCH/);
 assert.match(source,/FAMILY_CHOOSER_SOURCE_LEDGER_MISMATCH/);
 assert.match(source,/installed\.statementsSha256 !== candidate\.statementsSha256/);
 assert.match(source,/FAMILY_CHOOSER_TEST_LEDGER_MISMATCH/);
 assert.match(source,/canonicalFamilyChooser \? familyTestLedger/);
 assert.match(source,/receipts\.test_catalogue_run_id\?\.ledgerStatementsSha256/);
});

test('IDV request-only ACR: signed identity remains mandatory, requested acr stays fixed, Test-only release is pinned', async () => {
  const {
    IDV_DIGILOCKER_REQUEST_CANDIDATE, IDV_DIGILOCKER_REQUEST_SCOPE,
    IDV_DIGILOCKER_REQUEST_PREFLIGHT, IDV_DIGILOCKER_REQUEST_POSTFLIGHT,
    assertIdvDigilockerRequestLedger, idvDigilockerRequestReceiptFields,
    verifyIdvDigilockerRequestTestReceipt
  } = await import('../../scripts/release/idv-digilocker-v1-release.mjs');
  const {candidate, sha256} = verifyCandidateSha(IDV_DIGILOCKER_REQUEST_CANDIDATE);
  assert.deepEqual([candidate.version, candidate.filename, sha256],
    ['20261123150000', '20261123150000_idv_digilocker_acr_request_only.sql',
      '6bc3877a9e6a6d9491960a3437390ab1672122682442326fa739e1d22589db3c']);
  assert.equal(candidate.testOnly, true);
  assert.equal(candidate.autoPromote, false);
  assert.equal(candidate.allowedProjectRef, REFS.FairSwapTest);
  assert.equal(planDispatch({candidateId: candidate.id, target: 'test'}).target, 'test');
  for(const target of ['production', 'adopt'])
    assert.throws(() => planDispatch({candidateId:candidate.id,target}), /TEST_ONLY_CANDIDATE/);
  assert.deepEqual(assertIdvDigilockerRequestLedger('FairSwapTest', acrLedger({extra:[acrRow()]})),
    {includeAll:false,ahead:[]});
  assert.throws(() => assertIdvDigilockerRequestLedger('FairSwapProd', acrLedger({extra:[acrRow()]})), /REQUEST_TEST_ONLY/);
  assert.throws(() => assertIdvDigilockerRequestLedger('FairSwapTest', acrLedger()), /REQUEST_ACR_PREREQUISITE_MISSING/);
  assert.throws(() => assertIdvDigilockerRequestLedger('FairSwapTest',
    acrLedger({extra:[acrRow(),{version:candidate.version,name:candidate.filename.slice(15,-4)}]})), /REQUEST_ALREADY_RECORDED/);
  const oidc = readFileSync('supabase/functions/_shared/idv/digilocker-oidc.ts','utf8');
  assert.match(oidc, /u\.searchParams\.set\("acr", OIDC_ACR\)/);
  assert.match(oidc, /OIDC_ACR = "aadhaar"/);
  assert.doesNotMatch(oidc, /if \(claims\["acr"\]/);
  assert.match(oidc, /OIDC_EVIDENCE_METHOD = "oidc_v2_signed_id_requested_aadhaar"/);
  const sql = readFileSync(candidate.path,'utf8');
  assert.match(sql, /oidc_v2_signed_id_requested_aadhaar/);
  assert.match(sql, /oidc_v2_signed_aadhaar_acr/);
  assert.doesNotMatch(sql, /update public\.app_system_settings/i);
  const wf=readFileSync('.github/workflows/reusable-supabase-release.yml','utf8');
  assert.match(wf, /- idv-digilocker-acr-request-only/);
  assert.match(wf, /inputs\.candidate != 'idv-digilocker-acr-request-only'/);
  assert.ok(Object.keys(IDV_DIGILOCKER_REQUEST_PREFLIGHT).includes('acr_bodies_exact'));
  assert.ok(IDV_DIGILOCKER_REQUEST_POSTFLIGHT.acr_bodies_exact.includes('oidc_v2_signed_id_requested_aadhaar'));
  assert.ok(IDV_DIGILOCKER_REQUEST_POSTFLIGHT.acr_evidence_constraint.includes('oidc_v2_signed_aadhaar_acr'));
  const context={GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'135',GITHUB_RUN_ATTEMPT:'1',CANDIDATE:candidate.id};
  const receipt={
    environment:'FairSwapTest',projectRef:REFS.FairSwapTest,candidateId:candidate.id,
    migrationVersion:candidate.version,migrationFile:candidate.filename,migrationSha256:candidate.sha256,
    reviewedCommit:context.GITHUB_SHA,releaseWorkflowRun:context.GITHUB_RUN_ID,
    releaseWorkflowAttempt:context.GITHUB_RUN_ATTEMPT,postflightVerified:true,
    status:'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED',dryRunPending:[candidate.filename],
    ledgerStatementsSha256:'f'.repeat(64),postflightScope:IDV_DIGILOCKER_REQUEST_SCOPE,
    prerequisiteLedger:IDV_FOUNDATION_LEDGER.FairSwapTest,
    edgeFunctionsDeployedByThisWorkflow:false, ...idvDigilockerRequestReceiptFields()
  };
  assert.equal(verifyIdvDigilockerRequestTestReceipt(receipt,context),receipt.ledgerStatementsSha256);
  for(const overrides of [{identityVerificationRequired:false},{autoPromote:true},{postflightScope:'incorrect'},
    {status:'ALREADY_APPLIED_VERIFIED'},{acrRequested:'no'},{projectRef:REFS.FairSwapProd}])
    assert.throws(()=>verifyIdvDigilockerRequestTestReceipt({...receipt,...overrides},context),/REQUEST_TEST_RECEIPT_INVALID/);
});
