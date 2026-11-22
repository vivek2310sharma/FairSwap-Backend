// Native PostgreSQL 17: FairSwapProd sequence foundation -> V3 identity prerequisite -> DigiLocker V1 (see prod-v3-to-v1-scenarios.mjs).
// Usage: node tests/idv-pg17/run-prod-v3-to-v1.mjs --native-port=<port> [--pg-bin=<dir>]
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runProdV3ToV1Scenarios, setupSql} from './prod-v3-to-v1-scenarios.mjs';

const arg = name => process.argv.find(x => x.startsWith(`--${name}=`))?.split('=')[1];
const port = arg('native-port');
if (!port) { console.error('--native-port is required'); process.exit(2); }
const psql = join(arg('pg-bin') ?? '/usr/lib/postgresql/17/bin', 'psql');
const dir = mkdtempSync(join(tmpdir(), 'idv-prod-v3-v1-'));
const database = `idv_prod_v3_to_v1_${process.pid}`;
const exec = (db, args) => {
  const res = spawnSync(psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', db, ...args],
    {encoding: 'utf8', env: {...process.env, PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8'}});
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`psql failed (${res.status}): ${res.stderr}`);
  return res.stdout;
};
let n = 0;
const run = async sql => {
  const file = join(dir, `s${n++}.sql`);
  writeFileSync(file, sql, 'utf8');
  return exec(database, ['-f', file]).trim().split('\n').filter(Boolean).at(-1) ?? '';
};
try {
  const version = exec('postgres', ['-c', 'show server_version_num']).trim();
  if (!/^17\d{4}$/.test(version)) throw new Error(`PostgreSQL 17 required, got ${version}`);
  exec('postgres', ['-c', `create database ${database}`]);
  await run(setupSql());
  await runProdV3ToV1Scenarios(run);
  console.log('PASS: FairSwapProd V3 -> DigiLocker V1 compatibility on native PostgreSQL 17.');
} finally {
  try { exec('postgres', ['-c', `drop database if exists ${database} with (force)`]); } catch {}
  rmSync(dir, {recursive: true, force: true});
}
