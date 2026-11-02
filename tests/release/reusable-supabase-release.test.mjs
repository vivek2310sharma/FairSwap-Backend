import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {getCandidate, verifyCandidateSha, CANDIDATES} from '../../scripts/release/reusable-candidates.mjs';
import {parsePendingDryRun, verifyLedgerVersion, releaseReusable, REFS} from '../../scripts/release/reusable-supabase-release.mjs';

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

test('verifyLedgerVersion checks exact presence of version line', () => {
  const ledger = `
    | 20261017205807 | applied | 20261017205807_cat.sql |
    | 20261102000000 | applied | 20261102000000_admin_moderation_analytics_v1.sql |
  `;
  assert.doesNotThrow(() => {
    verifyLedgerVersion(ledger, '20261102000000', '20261102000000_admin_moderation_analytics_v1.sql');
  });
  assert.throws(() => {
    verifyLedgerVersion(ledger, '20261199999999', '20261199999999_missing.sql');
  }, /REUSABLE_RELEASE_EXACT_LEDGER_ENTRY_MISSING/);
});

test('verifyLedgerVersion rejects substring match on unrelated migration', () => {
  const ledger = `
    | 2026110200000011 | applied | other.sql |
  `;
  assert.throws(() => {
    verifyLedgerVersion(ledger, '20261102000000');
  }, /REUSABLE_RELEASE_EXACT_LEDGER_ENTRY_MISSING/);
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
      return '| 20261102000000 | applied | 20261102000000_admin_moderation_analytics_v1.sql |';
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
});
