// Disposable in-memory PostgreSQL only. Transport/PG17 identity are synthetic;
// full catalog SQL executes, while TLS and hosted identity remain runtime gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '../ratings/node_modules/@electric-sql/pglite/dist/index.js';
import {parseMetadata,subprocessFailure,safeFailure,release} from '../../scripts/release/fsw-sec-003-prelaunch.mjs';
import {materializeNullHistory,verifyHistory,verifyCapture,refs,sha} from './release-gate.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
async function fixture(fn) {
 const db=new PGlite();
 try {
  const old=read('supabase/migrations/20261001000031_harden_public_listing_location_privacy.sql');
  const discovery=read('supabase/migrations/20260914000009_create_discovery_and_favourites.sql');
  await db.exec(read('tests/fsw-sec-003/fixture.sql')+old.slice(old.indexOf('CREATE OR REPLACE FUNCTION'),old.indexOf('-- 2. Revoke'))+discovery.slice(discovery.indexOf('REVOKE ALL ON FUNCTION app_security.impl_search_public_listings')));
  await db.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]); insert into supabase_migrations.schema_migrations values ('20260914000001','fixture',array['select 1']),('20261023160752','legacy',null);");
  const capture=async environment=>{
   const sql=read('tests/fsw-sec-003/capture-release.sql').replaceAll(":'HOST'",`'db.${refs[environment]}.supabase.co'`).replaceAll(":'PORT'","'5432'").replaceAll(":'USER'","'postgres'");
   const results=await db.exec(sql);
   return results.find(x=>x.rows?.length).rows[0].jsonb_build_object;
  };
  await fn(db,capture);
 }finally{await db.close();}
}
const identity=meta=>({...meta,tls:true,serverVersion:'170006'});
test('capture SQL preserves NULL distinctly and leaves real ledger untouched',async()=>fixture(async(db,capture)=>{
 const before=(await db.query('table supabase_migrations.schema_migrations')).rows;
 const meta=identity(await capture('FairSwapProd'));
 assert.equal(meta.functions.length,2);assert.equal(meta.security.length,6);
 assert.equal(meta.ledger[1].statementsNull,true);assert.equal(meta.ledger[1].statementsSha256,null);
 assert.equal(meta.ledger[0].statementsNull,false);assert.equal(meta.ledger[0].statementsSha256,sha('select 1'));
 parseMetadata('FairSwapProd',JSON.stringify(meta));
 const dir=mkdtempSync(join(tmpdir(),'fsw-null-history-'));
 try {
  writeFileSync(join(dir,'20260914000001_fixture.sql'),'select 1;\n');
  materializeNullHistory(meta,dir);assert.ok(existsSync(join(dir,'20261023160752_legacy.sql')));verifyHistory(meta,dir);
  writeFileSync(join(dir,'20261023160752_legacy.sql'),'select 99;');
  assert.throws(()=>verifyHistory(meta,dir),/empty local SQL/);
  materializeNullHistory(meta,dir);assert.equal(readFileSync(join(dir,'20261023160752_legacy.sql'),'utf8'),'select 99;');
  writeFileSync(join(dir,'20261023160752_legacy.sql'),'');
  writeFileSync(join(dir,'20260914000001_fixture.sql'),'select 2;');assert.throws(()=>verifyHistory(meta,dir),/genuine ledger/);
 }finally{rmSync(dir,{recursive:true,force:true});}
 assert.deepEqual((await db.query('table supabase_migrations.schema_migrations')).rows,before);
 // Same NULL row is forbidden in Test and for every other version in Prod.
 const wrong=identity(await capture('FairSwapTest'));assert.throws(()=>verifyCapture('FairSwapTest',wrong),/unexpected NULL/);
 for(const change of [row=>row.version='20261023160753',row=>delete row.statementsNull,row=>row.statementsSha256=sha('')]) {
  const bad=structuredClone(meta);change(bad.ledger[1]);assert.throws(()=>verifyCapture('FairSwapProd',bad));
 }
 await db.exec("update supabase_migrations.schema_migrations set statements='{}' where version='20261023160752'");
 const empty=identity(await capture('FairSwapProd'));assert.equal(empty.ledger[1].statementsNull,false);assert.equal(empty.ledger[1].statementsSha256,sha(''));
}));
test('Test capture identifies each invariant without dumping metadata',async()=>fixture(async(db,capture)=>{
 await db.exec("delete from supabase_migrations.schema_migrations where statements is null");
 const meta=identity(await capture('FairSwapTest'));parseMetadata('FairSwapTest',JSON.stringify(meta));
 for(const [change,code] of [
  [x=>x.tls=false,'TLS'],[x=>x.connection.user='wrong','TARGET'],
  [x=>x.functions[0].acl='SECRET','RPC_EXECUTE_ACL'],
  [x=>x.functions[0].owner='PRIVATE','RPC_OWNER'],
  [x=>x.security.find(t=>t.table==='listings').rls=false,'TABLE_RLS'],
  [x=>x.ledger[0].statementsSha256=null,'LEDGER_HASH']
 ]) {
  const bad=structuredClone(meta);change(bad);
  assert.throws(()=>parseMetadata('FairSwapTest',JSON.stringify(bad)),error=>{
   const detail=safeFailure(error,'capture');assert.ok(detail.includes(code));assert.doesNotMatch(detail,/SECRET|PRIVATE|actual|expected/);return true;
  });
 }
 assert.throws(()=>parseMetadata('FairSwapTest','SECRET broken JSON'),/INVALID_JSON/);
}));
test('subprocess diagnostics classify SQLSTATE, TLS and connection failures safely',()=>{
 for(const [stderr,code] of [['psql:capture-release.sql:39: ERROR: 42601 SECRET','SQL_SYNTAX'],['ERROR: 42703 PRIVATE','SQL_COLUMN'],['FATAL: 28P01 password=SECRET','AUTHENTICATION'],['certificate verify failed SECRET','TLS'],['could not translate host SECRET','DNS']]) {
  const e=subprocessFailure({stderr,status:3},'capture');assert.match(e.message,new RegExp(code));
  assert.doesNotMatch(safeFailure(e,'capture'),/SECRET|PRIVATE|password=/);
 }
});
test('failed Test receipt blocks Production before any API or database action',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fsw-prod-block-'));let calls=0;
 const c={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_SHA:'a'.repeat(40),APPROVED_SHA:'a'.repeat(40),GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',FSW_RELEASE_ENABLED:'true',FSW_ENVIRONMENT:'FairSwapProd'};
 const bytes=JSON.stringify({environment:'FairSwapTest',projectRef:refs.FairSwapTest,sourceCommit:c.GITHUB_SHA,runId:'1',runAttempt:'1',sha256:'b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd',version:'20261031110408',migrationAttempted:true,phase:'postflight',status:'FAIL'});c.TEST_RECEIPT_SHA=sha(bytes);
 try {
  await assert.rejects(release('FairSwapProd',{context:c,testReceiptBytes:bytes,receiptDir:dir,fetcher:async()=>{calls++;throw Error('unexpected API');},runner:()=>{calls++;throw Error('unexpected CLI');}}),/SUCCESSFUL_TEST_RECEIPT/);
  assert.equal(calls,0);const receipt=JSON.parse(readFileSync(join(dir,'receipt.json')));assert.equal(receipt.migrationAttempted,false);assert.equal(receipt.status,'FAIL');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Test metadata failure writes sanitized FAIL receipt and never pushes',async()=>fixture(async(db,capture)=>{
 const {rootCertificates}=await import('node:tls');const {X509Certificate}=await import('node:crypto');
 await db.exec("delete from supabase_migrations.schema_migrations where statements is null");
 const meta=identity(await capture('FairSwapTest'));meta.functions[0].acl='PRIVATE_DATA';
 const certificate=rootCertificates.find(p=>{const x=new X509Certificate(p);return x.ca&&Date.parse(x.validFrom)<Date.now()&&Date.parse(x.validTo)>Date.now();});
 const c={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_SHA:'a'.repeat(40),APPROVED_SHA:'a'.repeat(40),GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',FSW_RELEASE_ENABLED:'true',FSW_ENVIRONMENT:'FairSwapTest',GITHUB_TOKEN:'fake',SUPABASE_ACCESS_TOKEN:'fake',CHAT_DATABASE_PASSWORD:'SECRET',CHAT_DB_SSL_ROOT_CERT_PEM:certificate,CHAT_DB_POOLER_HOST:'aws-0-eu-central-1.pooler.supabase.com',FSW_PSQL:'/fake/psql',FSW_CLI:'/fake/supabase'};
 const dir=mkdtempSync(join(tmpdir(),'fsw-capture-failure-'));const commands=[];
 const fetcher=async url=>({ok:true,headers:new Headers(),json:async()=>url.includes('/postgrest')?{db_schema:'public'}:{total_count:1,workflow_runs:[{head_sha:c.GITHUB_SHA,head_branch:'main',status:'completed',conclusion:'success'}]}});
 const runner=(binary,args)=>{commands.push(args);
  if(args.includes('--version'))return binary===c.FSW_PSQL?'psql (PostgreSQL) 17.6':'2.117.0';
  if(args.includes('--help'))return '--project-ref --linked --db-url --dry-run';
  if(binary===c.FSW_PSQL&&args.includes('-f')){assert.ok(args.includes('VERBOSITY=sqlstate'));return JSON.stringify(meta);}
  throw Error('unexpected command');
 };
 try {
  await assert.rejects(release('FairSwapTest',{context:c,runner,fetcher,protection:async()=>({snapshotSha256:'b'.repeat(64)}),receiptDir:dir}),/RPC_EXECUTE_ACL/);
  const bytes=readFileSync(join(dir,'receipt.json'),'utf8');assert.doesNotMatch(bytes,/PRIVATE_DATA|SECRET/);
  const receipt=JSON.parse(bytes);assert.equal(receipt.phase,'capture');assert.equal(receipt.status,'FAIL');assert.equal(receipt.migrationAttempted,false);
  assert.ok(!commands.some(args=>args.includes('push')&&!args.includes('--help')));
 }finally{rmSync(dir,{recursive:true,force:true});}
}));
