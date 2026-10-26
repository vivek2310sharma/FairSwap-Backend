import './offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('self-contained PGlite dependency is pinned across package, lockfile and toolchain',()=>{
  const pkg=JSON.parse(read('package.json')),pins=JSON.parse(read('scripts/ci/toolchain.json'));
  assert.equal(process.versions.node,pins.node);assert.equal(pkg.packageManager,'pnpm@'+pins.pnpm);
  assert.equal(pkg.devDependencies['@electric-sql/pglite'],'0.5.8');assert.equal(pins.packages['@electric-sql/pglite'],'0.5.8');
  assert.match(read('pnpm-lock.yaml'),/'@electric-sql\/pglite':\s+specifier: 0\.5\.8\s+version: 0\.5\.8/);
  const harness=read('scripts/ci/test-chat-v2.mjs');assert(!harness.includes('FairSwap-Web'));assert.match(harness,/from '@electric-sql\/pglite'/);
});
test('Chat V2 CI job is a required fail-closed dependency, preserving existing gates',()=>{
  const ci=read('.github/workflows/backend-ci.yml');
  assert.match(ci,/needs: \[unit-integrity, database-pg15, chat-v2\]/);
  for(const command of ['node scripts/ci/verify-baseline.mjs','node scripts/ci/verify-unit-results.mjs --check-isolation','bash scripts/ci/run-local-db.sh','node --test tests/chat-v2/*.test.mjs','node scripts/ci/test-chat-v2.mjs'])assert(ci.includes(command));
  assert(ci.includes('$CHAT_V2_RESULT" == success'));assert(!ci.includes('continue-on-error: true'));
  assert.match(ci,/--frozen-lockfile --ignore-scripts --engine-strict/);
});
test('legacy 93-case unit allowlist and no-network digest remain unchanged',()=>{
  const source=read('scripts/ci/verify-unit-results.mjs');
  for(const count of [39,7,10,3,34])assert(source.includes(': '+count+','));
  const setup=Buffer.from(read('tests/setup/no-network.ts').replaceAll('\r\n','\n'));
  assert.equal(createHash('sha256').update(setup).digest('hex'),'c4a49badd88b567fa99b198f263f37308a16796bd026020522d29b0e2e95ce5f');
});
test('custom-header auth has exact Deno pins and explicit gateway configuration',()=>{
  const imports=JSON.parse(read('supabase/functions/process-chat-safety/deno.json')).imports;
  assert.equal(imports['@supabase/supabase-js'],'npm:@supabase/supabase-js@2.116.0');assert.equal(imports.zod,'npm:zod@3.24.2');
  assert.match(read('supabase/config.toml'),/\[functions.process-chat-safety\]\s+verify_jwt = false/);
  const entry=read('supabase/functions/process-chat-safety/index.ts');assert(!entry.includes('WORKER_SECRET'));assert(!entry.includes('Authorization'));
});
test('environment release artifacts contain no activation or credential literals',()=>{
  for(const env of ['fairswaptest','fairswapprod']){
    const sql=read(`supabase/forward-migrations/chat-v2/release/${env}.inactive.sql`);
    assert(sql.includes('configure_chat_safety_inactive'));assert(!/enabled\s*=\s*true|active\s*[:=]+\s*true|Bearer|sb_secret_|[a-f0-9]{64}/i.test(sql));
    const prerequisite=read(`supabase/forward-migrations/chat-v2/release/${env}.vault-prerequisite.sql`);
    assert(prerequisite.includes('provision_chat_safety_project_url'));assert(!/sb_secret_|Bearer|[a-f0-9]{64}/.test(prerequisite));
  }
});
test('migration never mutates extension-owned ACLs or hides dispatch failures',()=>{
  const sql=read('supabase/forward-migrations/chat-v2/supabase/migrations/20261026073143_chat_safety_worker_infrastructure.sql');
  assert(!/(?:revoke|grant)\s+[^;]+\bon\s+(?:table\s+)?net\./i.test(sql));
  assert(sql.includes('assert_chat_safety_net_privileges()'));assert(sql.includes("last_dispatch_status='blocked'"));
  assert(sql.includes('CHAT_SAFETY_DISPATCH_FAILED'));assert(!/raise warning[^;]*(SQLERRM|v_token)/i.test(sql));
  assert(sql.indexOf('perform app_security.assert_chat_safety_net_privileges();',sql.indexOf('create function app_security.dispatch_chat_safety'))<sql.indexOf('select count(*),min(decrypted_secret)',sql.indexOf('create function app_security.dispatch_chat_safety')));
});
test('native PG15 privilege regression is required and isolated with the existing digest pin',()=>{
  const script=read('scripts/ci/run-chat-net-privileges-pg15.sh'),ci=read('.github/workflows/backend-ci.yml');
  assert(ci.includes('bash scripts/ci/run-chat-net-privileges-pg15.sh'));assert(script.includes('--network none'));
  assert(script.includes('150008'));assert(script.includes('p.digest'));assert(!script.includes('--network host'));
  const fixtures=read('tests/chat-v2/bootstrap.sql');assert(fixtures.includes('create role postgres bypassrls'));
  assert(fixtures.includes('owner to supabase_admin'));assert(fixtures.includes('create function net.http_post'));
});
