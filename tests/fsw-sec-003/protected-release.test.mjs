// Synthetic only: injected API and CLI boundaries; no hosted access or real credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {release,authorize,exposure,recovery,verifyBackup,verifyTestReceipt,verifySchemas,requireCi} from '../../scripts/release/fsw-sec-003-release.mjs';
import {refs,SHA,FILE,VERSION,NAME,LEDGER_SHA,sha} from './release-gate.mjs';
const sql=readFileSync(new URL('../../releases/candidates/fsw-sec-003/supabase/migrations/'+FILE,import.meta.url),'utf8');
const certificate=rootCertificates.find(p=>{const c=new X509Certificate(p);return c.ca&&Date.parse(c.validFrom)<Date.now()&&Date.parse(c.validTo)>Date.now();});
const ctx=(environment='FairSwapTest')=>({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_SHA:'a'.repeat(40),APPROVED_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',FSW_RELEASE_ENABLED:'true',FSW_ENVIRONMENT:environment,GITHUB_TOKEN:'synthetic-github-secret',SUPABASE_ACCESS_TOKEN:'synthetic-project-secret',CHAT_RELEASE_AUDIT_TOKEN:'synthetic-audit-secret',CHAT_DATABASE_PASSWORD:'synthetic-password',CHAT_DB_POOLER_HOST:'aws-0-eu-central-1.pooler.supabase.com',CHAT_DB_SSL_ROOT_CERT_PEM:certificate,FSW_PSQL:'/synthetic/psql',FSW_CLI:'/synthetic/supabase',PATH:process.env.PATH});
const backup={id:1,status:'COMPLETED',inserted_at:new Date().toISOString(),is_physical_backup:true};
const proof=(environment='FairSwapTest')=>JSON.stringify({status:'PASS',environment,projectRef:refs[environment],sha256:SHA,verifiedAt:new Date().toISOString(),backupId:1,backupAvailable:true,automatedRestoreVerified:true,exclusiveBackendAuthority:true,backupSha256:sha(JSON.stringify(backup)),automatedRestoreReceiptSha256:sha('restore'),privilegedWriterInventorySha256:sha('inventory'),retiredWriterProofSha256:sha('retirement')});
const params=['query','category_id','category_slug','city_id','locality_id','condition','price_min','price_max','sort','page','per_page'];
function snapshot(environment) {return {capturedAt:new Date().toISOString(),tls:true,serverVersion:'170006',exposedSchemas:null,connection:{host:ctx().CHAT_DB_POOLER_HOST,port:'5432',user:'postgres.'+refs[environment]},ledger:[{version:'20260914000001',name:'synthetic',statementsSha256:sha('select 1')}],functions:['app_security','public'].map(schema=>({schema,owner:'postgres',volatility:'s',config:['search_path=""'],returnType:'jsonb',definer:schema==='app_security',acl:'{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',argNames:params.map(x=>schema==='app_security'?'p_'+x:x),bodySha256:sha(schema),bodyMd5:schema==='app_security'?'0ccc07eede6a6fa06b30acc06d9cdc10':environment==='FairSwapTest'?'821f536ad89962bc345586f175c86d23':'150b3b0298c05e2eb9733bd010e6f5a2'})),security:['categories','cities','listing_media','listings','localities','user_accounts'].map(table=>({table,rls:true}))};}
const schemas=()=>['app_security','public'].map(schema=>({schema,owner:'postgres',acl:null,rolePrivileges:['anon','authenticated','service_role'].map(role=>({role,usage:true,create:false}))}));
function harness(environment='FairSwapTest',options={}) {
 const calls=[],before=snapshot(environment);let applied=false;
 const fetcher=async(url,init)=>{
  calls.push(['GET',url]);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  if(options.missingPermissions)return {ok:false,headers:new Headers(),json:async()=>({jwt_secret:'NEVER_LOG'})};
  const result=url.includes('/postgrest')?{db_schema:options.exposed??'public',jwt_secret:'NEVER_LOG'}:url.includes('/backups')?{backups:[backup]}:{total_count:1,workflow_runs:[{head_sha:ctx().GITHUB_SHA,head_branch:'main',status:'completed',conclusion:options.ciFailure?'failure':'success'}]};
  return {ok:true,headers:new Headers(),json:async()=>result};
 };
 const runner=(binary,args,env,input)=>{
  calls.push([binary,...args]);assert.equal(env.PGSSLMODE,'verify-full');assert.equal(env.SUPABASE_DB_PASSWORD,ctx().CHAT_DATABASE_PASSWORD);
  if(args[0]==='--version')return binary.endsWith('psql')?'psql (PostgreSQL) 17.6':'2.117.0';
  if(args.includes('--help'))return '--linked --project-ref --db-url --dry-run';
  if(binary.endsWith('psql')) {
   assert.ok(args.find(a=>a.includes('sslmode=verify-full')));if(options.tlsFailure)throw Error('certificate failed '+ctx().CHAT_DATABASE_PASSWORD);
   if(input){const value=schemas();if(applied&&options.schemaDrift)value[0].owner='drift';return JSON.stringify(value);}
   const value=structuredClone(before);
   if(options.duplicate)value.ledger.push({version:VERSION,name:NAME,statementsSha256:LEDGER_SHA});
   if(applied){value.ledger.push({version:VERSION,name:NAME,statementsSha256:LEDGER_SHA});value.functions[0].bodySha256=sha(sql.split('AS $$')[1].split('$$;')[0]);value.functions[0].bodyMd5='new';if(options.catalogDrift)value.security[0].rls=false;}
   return JSON.stringify(value);
  }
  const workspace=args.at(-1);
  if(args[0]==='init'){mkdirSync(join(workspace,'supabase/migrations'),{recursive:true});return '';}
  if(args[0]==='link'){mkdirSync(join(workspace,'supabase/.temp'));writeFileSync(join(workspace,'supabase/.temp/project-ref'),refs[options.wrongLink?'FairSwapProd':environment]);return '';}
  if(args[0]==='migration'){assert.deepEqual(args.slice(0,3),['migration','fetch','--linked']);writeFileSync(join(workspace,'supabase/migrations/20260914000001_synthetic.sql'),options.historyDrift?'select 2;':'select 1;');return '';}
  assert.deepEqual(args.slice(0,3),['db','push','--db-url']);
  if(args.includes('--dry-run'))return FILE+(options.extraPending?'\n20261101000000_unexpected.sql':'');
  assert.ok(args.includes('--yes'));applied=true;return '';
 };
 return {calls,fetcher,runner,protection:async()=>({snapshotSha256:sha('protected')}),recoveryBytes:proof(environment)};
}
async function simulate(environment='FairSwapTest',options={}) {
 const dir=mkdtempSync(join(tmpdir(),'fsw-synthetic-'));const h=harness(environment,options);
 try {
  let failure;try{await release(environment,{...h,context:{...ctx(environment),...options.context},testReceiptBytes:options.testReceiptBytes,receiptDir:dir,...(options.noRecovery?{recoveryBytes:undefined}:{})});}catch(e){failure=e;}
  const bytes=readFileSync(join(dir,'receipt.json'));
  const receipt=JSON.parse(bytes);assert.equal(readFileSync(join(dir,'SHA256SUMS'),'utf8'),sha(bytes)+'  receipt.json\n');
  for(const secret of ['synthetic-password','synthetic-project-secret','synthetic-audit-secret','NEVER_LOG','BEGIN CERTIFICATE'])assert.ok(!bytes.includes(secret));
  for(const c of h.calls.filter(c=>c.includes('init')))assert.equal(existsSync(c.at(-1)),false,'private workspace removed');
  return {...h,receipt,bytes,failure};
 } finally {rmSync(dir,{recursive:true,force:true});}
}
test('complete synthetic Test path: independent history, dry-run, apply, postflight and sanitized checksum receipt',async()=>{
 const r=await simulate();assert.ifError(r.failure);assert.equal(r.receipt.status,'PASS');
 verifyTestReceipt(r.bytes,sha(r.bytes),ctx());
 assert.equal(r.calls.filter(c=>c.includes('--yes')).length,1);
 const dry=r.calls.findIndex(c=>c.includes('--dry-run')),apply=r.calls.findIndex(c=>c.includes('--yes'));
 assert.ok(dry>0&&apply>dry&&r.calls.slice(dry+1,apply).some(c=>c.includes('-f')));
});
for(const [name,options] of Object.entries({wrongEnvironment:{context:{FSW_ENVIRONMENT:'FairSwapProd'}},wrongSha:{context:{APPROVED_SHA:'b'.repeat(40)}},wrongActor:{context:{GITHUB_ACTOR:'other'}},wrongTrigger:{context:{GITHUB_TRIGGERING_ACTOR:'other'}},notMain:{context:{GITHUB_REF:'refs/heads/other'}},missingPermissions:{missingPermissions:true},tls:{tlsFailure:true},duplicateMigration:{duplicate:true},unexpectedPending:{extraPending:true},historyDrift:{historyDrift:true},linkedTarget:{wrongLink:true},ciFailure:{ciFailure:true},unknownExposure:{exposed:''},privateSchema:{exposed:'public,app_security'},missingRecovery:{noRecovery:true}}))test('blocks before apply: '+name,async()=>{const r=await simulate('FairSwapTest',options);assert.ok(r.failure);assert.equal(r.receipt.status,'FAIL');assert.equal(r.calls.some(c=>c.includes('--yes')),false);});
for(const name of ['catalogDrift','schemaDrift'])test('postflight failure preserves attempted-migration failure receipt: '+name,async()=>{const r=await simulate('FairSwapTest',{[name]:true});assert.ok(r.failure);assert.equal(r.receipt.status,'FAIL');assert.equal(r.receipt.migrationAttempted,true);});
test('Test receipt must match hash, environment, run, attempt, commit, artifact and freshness',async()=>{
 const {bytes}=await simulate();
 for(const key of ['runId','runAttempt','sourceCommit','sha256','environment','projectRef','status','postflight','completedAt','recoverySha256']) {
  const r=JSON.parse(bytes);r[key]=key==='completedAt'?'2000-01-01T00:00:00Z':'wrong';const changed=JSON.stringify(r);
  assert.throws(()=>verifyTestReceipt(changed,sha(changed),ctx()));
 }
 assert.throws(()=>verifyTestReceipt(bytes,'0'.repeat(64),ctx()));
});
test('unknown config, missing token and forbidden permission fail closed; secret config fields are discarded',async()=>{
 assert.deepEqual(await exposure('FairSwapTest','fixture',harness().fetcher),{projectRef:refs.FairSwapTest,schemas:['public']});
 await assert.rejects(()=>exposure('FairSwapTest','',harness().fetcher));
 await assert.rejects(()=>exposure('FairSwapTest','fixture',async()=>({ok:true,headers:new Headers(),json:async()=>({jwt_secret:'secret'})})));
});
test('fresh completed backup must be independently available and match reviewed digest',async()=>{
 await verifyBackup('FairSwapTest',proof(),'fixture',harness().fetcher);
 for(const mutate of [x=>{x.backupId=2;},x=>{x.backupSha256='0'.repeat(64);}]) {const r=JSON.parse(proof());mutate(r);await assert.rejects(()=>verifyBackup('FairSwapTest',JSON.stringify(r),'fixture',harness().fetcher));}
 for(const mutate of [x=>{delete x.automatedRestoreReceiptSha256;},x=>{x.verifiedAt='2000-01-01Z';},x=>{x.exclusiveBackendAuthority=false;}]){const r=JSON.parse(proof());mutate(r);assert.throws(()=>recovery('FairSwapTest',JSON.stringify(r)));}
});
test('workflow retains protected environments, owner actors, immutable receipt transfer and CI',()=>{
 const w=readFileSync(new URL('../../.github/workflows/fsw-sec-003-protected-release.yml',import.meta.url),'utf8');
 for(const value of ['workflow_dispatch:','cancel-in-progress: false','environment: FairSwapTest','environment: FairSwapProd','needs: [verify, test, verify_test]',"verifyTestReceipt(readFileSync('test-evidence/receipt.json')",'github.triggering_actor','inputs.approved_sha == github.sha','artifact-ids: ${{ needs.test.outputs.artifact_id }}','TEST_RECEIPT_SHA: ${{ needs.test.outputs.receipt_sha }}','always()','requireCi(process.env)','install-fsw-sec-003-pg.sh'])assert.ok(w.includes(value),value);
 assert.ok(!w.includes('continue-on-error')&&!w.includes('pull_request:')&&!w.includes('push:'));
 const ci=readFileSync(new URL('../../.github/workflows/backend-ci.yml',import.meta.url),'utf8');assert.ok(ci.includes('tests/fsw-sec-003/protected-release.test.mjs'));
});

test('Production consumes the exact successful same-run Test bytes and independently prepares its own history',async()=>{
 const t=await simulate();assert.ifError(t.failure);
 const p=await simulate('FairSwapProd',{testReceiptBytes:t.bytes,context:{TEST_RECEIPT_SHA:sha(t.bytes)}});
 assert.ifError(p.failure);assert.equal(p.receipt.status,'PASS');assert.equal(p.receipt.projectRef,refs.FairSwapProd);
 assert.ok(p.calls.some(c=>c.includes(refs.FairSwapProd)));
 assert.ok(p.calls.filter(c=>c[0]==='GET'&&c[1].includes('api.supabase.com')).every(c=>c[1].includes(refs.FairSwapProd)));
 for(const overrides of [{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_RUN_ID:'13'},{TEST_RECEIPT_SHA:'0'.repeat(64)}]) {
  const r=await simulate('FairSwapProd',{testReceiptBytes:t.bytes,context:{TEST_RECEIPT_SHA:sha(t.bytes),...overrides}});
  assert.ok(r.failure);assert.equal(r.calls.length,0);
 }
});
