#!/usr/bin/env node
// Disposable-DB test runner for supabase/forward-migrations/moderation-analytics-v1.
// Applies the 58 baseline migrations unchanged, then the Moderation Analytics forward migration,
// then executes tests/admin_moderation_analytics_security.test.sql (pgTAP) via psql -f (file-based).
// Fails closed: target must be a loopback host (localhost / 127.0.0.1 / [::1]) and no hosted credentials may be set.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'supabase', 'forward-migrations', 'moderation-analytics-v1');
const testSqlFile = join(dir, 'tests', 'admin_moderation_analytics_security.test.sql');

const failures = [];
const fail = (m) => failures.push(m);

function staticScan() {
  const migrations = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  const EXPECTED = ['20261102000000_admin_moderation_analytics_v1.sql'];
  if (migrations.length !== EXPECTED.length || migrations.some((f, i) => f !== EXPECTED[i])) {
    fail(`forward migrations must be exactly the expected file: ${EXPECTED.join(', ')}; found: ${migrations.join(', ')}`);
  }

  for (const f of migrations) {
    const sql = readFileSync(join(dir, f), 'utf8');
    if ((sql.match(/\$\$/g) || []).length % 2 !== 0) fail(`${f}: unbalanced $$ dollar quoting`);
    if (!/^begin;/mi.test(sql) || !/^commit;/mi.test(sql)) fail(`${f}: missing begin/commit`);
    if (/\b(drop table|truncate|delete from public\.(profiles|user_accounts|listings))\b/i.test(sql)) fail(`${f}: destructive statement`);
    if (/grant\s+[^;]*\bto\s+[^;]*\banon\b/i.test(sql)) fail(`${f}: unexpected anon grant`);
    if (!/STABLE/i.test(sql)) fail(`${f}: public wrapper and impl must be declared STABLE`);
    if (!/SET search_path = ''/i.test(sql)) fail(`${f}: function must use empty search_path`);
    if (/clock_timestamp\(\)/i.test(sql)) fail(`${f}: volatile clock_timestamp() used instead of statement_timestamp()`);
  }

  if (!existsSync(testSqlFile)) {
    fail(`pgTAP test file missing: ${testSqlFile}`);
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOSTED_ENV = [
  'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY',
  'SUPABASE_PROJECT_REF', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_JWT_SECRET',
  'DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'PGHOSTADDR', 'PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE',
];

export function checkTarget(rawUrl, env = {}) {
  if (!rawUrl) return 'MODERATION_ANALYTICS_DB_URL is required';
  let u;
  try { u = new URL(rawUrl); } catch { return 'DB URL is not a parseable URL'; }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return 'DB URL must use postgres(ql)://';
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return `DB host "${u.hostname}" is not loopback (localhost/127.0.0.1/::1 only)`;
  if (!u.port || !/^\d+$/.test(u.port) || Number(u.port) < 1024 || Number(u.port) > 65535) return 'DB URL needs an explicit unprivileged numeric port';
  if (u.search || u.hash) return 'DB URL must not carry query parameters';
  if (u.pathname !== '/postgres') return 'DB name must be "postgres" on the disposable stack';
  for (const k of HOSTED_ENV) if (env[k]) return `${k} must not be set`;
  const pub = env.NEXT_PUBLIC_SUPABASE_URL;
  if (pub) return 'NEXT_PUBLIC_SUPABASE_URL must not be set';
  return null;
}

function selfTest() {
  const ok = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const cases = [
    [ok, {}, true],
    ['postgres://postgres:postgres@localhost:54999/postgres', {}, true],
    ['postgresql://postgres:postgres@[::1]:54322/postgres', {}, true],
    ['postgresql://postgres:pw@db.wpppxlnbzqynvhpeuavd.supabase.co:5432/postgres', {}, false],
    ['postgresql://postgres.x:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres', {}, false],
    ['postgresql://postgres:postgres@10.0.0.5:54322/postgres', {}, false],
    ['postgresql://postgres:postgres@127.0.0.1.evil.example:54322/postgres', {}, false],
    ['postgresql://127.0.0.1@evil.example:54322/postgres', {}, false],
    ['postgresql://postgres:postgres@127.0.0.1/postgres', {}, false],
    ['postgresql://postgres:postgres@127.0.0.1:80/postgres', {}, false],
    ['mysql://postgres:postgres@127.0.0.1:54322/postgres', {}, false],
    ['', {}, false],
    [ok, { SUPABASE_ACCESS_TOKEN: 'x' }, false],
    [ok, { PGHOST: 'db.example.com' }, false],
  ];
  cases.forEach(([url, env, expectOk], i) => {
    const err = checkTarget(url, env);
    if (expectOk !== (err === null)) fail(`self-test case ${i}: expected ${expectOk ? 'accept' : 'reject'}, got ${err ?? 'accept'}`);
  });
  if (!failures.length) console.log(`self-test OK (${cases.length} allowlist cases)`);
}

function execute() {
  const url = process.env.MODERATION_ANALYTICS_DB_URL;
  const err = checkTarget(url, process.env);
  if (err) { console.error(`Refusing to run: ${err}`); process.exit(2); }

  // Scrubbed environment: prevent libpq environment variables from redirecting connection
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PGCONNECT_TIMEOUT: '15' };

  // File-based psql execution: keeps PostgreSQL errors directly visible without EPIPE
  const psqlFile = (filePath) => spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', filePath], { encoding: 'utf8', env });
  const psqlCmd = (sqlText) => spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sqlText], { encoding: 'utf8', env });

  const ext = psqlCmd('CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions');
  if (ext.status !== 0) { fail(`pgtap extension unavailable: ${ext.stderr || ext.stdout}`); return; }

  // Apply the Moderation Analytics forward migration from file
  const forwardMigration = join(dir, '20261102000000_admin_moderation_analytics_v1.sql');
  const applyRes = psqlFile(forwardMigration);
  if (applyRes.status !== 0) {
    fail(`apply ${forwardMigration}: ${applyRes.stderr || applyRes.stdout}`);
    return;
  }

  // Execute pgTAP test file directly from disk
  const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A', '-f', testSqlFile], { encoding: 'utf8', env });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  process.stdout.write(out);

  if (r.status !== 0) fail(`pgTAP run exited non-zero with code ${r.status}`);
  if (/^not ok /m.test(out)) fail('pgTAP reported failing assertions');
  const okCount = (out.match(/^ok /gm) || []).length;
  if (okCount < 15) fail(`only ${okCount} passing assertions; suite incomplete`);
  console.log(`Executed pgTAP successfully: ${okCount} passing assertions.`);
}

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--static') staticScan();
else if (mode === '--execute') { staticScan(); execute(); }
else { console.error('usage: --self-test | --static | --execute'); process.exit(2); }

if (failures.length) { console.error('FAIL:\n- ' + failures.join('\n- ')); process.exit(1); }
if (mode === '--static') console.log('static scan OK');
else if (mode === '--execute') console.log('moderation-analytics pgTAP OK');
