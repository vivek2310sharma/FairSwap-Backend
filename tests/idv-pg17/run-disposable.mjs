import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));

const sources = [
  'tests/idv-pg17/fixture.sql',
  'tests/idv-pg17/fixture-digilocker.sql',
  'supabase/forward-migrations/idv/20261026183000_idv_digilocker_foundation.sql',
  'tests/idv-pg17/assertions.sql',
  'supabase/forward-migrations/idv/20261117090000_idv_digilocker_direct_v1.sql',
  'tests/idv-pg17/assertions-digilocker.sql',
  'supabase/forward-migrations/idv/20261119200000_idv_digilocker_oidc_v2_badge.sql',
  'tests/idv-pg17/assertions-digilocker-v2.sql',
  'supabase/forward-migrations/idv/20261122100000_idv_digilocker_required_gate.sql',
  'tests/idv-pg17/assertions-digilocker-required.sql',
  'supabase/forward-migrations/idv/20261123120000_idv_digilocker_aadhaar_acr.sql',
  'tests/idv-pg17/assertions-digilocker-aadhaar-acr.sql',
  'supabase/forward-migrations/idv/20261123150000_idv_digilocker_acr_request_only.sql',
  'tests/idv-pg17/assertions-digilocker-acr-request-only.sql',
  'supabase/forward-migrations/idv/20261123180000_idv_digilocker_production_parity.sql',
  'tests/idv-pg17/assertions-digilocker-production-parity.sql',
];

// DigiLocker fraud-suspension integration runs against the REAL account-status implementation (not a stub):
// extract it verbatim from the immutable baseline migration and load it after the fixtures.
const accountStatusMigration = 'supabase/migrations/20260914000016_staff_user_moderation_and_hardening.sql';
function extractFunction(text, qualifiedName) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION ${qualifiedName.replace('.', '\\.')}\\([\\s\\S]*?\\n\\$\\$;`);
  const m = text.match(re);
  if (!m) throw new Error(`Cannot extract ${qualifiedName} from ${accountStatusMigration}`);
  return m[0];
}
const accountStatusText = readFileSync(path.join(root, accountStatusMigration), 'utf8');
const realAccountStatusSql = [
  `-- Extracted verbatim from ${accountStatusMigration}`,
  extractFunction(accountStatusText, 'app_security.impl_update_user_account_status'),
  extractFunction(accountStatusText, 'public.admin_update_user_account_status'),
].join('\n\n');

const sql = sources
  .map((p) => readFileSync(path.join(root, p), 'utf8') + (p === 'tests/idv-pg17/fixture-digilocker.sql' ? '\n' + realAccountStatusSql : ''))
  .join('\n');

const nativePortArg = process.argv.find((x) => x.startsWith('--native-port='));
const pgBinArg = process.argv.find((x) => x.startsWith('--pg-bin='));

if (process.argv[2] === '--emit-sql') {
  process.stdout.write(sql);
} else if (nativePortArg) {
  const port = nativePortArg.split('=')[1];
  const pgBin = pgBinArg ? pgBinArg.split('=')[1] : (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin');
  const psql = path.join(pgBin, process.platform === 'win32' ? 'psql.exe' : 'psql');

  console.log(`Connecting to native PostgreSQL 17 on port ${port} using ${psql}...`);

  const dir = mkdtempSync(path.join(tmpdir(), 'idv-pg17-'));
  const sqlFile = path.join(dir, 'suite.sql');
  writeFileSync(sqlFile, sql, 'utf8');

  const args = [
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1',
    '-p', port,
    '-U', 'postgres',
    '-d', 'postgres',
    '-f', sqlFile,
  ];

  try {
    const res = spawnSync(psql, args, {
      encoding: 'utf8',
      env: { ...process.env, PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8' },
    });

    if (res.error) {
      throw res.error;
    }

    if (res.status !== 0) {
      console.error('FAIL: Native PostgreSQL 17 execution failed (exit code ' + res.status + '):');
      console.error(res.stderr || res.stdout);
      process.exit(res.status || 1);
    }

    console.log(res.stdout);
    console.log('PASS: FairSwap IDV-V1 PostgreSQL 17 disposable test assertions executed cleanly.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log(`
FairSwap IDV-V1 PostgreSQL 17 Automated Test Runner
Usage:
  node run-disposable.mjs --native-port=<PORT> [--pg-bin=<DIR>]
    Executes fixture, migration, and assertions directly against disposable native PG17 with ON_ERROR_STOP=1.
  node run-disposable.mjs --emit-sql > full_test_suite.sql
    Emits full concatenation for piping into psql.
`);
}
