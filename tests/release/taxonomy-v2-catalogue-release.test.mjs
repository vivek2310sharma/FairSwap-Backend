import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {getCandidate,verifyCandidateSha,planDispatch} from '../../scripts/release/reusable-candidates.mjs';
import {assertLedgerOrdering} from '../../scripts/release/accessories-v1-release.mjs';
import {releaseReusable} from '../../scripts/release/reusable-supabase-release.mjs';
import {CATALOGUE_CANDIDATE as ID,CATALOGUE_SCOPE as SCOPE,snapshotSql,postflightSql,readCatalogueSnapshot,runCataloguePreflight,verifyCataloguePostflight,verifyCatalogueTestReceipt} from '../../scripts/release/taxonomy-v2-catalogue-release.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const oldRow=(slug)=>({slug,stable:'a'.repeat(32),sort_order:1,status:null,parent_id:null,posting_flow:null,catalogue_mode:null});
const before=()=>({categories:{phone:oldRow('mobile-phones'),tablet:oldRow('tablets'),wearable:oldRow('wearables'),broad:oldRow('books')},installed:true,empty:true,managedCount:0,taxonomyRevision:'foundation-1',listings:'b'.repeat(32),catalogues:{all:'unchanged'},security:{tables:'same',policies:'same',functions:'same'},package2Integrity:{all:'same'}});
const after=(b)=>{
 const a=structuredClone(b);a.managedCount=78;a.taxonomyRevision='catalogue-2';
 for(const [id,order,flow] of [['phone',101,'phone'],['tablet',102,'tablet'],['wearable',103,'wearable']])Object.assign(a.categories[id],{sort_order:order,status:'live',parent_id:'root',posting_flow:'specialist:'+flow,catalogue_mode:'brand_model'});
 for(let n=0;n<75;n++)a.categories['new-'+n]={slug:'new-'+n};return a;
};
const keys=['nodes','roots','leaves','modes','config','unimplemented','specialistGenericClosed','rootClosed','servicesJobs','api','guards','privateHelpers','rls','empty'];
const checks=()=>Object.fromEntries(keys.map(k=>[k,true]));
const context={GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'234',GITHUB_RUN_ATTEMPT:'1'};
const receipt=()=>{const c=getCandidate(ID);return {environment:'FairSwapTest',projectRef:'wpppxlnbzqynvhpeuavd',candidateId:ID,migrationVersion:c.version,migrationFile:c.filename,migrationSha256:c.sha256,reviewedCommit:context.GITHUB_SHA,releaseWorkflowRun:'234',releaseWorkflowAttempt:'1',status:'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED',postflightVerified:true,postflightScope:SCOPE,dryRunPending:[c.filename],ledgerStatementsSha256:'b'.repeat(64)};};

