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
import {TAXONOMY_CANDIDATE as ID,TAXONOMY_SCOPE as SCOPE,snapshotSql,postflightSql,readTaxonomySnapshot,runTaxonomyPreflight,verifyTaxonomyPostflight,verifyTaxonomyTestReceipt} from '../../scripts/release/taxonomy-v2-release.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const names=['phone_brands','phone_models','tablet_brands_v1','tablet_models_v1','wearable_brands_v1','wearable_models_v1','car_brands','car_models','vehicle_brands','vehicle_models',
 'listing_mobile_contexts','listing_tablet_contexts','listing_wearable_contexts_v1','listing_car_contexts','listing_vehicle_contexts','posting_category_definitions'];
const baseline=()=>({categories:'a'.repeat(32),listings:'b'.repeat(32),catalogues:Object.fromEntries(names.map(n=>[n,'c'.repeat(32)])),security:{tables:['unchanged'],policies:['owner and policy'],columnGrants:['minimal'],functions:['moderation'],triggers:['existing']},installed:false});
const checks=()=>Object.fromEntries(['empty','legacy','rls','lookupReadOnly','identityGrants','api','depthFK','listingGuard'].map(k=>[k,true]));
const context={GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
const receipt=()=>{const c=getCandidate(ID);return {environment:'FairSwapTest',projectRef:'wpppxlnbzqynvhpeuavd',candidateId:ID,migrationVersion:c.version,migrationFile:c.filename,migrationSha256:c.sha256,reviewedCommit:context.GITHUB_SHA,releaseWorkflowRun:'123',releaseWorkflowAttempt:'1',status:'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED',postflightVerified:true,postflightScope:SCOPE,dryRunPending:[c.filename],ledgerStatementsSha256:'b'.repeat(64)};};

test('foundation bytes are unchanged, registered and Test-only dispatch auto-promotes',()=>{
 const c=verifyCandidateSha(ID).candidate;
 assert.equal(c.sha256,'85e6e501e009dc56bc7ba4e28fb72b8b827e35c031fff7f283d0a373b92bbc25');
 assert.equal(c.autoPromote,true);assert.equal(planDispatch({candidateId:ID,target:'test'}).candidate,c);
 assert.throws(()=>planDispatch({candidateId:ID,target:'production'}),/TARGET_NOT_SUPPORTED/);
 assert.throws(()=>planDispatch({candidateId:ID,target:'adopt'}),/ADOPTION_NOT_REGISTERED/);
});
test('taxonomy rejects mismatched local/remote history before apply',()=>{
 const c=getCandidate(ID);
 const valid='LOCAL | REMOTE | TIME (UTC)\n20260101000000 | 20260101000000 | x';
 assert.equal(assertLedgerOrdering(c,valid).state,'absent');
 assert.throws(()=>assertLedgerOrdering(c,valid+'\n20260101000001 | | x'),/LEDGER_HISTORY_CHANGED/);
 assert.throws(()=>assertLedgerOrdering(c,valid+'\n | 20260101000001 | x'),/LEDGER_HISTORY_CHANGED/);
});
test('preflight fails on partial installation and malformed or missing specialist evidence',()=>{
 assert.equal(runTaxonomyPreflight(()=>JSON.stringify(baseline())).installed,false);
 assert.throws(()=>runTaxonomyPreflight(()=>JSON.stringify({...baseline(),installed:true})),/PARTIAL_OR_EXISTING_STATE/);
 assert.throws(()=>readTaxonomySnapshot(()=>'{'),/INVALID_RESPONSE/);
 const b=baseline();delete b.catalogues.wearable_models_v1;
 assert.throws(()=>readTaxonomySnapshot(()=>JSON.stringify(b)),/INVALID_SNAPSHOT/);
 assert.match(snapshotSql,/BEGIN READ ONLY/);assert.match(postflightSql,/BEGIN READ ONLY/);
});
test('postflight accepts unchanged five-specialist contracts and zero-data foundation',()=>{
 const b=baseline();assert.deepEqual(verifyTaxonomyPostflight(b,{...b,installed:true},checks()),{status:'PASS',scope:SCOPE});
});
for(const kind of ['listings','categories','catalogues','security'])test(`postflight withholds success on ${kind} drift`,()=>{
 const b=baseline(),after=structuredClone({...b,installed:true});after[kind]=kind==='security'?{}:'changed';
 assert.throws(()=>verifyTaxonomyPostflight(b,after,checks()),/PRESERVATION_FAILED/);
});
test('postflight rejects imported lookup data, seeded nodes, weakened RLS and missing guards',()=>{
 const b=baseline();for(const key of Object.keys(checks()))assert.throws(()=>verifyTaxonomyPostflight(b,{...b,installed:true},{...checks(),[key]:false}),/POSTFLIGHT_FAILED/);
});
test('Test receipt binds same source, candidate, run, attempt and installed statements',()=>{
 assert.equal(verifyTaxonomyTestReceipt(receipt(),context),'b'.repeat(64));
 for(const [key,value] of Object.entries({environment:'FairSwapProd',migrationSha256:'c'.repeat(64),reviewedCommit:'c'.repeat(40),releaseWorkflowRun:'124',releaseWorkflowAttempt:'2',postflightVerified:false,postflightScope:'other',ledgerStatementsSha256:'',dryRunPending:[]}))
  assert.throws(()=>verifyTaxonomyTestReceipt({...receipt(),[key]:value},context),/TEST_RECEIPT_INVALID/);
});
test('Production is rejected before any subprocess without same-run Test evidence',async()=>{
 let called=false;
 for(const over of [{},{TARGET:'production',TAXONOMY_TEST_LEDGER_SHA:'b'.repeat(64)}])
  await assert.rejects(releaseReusable({environment:'FairSwapProd',candidateId:ID,context:over,runner:()=>{called=true;}}),/TAXONOMY_TEST_EVIDENCE_REQUIRED/);
 assert.equal(called,false);
});
test('existing workflow requires successful Test, hash-verified receipt and taxonomy proof before Production',()=>{
 const w=read('.github/workflows/reusable-supabase-release.yml');
 assert.match(w,/- taxonomy-v2-foundation\n/);
 assert(w.indexOf('sha256sum --check --status')<w.indexOf('Verify Taxonomy V2 Test postflight receipt'));
 assert(w.includes("inputs.candidate != 'taxonomy-v2-foundation' || needs.verify_test.outputs.taxonomy_ledger_sha != ''"));
 assert(w.includes("inputs.candidate != 'listing-validity-365' && inputs.candidate != 'taxonomy-v2-foundation' && inputs.candidate != 'taxonomy-v2-catalogue')"));
 assert.match(w,/TAXONOMY_TEST_LEDGER_SHA: \$\{\{ needs.verify_test.outputs.taxonomy_ledger_sha/);
 assert.match(w,/secrets\.FAIRSWAP_TEST_DB_PASSWORD/);assert.match(w,/secrets\.FAIRSWAP_PROD_DB_PASSWORD/);
 assert.doesNotMatch(w,/^ {4}environment:/m);
});

test('existing CLI orchestration preserves history, verifies Test then Production and withholds bad receipts (mock subprocesses only)',async()=>{
 const certificate=rootCertificates.find(p=>{const c=new X509Certificate(p);return c.ca&&Date.parse(c.validFrom)<=Date.now()&&Date.parse(c.validTo)>Date.now();});
 const dir=mkdtempSync(join(tmpdir(),'taxonomy-release-test-'));
 const c=getCandidate(ID);
 const execute=async(environment,{testDigest,drift=false,ledgerDigest='b'.repeat(64),already=false}={})=>{
  let applied=already,postflight=false;
  const history=Array.from({length:50},(_,i)=>({version:String(20260101000000+i),name:'historical',hasStatements:true,statementCount:1,statementsSha256:'d'.repeat(64)}));
  const row={version:c.version,name:c.filename.slice(15,-4),hasStatements:true,statementCount:1,statementsSha256:ledgerDigest};
  const runner=(cmd,args)=>{
   if(cmd==='psql'){
    const sql=args[args.indexOf('-c')+1];
    if(sql.includes('schema_migrations'))return JSON.stringify(applied?[...history,row]:history);
    if(sql===snapshotSql){if(applied)postflight=true;return JSON.stringify({...baseline(),installed:applied,...(applied&&drift?{listings:'f'.repeat(32)}:{})});}
    if(sql===postflightSql)return JSON.stringify(checks());
    assert.fail('Unexpected SQL');
   }
   assert.equal(cmd,'supabase');if(args[0]==='--version')return '2.117.0';
   const workspace=args[args.indexOf('--workdir')+1];
   if(args[0]==='init'){mkdirSync(join(workspace,'supabase/migrations'),{recursive:true});mkdirSync(join(workspace,'supabase/.temp'),{recursive:true});return '';}
   if(args[0]==='link'){writeFileSync(join(workspace,'supabase/.temp/project-ref'),environment==='FairSwapTest'?'wpppxlnbzqynvhpeuavd':'kriuhwppxgxsyyrbjsau');return '';}
   if(args[0]==='migration'&&args[1]==='fetch'){for(const item of history)writeFileSync(join(workspace,'supabase/migrations',`${item.version}_historical.sql`),'select 1;');return '';}
   if(args[0]==='migration'&&args[1]==='list')return 'LOCAL | REMOTE | TIME (UTC)\n'+[...history,...(applied?[row]:[])].map(item=>`${item.version} | ${item.version} | x`).join('\n');
   if(args[0]==='db'&&args[1]==='push'){if(args.includes('--dry-run'))return c.filename;assert(args.includes('--yes'));assert.equal(applied,false);applied=true;return '';}
   assert.fail('Unexpected subprocess');
  };
  const result=await releaseReusable({environment,candidateId:ID,runner,receiptDir:dir,context:{...context,TARGET:'test',
   SUPABASE_ACCESS_TOKEN:'synthetic',CHAT_DATABASE_PASSWORD:'synthetic',CHAT_DB_POOLER_HOST:'aws-0-ap-south-1.pooler.supabase.com',CHAT_DB_SSL_ROOT_CERT_PEM:certificate,
   ...(testDigest?{TAXONOMY_TEST_LEDGER_SHA:testDigest}:{})}});
  assert(applied&&postflight);assert.equal(result.postflightScope,SCOPE);return result;
 };
 try {
  const testReceipt=await execute('FairSwapTest');const digest=verifyTaxonomyTestReceipt(testReceipt,context);
  await assert.rejects(execute('FairSwapProd',{testDigest:digest,ledgerDigest:'e'.repeat(64)}),/TEST_LEDGER_MISMATCH/);
  await assert.rejects(execute('FairSwapProd',{testDigest:digest,drift:true}),/PRESERVATION_FAILED/);
  assert(!existsSync(join(dir,ID+'-fairswapprod.json')));
  const prod=await execute('FairSwapProd',{testDigest:digest});assert.equal(prod.testLedgerStatementsSha256,digest);
  assert(!JSON.stringify(prod).includes('catalogues'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
