import {createHash} from 'node:crypto';
import * as adapterFs from 'node:fs';
import {rewriteDatabaseCreate,runDocker} from './start-postgres-cron-off.mjs';
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
import {verifyExtensionInventory,extensionMinimumVersions,inspectSuiteEvidence,verifyEvidence,verifySecurity,expectedRls,expectedColumnDml,expectedMigrationVersions,requiredSuites,collectEvidence,verifyDbResults,isolationKeys,cleanupKeys,imageDiagnosticStages,diagnosticStages,diagnosticCategories,sanitizeDiagnostic,invalidateCleanupEvidence} from './verify-db-results.mjs';
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
 securityBefore:security(),securityAfter:security(),extensionReview:{before:verifyExtensionInventory(security().checks.extensions),after:verifyExtensionInventory(security().checks.extensions)}};
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
 const prefix=runner.slice(runner.indexOf('failure_stage=network-setup\n'),runner.indexOf('# BEGIN task-private startup adapter'));
 const suffix=runner.replace('const {verifySecurity,verifyExtensionInventory,expectedMigrationVersions,expectedRls,expectedColumnDml}=', 'const {verifySecurity,expectedMigrationVersions,expectedRls,expectedColumnDml}=')
 .replace('// Provisional versions never bypass any non-extension security check.\ntry { verifySecurity(snapshot,{allowUnapprovedExtensions:true}); }','try { verifySecurity(snapshot); }')
 .replace("['security-extensions',(()=>{try {verifyExtensionInventory(snapshot.checks?.extensions);return true;} catch {return false;}})()],","['security-extensions',equal(snapshot.checks?.extensions,expected.checks.extensions)],").slice(runner.indexOf('# Defense in depth: remove default routes')).replace("# Migration 24 creates pg_cron; require its objects after replay, before security snapshots/tests.\nfailure_category=security-cron\ncheck_cron_safety true >\"$raw/cron-objects-after.stdout\" 2>\"$raw/cron-objects-after.stderr\"\n[[ $(cat -- \"$raw/cron-objects-after.stdout\") == t ]]\nfailure_category=none\n",'');
 assert.equal(createHash('sha256').update(prefix).digest('hex'),'e729b5256627690c83dbd4bfded228feb003b601a57258f106716e066db78a24');
 assert.equal(createHash('sha256').update(suffix).digest('hex'),'9de9aadab1868bcdcce3dda1f96e74f07063a6b7e86270bd624a29215f071cec');
});

