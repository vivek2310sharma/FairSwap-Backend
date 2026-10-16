import {createHash} from 'node:crypto';
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
 ['image-postgres-index-fetch','registry_fetch "$raw/pg17-index.json"'],
 ['image-postgres-index-digest','"'+ '$'+'{pg_index#sha256:}" "$raw/pg17-index.json" | sha256sum -c -'],
 ['image-postgres-amd64-descriptor','node --input-type=module - "$raw/pg17-index.json" "$pg_child"'],
 ['image-postgres-child-fetch','registry_fetch "$raw/pg17-child.json"'],
 ['image-postgres-child-digest','"'+ '$'+'{pg_child#sha256:}" "$raw/pg17-child.json" | sha256sum -c -'],
 ['image-postgres-child-pull','registry_fetch "$raw/pg17-child-pull.stdout"'],
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

(function retrySpecs(){
const helperMatch=runner.match(/# BEGIN bounded registry retry helpers\n([\s\S]*?)# END bounded registry retry helpers/);
assert.ok(helperMatch);
const registryHelpers=helperMatch[1];
const q=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
const pinnedRef='public.ecr.aws/supabase/postgres@'+pins.database.images.postgres.digest;
const childRef='public.ecr.aws/supabase/postgres@'+pins.database.postgresChildDigest;
function mockedFetch(responses,{pull=false,operations=1,ref=pinnedRef,expectedDigest=null,afterAttempt=false}={}){
 assert.doesNotMatch(registryHelpers,/\bcommand\s+docker\b|\/(?:usr|bin)\/[^\s]*docker/);
 const responseCases=responses.map((r,i)=>`${i+1}) printf '%s' ${q(r.output??'synthetic immutable manifest')}; printf '%s\\n' ${q(r.error??'')} >&2; return ${r.code??0} ;;`);
 const argv=pull?['docker','pull','--platform','linux/amd64',ref]:['docker','buildx','imagetools','inspect','--raw',ref];
 const program=[
 'set -euo pipefail','umask 077',registryHelpers,
 'raw=$(mktemp -d /tmp/fairswap-registry-mock.XXXXXXXX)',
 'trap \'[[ $raw == /tmp/fairswap-registry-mock.* ]] && rm -rf -- "$raw"\' EXIT',
 'calls=0; failure_stage=image-postgres-index-fetch; failure_category=manifest-retrieval-failed',
 ': >"$raw/args"; : >"$raw/sleeps"; : >"$raw/events"',
 'docker() {',
 ' calls=$((calls+1)); printf "CALL:%s\\n" "$calls" >>"$raw/args"',
 ' printf "ARG:%s\\n" "$@" >>"$raw/args"',
 ' case "$calls" in',...responseCases,
 ' *) printf "synthetic unexpected call\\n" >&2; return 1 ;;',
 ' esac','}',
 'sleep() { printf "%s\\n" "$1" >>"$raw/sleeps"; }',
 'readonly -f docker sleep',
 'status=0',
 ...Array.from({length:operations},(_,i)=>`if [[ $status == 0 ]]; then registry_fetch "$raw/out-${i}" "$raw/fetch-${i}" ${pull?'image-pull-failed':'manifest-retrieval-failed'} ${argv.map(q).join(' ')} || status=$?; fi`),
 ...(expectedDigest?[`if [[ $status == 0 ]]; then if ! printf '%s  %s\\n' ${q(expectedDigest)} "$raw/out-0" | sha256sum -c - >"$raw/digest-check" 2>&1; then status=1; failure_category=digest-check-failed; fi; fi`]:[]),
 'if [[ $status == 0 ]]; then printf "digest-and-security-sentinel\\n" >>"$raw/events"; fi',
 'printf "STATUS:%s\\nCATEGORY:%s\\nCALLS:%s\\n" "$status" "$failure_category" "$calls"',
 'while IFS= read -r delay; do printf "WAIT:%s\\n" "$delay"; done <"$raw/sleeps"',
 'cat "$raw/args"',
 'printf "ATTEMPT_FILES:%s\\n" "$(find "$raw" -type f -name \'*attempt-*\' | wc -l)"',
 'printf "SECURITY:%s\\n" "$(wc -l <"$raw/events")"',
 'if [[ -f $raw/out-0 ]]; then printf "OUTPUT_SHA:%s\\n" "$(sha256sum "$raw/out-0" | cut -d \' \' -f 1)"; fi',
 'exit 0',
 ].join('\n')+'\n';
 const win=process.platform==='win32';
 const command=win?'wsl.exe':'bash';
 const args=win?['-d','Ubuntu','--exec','/bin/bash','--noprofile','--norc','-euo','pipefail','-s']:['--noprofile','--norc','-euo','pipefail','-s'];
 const output=execFileSync(command,args,{input:program,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:20000});
 const first=key=>output.match(new RegExp('^'+key+':([^\\r\\n]+)$','m'))?.[1];
 const calls=[];
 for(const line of output.split(/\r?\n/)){
  if(line.startsWith('CALL:'))calls.push([]);
  else if(line.startsWith('ARG:'))calls.at(-1).push(line.slice(4));
 }
 return {status:Number(first('STATUS')),category:first('CATEGORY'),count:Number(first('CALLS')),
 waits:[...output.matchAll(/^WAIT:(\d+)$/gm)].map(m=>Number(m[1])),
 attemptFiles:Number(first('ATTEMPT_FILES')),security:Number(first('SECURITY')),
 outputSha:first('OUTPUT_SHA'),argv:calls};
}
const throttled={code:1,error:'HTTP/1.1 429 Too Many Requests; fixture-not-a-real-secret'};
test('retry: throttling followed by success keeps immutable argv and bytes',()=>{
 const r=mockedFetch([throttled,{output:'exact successful manifest bytes'}]);
 assert.equal(r.status,0);assert.equal(r.category,'none');assert.equal(r.count,2);
 assert.equal(r.waits.length,1);assert.ok(r.waits[0]>=10&&r.waits[0]<=20);
 assert.deepEqual(r.argv[0],r.argv[1]);assert.equal(r.argv[0].at(-1),pinnedRef);
 assert.equal(r.outputSha,createHash('sha256').update('exact successful manifest bytes').digest('hex'));
 assert.equal(r.attemptFiles,4);assert.equal(r.security,1);
});
test('retry: all three throttled attempts fail with existing safe diagnostic',()=>{
 const r=mockedFetch([throttled,throttled,throttled]);
 assert.equal(r.status,1);assert.equal(r.category,'rate-limited');assert.equal(r.count,3);
 assert.equal(r.waits.length,2);assert.ok(r.waits[0]>=10&&r.waits[0]<=20);assert.ok(r.waits[1]>=30&&r.waits[1]<=50);
 assert.ok(r.waits.reduce((a,b)=>a+b,0)<=70);assert.equal(r.attemptFiles,6);assert.equal(r.security,0);
 assert.deepEqual(r.argv[0],r.argv[1]);assert.deepEqual(r.argv[1],r.argv[2]);
 const artifact=collectDiagnostic({stage:'image-postgres-index-fetch',category:r.category});
 assert.equal(artifact.success,false);assert.deepEqual(artifact.diagnostic,{stage:'image-postgres-index-fetch',category:'rate-limited'});
 assert.ok(!JSON.stringify(artifact).includes(throttled.error));
});
test('retry: two throttles then success stops exactly at attempt three',()=>{
 const r=mockedFetch([throttled,throttled,{}],{pull:true,ref:childRef});
 assert.equal(r.status,0);assert.equal(r.count,3);assert.equal(r.security,1);
 assert.ok(r.argv.every(a=>JSON.stringify(a)===JSON.stringify(r.argv[0])));
 assert.deepEqual(r.argv[0],['pull','--platform','linux/amd64',childRef]);
});
for(const [name,error,category] of [
 ['unauthorized','HTTP/1.1 401 Unauthorized; rate limit exceeded','registry-denied'],
 ['forbidden','HTTP/1.1 403 Forbidden; TooManyRequests','registry-denied'],
 ['unknown manifest','manifest unknown; HTTP 429 Too Many Requests','manifest-not-found'],
 ['digest mismatch','manifest digest mismatch; TooManyRequests','digest-check-failed'],
 ['malformed manifest','malformed manifest; rate limit exceeded','descriptor-check-failed'],
 ['malformed JSON','invalid JSON manifest; HTTP 429 Too Many Requests','descriptor-check-failed'],
 ['unsupported platform','no matching manifest for platform; TooManyRequests','unsupported-manifest'],
 ['unsupported media type','unsupported media type; HTTP 429 Too Many Requests','unsupported-manifest'],
 ['storage','no space left on device; HTTP 429 Too Many Requests','storage-error'],
 ['transport','connection refused','transport-error'],
 ['ambiguous mention','generic error with rate limit documentation','manifest-retrieval-failed'],
 ['unrelated number','synthetic error sha256:a429b','manifest-retrieval-failed'],
 ['arbitrary error','fixture-not-a-real-secret','manifest-retrieval-failed'],
])test('retry: immediate fatal/non-throttle failure: '+name,()=>{
 const r=mockedFetch([{code:1,error}]);
 assert.equal(r.status,1);assert.equal(r.category,category);assert.equal(r.count,1);assert.deepEqual(r.waits,[]);assert.equal(r.security,0);
});
test('retry: a fatal response after throttling stops before attempt three',()=>{
 const r=mockedFetch([throttled,{code:1,error:'401 unauthorized'}]);
 assert.equal(r.status,1);assert.equal(r.category,'registry-denied');assert.equal(r.count,2);assert.equal(r.waits.length,1);
});
test('retry: a successful request followed by a digest mismatch never fetches again',()=>{
 const r=mockedFetch([{output:'wrong manifest bytes'}],{expectedDigest:'0'.repeat(64)});
 assert.equal(r.status,1);assert.equal(r.category,'digest-check-failed');assert.equal(r.count,1);assert.deepEqual(r.waits,[]);assert.equal(r.security,0);
});
test('retry: mutable/invalid references are rejected before commands or waiting',()=>{
 for(const ref of ['public.ecr.aws/supabase/postgres:latest','public.ecr.aws/supabase/postgres@sha256:bad']){
  const r=mockedFetch([],{ref});assert.equal(r.status,1);assert.equal(r.category,'pin-check-failed');assert.equal(r.count,0);assert.deepEqual(r.waits,[]);
 }
});
test('retry: separate task-controlled registry operations are paced',()=>{
 const r=mockedFetch([{},{}],{operations:2});
 assert.equal(r.status,0);assert.equal(r.count,2);assert.deepEqual(r.waits,[5]);assert.equal(r.security,1);
});
test('retry: untrusted Retry-After text cannot expand waits',()=>{
 const r=mockedFetch([{code:1,error:'HTTP 429 Too Many Requests; Retry-After: 99999999'},{}]);
 assert.equal(r.status,0);assert.equal(r.count,2);assert.ok(r.waits[0]>=10&&r.waits[0]<=20);
});
test('retry: zero delays on first successful operation; no retry cache or tag fallback',()=>{
 const r=mockedFetch([{}]);assert.equal(r.count,1);assert.deepEqual(r.waits,[]);assert.equal(r.category,'none');
 assert.ok(registryHelpers.includes('local -ar command_args=("$@")'));
 assert.doesNotMatch(registryHelpers,/docker\s+(?:login|start|run)|\bcurl\b|Retry-After.*parse/);
 assert.equal((runner.match(/^\s*registry_fetch "\$raw\/|^\s*registry_fetch "\$pull_log/gm)||[]).length,4);
});
})();

test('retry: network/security/SQL code outside reviewed startup remains byte-for-byte unchanged',()=>{
 const prefix=runner.slice(runner.indexOf('failure_stage=network-setup\n'),runner.indexOf('# BEGIN granular startup diagnostics'));
 const suffix=runner.slice(runner.indexOf('# Defense in depth: remove default routes'));
 assert.equal(createHash('sha256').update(prefix).digest('hex'),'e729b5256627690c83dbd4bfded228feb003b601a57258f106716e066db78a24');
 assert.equal(createHash('sha256').update(suffix).digest('hex'),'9de9aadab1868bcdcce3dda1f96e74f07063a6b7e86270bd624a29215f071cec');
});

(function startupSpecs(){
const startupStages=['db-start-cli','db-start-version-num-query','db-start-version-num-verify','db-start-version-text-query','db-start-version-text-verify','db-start-cron-alter','db-start-cron-reload','db-start-cron-confirm','db-start-pgtap-extension'];
const match=runner.match(/# BEGIN granular startup diagnostics\n([\s\S]*?)# END granular startup diagnostics/);
assert.ok(match);
const startupBlock=match[1],q=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function mockStartup(fail='',{cronMismatch=false,queryOutputOnFailure=false}={}){
const program=[
'set -euo pipefail','umask 077',
'raw=$(mktemp -d /tmp/fairswap-startup-mock.XXXXXXXX)',
'trap \'[[ $raw == /tmp/fairswap-startup-mock.* ]] && rm -rf -- "$raw"\' EXIT',
'db=synthetic-task-db; fail='+q(fail),
'cron_mismatch='+Number(cronMismatch)+'; output_on_failure='+Number(queryOutputOnFailure),
': >"$raw/calls"; : >"$raw/sleeps"; : >"$raw/next"',
'cli_local() { printf "CALL:%s\\n" "$failure_stage" >>"$raw/calls"; printf "fixture-not-a-real-secret\\n"; printf "synthetic-private-message\\n" >&2; [[ $fail != db-start-cli ]]; }',
'docker() {',
' [[ $1 == exec && $2 == "$db" && $3 == psql ]] || return 1',
' printf "CALL:%s\\n" "$failure_stage" >>"$raw/calls"',
' if [[ $fail == "$failure_stage" ]]; then',
'   if [[ $output_on_failure == 1 ]]; then',
'     case "$failure_stage" in db-start-version-num-query) printf "170006\\n" ;; db-start-version-text-query) printf "17.6\\n" ;; db-start-cron-confirm) printf "off\\n" ;; *) printf "fixture-not-a-real-secret\\n" ;; esac',
'   else printf "fixture-not-a-real-secret\\n"; fi',
'   printf "synthetic-private-message\\n" >&2; return 1',
' fi',
' case "$failure_stage" in',
' db-start-version-num-query) if [[ $fail == db-start-version-num-verify ]]; then printf "170007\\n"; else printf "170006\\n"; fi ;;',
' db-start-version-text-query) if [[ $fail == db-start-version-text-verify ]]; then printf "17.7\\n"; else printf "17.6\\n"; fi ;;',
' db-start-cron-confirm) if [[ $cron_mismatch == 1 ]]; then printf "on\\n"; else printf "off\\n"; fi ;;',
' *) printf "fixture-not-a-real-secret\\n"; printf "synthetic-private-message\\n" >&2 ;;',
' esac','}',
'sleep() { printf "%s\\n" "$1" >>"$raw/sleeps"; }',
'readonly -f cli_local docker sleep',
'set +e','(',
'set -e',
'trap \'code=$?; printf "STATUS:%s\\nSTAGE:%s\\nCATEGORY:%s\\n" "$code" "$failure_stage" "$failure_category" >"$raw/state"; exit "$code"\' EXIT',
startupBlock,
'printf "SECURITY-CONTINUES\\n" >>"$raw/next"',
') >"$raw/console" 2>&1',
'code=$?','set -e',
'cat "$raw/state" "$raw/calls"',
'printf "NEXT:%s\\n" "$(wc -l <"$raw/next")"',
'printf "SLEEPS:%s\\n" "$(wc -l <"$raw/sleeps")"',
'if [[ -s $raw/console ]]; then printf "CONSOLE_LEAK:1\\n"; else printf "CONSOLE_LEAK:0\\n"; fi',
'if grep -Rlq "fixture-not-a-real-secret" "$raw"; then printf "PRIVATE:1\\n"; else printf "PRIVATE:0\\n"; fi',
].join('\n')+'\n';
const win=process.platform==='win32',command=win?'wsl.exe':'bash';
const args=win?['-d','Ubuntu','--exec','/bin/bash','--noprofile','--norc','-euo','pipefail','-s']:['--noprofile','--norc','-euo','pipefail','-s'];
const output=execFileSync(command,args,{input:program,encoding:'utf8',stdio:'pipe',timeout:20000});
assert.doesNotMatch(output,/fixture-not-a-real-secret|synthetic-private-message/);
const field=k=>output.match(new RegExp('^'+k+':([^\\r\\n]+)$','m'))?.[1];
return {status:Number(field('STATUS')),stage:field('STAGE'),category:field('CATEGORY'),next:Number(field('NEXT')),sleeps:Number(field('SLEEPS')),leak:Number(field('CONSOLE_LEAK')),private:Number(field('PRIVATE')),calls:[...output.matchAll(/^CALL:(.+)$/gm)].map(m=>m[1])};
}
for(const stage of startupStages)test('startup: mocked failure retains precise safe phase '+stage,()=>{
const r=mockStartup(stage),category=stage.endsWith('-verify')?'db-start-version-mismatch':'db-start-command-failed';
assert.notEqual(r.status,0);assert.equal(r.stage,stage);assert.equal(r.category,category);assert.equal(r.next,0);assert.equal(r.leak,0);assert.equal(r.private,1);
const d={stage,category};assert.deepEqual(sanitizeDiagnostic(d),d);const artifact=collectDiagnostic(d);assert.deepEqual(artifact.diagnostic,d);assert.equal(artifact.success,false);
const success=successfulContract();success.diagnostic=d;assert.throws(()=>verifyDbResults(success));
if(stage==='db-start-cron-confirm'){assert.equal(r.calls.filter(s=>s===stage).length,5);assert.equal(r.sleeps,5)}
});
test('startup: successful diagnostics preserve command order and resume security checks',()=>{
const r=mockStartup();assert.equal(r.status,0);assert.equal(r.next,1);assert.equal(r.leak,0);assert.equal(r.category,'none');assert.equal(r.sleeps,0);
assert.deepEqual(r.calls,['db-start-cli','db-start-version-num-query','db-start-version-text-query','db-start-cron-alter','db-start-cron-reload','db-start-cron-confirm','db-start-pgtap-extension']);
});
test('startup: disabled Cron is mandatory after the unchanged five confirmation attempts',()=>{
const r=mockStartup('',{cronMismatch:true});assert.notEqual(r.status,0);assert.equal(r.stage,'db-start-cron-confirm');assert.equal(r.category,'db-start-cron-not-disabled');assert.equal(r.next,0);assert.equal(r.sleeps,5);assert.equal(r.leak,0);
});
for(const stage of ['db-start-version-num-query','db-start-version-text-query','db-start-cron-confirm'])test('startup: valid-looking stdout cannot hide nonzero query exit '+stage,()=>{
const r=mockStartup(stage,{queryOutputOnFailure:true});assert.notEqual(r.status,0);assert.equal(r.category,'db-start-command-failed');assert.equal(r.stage,stage);assert.equal(r.next,0);assert.equal(r.leak,0);
});
for(const d of [
{stage:'db-start-cli\nsynthetic-private-message',category:'db-start-command-failed'},
{stage:'db-start-unknown',category:'db-start-command-failed'},
{stage:'db-start-cli',category:'unrecognized-startup-error'},
{stage:'db-start-cli',category:'db-start-command-failed',stdout:'fixture-not-a-real-secret'},
{stage:'db-start-cli',category:['db-start-command-failed']},
])test('startup: malformed diagnostics cannot escape sanitizer '+JSON.stringify(Object.keys(d)),()=>{
assert.deepEqual(sanitizeDiagnostic(d),unknownDiagnostic);assert.deepEqual(collectDiagnostic(d).diagnostic,unknownDiagnostic);
});
test('startup: cleanup failure cannot turn a startup failure into green evidence',()=>{
const dir=mkdtempSync(path.join(tmpdir(),'stage3-startup-cleanup-'));
try{writeFileSync(path.join(dir,'result.json'),JSON.stringify(successfulContract()));assert.equal(invalidateCleanupEvidence(dir,{stage:'db-start-cron-alter',category:'db-start-command-failed'}),false);const r=JSON.parse(readFileSync(path.join(dir,'result.json'),'utf8'));assert.equal(r.success,false);assert.equal(r.cleanup,'FAILED');assert.throws(()=>verifyDbResults(r))}finally{rmSync(dir,{recursive:true,force:true})}
});
test('startup: exactly the nine approved phases precede their operations',()=>{
const markers=[...startupBlock.matchAll(/^failure_stage=(\S+)$/gm)].map(m=>m[1]);assert.deepEqual(markers,startupStages);
for(const s of startupStages)assert.ok(diagnosticStages.includes(s));
assert.ok(startupBlock.includes('for attempt in 1 2 3 4 5; do'));assert.ok(startupBlock.includes('[[ $cron_safe == 1 ]]'));
assert.ok(runner.indexOf('# END granular startup diagnostics')<runner.indexOf('failure_stage=route-isolation'));
});
})();
