#!/usr/bin/env node
// Isolated gate for supabase/forward-migrations/profile-onboarding.
// Does NOT touch the pinned baseline (assert-local-security.sql / verify-db-results.mjs).
//
//   node scripts/ci/run-profile-onboarding-tests.mjs --static
//       Supplementary static scan of the forward SQL (no database). NOT production acceptance.
//
//   PROFILE_ONBOARDING_DB_URL=postgres://... node scripts/ci/run-profile-onboarding-tests.mjs --execute
//       Applies the forward migrations in order to a DISPOSABLE database that already has the
//       repo migrations, then executes tests/profile_onboarding.test.sql (pgTAP) via psql and
//       fails on any "not ok" / psql error. Fails closed: the target must be a loopback host
//       (positive allowlist: localhost / 127.0.0.1 / ::1) and no hosted credentials may be set.
//       Requires psql + pgTAP.
//
//   node scripts/ci/run-profile-onboarding-tests.mjs --self-test
//       Pure unit checks of the target allowlist / credential guard (no database).
//
// Wiring into GitHub Actions is owned by ChatGPT; see docs/contracts/profile-public-private.md.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'supabase', 'forward-migrations', 'profile-onboarding');
const migrations = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
const failures = [];
const fail = (m) => failures.push(m);

function staticScan() {
  // The release package is exactly these eight forward migrations, in this order. The runner
  // depends only on the 58 repo migrations (profiles, user_accounts, policy/staff helpers,
  // postal tables, lookup_pincode, privacy_requests, storage); no other forward topic
  // (seller-profile, india-taxonomy, moderation-v2) is a prerequisite.
  const EXPECTED = [
    '20261025100001_user_private_details.sql',
    '20261025100002_profile_text_validation.sql',
    '20261025100003_profile_rpcs.sql',
    '20261025100004_handle_new_user_hardening.sql',
    '20261025100005_avatars_bucket_and_rpcs.sql',
    '20261025100006_privacy_export_and_deletion.sql',
    '20261025100007_avatar_cleanup_consumer.sql',
    '20261025100008_atomic_profile_save.sql',
  ];
  if (migrations.length !== EXPECTED.length || migrations.some((f, i) => f !== EXPECTED[i])) {
    fail(`forward migrations must be exactly the eight expected files in order; found: ${migrations.join(', ')}`);
  }
  const m6 = readFileSync(join(dir, EXPECTED[5]), 'utf8').replace(/--.*$/gm, '');
  if (!/RENAME TO impl_fulfill_data_export_base/.test(m6)
      || !/v_export := app_security\.impl_fulfill_data_export_base\(p_request_id\)/.test(m6)
      || !/REVOKE ALL ON FUNCTION app_security\.impl_fulfill_data_export_base\(uuid\)\s+FROM PUBLIC, anon, authenticated, service_role/.test(m6)
      || !/GRANT EXECUTE ON FUNCTION app_security\.impl_fulfill_data_export\(uuid\) TO authenticated, service_role/.test(m6)
      || !/private_details/.test(m6)) {
    fail('migration 006 must wrap the renamed export base (rename, base call, base ACL revoked, original ACL, private_details)');
  }
  if (/SELECT \* INTO v_req|is_active_staff_aal2/.test(m6)) fail('migration 006 must not duplicate the historical export authorization logic');
  for (const f of migrations) {
    const sql = readFileSync(join(dir, f), 'utf8');
    if ((sql.match(/\$\$/g) || []).length % 2 !== 0) fail(`${f}: unbalanced $$ dollar quoting`);
    if (!/^begin;/m.test(sql) || !/^commit;/m.test(sql)) fail(`${f}: missing begin/commit`);
    if (!/set local lock_timeout = '5s'/.test(sql) || !/set local statement_timeout = '30s'/.test(sql)) fail(`${f}: missing timeouts`);
    if (/\b(drop table|truncate|delete from public\.(profiles|user_accounts|listings))\b/i.test(sql)) fail(`${f}: destructive statement`);
    if (/grant\s+[^;]*\bto\s+[^;]*\banon\b/i.test(sql) && !/public_profile_location/.test(sql)) fail(`${f}: unexpected anon grant`);
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION (app_security\.impl_\w+)[\s\S]*?\$\$;/gi)) {
      if (!/SECURITY DEFINER/i.test(m[0]) || !/SET search_path = ''/i.test(m[0])) fail(`${f}: ${m[1]} must be SECURITY DEFINER with empty search_path`);
    }
    if (/https?:\/\/[a-z0-9-]+\.supabase\.co/i.test(sql)) fail(`${f}: hardcoded Supabase host`);
    if (/raw_user_meta_data[^;]*(role|admin|staff)/i.test(sql)) fail(`${f}: raw_user_meta_data used for authorization`);
    if (/raw_user_meta_data->>'(email|phone)'/i.test(sql)) fail(`${f}: metadata email/phone used`);
  }
  const all = migrations.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const clientGrant = /grant\s+execute\s+on\s+function\s+[^;]*(service_(claim|complete|fail)_avatar_cleanup|impl_(claim|complete|fail)_avatar_cleanup|service_(set|clear)_profile_avatar)[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i;
  if (clientGrant.test(all)) {
    fail('service-role-only function granted to a client role');
  }
  const required = [
    [/user_private_details[\s\S]*FORCE ROW LEVEL SECURITY/i, 'private details RLS forced'],
    [/REVOKE ALL ON TABLE public\.user_private_details FROM PUBLIC, anon, authenticated/i, 'private details revoke'],
    [/INSERT INTO storage\.buckets[\s\S]*'avatars'[\s\S]*image\/webp/i, 'avatars bucket webp'],
    [/REVOKE UPDATE \(avatar_url\)/i, 'avatar_url client write revoked'],
    [/avatar_cleanup_queue/i, 'avatar cleanup queue'],
    [/AVATAR_CONFLICT/, 'avatar CAS'],
    [/Member-/, 'neutral fallback name'],
    [/service_claim_avatar_cleanup[\s\S]*service_complete_avatar_cleanup[\s\S]*service_fail_avatar_cleanup/i, 'cleanup consumer RPCs'],
    [/FOR UPDATE SKIP LOCKED/i, 'cleanup claim uses SKIP LOCKED'],
    [/save_my_profile_details/, 'atomic profile save RPC'],
  ];
  for (const [re, label] of required) if (!re.test(all)) fail(`missing: ${label}`);
  if (/split_part\(\s*NEW\.email/i.test(readFileSync(join(dir, '20261025100004_handle_new_user_hardening.sql'), 'utf8').replace(/--.*$/gm, ''))) {
    fail('handle_new_user still derives name from email');
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOSTED_ENV = [
  'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY',
  'SUPABASE_PROJECT_REF', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_JWT_SECRET',
  'DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'PGHOSTADDR', 'PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE',
];

// Returns an error string, or null when the target is an acceptable disposable loopback database.
export function checkTarget(rawUrl, env = {}) {
  if (!rawUrl) return 'PROFILE_ONBOARDING_DB_URL is required';
  let u;
  try { u = new URL(rawUrl); } catch { return 'DB URL is not a parseable URL'; }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return 'DB URL must use postgres(ql)://';
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return `DB host "${u.hostname}" is not loopback (localhost/127.0.0.1/::1 only)`;
  if (!u.port || !/^\d+$/.test(u.port) || Number(u.port) < 1024 || Number(u.port) > 65535) return 'DB URL needs an explicit unprivileged numeric port';
  if (u.search || u.hash) return 'DB URL must not carry query parameters (host=, hostaddr=, sslmode overrides, ...)';
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
    ['postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=db.example.com', {}, false],
    ['postgresql://postgres:postgres@127.0.0.1:54322/postgres?hostaddr=8.8.8.8', {}, false],
    ['postgresql://postgres:postgres@127.0.0.1:54322/prod', {}, false],
    ['mysql://postgres:postgres@127.0.0.1:54322/postgres', {}, false],
    ['not a url', {}, false],
    ['', {}, false],
    [ok, { SUPABASE_ACCESS_TOKEN: 'x' }, false],
    [ok, { SUPABASE_SERVICE_ROLE_KEY: 'x' }, false],
    [ok, { PGHOST: 'db.example.com' }, false],
    [ok, { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' }, false],
  ];
  cases.forEach(([url, env, expectOk], i) => {
    const err = checkTarget(url, env);
    if (expectOk !== (err === null)) fail(`self-test case ${i} (${url || '<empty>'}): expected ${expectOk ? 'accept' : 'reject'}, got ${err ?? 'accept'}`);
  });
  if (!failures.length) console.log(`self-test OK (${cases.length} allowlist cases)`);
}

function execute() {
  const url = process.env.PROFILE_ONBOARDING_DB_URL;
  const err = checkTarget(url, process.env);
  if (err) { console.error(`Refusing to run: ${err}`); process.exit(2); }
  // Never let libpq environment redirect the connection away from the validated URL.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PGCONNECT_TIMEOUT: '15' };
  const psql = (args) => spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-X', ...args], { encoding: 'utf8', env });
  const ext = psql(['-q', '-c', 'CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions']);
  if (ext.status !== 0) { fail(`pgtap extension unavailable: ${ext.stderr}`); return; }
  if (process.env.PROFILE_ONBOARDING_APPLY !== '0') {
    for (const f of migrations) {
      const r = psql(['-q', '-f', join(dir, f)]);
      if (r.status !== 0) { fail(`apply ${f}: ${r.stderr || r.stdout}`); return; }
    }
  }
  const r = psql(['-q', '-t', '-A', '-f', join(dir, 'tests', 'profile_onboarding.test.sql')]);
  const out = `${r.stdout}
${r.stderr}`;
  process.stdout.write(out);
  if (r.status !== 0) fail('pgTAP run exited non-zero');
  if (/^not ok /m.test(out)) fail('pgTAP reported failing assertions');
  const planned = out.match(/^1\.\.(\d+)$/m);
  const ok = (out.match(/^ok /gm) || []).length;
  if (planned && Number(planned[1]) !== ok) fail(`pgTAP plan ${planned[1]} != ${ok} passing assertions`);
  if (ok < EXPECTED_MIN_ASSERTIONS) fail(`only ${ok} passing assertions (< ${EXPECTED_MIN_ASSERTIONS}); suite incomplete`);
}

const EXPECTED_MIN_ASSERTIONS = 180; // >= statically counted assertions in tests/profile_onboarding.test.sql (181 single-row + multi-row)

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--static') staticScan();
else if (mode === '--execute') { staticScan(); execute(); }
else { console.error('usage: --self-test | --static | --execute'); process.exit(2); }

if (failures.length) { console.error('FAIL:\n- ' + failures.join('\n- ')); process.exit(1); }
if (mode === '--static') console.log('static scan OK (supplementary; not acceptance)');
else if (mode === '--execute') console.log('profile-onboarding pgTAP OK');