test('Package 2 is hash-pinned after the deployed foundation and Test-only dispatch promotes automatically',()=>{
 const c=verifyCandidateSha(ID).candidate;
 assert.equal(c.version,'20261118092010');assert.equal(c.autoPromote,true);
 assert.equal(planDispatch({candidateId:ID,target:'test'}).candidate,c);
 assert.throws(()=>planDispatch({candidateId:ID,target:'production'}),/TARGET_NOT_SUPPORTED/);
 assert.throws(()=>planDispatch({candidateId:ID,target:'adopt'}),/ADOPTION_NOT_REGISTERED/);
 const ledger=v=>'LOCAL | REMOTE | TIME (UTC)\n'+v.map(x=>`${x} | ${x} | x`).join('\n');
 assert.throws(()=>assertLedgerOrdering(c,ledger(['20261111195641'])),/PREREQUISITE_MIGRATION_MISSING/);
 assert.equal(assertLedgerOrdering(c,ledger(['20261117185218'])).state,'absent');
});
test('preflight requires an untouched foundation and empty generic tables',()=>{
 assert.deepEqual(runCataloguePreflight(()=>JSON.stringify(before())),before());
 for(const changed of [{managedCount:1},{taxonomyRevision:'catalogue-2'},{empty:false}])assert.throws(()=>runCataloguePreflight(()=>JSON.stringify({...before(),...changed})),/PREREQUISITE_OR_PARTIAL_STATE/);
 assert.throws(()=>readCatalogueSnapshot(()=>'{'),/INVALID_RESPONSE/);
 assert.match(snapshotSql,/begin read only/i);assert.match(postflightSql,/begin read only/i);
});
test('postflight allows exactly three metadata mappings and 75 deterministic new categories',()=>{
 const b=before();assert.deepEqual(verifyCataloguePostflight(b,after(b),checks()),{status:'PASS',scope:SCOPE});
});
for(const kind of ['listing','legacy-category','specialist-id','specialist-flow','security','attributes','new-count'])test('postflight rejects '+kind+' drift',()=>{
 const b=before(),a=after(b);
 if(kind==='listing')a.listings='changed';
 if(kind==='legacy-category')a.categories.broad.status='hidden';
 if(kind==='specialist-id'){a.categories.rekeyed=a.categories.phone;delete a.categories.phone;}
 if(kind==='specialist-flow')a.categories.phone.posting_flow='generic';
 if(kind==='security')a.security.policies='weakened';
 if(kind==='attributes')a.package2Integrity.all='changed';
 if(kind==='new-count')delete a.categories['new-0'];
 assert.throws(()=>verifyCataloguePostflight(b,a,checks()),/PRESERVATION_FAILED/);
});
test('postflight fails every count, mode, route, API, RLS or emptiness denial',()=>{
 const b=before();for(const key of keys)assert.throws(()=>verifyCataloguePostflight(b,after(b),{...checks(),[key]:false}),/POSTFLIGHT_FAILED/);
});
test('Package 2 receipt cannot reuse a foundation proof, another source, attempt or workflow run',()=>{
 assert.equal(verifyCatalogueTestReceipt(receipt(),context),'b'.repeat(64));
 for(const changed of [{candidateId:'taxonomy-v2-foundation'},{postflightScope:'taxonomy-v2-foundation-integrity'},{reviewedCommit:'c'.repeat(40)},{migrationSha256:'c'.repeat(64)},{releaseWorkflowRun:'999'},{releaseWorkflowAttempt:'2'},{postflightVerified:false},{dryRunPending:[]}])assert.throws(()=>verifyCatalogueTestReceipt({...receipt(),...changed},context),/TEST_RECEIPT_INVALID/);
});
test('existing workflow gates catalogue Production on verified same-run Test proof and required CI',()=>{
 const w=read('.github/workflows/reusable-supabase-release.yml');
 assert.match(w,/- taxonomy-v2-catalogue\n/);assert.match(w,/verifyCatalogueTestReceipt/);
 assert(w.includes("inputs.candidate != 'taxonomy-v2-catalogue' || needs.verify_test.outputs.taxonomy_ledger_sha != ''"));
 assert(w.includes("&& inputs.candidate != 'taxonomy-v2-catalogue')"));
 const ci=read('.github/workflows/backend-ci.yml');
 for(const count of [53,55]){assert(ci.includes(`--category-count=${count} --package=2\n`));assert(ci.includes(`--category-count=${count} --package=2 --native-bin=`));}
 assert(ci.includes('tests/release/taxonomy-v2-catalogue-release.test.mjs'));
});
test('existing CLI pipeline enforces Test -> Production and refuses bad Package 2 postflight/ledger (mock subprocesses)',async()=>{
 const cert=rootCertificates.find(p=>{const c=new X509Certificate(p);return c.ca&&Date.parse(c.validFrom)<=Date.now()&&Date.parse(c.validTo)>Date.now();});
 const dir=mkdtempSync(join(tmpdir(),'taxonomy-p2-release-'));const c=getCandidate(ID);
 const run=async(environment,{digest,drift=false,ledgerDigest='b'.repeat(64)}={})=>{
  let applied=false;
  const history=Array.from({length:50},(_,i)=>({version:String(20260101000000+i),name:'historical',hasStatements:true,statementCount:1,statementsSha256:'d'.repeat(64)}));
  history.push({version:'20261117185218',name:'taxonomy_v2_foundation',hasStatements:true,statementCount:1,statementsSha256:'c'.repeat(64)});
  const row={version:c.version,name:c.filename.slice(15,-4),hasStatements:true,statementCount:1,statementsSha256:ledgerDigest};
  const runner=(cmd,args)=>{
   if(cmd==='psql'){
    const sql=args[args.indexOf('-c')+1];
    if(sql.includes('schema_migrations'))return JSON.stringify(applied?[...history,row]:history);
    if(sql===snapshotSql){const b=before();return JSON.stringify(applied?after(b):b);}
    if(sql===postflightSql)return JSON.stringify({...checks(),...(drift?{unimplemented:false}:{})});
    assert.fail('Unexpected SQL');
   }
   assert.equal(cmd,'supabase');if(args[0]==='--version')return '2.117.0';
   const ws=args[args.indexOf('--workdir')+1];
   if(args[0]==='init'){mkdirSync(join(ws,'supabase/migrations'),{recursive:true});mkdirSync(join(ws,'supabase/.temp'),{recursive:true});return '';}
   if(args[0]==='link'){writeFileSync(join(ws,'supabase/.temp/project-ref'),environment==='FairSwapTest'?'wpppxlnbzqynvhpeuavd':'kriuhwppxgxsyyrbjsau');return '';}
   if(args[0]==='migration'&&args[1]==='fetch'){for(const r of history)writeFileSync(join(ws,'supabase/migrations',`${r.version}_${r.name}.sql`),'select 1;');return '';}
   if(args[0]==='migration'&&args[1]==='list')return 'LOCAL | REMOTE | TIME (UTC)\n'+[...history,...(applied?[row]:[])].map(r=>`${r.version} | ${r.version} | x`).join('\n');
   if(args[0]==='db'&&args[1]==='push'){if(args.includes('--dry-run'))return c.filename;assert(args.includes('--yes'));assert(!applied);applied=true;return '';}
   assert.fail('Unexpected subprocess');
  };
  return releaseReusable({environment,candidateId:ID,runner,receiptDir:dir,context:{...context,TARGET:'test',SUPABASE_ACCESS_TOKEN:'synthetic',CHAT_DATABASE_PASSWORD:'synthetic',CHAT_DB_POOLER_HOST:'aws-0-ap-south-1.pooler.supabase.com',CHAT_DB_SSL_ROOT_CERT_PEM:cert,...(digest?{TAXONOMY_TEST_LEDGER_SHA:digest}:{})}});
 };
 try{
  await assert.rejects(run('FairSwapProd'),/TEST_EVIDENCE_REQUIRED/);
  const r=await run('FairSwapTest');const digest=verifyCatalogueTestReceipt(r,context);
  await assert.rejects(run('FairSwapProd',{digest,ledgerDigest:'d'.repeat(64)}),/TEST_LEDGER_MISMATCH/);
  await assert.rejects(run('FairSwapProd',{digest,drift:true}),/POSTFLIGHT_FAILED/);
  assert(!existsSync(join(dir,ID+'-fairswapprod.json')));
  assert.equal((await run('FairSwapProd',{digest})).testLedgerStatementsSha256,digest);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