(function startupSpecs(){
const startupStages=['db-start-cli','db-start-version-num-query','db-start-version-num-verify','db-start-version-text-query','db-start-version-text-verify','db-start-cron-confirm','db-start-pgtap-extension'];
const match=runner.match(/# BEGIN granular startup diagnostics\n([\s\S]*?)# END granular startup diagnostics/);
assert.ok(match);
const startupBlock=match[1],q=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function mockStartup(fail='',{cronMismatch=false,queryOutputOnFailure=false}={}){
const program=[
'set -euo pipefail','umask 077',
'raw=$(mktemp -d /tmp/fairswap-startup-mock.XXXXXXXX)',
'trap \'[[ $raw == /tmp/fairswap-startup-mock.* ]] && rm -rf -- "$raw"\' EXIT',
'task="$raw"; mkdir -p "$task/bin"',
'db=synthetic-task-db; fail='+q(fail),
'cron_mismatch='+Number(cronMismatch)+'; output_on_failure='+Number(queryOutputOnFailure),
': >"$raw/calls"; : >"$raw/sleeps"; : >"$raw/next"',
'cli_local() { printf "CALL:%s\\n" "$failure_stage" >>"$raw/calls"; printf "fixture-not-a-real-secret\\n"; printf "synthetic-private-message\\n" >&2; [[ $fail != db-start-cli ]] || return 1; if [[ $fail != missing-adapter-proof ]]; then printf \'{"serverCronOff":true}\\n\' >"$raw/startup-override.json"; fi; }',
'docker() {',
' [[ $1 == exec ]] || return 1; if [[ $2 == -i ]]; then shift; fi; [[ $2 == "$db" && $3 == psql ]] || return 1',
' printf "CALL:%s\\n" "$failure_stage" >>"$raw/calls"',
' if [[ $fail == "$failure_stage" ]]; then',
'   if [[ $output_on_failure == 1 ]]; then',
'     case "$failure_stage" in db-start-version-num-query) printf "170006\\n" ;; db-start-version-text-query) printf "17.6\\n" ;; db-start-cron-confirm) printf "t\\n" ;; *) printf "fixture-not-a-real-secret\\n" ;; esac',
'   else printf "fixture-not-a-real-secret\\n"; fi',
'   printf "synthetic-private-message\\n" >&2; return 1',
' fi',
' case "$failure_stage" in',
' db-start-version-num-query) if [[ $fail == db-start-version-num-verify ]]; then printf "170007\\n"; else printf "170006\\n"; fi ;;',
' db-start-version-text-query) if [[ $fail == db-start-version-text-verify ]]; then printf "17.7\\n"; else printf "17.6\\n"; fi ;;',
' db-start-cron-confirm) if [[ $cron_mismatch == 1 ]]; then printf "f\\n"; else printf "t\\n"; fi ;;',
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
if(stage==='db-start-cron-confirm'){assert.equal(r.calls.filter(s=>s===stage).length,1);assert.equal(r.sleeps,0)}
});
test('startup: successful diagnostics preserve command order and resume security checks',()=>{
const r=mockStartup();assert.equal(r.status,0);assert.equal(r.next,1);assert.equal(r.leak,0);assert.equal(r.category,'none');assert.equal(r.sleeps,0);
assert.deepEqual(r.calls,['db-start-cli','db-start-version-num-query','db-start-version-text-query','db-start-cron-confirm','db-start-pgtap-extension']);
});
test('startup: missing transformation proof blocks SQL and security continuation',()=>{
 const r=mockStartup('missing-adapter-proof');assert.notEqual(r.status,0);assert.equal(r.stage,'db-start-cli');assert.equal(r.category,'db-start-command-failed');assert.equal(r.next,0);assert.equal(r.leak,0);assert.deepEqual(r.calls,['db-start-cli']);
});
test('startup: server-wide Cron proof is mandatory before migrations',()=>{
const r=mockStartup('',{cronMismatch:true});assert.notEqual(r.status,0);assert.equal(r.stage,'db-start-cron-confirm');assert.equal(r.category,'db-start-cron-not-disabled');assert.equal(r.next,0);assert.equal(r.sleeps,0);assert.equal(r.leak,0);
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
test('startup: current startup phases precede their operations',()=>{
const markers=[...startupBlock.matchAll(/^failure_stage=(\S+)$/gm)].map(m=>m[1]);assert.deepEqual(markers,startupStages);
for(const s of startupStages)assert.ok(diagnosticStages.includes(s));
assert.ok(startupBlock.includes("source = 'command line'"));assert.ok(startupBlock.includes('[[ $cron_safe == t ]]'));
assert.ok(runner.indexOf('# END granular startup diagnostics')<runner.indexOf('failure_stage=route-isolation'));
});
})();

(function adapterSpecs(){
const database='supabase_db_fairswap-ci-'+'1'.repeat(20),project=database.slice('supabase_db_'.length),imageId='sha256:'+'a'.repeat(64);
const launch='exec docker-entrypoint.sh postgres -D /etc/postgresql \n';
const script="\ncat <<'EOF' > /etc/postgresql.schema.sql && \\\ncat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n"+launch+"SYNTHETIC_SCHEMA_ROLES_GRANTS_WEBHOOKS\nEOF\n# settings\nEOF\n";
const command=()=>['create','--name',database,'--env','JWT_SECRET','--label','com.supabase.cli.project='+project,'--label','com.docker.compose.project='+project,'--entrypoint','sh',pins.database.images.postgres.tag,'-c',script];
function fixture(fn){
const task=adapterFs.mkdtempSync(path.join(adapterFs.realpathSync(tmpdir()),'fairswap-stage3-ci.')),raw=path.join(task,'raw');
adapterFs.mkdirSync(raw);adapterFs.writeFileSync(path.join(task,'owner'),'00000000-0000-4000-8000-000000000000\n');
adapterFs.writeFileSync(path.join(raw,'images.json'),JSON.stringify({postgres:{...pins.database.images.postgres,imageId,platform:'linux/amd64'}}));
const env={FAIRSWAP_DB_CLEAN_ENV:'1',FAIRSWAP_DB_TASK:task,FAIRSWAP_DB_OWNER:'00000000-0000-4000-8000-000000000000'},marker=path.join(raw,'startup-override.json'),realDocker=path.join(adapterFs.realpathSync(tmpdir()),'synthetic-unused-docker');
const calls=[],run=(executable,args,options)=>{calls.push({executable,args:[...args],options});return args[0]==='image'?{status:0,stdout:imageId+'\n'}:{status:0}};
try{return fn({task,raw,env,marker,realDocker,calls,run})}finally{adapterFs.rmSync(task,{recursive:true,force:true})}
}
test('adapter: only one launch argument changes; bootstrap and other arguments remain exact',()=>{
const args=command(),saved=[...args],r=rewriteDatabaseCreate(args,database);assert.equal(r.changed,true);assert.deepEqual(args,saved);assert.deepEqual(r.args.slice(0,-1),saved.slice(0,-1));
assert.equal(r.args.at(-1),script.replace(launch,launch.replace(' \n',' -c cron.launch_active_jobs=off\n')));
assert.equal(r.args.at(-1).replace(' -c cron.launch_active_jobs=off\n',' \n'),script);
});
for(const [name,mutate]of [
['missing CLI ownership',a=>a.splice(a.indexOf('--label'),2)],
['wrong compose ownership',a=>a[a.indexOf('com.docker.compose.project='+project)]='com.docker.compose.project=another-task'],
['duplicate ownership',a=>a.splice(1,0,'--label','com.supabase.cli.project='+project)],
['ambiguous name',a=>a.splice(1,0,'--name','another-db')],
['name alias',a=>a.splice(1,2,'--name='+database)],
['entrypoint alias',a=>a.splice(a.indexOf('--entrypoint'),2,'--entrypoint=sh')],
['different entrypoint',a=>a[a.indexOf('--entrypoint')+1]='bash'],
['different image',a=>a[a.length-3]='public.ecr.aws/supabase/postgres:latest'],
['wrong digest',a=>a[a.length-3]='public.ecr.aws/supabase/postgres@sha256:'+'0'.repeat(64)],
['unsupported script',a=>a[a.length-1]='exec postgres\n'],
['ambiguous launch',a=>a[a.length-1]=script+launch],
['duplicate transformation',a=>a[a.length-1]=script.replace(launch,launch.replace(' \n',' -c cron.launch_active_jobs=off\n'))],
['backup path',a=>a[a.length-1]=script+'/etc/backup.sql'],
['label-file bypass',a=>a.splice(1,0,'--label-file','synthetic-file')],
['short-label bypass',a=>a.splice(1,0,'-l','com.supabase.cli.project=other')],
])test('adapter: reject '+name,()=>{const a=command();mutate(a);assert.throws(()=>rewriteDatabaseCreate(a,database))});
test('adapter: container create alias targeting the owned DB fails closed',()=>assert.throws(()=>rewriteDatabaseCreate(['container',...command()],database)));
for(const [label,args] of [
 ['run',['run','--name',database,pins.database.images.postgres.tag]],
 ['container run',['container','run','--name',database,pins.database.images.postgres.tag]],
])test('adapter: alternate owned database launch rejected before Docker '+label,()=>fixture(c=>{
 assert.throws(()=>runDocker(c.realDocker,database,c.marker,args,{run:c.run,env:c.env}));
 assert.equal(c.calls.length,0);
}));
test('adapter: alternate Docker run for unrelated container still passes through',()=>fixture(c=>{
 const args=['run','--name','unrelated-bootstrap',pins.database.images.postgres.tag];
 assert.equal(runDocker(c.realDocker,database,c.marker,args,{run:c.run,env:c.env}),0);
 assert.deepEqual(c.calls[0].args,args);
}));
test('adapter: unrelated Docker commands and bootstrap containers remain byte-for-byte unchanged',()=>{
for(const a of [['inspect',database],['start',database],['cp','-',database+':/'],['create','--name','synthetic-auth-job','synthetic-image','synthetic-command','-h',database]]){
const r=rewriteDatabaseCreate(a,database);assert.equal(r.changed,false);assert.deepEqual(r.args,a);
}
});
test('adapter: successful mocked image check/create writes exactly-once private proof',()=>fixture(c=>{
assert.equal(runDocker(c.realDocker,database,c.marker,command(),{run:c.run,env:c.env}),0);
assert.equal(c.calls.length,2);assert.deepEqual(c.calls[0].args,['image','inspect','-f','{{.Id}}',pins.database.images.postgres.tag]);
assert.equal(adapterFs.readFileSync(c.marker,'utf8'),'{"serverCronOff":true}\n');
assert.throws(()=>runDocker(c.realDocker,database,c.marker,command(),{run:c.run,env:c.env}));assert.equal(c.calls.length,2);
}));
test('adapter: failed Docker create cannot write successful proof',()=>fixture(c=>{
const run=(exe,args,options)=>{c.calls.push(args);return args[0]==='image'?{status:0,stdout:imageId+'\n'}:{status:17}};
assert.equal(runDocker(c.realDocker,database,c.marker,command(),{run,env:c.env}),17);assert.equal(adapterFs.existsSync(c.marker),false);
}));
test('adapter: wrong local image ID blocks create and proof',()=>fixture(c=>{
const run=()=>{c.calls.push('inspect');return {status:0,stdout:'sha256:'+'b'.repeat(64)+'\n'}};
assert.throws(()=>runDocker(c.realDocker,database,c.marker,command(),{run,env:c.env}));assert.equal(c.calls.length,1);assert.equal(adapterFs.existsSync(c.marker),false);
}));
test('adapter: image inspect failure blocks create and proof',()=>fixture(c=>{
const run=()=>{c.calls.push('inspect');return {status:1,stderr:'fixture-not-a-real-secret'}};
assert.throws(()=>runDocker(c.realDocker,database,c.marker,command(),{run,env:c.env}));assert.equal(c.calls.length,1);
}));
test('adapter: missing owner authorization blocks all Docker calls',()=>fixture(c=>{
assert.throws(()=>runDocker(c.realDocker,database,c.marker,command(),{run:c.run,env:{...c.env,FAIRSWAP_DB_OWNER:'11111111-1111-4111-8111-111111111111'}}));assert.equal(c.calls.length,0);
}));
test('adapter: unrelated commands pass through the exact executable and argv once',()=>fixture(c=>{
const args=['cp','-',database+':/'];assert.equal(runDocker(c.realDocker,database,c.marker,args,{run:c.run,env:c.env}),0);assert.equal(c.calls.length,1);assert.deepEqual(c.calls[0].args,args);assert.equal(c.calls[0].executable,c.realDocker);assert.equal(adapterFs.existsSync(c.marker),false);
}));
test('adapter: termination or missing Docker status cannot create proof',()=>fixture(c=>{
 for(const response of [{status:null,signal:'SIGTERM'},{status:null,error:new Error('synthetic-private-message')}]){
  const run=(exe,args)=>args[0]==='image'?{status:0,stdout:imageId+'\n'}:response;
  assert.equal(runDocker(c.realDocker,database,c.marker,command(),{run,env:c.env}),1);
  assert.equal(adapterFs.existsSync(c.marker),false);
 }
}));
test('adapter: altered private image pin evidence fails before Docker invocation',()=>fixture(c=>{
 const evidence=JSON.parse(adapterFs.readFileSync(path.join(c.raw,'images.json')));
 evidence.postgres.digest='sha256:'+'0'.repeat(64);adapterFs.writeFileSync(path.join(c.raw,'images.json'),JSON.stringify(evidence));
 assert.throws(()=>runDocker(c.realDocker,database,c.marker,command(),{run:c.run,env:c.env}));assert.equal(c.calls.length,0);
}));
test('adapter: CLI failure exports only its fixed error message and never arguments',()=>fixture(c=>{
 const helper=fileURLToPath(new URL('./start-postgres-cron-off.mjs',import.meta.url));
 let failure;try{execFileSync(process.execPath,[helper,c.realDocker,database,c.marker,'synthetic-private-message'],{encoding:'utf8',stdio:'pipe',env:{...process.env,...c.env,FAIRSWAP_DB_CLEAN_ENV:'0'}})}catch(e){failure=e}
 assert.ok(failure);assert.equal(failure.status,1);assert.equal(failure.stdout,'');
 assert.match(failure.stderr,/^FAIL: task PostgreSQL startup adapter rejected; raw output withheld\s*$/);
 for(const value of [c.task,c.realDocker,database,'synthetic-private-message'])assert.ok(!failure.stderr.includes(value));
}));
test('adapter: runner limits PATH to startup and retains exact proof before SQL',()=>{
assert.equal((runner.match(/PATH="\$task\/bin:\$PATH" cli_local db start/g)||[]).length,1);
assert.ok(runner.includes('>\"$task/bin/docker\"'));assert.ok(runner.includes('[[ $real_docker == /* && $real_docker != "$task/bin/"* ]]'));
assert.ok(runner.indexOf('cat -- "$raw/startup-override.json"')<runner.indexOf('failure_stage=db-start-version-num-query'));
assert.ok(!runner.includes('ALTER SYSTEM SET cron.launch_active_jobs'));assert.ok(!runner.includes('SELECT pg_reload_conf()'));
assert.ok(runner.includes("source = 'command line' AND NOT pending_restart"));
assert.ok(runner.slice(runner.indexOf('check_cron_safety()'),runner.indexOf('failure_stage=db-start-cli')).includes('-U supabase_admin -d postgres'));
 assert.ok(runner.slice(runner.indexOf('failure_stage=db-start-cron-confirm')).includes('check_cron_safety false'));
for(const token of ["rolsuper FROM pg_roles WHERE rolname = current_user","current_setting('cron.database_name') = 'postgres'","current_setting('cron.host') = 'localhost'","shared_preload_libraries","extname = 'pg_cron'","to_regclass(object_name)","ARRAY['cron.job', 'cron.job_run_details']","IF $require_objects OR extension_installed"])assert.ok(runner.includes(token));
assert.ok(runner.indexOf('[[ $cron_safe == t ]]')<runner.indexOf('failure_stage=migrations'));
});
for(const stage of ['db-start-cron-alter','db-start-cron-reload'])test('adapter: historical diagnostic retained safely '+stage,()=>{
const d={stage,category:'db-start-command-failed'};assert.deepEqual(sanitizeDiagnostic(d),d);assert.deepEqual(collectDiagnostic(d).diagnostic,d);
});
})();

test('cron lifecycle: resolve optional startup catalogs before dynamic access',()=>{
 const sql=runner.slice(runner.indexOf('check_cron_safety() {'),runner.indexOf('failure_stage=db-start-cli'));
 assert.ok(sql.includes('relation_id := to_regclass(object_name)'));
 assert.ok(sql.indexOf('IF relation_id IS NULL THEN')<sql.indexOf('EXECUTE format('));
 assert.ok(sql.includes('IF $require_objects OR extension_installed THEN'));
 assert.ok(sql.includes("ELSIF NOT $require_objects OR object_name = 'cron.job_run_details' THEN"));
 assert.doesNotMatch(sql,/FROM cron\.(job|job_run_details)\b/);
 assert.ok(sql.includes('IS DISTINCT FROM true'));assert.ok(sql.includes('nonempty IS DISTINCT FROM false'));
 assert.ok(sql.includes('BEGIN READ ONLY;'));assert.ok(sql.includes('ON_ERROR_STOP=1'));
});
test('cron lifecycle: require objects after replay before existing security snapshots',()=>{
 const replay=runner.indexOf('cli_local migration up --local'),check=runner.indexOf('check_cron_safety true');
 const snapshot=runner.indexOf('<"$root/scripts/stage3/assert-local-security.sql"'),suites=runner.indexOf('failure_stage=pgtap');
 assert.ok(replay<check&&check<snapshot&&snapshot<suites);
 assert.ok(runner.includes('IF $require_objects AND NOT extension_installed THEN'));
 assert.ok(runner.includes('check_cron_safety false >'));
});
test('cron lifecycle: retain server-wide pre-migration safety requirements',()=>{
 for(const token of ["source = 'command line' AND NOT pending_restart","current_setting('cron.launch_active_jobs') = 'off'","current_setting('cron.database_name') = 'postgres'","current_setting('cron.host') = 'localhost'","shared_preload_libraries","rolsuper FROM pg_roles WHERE rolname = current_user"])assert.ok(runner.includes(token));
 assert.ok(runner.indexOf('check_cron_safety false >')<runner.indexOf('failure_stage=migrations'));
 assert.ok(runner.includes('failure_category=security-cron\ncheck_cron_safety true'));
});

// Step 1O: synthetic inventories and command outputs only; never runtime claims.
test('extension floors retain the verified Stage 2B minima',()=>{
 assert.deepEqual(extensionMinimumVersions,{pg_cron:'1.6',pg_net:'0.14.0',supabase_vault:'0.3.1'});
 assert.equal(verifyExtensionInventory(security().checks.extensions).approved,true);
});
for(const name of Object.keys(extensionMinimumVersions)) {
 test('extension rejects missing '+name,()=>{const x=security().checks.extensions;delete x[name];assert.throws(()=>verifyExtensionInventory(x));});
 test('extension rejects downgraded '+name,()=>{const x=security().checks.extensions;x[name]={pg_cron:'1.5.99',pg_net:'0.13.99',supabase_vault:'0.3.0'}[name];assert.throws(()=>verifyExtensionInventory(x));});
 test('extension admits provisional numeric upgrade '+name,()=>{const x=security().checks.extensions;x[name]={pg_cron:'1.7',pg_net:'0.15.0',supabase_vault:'0.3.2'}[name];assert.equal(verifyExtensionInventory(x).approved,false);});
}
for(const version of ['',null,1,'1','1.06','01.6','1.6.00','1.6-beta','1.6\n','1.6 /private/operator','9999.0.0','1.6.0.0','1.6+build','1.6;secret=fixture']) {
 test('extension rejects malformed version '+JSON.stringify(version),()=>{const x=security().checks.extensions;x.pg_cron=version;assert.throws(()=>verifyExtensionInventory(x));});
}
test('extension rejects unknown name, array, null and extra fields',()=>{
 for(const x of [{...security().checks.extensions,unexpected:'1.0'},[],null,{versions:security().checks.extensions}])assert.throws(()=>verifyExtensionInventory(x));
});
test('extension numeric comparison does not use lexical ordering or auto-approve aliases',()=>{
 const x=security().checks.extensions;x.pg_cron='1.10';assert.equal(verifyExtensionInventory(x).approved,false);
 x.pg_cron='1.6.0';assert.equal(verifyExtensionInventory(x).approved,false);
 x.pg_cron='0.999.999';assert.throws(()=>verifyExtensionInventory(x));
 x.pg_cron='999.999.999';assert.equal(verifyExtensionInventory(x).approved,false);
});
test('provisional extension versions cannot bypass any remaining security boundary',()=>{
 const mutations=[s=>s.version_num=170007,s=>s.migration_versions.pop(),s=>s.vault_count=1,
 s=>s.moderation_automation_enabled='true',s=>s.httpRequests=1,s=>s.httpResponses=1,
 s=>s.checks.buckets=[],s=>s.checks.rls[0].relrowsecurity=false,
 s=>s.checks.column_dml[0].anon_table_insert=true,s=>s.checks.sensitive_rpcs=[],
 s=>s.checks.cron_jobs=[],s=>s.checks.runtime_settings[0].setting='unapproved',
 s=>s.triggerAclContext={}];
 for(const mutate of mutations){const s=security();s.checks.extensions.pg_net='0.15.0';mutate(s);assert.throws(()=>verifySecurity(s,{allowUnapprovedExtensions:true}));}
});
test('valid provisional inventory passes only the pre-SQL security mode',()=>{
 const s=security();s.checks.extensions.pg_net='0.15.0';
 verifySecurity(s,{allowUnapprovedExtensions:true});assert.throws(()=>verifySecurity(s));
 for(const value of ['true',1,{}])assert.throws(()=>verifySecurity(s,{allowUnapprovedExtensions:value}));
});
function runPreSqlGate(snapshot) {
 const start=runner.indexOf('const {verifySecurity,verifyExtensionInventory,expectedMigrationVersions');
 const end=runner.indexOf('\nNODE',start);
 const block="import {pathToFileURL} from 'node:url';\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst [verifierPath,snapshotPath,referencePath,categoryPath]=process.argv.slice(2);\n"+runner.slice(start,end);
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-pre-sql-'));
 try{
  writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify(snapshot));
  let status=0;
  try{execFileSync(process.execPath,['--input-type=module','-',fileURLToPath(new URL('./verify-db-results.mjs',import.meta.url)),path.join(dir,'snapshot.json'),fileURLToPath(new URL('../../docs/extraction/evidence/stage2b/r6/result.json',import.meta.url)),path.join(dir,'category')],{input:block,stdio:'pipe'});}
  catch(e){status=e.status;}
  return {status,category:adapterFs.existsSync(path.join(dir,'category'))?readFileSync(path.join(dir,'category'),'utf8'):null};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('actual runner gate permits provisional versions only after strict security',()=>{
 const s=security();s.checks.extensions.pg_net='0.15.0';assert.equal(runPreSqlGate(s).status,0);
 s.checks.sensitive_rpcs=[];assert.deepEqual(runPreSqlGate(s),{status:1,category:'security-rpcs'});
});
test('actual runner gate rejects missing, malformed, downgraded and unexpected inventory',()=>{
 for(const alter of [x=>delete x.pg_net,x=>x.pg_net='private-raw-text',x=>x.pg_net='0.13.99',x=>x.unexpected='1.0']){
  const s=security();alter(s.checks.extensions);assert.deepEqual(runPreSqlGate(s),{status:1,category:'security-extensions'});
 }
 assert.ok(runner.indexOf('try { verifySecurity(snapshot,{allowUnapprovedExtensions:true}); }')<runner.indexOf('failure_stage=pgtap'));
});
function withExtensionCollection({pending=true,failedSql=false,cleanup=true,invalid=false,rawField=false}={},inspect){
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-extension-'));
 try{
  const raw=path.join(dir,'raw'),out=path.join(dir,'out');mkdirSync(raw);
  const contract=successfulContract();
  if(pending)for(const s of [contract.securityBefore,contract.securityAfter])s.checks.extensions.pg_net='0.15.0';
  if(invalid)contract.securityBefore.checks.extensions.pg_net='private-fixture-secret';
  if(rawField)for(const s of [contract.securityBefore,contract.securityAfter]){s.raw='private-fixture-secret';s.checks.unknown='private-fixture-secret';}
  if(!cleanup)contract.cleanup.firewallRemoved=false;
  const files={'execution.json':{exitCode:failedSql?1:0},'diagnostic.json':{stage:failedSql?'pgtap':'complete',category:'none'},
   'manifest.json':{sha256:manifestSha256,before:true,after:true},'tools.json':contract.tools,'images.json':contract.images,
   'isolation-before.json':contract.isolationBefore,'isolation-after.json':contract.isolationAfter,
   'security-before.json':contract.securityBefore,'security-after.json':contract.securityAfter,'cleanup.json':contract.cleanup};
  for(const [name,value]of Object.entries(files))writeFileSync(path.join(raw,name),JSON.stringify(value));
  for(const [file,count]of Object.entries(requiredSuites)){
   const log=file==='moderation_compatibility.test.sql'?(failedSql?goodTap().replace('ok 1 ','not ok 1 '):goodTap()):
    '/supabase/tests/'+file+'\nAll tests successful.\nFiles=1, Tests='+count+', 0 wallclock secs\nResult: PASS\n';
   writeFileSync(path.join(raw,file+'.log'),log);
   writeFileSync(path.join(raw,file+'.exit'),failedSql&&file==='moderation_compatibility.test.sql'?'1\n':'0\n');
  }
  writeFileSync(path.join(raw,'private.log'),'private-fixture-secret /private/operator/.env');
  const acceptedResult=collectEvidence(raw,out),report=JSON.parse(readFileSync(path.join(out,'result.json'),'utf8'));
  const suites=JSON.parse(readFileSync(path.join(out,'suite-results.json'),'utf8'));
  assert.deepEqual(readdirSync(out).sort(),['SHA256SUMS','result.json','suite-results.json']);
  for(const name of ['result.json','suite-results.json']){
   const text=readFileSync(path.join(out,name),'utf8');assert.ok(!text.includes('private-fixture-secret')&&!text.includes('/private/operator'));
   assert.ok(readFileSync(path.join(out,'SHA256SUMS'),'utf8').includes(createHash('sha256').update(text).digest('hex')+'  '+name));
  }
  inspect({acceptedResult,report,suites,out});
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('unapproved inventory preserves all 344 executed passing assertions but cannot return green',()=>{
 withExtensionCollection({},({acceptedResult,report,suites,out})=>{
  assert.equal(acceptedResult,false);assert.equal(report.success,false);
  assert.deepEqual(report.diagnostic,{stage:'artifact-validation',category:'security-extension-approval-pending'});
  assert.equal(report.extensionReview.before.approved,false);assert.equal(report.extensionReview.after.approved,false);
  assert.deepEqual(Object.keys(report.extensionReview.before.versions).sort(),Object.keys(extensionMinimumVersions).sort());
  assert.equal(suites.length,10);assert.equal(suites.reduce((n,s)=>n+s.assertionsObserved,0),344);
  assert.equal(suites.reduce((n,s)=>n+s.passed.length,0),344);assert.ok(suites.every(s=>s.failed.length===0));
  assert.throws(()=>verifyDbResults(report));assert.throws(()=>verifyEvidence(out));
 });
});
test('unapproved extensions preserve failed assertions and compatibility observations',()=>{
 withExtensionCollection({failedSql:true},({acceptedResult,report,suites})=>{
  assert.equal(acceptedResult,false);assert.equal(report.compatibility.passed,false);
  assert.equal(report.compatibility.assertionsObserved,74);assert.deepEqual(report.compatibility.failed,[1]);
  assert.equal(report.compatibility.observations.length,4);assert.equal(report.extensionReview.before.approved,false);
  const suite=suites.find(s=>s.file==='moderation_compatibility.test.sql');assert.deepEqual(suite.failed,[1]);assert.equal(suite.passed.length,73);
  assert.equal(suites.reduce((n,s)=>n+s.assertionsObserved,0),344);assert.equal(report.diagnostic.stage,'pgtap');
 });
});
test('cleanup failure invalidates provisional results while preserving numeric evidence',()=>{
 withExtensionCollection({cleanup:false},({acceptedResult,report,suites})=>{
  assert.equal(acceptedResult,false);assert.equal(report.cleanup,'UNVERIFIED');assert.equal(suites.length,10);assert.throws(()=>verifyDbResults(report));
 });
});
test('invalid inventory and arbitrary snapshot fields cannot escape evidence sanitization',()=>{
 withExtensionCollection({invalid:true,rawField:true},({acceptedResult,report})=>{
  assert.equal(acceptedResult,false);assert.equal(report.extensionReview.before,undefined);
  assert.equal(report.extensionReview.after.approved,false);assert.equal(report.securityBefore,undefined);
 });
});
test('approved successful evidence contract remains strict and verifiable',()=>{
 withExtensionCollection({pending:false,rawField:true},({acceptedResult,report,out})=>{
  assert.equal(acceptedResult,true);assert.equal(report.success,true);assert.equal(report.extensionReview.before.approved,true);verifyEvidence(out);
 });
});
test('public final verifier cannot be opted into accepting unapproved versions',()=>{
 const r=successfulContract();r.securityBefore.checks.extensions.pg_net='0.15.0';
 r.extensionReview.before=verifyExtensionInventory(r.securityBefore.checks.extensions);
 assert.throws(()=>verifyDbResults(r,{allowUnapprovedExtensions:true}));
 r.extensionReview.before.approved=true;assert.throws(()=>verifyDbResults(r));
});
test('TAP evidence keeps only executed prefix numbers and excludes skips from passed assertions',()=>{
 const r=inspectSuiteEvidence('moderation_compatibility.test.sql','1..74\nok 1 - private description\nnot ok 2 - raw text\nok 3 # SKIP arbitrary\n',1);
 assert.equal(r.assertionsObserved,3);assert.deepEqual(r.passed,[1]);assert.deepEqual(r.failed,[2]);assert.equal(r.result,'NOT_VERIFIED');
 assert.ok(!JSON.stringify(r).includes('private description'));
 for(const log of ['ok 2 - out of order\n','ok 1\nok 1\n','ok 999999\n'])assert.throws(()=>inspectSuiteEvidence('moderation_compatibility.test.sql',log,1));
});
test('pg_prove failure evidence preserves bounded counts and failed ranges without assuming other passes',()=>{
 const r=inspectSuiteEvidence('schema_security.test.sql','Failed tests: 1, 3-4\nFiles=1, Tests=22, 0 wallclock secs\nResult: FAIL\n',1);
 assert.equal(r.assertionsObserved,22);assert.deepEqual(r.failed,[1,3,4]);assert.deepEqual(r.passed,[]);assert.equal(r.result,'NOT_VERIFIED');
 for(const log of ['Failed tests: 1-999999\nFiles=1, Tests=22, x\n','Files=1, Tests=999999, x\n','Failed tests: 1, 1\nFiles=1, Tests=22, x\n'])assert.throws(()=>inspectSuiteEvidence('schema_security.test.sql',log,1));
});
test('pre-SQL, image, network and cleanup failures never become approved through extension handling',()=>{
 for(const mutate of [r=>r.images.postgres.digest='sha256:'+'0'.repeat(64),r=>r.isolationBefore.ipv6Denied=false,
  r=>r.cleanup.firewallRemoved=false,r=>r.securityBefore.checks.cron_jobs=[]]){
  const r=successfulContract();r.securityBefore.checks.extensions.pg_net='0.15.0';mutate(r);assert.throws(()=>verifyDbResults(r));
 }
});

test('extension parser rejects every whitespace boundary and bounded component overflow',()=>{
 for(const v of ['1.6\r','1.6\n',' 1.6','1.6 ','1.6\t','1.6.1000','1000.0','1.6.0\u0000']){
  const x=security().checks.extensions;x.pg_cron=v;assert.throws(()=>verifyExtensionInventory(x));
 }
});
test('post-execution unapproved inventory cannot be hidden by approved pre-execution values',()=>{
 const r=successfulContract();r.securityAfter.checks.extensions.supabase_vault='0.3.2';
 r.extensionReview.after=verifyExtensionInventory(r.securityAfter.checks.extensions);
 assert.throws(()=>verifyDbResults(r));
 r.extensionReview.after.approved=true;assert.throws(()=>verifyDbResults(r));
});
test('malformed TAP numbering is never exported as compatibility evidence',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-bounded-tap-'));
 try{
  const raw=path.join(dir,'raw'),out=path.join(dir,'out');mkdirSync(raw);
  writeFileSync(path.join(raw,'moderation_compatibility.test.sql.log'),goodTap().replace('ok 1 ','not ok 999999 '));
  writeFileSync(path.join(raw,'moderation_compatibility.test.sql.exit'),'1\n');
  assert.equal(collectEvidence(raw,out),false);
  const r=JSON.parse(readFileSync(path.join(out,'result.json'),'utf8'));
  assert.equal(r.compatibility.passed,false);assert.equal(r.compatibility.failed,undefined);
  assert.ok(!readFileSync(path.join(out,'result.json'),'utf8').includes('999999'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('missing or partial suite outputs never turn 344 planned assertions into executed passes',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stage3-partial-tap-'));
 try{
  const raw=path.join(dir,'raw'),out=path.join(dir,'out');mkdirSync(raw);
  writeFileSync(path.join(raw,'moderation_compatibility.test.sql.log'),'1..74\nok 1 - synthetic\n');
  writeFileSync(path.join(raw,'moderation_compatibility.test.sql.exit'),'1\n');
  assert.equal(collectEvidence(raw,out),false);
  const suites=JSON.parse(readFileSync(path.join(out,'suite-results.json'),'utf8'));
  assert.equal(suites.length,1);assert.equal(suites[0].assertionsObserved,1);assert.deepEqual(suites[0].passed,[1]);assert.equal(suites[0].result,'NOT_VERIFIED');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('pending extension CLI collection exits nonzero and cannot print private fields',()=>{
 withExtensionCollection({},({out})=>{
  let error;try{execFileSync(process.execPath,[fileURLToPath(new URL('./verify-db-results.mjs',import.meta.url)),'--verify',out],{encoding:'utf8',stdio:'pipe'});}catch(e){error=e;}
  assert.ok(error);assert.equal(error.status,1);
  assert.ok(!error.stderr.includes(out)&&!error.stderr.includes('private-fixture-secret'));
 });
});
