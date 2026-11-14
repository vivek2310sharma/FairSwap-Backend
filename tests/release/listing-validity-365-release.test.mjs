import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {getCandidate,planDispatch,verifyCandidateSha} from '../../scripts/release/reusable-candidates.mjs';
import {expectedValidityFunctions,readValiditySnapshot,snapshotSql,verifyValidityPostflight,verifyValidityTestReceipt,VALIDITY_SCOPE} from '../../scripts/release/listing-validity-365-release.mjs';
import {releaseReusable} from '../../scripts/release/reusable-supabase-release.mjs';
const source=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const fixtures=JSON.parse(source('tests/listing-validity-365/hosted-functions.json'));
const functions=Object.fromEntries([...fixtures.production,fixtures.notification].map(f=>{
 const name=f.proname==='trg_fn_listing_transition_notification'?'public.'+f.proname:'app_security.'+f.proname;
 return [name,f.definition.replaceAll('\r\n','\n')];
}));
const baseline=()=>({capturedAt:'2026-11-14T12:00:00Z',functions,security:{tables:['RLS','ACL'],policies:['owner']},rows:{
 eligible:{fingerprint:'a',expiry:'2026-12-01 00:00:00+00',desired:'2027-11-01 00:00:00+00',eligible:true},
 sold:{fingerprint:'b',expiry:'2026-12-01 00:00:00+00',desired:'2027-11-01 00:00:00+00',eligible:false},
 'f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8':{fingerprint:'c',expiry:'2027-11-11 18:49:01.486986+00',desired:'2027-10-12 11:01:31.760406+00',eligible:false}
}});
const after=before=>{const value=structuredClone(before);value.functions=expectedValidityFunctions(before.functions);value.rows.eligible.expiry=value.rows.eligible.desired;return value;};
const context={GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
const receipt=()=>{const c=getCandidate('listing-validity-365');return {
 environment:'FairSwapTest',projectRef:'wpppxlnbzqynvhpeuavd',candidateId:c.id,migrationVersion:c.version,migrationFile:c.filename,migrationSha256:c.sha256,
 reviewedCommit:context.GITHUB_SHA,releaseWorkflowRun:'123',releaseWorkflowAttempt:'1',status:'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED',postflightVerified:true,postflightScope:VALIDITY_SCOPE,dryRunPending:[c.filename],ledgerStatementsSha256:'b'.repeat(64)
};};
test('unchanged versioned migration is hash-pinned and uses automatic promotion in existing pipeline',()=>{
 const c=verifyCandidateSha('listing-validity-365',fileURLToPath(new URL('../..',import.meta.url))).candidate;
 assert.equal(c.version,'20261111194340');assert.equal(c.autoPromote,true);
 assert.equal(planDispatch({candidateId:c.id,target:'test'}).candidate,c);
 assert.throws(()=>planDispatch({candidateId:c.id,target:'production'}),/TARGET_NOT_SUPPORTED/);
 assert.throws(()=>planDispatch({candidateId:c.id,target:'adopt'}),/ADOPTION_NOT_REGISTERED/);
});
test('read-only snapshot SQL covers exact expiry, owner/moderation functions, RLS and grants without persisting rows',()=>{
 assert.match(snapshotSql,/BEGIN READ ONLY/);assert.match(snapshotSql,/l\.expires_at::text/);
 assert.match(snapshotSql,/impl_seller_transition_listing/);assert.match(snapshotSql,/pg_policies/);assert.match(snapshotSql,/proacl/);
 assert.match(snapshotSql,/md5\(\(to_jsonb\(l\)/);
 assert.deepEqual(readValiditySnapshot(sql=>{assert.equal(sql,snapshotSql);return JSON.stringify(baseline());}),baseline());
 assert.throws(()=>readValiditySnapshot(()=>'{bad'),/SNAPSHOT_INVALID/);
});
test('postflight proves only reviewed function edits and eligible extensions',()=>{const b=baseline();assert.equal(verifyValidityPostflight(b,after(b)).status,'PASS');});
for(const kind of ['RLS','moderation','protected-microsecond','sold','shorter','unextended','ownership','missing-row']) test(`postflight rejects ${kind} drift`,()=>{
 const b=baseline(),a=after(b);
 if(kind==='RLS')a.security.policies=[];
 if(kind==='moderation')a.functions['app_security.impl_finalize_moderation_result_azure_v1']+='\n--unreviewed';
 if(kind==='protected-microsecond')a.rows['f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8'].expiry='2027-11-11 18:49:01.486987+00';
 if(kind==='sold')a.rows.sold.expiry=a.rows.sold.desired;
 if(kind==='shorter')a.rows.eligible.expiry='2026-11-15 00:00:00+00';
 if(kind==='unextended')a.rows.eligible.expiry=b.rows.eligible.expiry;
 if(kind==='ownership')a.rows.eligible.fingerprint='changed';
 if(kind==='missing-row')delete a.rows.sold;
 assert.throws(()=>verifyValidityPostflight(b,a),/POSTFLIGHT_FAILED/);
});
test('same-run successful Test receipt binds source, candidate, attempt and ledger digest',()=>{
 assert.equal(verifyValidityTestReceipt(receipt(),context),'b'.repeat(64));
 for(const [key,value] of Object.entries({environment:'FairSwapProd',migrationSha256:'c'.repeat(64),reviewedCommit:'c'.repeat(40),releaseWorkflowRun:'124',releaseWorkflowAttempt:'2',postflightVerified:false,postflightScope:'other',ledgerStatementsSha256:'',dryRunPending:[]})){
  assert.throws(()=>verifyValidityTestReceipt({...receipt(),[key]:value},context),/TEST_RECEIPT_INVALID/);
 }
});
test('Production runner rejects absent Test evidence before touching credentials, CLI or database',async()=>{
 let called=false;
 await assert.rejects(()=>releaseReusable({environment:'FairSwapProd',candidateId:'listing-validity-365',context:{TARGET:'test'},runner:()=>{called=true;throw Error('called');}}),/LISTING_VALIDITY_TEST_EVIDENCE_REQUIRED/);
 assert.equal(called,false);
});
test('existing workflow gates Test receipt, Production and postflight without a new workflow or secret',()=>{
 const workflow=source('.github/workflows/reusable-supabase-release.yml');
 assert.match(workflow,/listing-validity-365/);assert.match(workflow,/verifyValidityTestReceipt/);
 assert.match(workflow,/LISTING_VALIDITY_TEST_LEDGER_SHA: \$\{\{ needs.verify_test.outputs.listing_validity_ledger_sha/);
 assert.match(workflow,/needs\.verify_test\.result == 'success'/);
 assert.match(workflow,/inputs\.candidate != 'listing-validity-365'/);
 const runner=source('scripts/release/reusable-supabase-release.mjs');
 assert.match(runner,/verifyValidityPostflight\(catalogueBefore/);assert.match(runner,/verifyHistoryPreserved/);
 assert.match(runner,/verifyTabletsLedger\(ledgerBefore, readLedger\(\), candidate\)/);
 const ci=source('.github/workflows/backend-ci.yml');
 assert.match(ci,/test-listing-validity-365\.mjs --pglite-module=tests\/ratings\/node_modules\/@electric-sql\/pglite\/dist\/index.js/);
});

test('existing CLI runner completes Test then Production with pinned ledger and automatic postflight (mock subprocesses only)',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {rootCertificates}=await import('node:tls');const {X509Certificate}=await import('node:crypto');
 const certificate=rootCertificates.find(p=>{const c=new X509Certificate(p);return c.ca&&Date.parse(c.validFrom)<=Date.now()&&Date.parse(c.validTo)>Date.now();});
 const dir=mkdtempSync(join(tmpdir(),'validity-release-test-'));
 try {
  const c=getCandidate('listing-validity-365');let testDigest;
  for(const environment of ['FairSwapTest','FairSwapProd']) {
   let applied=false,postflight=false;
   const history=Array.from({length:50},(_,i)=>({version:String(20260101000000+i),name:'historical',hasStatements:true,statementCount:1,statementsSha256:'d'.repeat(64)}));
   const candidateRow={version:c.version,name:c.filename.slice(15,-4),hasStatements:true,statementCount:1,statementsSha256:'b'.repeat(64)};
   const runner=(cmd,args)=>{
    if(cmd==='psql') {
     const sql=args[args.indexOf('-c')+1];
     if(sql.includes('schema_migrations'))return JSON.stringify(applied?[...history,candidateRow]:history);
     assert(sql.includes("'capturedAt'"),'unexpected query');
     if(applied)postflight=true;
     return JSON.stringify(applied?after(baseline()):baseline());
    }
    assert.equal(cmd,'supabase');
    if(args[0]==='--version')return '2.117.0';
    const workspace=args[args.indexOf('--workdir')+1];
    if(args[0]==='init'){mkdirSync(join(workspace,'supabase/migrations'),{recursive:true});mkdirSync(join(workspace,'supabase/.temp'),{recursive:true});return '';}
    if(args[0]==='link'){writeFileSync(join(workspace,'supabase/.temp/project-ref'),environment==='FairSwapTest'?'wpppxlnbzqynvhpeuavd':'kriuhwppxgxsyyrbjsau');return '';}
    if(args[0]==='migration'&&args[1]==='fetch'){for(const row of history)writeFileSync(join(workspace,'supabase/migrations',`${row.version}_historical.sql`),'select 1;');return '';}
    if(args[0]==='migration'&&args[1]==='list')return 'LOCAL | REMOTE | TIME (UTC)\n'+[...history,...(applied?[candidateRow]:[])].map(row=>`${row.version} | ${row.version} | x`).join('\n');
    if(args[0]==='db'&&args[1]==='push'){
     if(args.includes('--dry-run'))return c.filename;
     assert(args.includes('--yes'));assert.equal(applied,false);applied=true;return '';
    }
    assert.fail('unexpected subprocess');
   };
   const result=await releaseReusable({environment,candidateId:c.id,runner,receiptDir:dir,context:{...context,TARGET:'test',
    SUPABASE_ACCESS_TOKEN:'synthetic',CHAT_DATABASE_PASSWORD:'synthetic',CHAT_DB_POOLER_HOST:'aws-0-ap-south-1.pooler.supabase.com',CHAT_DB_SSL_ROOT_CERT_PEM:certificate,
    ...(testDigest?{LISTING_VALIDITY_TEST_LEDGER_SHA:testDigest}:{})}});
   assert.equal(applied,true);assert.equal(postflight,true);assert.equal(result.postflightScope,VALIDITY_SCOPE);
   if(environment==='FairSwapTest')testDigest=verifyValidityTestReceipt(result,context);
   else assert.equal(result.ledgerStatementsSha256,testDigest);
   assert(!JSON.stringify(result).includes('fingerprint'));
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('read-only snapshot query executes on isolated PostgreSQL and excludes the protected listing from backfill',async()=>{
 const {resolve}=await import('node:path');const {pathToFileURL}=await import('node:url');
 const path=process.env.FSW_PGLITE_MODULE??resolve('tests/ratings/node_modules/@electric-sql/pglite/dist/index.js');
 const {PGlite}=await import(pathToFileURL(resolve(path)).href);const db=new PGlite();
 try {
  await db.exec(`create schema app_security;
   create table public.categories(id uuid primary key,is_active boolean);
   create table public.listings(id uuid primary key,seller_id uuid,category_id uuid,status text,published_at timestamptz,expires_at timestamptz,sold_at timestamptz,updated_at timestamptz);
   create function app_security.get_account_status(uuid) returns text language sql as $$select 'active'::text$$;
   create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql as $$select true$$;
   create function public.trg_fn_listing_transition_notification() returns trigger language plpgsql as $$begin return new;end$$;`);
  for(const name of ['impl_moderate_listing','impl_finalize_moderation_result_azure_v1','impl_seller_transition_listing','is_listing_publicly_visible'])await db.exec(`create function app_security.${name}() returns boolean language sql as $$select true$$`);
  await db.exec(`insert into public.categories values('44444444-4444-4444-8444-444444444444',true);
   insert into public.listings select id,gen_random_uuid(),'44444444-4444-4444-8444-444444444444','active',now(),now()+interval '30 days',null,now()
   from unnest(array['f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8'::uuid,'11111111-1111-4111-8111-111111111111'::uuid]) id;`);
  const results=await db.exec(snapshotSql);const json=results.flatMap(r=>r.rows).find(r=>r.jsonb_build_object)?.jsonb_build_object;
  const snapshot=readValiditySnapshot(()=>JSON.stringify(json));
  assert.equal(snapshot.rows['f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8'].eligible,false);
  assert.equal(snapshot.rows['11111111-1111-4111-8111-111111111111'].eligible,true);
  assert.equal(snapshot.rows['11111111-1111-4111-8111-111111111111'].fingerprint.length,32);
 } finally {await db.close();}
});
