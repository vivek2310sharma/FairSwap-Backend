// Static and synthetic fixtures only. Never invokes Docker/PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,cpSync,existsSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepare,removePrepared,verifySource,sourceRoot,manifest,deriveRunner,hooks,expectedBodyHashes,extraSuite,stateSql} from './prepare-finalizer-rehearsal.mjs';
import {collect,gate,inspectSupplement,verifyChecksums,invalidate,observedExtensions} from './verify-finalizer-rehearsal.mjs';
import {expectedRls,expectedColumnDml,expectedMigrationVersions,requiredSuites,isolationKeys,cleanupKeys} from './verify-db-results.mjs';
import {manifestSha256} from '../ci/verify-baseline.mjs';
const read=p=>readFileSync(path.join(sourceRoot,p),'utf8');
const original=read('scripts/stage3/run-local-db.sh');
const tap85=()=>['1..85',...Array.from({length:85},(_,i)=>'ok '+(i+1)+' - synthetic supplemental fixture')].join('\n')+'\n';
const tap74=()=>['1..74',...Array.from({length:74},(_,i)=>'ok '+(i+1)+' - synthetic compatibility fixture'),
 ...['goods','cars','two-wheelers','property'].map(name=>'# STAGE3 '+JSON.stringify({case:name,sqlstate:'00000',listing_status:name==='goods'?'active':'pending_review',request_status:'completed',results:1,attempt_count:1,revision_matches:true,lease_retained:true}))].join('\n')+'\n';
