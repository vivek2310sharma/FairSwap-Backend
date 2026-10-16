// Static/regression checks only. Synthetic validator inputs are not runtime evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,readdirSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {manifestSha256} from '../ci/verify-baseline.mjs';
import {verifyEvent,verifyChanges,base} from './verify-source.mjs';
import {inspectTap,verifyTap,assertions} from './parse-compatibility.mjs';
import {verifySecurity,expectedRls,expectedColumnDml,expectedMigrationVersions,requiredSuites,collectEvidence,verifyDbResults,isolationKeys,cleanupKeys,imageDiagnosticStages,diagnosticStages,diagnosticCategories,sanitizeDiagnostic,invalidateCleanupEvidence} from './verify-db-results.mjs';
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

// Step 1E synthetic diagnostic fixtures only: no Docker, registry or database calls.
const unknownDiagnostic={stage:'unclassified',category:'unclassified'};
function collectDiagnostic(diagnostic,{malformed=false,cleanup=true}={}){
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-diagnostic-'));
 try{
  const raw=path.join(dir,'raw'),out=path.join(dir,'out');mkdirSync(raw);
  writeFileSync(path.join(raw,'diagnostic.json'),malformed?'not-json':JSON.stringify(diagnostic));
  writeFileSync(path.join(raw,'runner.log'),'synthetic-private-message /private/operator/.env token=fixture-not-a-real-secret');
  writeFileSync(path.join(raw,'execution.json'),'{"exitCode":1}');
  if(cleanup)writeFileSync(path.join(raw,'cleanup.json'),JSON.stringify(Object.fromEntries(cleanupKeys.map(k=>[k,true]))));
  assert.equal(collectEvidence(raw,out),false);
  const text=readFileSync(path.join(out,'result.json'),'utf8'),r=JSON.parse(text);
  assert.equal(r.success,false);
  for(const secret of [dir,'synthetic-private-message','fixture-not-a-real-secret'])assert.ok(!text.includes(secret));
  return r;
 }finally{rmSync(dir,{recursive:true,force:true})}
}
for(const stage of imageDiagnosticStages)test('retain safe image stage: '+stage,()=>{
 const d={stage,category:'image-pull-failed'};
 assert.deepEqual(sanitizeDiagnostic(d),d);
 assert.deepEqual(collectDiagnostic(d).diagnostic,d);
 const candidate=successfulContract();candidate.diagnostic=d;assert.throws(()=>verifyDbResults(candidate));
});
for(const [name,value] of [
 ['missing',undefined],['null',null],['array',[]],['string','synthetic-private-message'],
 ['missing category',{stage:'image-postgres-index-fetch'}],
 ['stage type',{stage:1,category:'none'}],
 ['category type',{stage:'image-postgres-index-fetch',category:{token:'fixture-not-a-real-secret'}}],
 ['unknown prefix',{stage:'image-postgres-synthetic-private-message',category:'none'}],
 ['newline stage',{stage:'image-postgres-index-fetch\nsynthetic-private-message',category:'none'}],
 ['unknown category',{stage:'image-postgres-index-fetch',category:'synthetic-private-message'}],
 ['extra raw text',{stage:'image-postgres-index-fetch',category:'registry-denied',raw:'fixture-not-a-real-secret'}],
 ['former wildcard category',{stage:'security-before',category:'security-rls-listings-synthetic-private-message'}],
 ['extra env',{stage:'image-postgres-index-fetch',category:'registry-denied',env:{TOKEN:'fixture-not-a-real-secret'}}],
])test('reject diagnostic '+name,()=>{
 assert.deepEqual(sanitizeDiagnostic(value),unknownDiagnostic);
 assert.deepEqual(collectDiagnostic(value===undefined?{}:value).diagnostic,unknownDiagnostic);
});
test('reject malformed diagnostic JSON without raw text',()=>assert.deepEqual(collectDiagnostic(null,{malformed:true}).diagnostic,unknownDiagnostic));
test('every category is an exact finite enum',()=>{
 assert.equal(new Set(diagnosticCategories).size,diagnosticCategories.length);
 for(const category of diagnosticCategories)assert.deepEqual(sanitizeDiagnostic({stage:'image-postgres-index-fetch',category}),{stage:'image-postgres-index-fetch',category});
 for(const x of [...diagnosticStages,...diagnosticCategories])assert.match(x,/^[A-Za-z0-9_-]+$/);
});
test('Bash and collector enums agree exactly; all 89 image stages are used',()=>{
 const stages=runner.match(/case \$\{failure_stage:-unclassified\} in\n\s+([^\n]+) \) ;;/);
 const categories=runner.match(/case \$\{failure_category:-none\} in\n\s+([^\n]+) \) ;;/);
 assert.ok(stages&&categories);
 assert.deepEqual(stages[1].split('|').sort(),[...diagnosticStages].sort());
 assert.deepEqual(categories[1].split('|').sort(),[...diagnosticCategories].sort());
 const used=new Set();
 for(const m of runner.matchAll(/^\s*image_phase (?:"([^"]+)"|(\S+)) (\S+)$/gm)){
  const stage=m[1]??m[2];assert.ok(diagnosticCategories.includes(m[3]));
  for(const s of stage.includes('$key')?['postgres','pgProve','authBootstrap','storageBootstrap','realtimeBootstrap'].map(role=>stage.replace('$key',role)):[stage]){
   assert.ok(imageDiagnosticStages.includes(s),s);used.add(s);
  }
 }
 assert.deepEqual([...used].sort(),[...imageDiagnosticStages].sort());
 assert.ok(runner.includes('done <"$raw/image-pins.tsv"'));
 assert.ok(runner.includes('--cleanup-failed "$evidence" "$failure_stage" "$failure_category"'));
});
test('formerly grouped initial commands have distinct preceding stages',()=>{
 const checks=[
 ['image-postgres-buildx-check','docker buildx version'],
 ['image-postgres-index-fetch','if ! docker buildx imagetools inspect --raw "$pg_repository@$pg_index"'],
 ['image-postgres-index-digest','"'+ '$'+'{pg_index#sha256:}" "$raw/pg17-index.json" | sha256sum -c -'],
 ['image-postgres-amd64-descriptor','node --input-type=module - "$raw/pg17-index.json" "$pg_child"'],
 ['image-postgres-child-fetch','if ! docker buildx imagetools inspect --raw "$pg_repository@$pg_child"'],
 ['image-postgres-child-digest','"'+ '$'+'{pg_child#sha256:}" "$raw/pg17-child.json" | sha256sum -c -'],
 ['image-postgres-child-pull','if ! docker pull --platform linux/amd64 "$pg_repository@$pg_child"'],
 ['image-postgres-child-id-inspect',"pg_child_id=$(docker image inspect -f '{{.Id}}'"],
 ];let previous=-1;
 for(const [stage,cmd] of checks){const marker=runner.indexOf('image_phase '+stage+' '),operation=runner.indexOf(cmd,marker);assert.ok(marker>previous&&operation>marker);previous=operation}
});
function successfulContract(){
 return {schemaVersion:1,success:true,executionExit:0,diagnostic:{stage:'complete',category:'none'},
 compatibility:verifyTap(goodTap(),0),manifestSha256,manifestVerifiedBeforeAndAfter:true,
 tools:{nodeVersion:pins.node,cliVersion:pins.database.cliVersion,os:'linux',arch:'amd64',dockerVersion:'29.0.0'},
 images:Object.fromEntries(Object.entries(pins.database.images).map(([k,p])=>[k,{...p,platform:'linux/amd64',imageId:'sha256:'+'a'.repeat(64)}])),
 isolationBefore:Object.fromEntries(isolationKeys.map(k=>[k,true])),isolationAfter:Object.fromEntries(isolationKeys.map(k=>[k,true])),
 cleanup:Object.fromEntries(cleanupKeys.map(k=>[k,true])),
 suites:Object.entries(requiredSuites).map(([file,assertions])=>({file,assertions,failedAssertions:0,exitCode:0,result:'PASS'})),
 securityBefore:security(),securityAfter:security()};
}
test('complete synthetic success still passes original contract',()=>assert.equal(verifyDbResults(successfulContract()),true));
for(const [name,alter] of [
 ['image failure',r=>r.diagnostic={stage:'image-postgres-index-digest',category:'digest-check-failed'}],
 ['image stage with none',r=>r.diagnostic={stage:'image-postgres-index-fetch',category:'none'}],
 ['unknown stage',r=>r.diagnostic=unknownDiagnostic],['missing diagnostic',r=>delete r.diagnostic],
 ['extra raw diagnostic',r=>r.diagnostic.raw='fixture-not-a-real-secret'],
 ['nonzero execution',r=>r.executionExit=1],['false success',r=>r.success=false],
 ['wrong manifest',r=>r.manifestSha256='0'.repeat(64)],['missing byte proof',r=>r.manifestVerifiedBeforeAndAfter=false],
 ['changed pin',r=>r.images.postgres.digest='sha256:'+'0'.repeat(64)],
 ['wrong Node',r=>r.tools.nodeVersion='24.0.0'],['wrong CLI',r=>r.tools.cliVersion='2.0.0'],
 ['insufficient Docker',r=>r.tools.dockerVersion='27.0.0'],
 ['missing v6 isolation',r=>r.isolationBefore.ipv6Denied=false],['post firewall failure',r=>r.isolationAfter.firewallIsolated=false],
 ['cleanup failed',r=>r.cleanup.firewallRemoved=false],['cleanup missing',r=>delete r.cleanup.portClosed],
 ['missing suite',r=>r.suites.pop()],['wrong SQL count',r=>r.suites[0].assertions=73],
 ['suite nonzero exit',r=>r.suites[0].exitCode=1],['compatibility failed',r=>r.compatibility.passed=false],
 ['wrong PG patch',r=>r.securityBefore.version_num=170007],['nonempty Vault',r=>r.securityAfter.vault_count=1],
 ['moderation enabled',r=>r.securityAfter.moderation_automation_enabled='true'],
 ['changed ledger',r=>r.securityAfter.migration_versions.pop()],
])test('success remains strict: '+name,()=>{const r=successfulContract();alter(r);assert.throws(()=>verifyDbResults(r))});
test('missing cleanup evidence cannot pass',()=>{
 const r=collectDiagnostic({stage:'image-postgres-index-fetch',category:'registry-denied'},{cleanup:false});
 assert.equal(r.success,false);assert.equal(r.cleanup,'UNVERIFIED');
});
test('late cleanup failure invalidates success and preserves safe stage',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-cleanup-'));
 try{
  writeFileSync(path.join(dir,'result.json'),JSON.stringify(successfulContract()));
  const d={stage:'image-postgres-child-pull',category:'transport-error'};
  assert.equal(invalidateCleanupEvidence(dir,d),false);
  const r=JSON.parse(readFileSync(path.join(dir,'result.json'),'utf8'));
  assert.equal(r.success,false);assert.equal(r.cleanup,'FAILED');assert.deepEqual(r.diagnostic,d);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir,'suite-results.json'),'utf8')),[]);
  assert.throws(()=>verifyDbResults(r));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('cleanup invalidation CLI remains a nonzero sanitized failure',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-cleanup-cli-'));
 try{
  let failure;try{execFileSync(process.execPath,[fileURLToPath(new URL('./verify-db-results.mjs',import.meta.url)),'--cleanup-failed',dir,'image-postgres-child-pull','image-pull-failed'],{encoding:'utf8',stdio:'pipe'})}catch(e){failure=e}
  assert.ok(failure);assert.equal(failure.status,1);
  assert.match(failure.stderr,/^FAIL: database CI evidence missing, unsafe, incomplete or outside the approved contract\s*$/);
  assert.equal(JSON.parse(readFileSync(path.join(dir,'result.json'),'utf8')).cleanup,'FAILED');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('runner initializes safe diagnostic defaults before any failing preflight command',()=>{
 assert.ok(runner.includes('failure_stage=preflight\nfailure_category=none\n'));
 assert.ok(runner.includes('failure_stage=$'+'{failure_stage:-unclassified}'));
 assert.ok(runner.includes('failure_category=$'+'{failure_category:-none}'));
 assert.ok(runner.indexOf('failure_category=none')<runner.indexOf('trap cleanup EXIT'));
});
test('image diagnostic CLI cannot produce success or print raw diagnostics',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-image-cli-'));
 try{
  const raw=path.join(dir,'raw'),out=path.join(dir,'out');mkdirSync(raw);
  writeFileSync(path.join(raw,'diagnostic.json'),JSON.stringify({stage:'image-postgres-index-fetch',category:'registry-denied'}));
  writeFileSync(path.join(raw,'execution.json'),'{"exitCode":1}');
  writeFileSync(path.join(raw,'runner.log'),'fixture-not-a-real-secret /private/operator/.env');
  let error;try{execFileSync(process.execPath,[fileURLToPath(new URL('./verify-db-results.mjs',import.meta.url)),'--collect',raw,out],{encoding:'utf8',stdio:'pipe'})}catch(e){error=e}
  assert.ok(error);assert.equal(error.status,1);
  assert.ok(!error.stderr.includes(dir)&&!error.stderr.includes('fixture-not-a-real-secret'));
  assert.equal(JSON.parse(readFileSync(path.join(out,'result.json'),'utf8')).success,false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
