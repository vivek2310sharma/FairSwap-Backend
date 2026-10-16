// Static/regression checks only. Synthetic validator inputs are not runtime evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,readdirSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifyEvent,verifyChanges,base} from './verify-source.mjs';
import {inspectTap,verifyTap,assertions} from './parse-compatibility.mjs';
import {verifySecurity,expectedRls,expectedColumnDml,expectedMigrationVersions,requiredSuites,collectEvidence} from './verify-db-results.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const workflow=read('.github/workflows/stage3-pg17-compat.yml');
const runner=read('scripts/stage3/run-local-db.sh');
const sql=read('tests/stage3/moderation_compatibility.test.sql');
const pins=JSON.parse(read('scripts/stage3/toolchain.json'));
const repo='vivek2310sharma/FairSwap-Backend',head='a'.repeat(40);
const event=()=>({repository:{full_name:repo},pull_request:{
 head:{ref:'test/stage3-moderation-pg17-compat',sha:head,repo:{full_name:repo}},
 base:{ref:'chore/backend-extraction-baseline',sha:base,repo:{full_name:repo}}}});
test('accept exact designated same-repository event',()=>verifyEvent(event(),head));
for(const [label,alter] of [
 ['fork',e=>e.pull_request.head.repo.full_name='foreign/FairSwap-Backend'],
 ['wrong head branch',e=>e.pull_request.head.ref='other'],
 ['wrong base branch',e=>e.pull_request.base.ref='main'],
 ['base SHA drift',e=>e.pull_request.base.sha='b'.repeat(40)],
 ['repository substitution',e=>e.repository.full_name='foreign/FairSwap-Backend'],
 ['malformed SHA',e=>e.pull_request.head.sha='abc']]) {
 test('reject '+label,()=>{const e=event();alter(e);assert.throws(()=>verifyEvent(e,head))});
}
test('reject checked-out SHA drift',()=>assert.throws(()=>verifyEvent(event(),'b'.repeat(40))));
test('source scope rejects canonical, PG15, application and traversal edits',()=>{
 for(const f of ['supabase/migrations/a.sql','scripts/ci/run-local-db.sh','package.json','src/a.ts','scripts/stage3/../../a','README.md'])
 assert.throws(()=>verifyChanges([f]));
 verifyChanges(['scripts/stage3/run-local-db.sh','tests/stage3/moderation_compatibility.test.sql','.github/workflows/stage3-pg17-compat.yml']);
});
const observations=['goods','cars','two-wheelers','property'].map(name=>({case:name,sqlstate:'00000',
 request_status:'completed',listing_status:name==='goods'?'active':'pending_review',
 attempt_count:1,results:1,revision_matches:true,lease_retained:true}));
const goodTap=()=>['1..'+assertions,...Array.from({length:assertions},(_,i)=>'ok '+(i+1)+' - synthetic parser fixture'),
 ...observations.map(o=>'# STAGE3 '+JSON.stringify(o))].join('\n')+'\n';