function security(){
 const s=JSON.parse(read('docs/extraction/evidence/stage2b/r6/result.json')).security;
 Object.assign(s,{postgresVersion:'17.6',version_num:170006,migration_versions:expectedMigrationVersions(),vault_count:0,moderation_automation_enabled:'false'});
 s.checks.rls=structuredClone(expectedRls);s.checks.column_dml=structuredClone(expectedColumnDml);s.checks.extensions={...observedExtensions};
 s.checks.runtime_settings=s.checks.runtime_settings.filter(r=>['cron.database_name','cron.host','cron.launch_active_jobs'].includes(r.name)).map(r=>r.name==='cron.launch_active_jobs'?{...r,setting:'off'}:r);return s;
}
function withFixture(mutate,inspect){
 const root=prepare(),temp=mkdtempSync(path.join(tmpdir(),'fairswap-step1r-mock-')),raw=path.join(temp,'raw'),project=path.join(temp,'project'),out=path.join(temp,'evidence');
 mkdirSync(raw);mkdirSync(project);mkdirSync(path.join(project,'docs/extraction'),{recursive:true});
 cpSync(path.join(root,'docs/extraction/MIGRATION_MANIFEST.sha256'),path.join(project,'docs/extraction/MIGRATION_MANIFEST.sha256'));
 cpSync(path.join(root,'supabase/migrations'),path.join(project,'supabase/migrations'),{recursive:true});
 const write=(name,v)=>writeFileSync(path.join(raw,name),typeof v==='string'?v:JSON.stringify(v));
 const update=(name,fn)=>{const j=JSON.parse(readFileSync(path.join(raw,name),'utf8'));fn(j);write(name,j);};
 const body=expectedBodyHashes(root),guards=['listings','listing_car_contexts','listing_vehicle_contexts','listing_property_contexts','listing_media'].sort().map((table,i)=>({name:table==='listings'?'z_0_test_submission_lifecycle':'zz_test_submission_child',table,enabled:'O',function:200+i,body:'a'.repeat(32)}));
 for(const p of ['before','overlay','after']){
  write('security-'+p+'.json',security());write('state-'+p+'.json',{function:{oid:100,owner:10,acl:['synthetic-owner=X/synthetic-owner'],config:['search_path=""'],definer:true,volatility:'v',language:'plpgsql',body:body[p==='before'?'before':'after']},guards,cronOff:true,cronHistoryEmpty:true});
 }
 const pins=JSON.parse(read('scripts/stage3/toolchain.json')).database;
 write('images.json',Object.fromEntries(Object.entries(pins.images).map(([k,v])=>[k,{...v,platform:'linux/amd64',imageId:'sha256:'+'a'.repeat(64)}])));
 write('tools.json',{cliVersion:'2.117.0',nodeVersion:'24.15.0',os:'linux',arch:'amd64',dockerVersion:'28.0.4'});
 for(const phase of ['before','after'])write('isolation-'+phase+'.json',Object.fromEntries(isolationKeys.map(k=>[k,true])));
 write('cleanup.json',Object.fromEntries(cleanupKeys.map(k=>[k,true])));
 write('manifest.json',{sha256:manifestSha256,before:true,after:true});write('execution.json',{exitCode:0});write('diagnostic.json',{stage:'complete',category:'none'});
 for(const [file,count]of Object.entries(requiredSuites)){
  write(file+'.log',file==='moderation_compatibility.test.sql'?tap74():'/supabase/tests/'+file+'\nAll tests successful.\nFiles=1, Tests='+count+', 0 wallclock secs\nResult: PASS\n');write(file+'.exit','0\n');
 }
 write(extraSuite+'.log',tap85());write(extraSuite+'.exit','0\n');
 try{
  mutate?.({root,raw,project,out,write,update});
  const accepted=collect(raw,out,root),report=JSON.parse(readFileSync(path.join(out,'result.json'),'utf8')),suites=JSON.parse(readFileSync(path.join(out,'suite-results.json'),'utf8'));
  verifyChecksums(out);assert.equal(accepted,false);assert.equal(report.success,false);assert.equal(report.compatibilityAccepted,false);assert.equal(report.extensionApproval,false);
  inspect({root,raw,project,out,report,suites,write,update});
 }finally{removePrepared(root);assert.ok(!existsSync(root));rmSync(temp,{recursive:true,force:true});}
}
test('overlay source pins exact approved head, 137 files, two Step 1Q payloads and no 59th migration',()=>{
 const m=manifest();assert.equal(m.head,'6e0ca44dfb5416661c780cb831617f5c3196c2a1');assert.equal(Object.keys(m.sources).length,137);
 assert.equal(Object.keys(m.sources).filter(f=>f.startsWith('supabase/migrations/')).length,58);
 assert.equal(m.payloads['scripts/stage3/step1q-finalizer.proposed.sql'],'59a94b449566a4fee4cdbf42eb419aa34057cf1e50fa6c1f6909e77d5190dc13');
 assert.equal(m.payloads['tests/stage3/step1q-finalizer-additional.proposed.test.sql'],'caaf6cc19cba2c73d54ed835706545fae9d1b7499b0fbb55b808eedeb3133357');
});
test('reversing three exact hooks and collector substitutions recovers approved runner bytes',()=>{
 let s=deriveRunner(original);for(const hook of Object.values(hooks))s=s.replace(hook,'');
 for(const mode of ['--collect','--cleanup-failed'])s=s.replace('"$root/scripts/stage3/verify-finalizer-rehearsal.mjs" '+mode,'"$root/scripts/stage3/verify-db-results.mjs" '+mode);
 assert.equal(s,original);
});
test('unexpected or duplicated runner anchors fail closed',()=>{
 assert.throws(()=>deriveRunner(original.replace('fi\nfailure_stage=pgtap\nsuite_failure=0','unsupported')));
 assert.throws(()=>deriveRunner(original+'\nfi\nfailure_stage=pgtap\nsuite_failure=0'));
});
test('proposal runs after canonical pre-security gate, supplement before mandatory post-security',()=>{
 const s=deriveRunner(original);assert.ok(s.indexOf(hooks.before)>s.indexOf('try { verifySecurity(snapshot,{allowUnapprovedExtensions:true}); }'));
 assert.ok(s.indexOf(hooks.before)<s.indexOf('suite_failure=0'));
 assert.ok(s.indexOf(hooks.supplement)>s.indexOf('done < <(node --input-type=module'));
 assert.ok(s.indexOf(hooks.after)<s.indexOf('[[ $suite_failure == 0 ]]'));
 assert.equal(s.split('<"$root/scripts/stage3/step1q-finalizer.proposed.sql"').length,2);
});
test('supplemental TAP requires exactly 85 passed assertions',()=>{
 const r=inspectSupplement(tap85(),0);assert.equal(r.result,'PASS');assert.equal(r.assertionsObserved,85);assert.equal(r.passed.length,85);
 for(const log of [tap85().replace('1..85','1..84'),tap85().replace('ok 1 ','not ok 1 '),tap85().replace('ok 1 -','ok 1 # SKIP'),tap85().replace('ok 1 -','ok 1 # TODO'),tap85()+'ERROR: private',tap85().replace(/^ok 85 .*\n/m,'')])assert.equal(inspectSupplement(log,0).result,'NOT_VERIFIED');
 assert.equal(inspectSupplement(tap85(),1).result,'NOT_VERIFIED');
 for(const log of [tap85().replace('ok 1 ','ok 99999 '),tap85()+'ok 86 - extra\n'])assert.throws(()=>inspectSupplement(log,0));
});
test('complete 429-assertion fixture remains provisional and never final-green',()=>{
 withFixture(null,({report,suites,out})=>{
  assert.equal(report.executionVerified,true);assert.equal(report.concurrencyVerified,false);
  assert.deepEqual(report.security,{before:true,afterProposal:true,afterSql:true});assert.equal(report.canonicalMigrations,58);assert.equal(report.proposalApplications,1);
  assert.deepEqual(report.counts,{suitesExecuted:11,suitesWithUnknownCounts:0,assertionsObserved:429,assertionsPassed:429,assertionsFailed:0});assert.equal(suites.length,11);
  const verifier=fileURLToPath(new URL('./verify-finalizer-rehearsal.mjs',import.meta.url));let failure;
  try{execFileSync(process.execPath,[verifier,'--verify',out],{encoding:'utf8',stdio:'pipe'});}catch(e){failure=e;}
  assert.ok(failure);assert.equal(failure.status,1);
 });
});
test('missing supplemental suite retains only 344 executed assertions',()=>{
 withFixture(({raw})=>{unlinkSync(path.join(raw,extraSuite+'.log'));unlinkSync(path.join(raw,extraSuite+'.exit'));},({report})=>{
  assert.equal(report.executionVerified,false);assert.equal(report.counts.assertionsObserved,344);assert.equal(report.counts.suitesExecuted,10);assert.equal(report.counts.suitesWithUnknownCounts,1);
 });
});
test('partial supplemental TAP never reports planned assertions as executed',()=>{
 withFixture(({write})=>{write(extraSuite+'.log','1..85\nok 1 - private\nnot ok 2 - private\n');write(extraSuite+'.exit','1\n');},({report,suites})=>{
  assert.equal(report.executionVerified,false);assert.equal(report.counts.assertionsObserved,346);assert.equal(report.counts.assertionsPassed,345);assert.equal(report.counts.assertionsFailed,1);
  assert.deepEqual(suites.find(s=>s.file===extraSuite).failed,[2]);
 });
});
test('failed original moderation assertions preserve counts and do not suppress post-security checks',()=>{
 withFixture(({write})=>{write('moderation_compatibility.test.sql.log',tap74().replace('ok 28 ','not ok 28 '));write('moderation_compatibility.test.sql.exit','1\n');},({report})=>{
  assert.equal(report.executionVerified,false);assert.equal(report.counts.assertionsObserved,429);assert.equal(report.counts.assertionsFailed,1);assert.deepEqual(report.compatibility.failed,[28]);
  assert.equal(report.security.afterSql,true);
 });
});
for(const [name,file,mutate]of [
 ['ledger','security-before.json',s=>s.migration_versions.pop()],
 ['Vault','security-overlay.json',s=>s.vault_count=1],
 ['kill switch','security-overlay.json',s=>s.moderation_automation_enabled='true'],
 ['RLS','security-after.json',s=>s.checks.rls[0].relrowsecurity=false],
 ['RPC grant','security-after.json',s=>s.checks.sensitive_rpcs=[]],
 ['Cron jobs','security-after.json',s=>s.checks.cron_jobs=[]],
 ['runtime setting','security-after.json',s=>s.checks.runtime_settings[0].setting='unsafe'],
 ['trigger ACL','security-after.json',s=>s.triggerAclContext=[]],
 ['column privilege','security-after.json',s=>s.checks.column_dml[0].anon_table_insert=true],
 ['new unapproved inventory','security-overlay.json',s=>s.checks.extensions.pg_net='0.21.0']
])test('security gate rejects '+name,()=>{
 withFixture(({update})=>update(file,mutate),({root,raw,project,report})=>{
  assert.equal(report.executionVerified,false);assert.throws(()=>gate(file==='security-before.json'?'before':file==='security-overlay.json'?'overlay':'after',project,raw,root));
 });
});
for(const [name,file,mutate]of [
 ['already replaced before replay','state-before.json',s=>s.function.body='0'.repeat(32)],
 ['wrong proposal body','state-overlay.json',s=>s.function.body='0'.repeat(32)],
 ['changed owner','state-overlay.json',s=>s.function.owner=999],
 ['changed ACL','state-overlay.json',s=>s.function.acl=[]],
 ['unsafe search path','state-overlay.json',s=>s.function.config=['search_path=public']],
 ['definer removed','state-overlay.json',s=>s.function.definer=false],
 ['disabled guard','state-after.json',s=>s.guards[0].enabled='D'],
 ['changed guard body','state-after.json',s=>s.guards[0].body='0'.repeat(32)],
 ['Cron enabled','state-before.json',s=>s.cronOff=false],
 ['Cron execution history','state-overlay.json',s=>s.cronHistoryEmpty=false]
])test('function/lifecycle gate rejects '+name,()=>{
 withFixture(({update})=>update(file,mutate),({report})=>assert.equal(report.executionVerified,false));
});
test('before gate requires exactly 58 canonical project migrations',()=>{
 withFixture(({project})=>writeFileSync(path.join(project,'supabase/migrations/20990101000000_unapproved.sql'),'SELECT 1;'),({report})=>{
  assert.equal(report.security.before,false);assert.equal(report.executionVerified,false);
 });
});
for(const [name,file,mutate]of [
 ['IPv6 isolation','isolation-before.json',s=>s.ipv6Denied=false],
 ['post firewall isolation','isolation-after.json',s=>s.firewallIsolated=false],
 ['image digest','images.json',s=>s.postgres.digest='sha256:'+'0'.repeat(64)],
 ['CLI version','tools.json',s=>s.cliVersion='2.0.0'],
 ['cleanup','cleanup.json',s=>s.firewallRemoved=false],
 ['canonical post hash proof','manifest.json',s=>s.after=false],
 ['nonzero process exit','execution.json',s=>s.exitCode=1]
])test('execution cannot pass with failed '+name,()=>{
 withFixture(({update})=>update(file,mutate),({report})=>assert.equal(report.executionVerified,false));
});
test('collector never exports raw errors, paths, environment or extra snapshot fields',()=>{
 withFixture(({write,update})=>{
  write('private.log','token=synthetic-private /private/operator/.env');
  update('security-overlay.json',s=>s.raw='synthetic-private');update('diagnostic.json',s=>s.raw='synthetic-private');
 },({out,report})=>{
  assert.deepEqual(report.diagnostic,{stage:'unclassified',category:'unclassified'});assert.equal(report.executionVerified,false);
  for(const f of ['result.json','suite-results.json'])assert.ok(!readFileSync(path.join(out,f),'utf8').includes('synthetic-private'));
 });
});
test('late cleanup failure invalidates completion and preserves only safe failure evidence',()=>{
 withFixture(null,({out})=>{assert.equal(invalidate(out,{stage:'cleanup',category:'cleanup-failed'}),false);verifyChecksums(out);const r=JSON.parse(readFileSync(path.join(out,'result.json')));assert.equal(r.cleanup,'FAILED');assert.equal(r.executionVerified,false);});
});
test('altered Step 1Q payload is rejected before any execution',()=>{
 const root=prepare(),p=path.join(root,'scripts/stage3/step1q-finalizer.proposed.sql'),b=readFileSync(p);
 try{writeFileSync(p,Buffer.concat([b,Buffer.from('\n-- changed')]));assert.throws(()=>verifySource(root,true));}
 finally{writeFileSync(p,b);removePrepared(root);}
});
test('cleanup refuses an unowned temporary directory',()=>{
 const p=mkdtempSync(path.join(tmpdir(),'fairswap-step1r-source-'));
 try{assert.throws(()=>removePrepared(p));}finally{rmSync(p,{recursive:true});}
});

test('catalog OIDs are explicitly numeric and state query remains read-only',()=>{
 assert.ok(stateSql.includes('p.oid::bigint')&&stateSql.includes('p.proowner::bigint')&&stateSql.includes('t.tgfoid::bigint'));
 assert.ok(stateSql.startsWith('BEGIN READ ONLY;'));
 assert.doesNotMatch(stateSql,/\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE)\b/i);
});
