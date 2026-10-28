import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));

const sources = [
  'tests/idv-pg17/fixture.sql',
  'supabase/forward-migrations/idv/20261026183000_idv_digilocker_foundation.sql',
  'tests/idv-pg17/assertions.sql',
];

const sql = sources.map((p) => readFileSync(path.join(root, p), 'utf8')).join('\n');

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
