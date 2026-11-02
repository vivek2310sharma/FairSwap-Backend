import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));

// The 58 baseline migrations verified by scripts/verify-migration-manifest.mjs
const manifestPath = path.join(root, 'docs/extraction/MIGRATION_MANIFEST.sha256');
const manifestLines = readFileSync(manifestPath, 'utf8').trim().split('\n');

const baselineFiles = manifestLines.map(line => {
  const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line.trim());
  if (!match) throw new Error(`Invalid manifest line: ${line}`);
  return match[2];
});

const sources = [
  ...baselineFiles,
  'supabase/forward-migrations/moderation-analytics-v1/20261102000000_admin_moderation_analytics_v1.sql',
  'supabase/forward-migrations/moderation-analytics-v1/tests/admin_moderation_analytics_security.test.sql',
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

  const args = [
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1',
    '-p', port,
    '-U', 'postgres',
    '-d', 'postgres',
  ];

  try {
    const res = spawnSync(psql, args, {
      input: sql,
      encoding: 'utf8',
      env: { ...process.env, PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8' },
    });

    if (res.error) {
      throw res.error;
    }

    if (res.status !== 0) {
      console.error(res.stderr || res.stdout);
      process.exit(res.status ?? 1);
    }

    console.log(res.stdout);
    console.log('PASS: Admin Moderation Analytics V1 security & boundary pgTAP tests');
  } catch (err) {
    console.error('FAIL running pgTAP test:', err);
    process.exit(1);
  }
} else {
  console.error('Usage: node run-disposable.mjs --emit-sql | --native-port=<port> [--pg-bin=<path>]');
  process.exit(1);
}