test('strict TAP accepts complete synthetic parser input',()=>assert.equal(verifyTap(goodTap(),0).passed,true));
for(const [label,alter,status] of [
 ['failed assertion',x=>x.replace('ok 1 ','not ok 1 '),0],
 ['skip',x=>x.replace('ok 1 -','ok 1 # SKIP'),0],
 ['todo',x=>x.replace('ok 1 -','ok 1 # TODO'),0],
 ['wrong plan',x=>x.replace('1..74','1..71'),0],
 ['missing assertion',x=>x.replace(/^ok 2 .*?\n/m,''),0],
 ['duplicate assertion number',x=>x.replace('ok 2 ','ok 1 '),0],
 ['missing observations',x=>x.replace(/^# STAGE3 .*\n/m,''),0],
 ['SQL error',x=>x+'ERROR: synthetic\n',0],
 ['nonzero SQL process',x=>x,1]]) {
 test('TAP rejects '+label,()=>assert.throws(()=>verifyTap(alter(goodTap()),status)));
}
test('reproduction observations never turn not-ok into pass',()=>{
 const result=inspectTap(goodTap().replace('ok 1 ','not ok 1 '),0);
 assert.equal(result.passed,false);assert.deepEqual(result.failed,[1]);
});
test('arbitrary diagnostic fields are rejected',()=>assert.throws(()=>inspectTap(goodTap().replace('"sqlstate":"00000"','"sqlstate":"00000","private":"withheld"'),0)));
const security=()=>{
 const s=JSON.parse(read('docs/extraction/evidence/stage2b/r6/result.json')).security;
 s.postgresVersion='17.6';s.version_num=170006;s.migration_versions=expectedMigrationVersions();
 s.vault_count=0;s.moderation_automation_enabled='false';
 s.checks.rls=structuredClone(expectedRls);s.checks.column_dml=structuredClone(expectedColumnDml);
 s.checks.runtime_settings=s.checks.runtime_settings.filter(r=>['cron.database_name','cron.host','cron.launch_active_jobs'].includes(r.name)).map(r=>r.name==='cron.launch_active_jobs'?{...r,setting:'off'}:r);
 return s;
};
test('PG17 security validator accepts exact synthetic security input',()=>verifySecurity(security()));
for(const [label,alter] of [
 ['PG15',s=>{s.postgresVersion='15.8';s.version_num=150008}],
 ['other PG17 patch',s=>s.version_num=170007],
 ['nonempty Vault',s=>s.vault_count=1],
 ['enabled moderation after rollback',s=>s.moderation_automation_enabled='true'],
 ['dispatch queue',s=>s.httpRequests=1],
 ['missing migration',s=>s.migration_versions.pop()],
 ['weakened RLS',s=>s.checks.rls[0].relrowsecurity=false],
 ['extra mutation grant',s=>s.checks.column_dml[0].authenticated_table_update=true],
 ['extension drift',s=>s.checks.extensions.pg_net='unapproved'],
 ['cron enabled',s=>s.checks.runtime_settings.find(r=>r.name==='cron.launch_active_jobs').setting='on']]) {
 test('security rejects '+label,()=>{const s=security();alter(s);assert.throws(()=>verifySecurity(s))});
}
test('SQL fixed assertion contract and no guard bypass',()=>{
 assert.match(sql,/SELECT plan\(74\)/);
 assert.equal((sql.match(/^SELECT ok\(/gm)||[]).length,assertions);
 assert.equal(requiredSuites['moderation_compatibility.test.sql'],assertions);
 assert.equal(Object.values(requiredSuites).reduce((a,b)=>a+b,0),344);
 assert.match(sql,/ROLLBACK;\s*$/);
 assert.doesNotMatch(sql,/\b(?:DISABLE\s+TRIGGER|session_replication_role|INSERT\s+INTO\s+app_security\.test_submission_permits|CREATE\s+OR\s+REPLACE)\b/i);
 for(const fn of ['save_car_draft','save_two_wheeler_draft','save_property_draft','seller_submit_listing','claim_moderation_batch','impl_finalize_moderation_result'])
 assert.ok(sql.includes('public.'+fn));
});
test('workflow and pins retain isolated PR-only boundaries',()=>{
 assert.match(workflow,/pull_request:/);assert.doesNotMatch(workflow,/pull_request_target|workflow_dispatch|secrets\.|SUPABASE_ACCESS_TOKEN/);
 assert.match(workflow,/contents: read/);assert.match(workflow,/persist-credentials: false/);
 assert.match(workflow,/ubuntu-24\.04/);
 assert.ok(workflow.indexOf('node scripts/stage3/verify-source.mjs')<workflow.indexOf('bash scripts/stage3/run-local-db.sh'));
 for(const match of workflow.matchAll(/uses:\s+(\S+)/g))assert.match(match[1],/@[a-f0-9]{40}$/);
 assert.equal(pins.database.serverVersionNum,170006);assert.equal(pins.database.cliVersion,'2.117.0');
 assert.ok(runner.includes(pins.database.images.postgres.digest));assert.ok(runner.includes(pins.database.postgresChildDigest));
});
test('runner preserves critical host isolation and independent checks',()=>{
 for(const text of ['ip6tables -w -C FORWARD -j DOCKER-USER','iptables -w -C FORWARD -j DOCKER-USER',
 'verify_host_firewall','nativeNamespace','ipv4Denied','ipv6Denied','loopbackOnly','--pull never','--ignore-scripts',
 'scripts/stage3/assert-local-security.sql','scripts/stage3/verify-db-results.mjs']) {
  if(text==='--ignore-scripts')assert.ok(workflow.includes(text));else assert.ok(runner.includes(text),text);
 }
 assert.match(runner,/major_version = 17/);
 assert.ok(runner.indexOf('check_isolation "$raw/isolation-before.json"')<runner.indexOf('cli_local migration up --local'));
 assert.doesNotMatch(runner,/scripts\/ci\/(?:run-local-db\.sh|verify-db-results\.mjs|toolchain\.json|assert-local-security\.sql)/);
});
test('incomplete evidence is sanitized and cannot pass',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-validator-'));
 try {
  assert.equal(collectEvidence(path.join(dir,'missing'),path.join(dir,'out')),false);
  assert.deepEqual(readdirSync(path.join(dir,'out')).sort(),['SHA256SUMS','result.json','suite-results.json']);
  const report=JSON.parse(readFileSync(path.join(dir,'out/result.json'),'utf8'));
  assert.equal(report.success,false);assert.equal(report.compatibility.executed,false);
  assert.ok(!JSON.stringify(report).includes(dir));
 } finally {rmSync(dir,{recursive:true,force:true})}
});

test('failed-run evidence preserves only validated compatibility observations',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-validator-'));
 try {
  const raw=path.join(dir,'raw');mkdirSync(raw);
  writeFileSync(path.join(raw,'moderation_compatibility.test.sql.log'),goodTap().replace('ok 1 ','not ok 1 '));
  writeFileSync(path.join(raw,'moderation_compatibility.test.sql.exit'),'1\n');
  assert.equal(collectEvidence(raw,path.join(dir,'out')),false);
  const report=JSON.parse(readFileSync(path.join(dir,'out/result.json'),'utf8'));
  assert.equal(report.success,false);assert.equal(report.compatibility.passed,false);
  assert.deepEqual(report.compatibility.failed,[1]);
  assert.equal(report.compatibility.observations.length,4);
  assert.ok(!JSON.stringify(report).includes('synthetic parser fixture'));
 } finally {rmSync(dir,{recursive:true,force:true})}
});
