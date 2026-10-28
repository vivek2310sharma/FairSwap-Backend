import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync,readdirSync,copyFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {auditProtection} from '../../scripts/release/inbox-protection.mjs';
import {buildPlan,hash,classifyCliFailure,diagnoseCliFailure,verifyHistoryWorkspace,historyCaptureSql,parseHistoryCapture} from '../../scripts/release/protected-inbox-plan.mjs';
import {verifyTestReceipt,release,bundleHash,databaseConnection,withDatabaseConnection,validateRootCertificate} from '../../scripts/release/protected-inbox-release.mjs';
import {manifest} from '../../scripts/release/chat-v2-inbox-only.mjs';
import {auditFixture as originalFixture,fixtureApi} from './audit-fixture.mjs';
async function auditFixture(...args){
 const fixture=await originalFixture(...args);
 fixture.responses['/rulesets/25821687'].bypass_actors=[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'}];
 fixture.responses['/rulesets/25352225'].bypass_actors=[];
 return fixture;
}

const [fixturePem,prodFixturePem]=rootCertificates.filter(pem=>{const cert=new X509Certificate(pem);return cert.ca&&Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now();});
assert(fixturePem&&prodFixturePem);
const fixtureRoot=join(tmpdir(),'chat-test-root.crt');
const input={projectRef:manifest.environments.fairswaptest.projectRef,baseCommit:manifest.baseCommit,observedAt:new Date().toISOString(),reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/60',ledger:[{version:'20260914000011',name:'create_communication',statementsSha256:hash(JSON.stringify(['fixture baseline']))}]};
test('hosted execution removes custom history writes and keeps exact source identity',()=>{
 const plan=buildPlan('fairswaptest',input);assert(!/insert into supabase_migrations/i.test(plan.execution));assert(plan.execution.includes('CHAT_EXACT_LEDGER_MISMATCH'));assert(plan.postflight.includes('CHAT_CLI_HISTORY_REQUIRED'));assert.equal(plan.sourceSha256,manifest.sha256);assert.equal(plan.executionSha256,hash(plan.execution));
});

test('CLI implicit transaction uses a procedural history lock; psql preflight owns an explicit transaction',()=>{
 const plan=buildPlan('fairswaptest',input);
 assert(plan.execution.includes('do $chat_cli_lock$ begin lock table supabase_migrations.schema_migrations in share row exclusive mode; end $chat_cli_lock$;'));
 assert(!/^lock table /m.test(plan.execution));
 assert(!/^\s*(?:begin|commit|rollback);/im.test(plan.execution));
 assert(plan.execution.includes("pg_advisory_xact_lock(hashtextextended('chat-v2-foundation-release',0))"));
 assert(plan.preflight.startsWith('begin;\n'));assert(plan.preflight.endsWith('rollback;\n'));
 assert(plan.preflight.includes('\nlock table supabase_migrations.schema_migrations in share row exclusive mode;'));
});
test('existing foundation must use a protected recovery receipt, never silent history repair',()=>{
 assert.throws(()=>buildPlan('fairswaptest',{...input,ledger:[...input.ledger,{version:manifest.version,name:manifest.name,statementsSha256:hash(JSON.stringify([readFileSync(new URL('../../releases/candidates/chat-v2-inbox-only/supabase/migrations/20261025204922_chat_v2_inbox_and_safety.sql',import.meta.url),'utf8')]))}]}),/PROTECTED_RECOVERY/);
});
test('Production requires successful Test evidence from this exact run, attempt and source',()=>{
 const expected={sha:'a'.repeat(40),runId:'1',runAttempt:'1',bundle:'b'.repeat(64),testLedgerSha256:'f'.repeat(64)};
 const receipt={schema:3,version:manifest.version,cliVersion:'2.117.0',postgresVersionNum:170006,webFlagOffConfirmed:true,capturedLedgerSha256:expected.testLedgerSha256,governanceOwner:'vivek2310sharma',actor:'vivek2310sharma',triggeringActor:'vivek2310sharma',environment:'FairSwapTest',status:'verified',sourceCommit:expected.sha,runId:'1',runAttempt:'1',bundleSha256:expected.bundle,sourceSha256:manifest.sha256,flagsOff:5,historySha256:'c'.repeat(64),protectionSnapshotSha256:'d'.repeat(64),executionSha256:'e'.repeat(64)};
 verifyTestReceipt(receipt,expected);
 for(const delta of [{runId:'2'},{runAttempt:'2'},{status:'failed'},{environment:'FairSwapProd'},{flagsOff:4},{webFlagOffConfirmed:false},{version:'20990101000000'},{cliVersion:'0.0.0'},{postgresVersionNum:150008},{sourceCommit:'d'.repeat(40)},{bundleSha256:'e'.repeat(64)}])assert.throws(()=>verifyTestReceipt({...receipt,...delta},expected),/SAME_RUN_TEST/);
 for(const field of ['protectionSnapshotSha256','executionSha256'])assert.throws(()=>verifyTestReceipt({...receipt,[field]:undefined},expected),/SAME_RUN_TEST/);
 for(const delta of [{schema:1},{actor:'contributor'},{triggeringActor:'contributor'},{governanceOwner:'contributor'},{capturedLedgerSha256:'0'.repeat(64)}])assert.throws(()=>verifyTestReceipt({...receipt,...delta},expected),/SAME_RUN_TEST/);
});
test('unavailable administration APIs block before credentials can be used for DB work',async()=>{
 const fixture=await auditFixture();
 await assert.rejects(()=>auditProtection('FairSwapTest','fixture',async()=>({ok:false}),fixture.evidence),/UNVERIFIABLE/);
});
test('workflow is manual/default-off and has separately gated Test and Production environments',()=>{
 const sql=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-release.yml',import.meta.url),'utf8');
 assert(sql.includes('workflow_dispatch:'));assert(!sql.includes('schedule:'));assert(!sql.includes('pull_request:'));assert(sql.includes('default: false'));assert(sql.includes('environment: FairSwapTest'));assert(sql.includes('environment: FairSwapProd'));assert(sql.includes('needs: [verify, test]'));assert(sql.includes('inputs.approved_sha == github.sha'));assert(sql.includes('overwrite: false'));assert(!sql.includes('db push'));
});
test('solo-owner protections pass; bypass, pagination and repository secrets fail',async()=>{
 const {responses,evidence}=await auditFixture();
 assert.equal((await auditProtection('FairSwapTest','fixture',fixtureApi(responses),evidence)).protected,true);
 for(const mutate of [x=>{x['/environments/FairSwapTest'].can_admins_bypass=true;},x=>{x['/actions/secrets?per_page=100']={total_count:1,secrets:[{name:'CHAT_DATABASE_PASSWORD'}]};},x=>{x['/actions/secrets?per_page=100'].total_count=999;},x=>{x['/rulesets/25352225'].bypass_actors=[{actor_id:1}];}]){
  const copy=structuredClone(responses);mutate(copy);await assert.rejects(()=>auditProtection('FairSwapTest','fixture',fixtureApi(copy),evidence),/CHAT_/);
 }
});
test('only the explicit PostgreSQL rollback sentinel is an expected negative result',()=>{
 assert.equal(classifyCliFailure('ERROR: CHAT_FIXTURE_ROLLBACK (SQLSTATE P0001)'),'EXPECTED_SQL_ROLLBACK');
 assert.equal(classifyCliFailure('message: "CHAT_FIXTURE_ROLLBACK", code: "P0001"'),'EXPECTED_SQL_ROLLBACK');
 assert.equal(classifyCliFailure('PostgresError: CHAT_FIXTURE_ROLLBACK\n code: "P0001"'),'EXPECTED_SQL_ROLLBACK');
 assert.equal(classifyCliFailure('query: CHAT_FIXTURE_ROLLBACK; syntax error (SQLSTATE 42601)'),'UNEXPECTED_SQL_FAILURE');
 assert.equal(classifyCliFailure("ERROR: CHAT_EXACT_LEDGER_MISMATCH (SQLSTATE P0001)\nquery: do $$begin raise exception 'CHAT_FIXTURE_ROLLBACK';end$$;"),'UNEXPECTED_SQL_FAILURE');
 assert.equal(classifyCliFailure('CHAT_FIXTURE_ROLLBACK'),'UNCLASSIFIED_CLI_FAILURE');
 assert.equal(classifyCliFailure('ERROR: CHAT_FIXTURE_ROLLBACK suffix (SQLSTATE P0001)'),'UNEXPECTED_SQL_FAILURE');
 assert.equal(classifyCliFailure('ERROR: CHAT_FIXTURE_ROLLBACK_SUFFIX (SQLSTATE P0001)'),'UNEXPECTED_SQL_FAILURE');
 assert.equal(classifyCliFailure('ERROR: chat_fixture_rollback (SQLSTATE P0001)'),'UNEXPECTED_SQL_FAILURE');
 assert.equal(classifyCliFailure('ERROR: CHAT_FIXTURE_ROLLBACK (SQLSTATE 42601)'),'UNEXPECTED_SQL_FAILURE');
 assert.equal(classifyCliFailure('query: ERROR: CHAT_FIXTURE_ROLLBACK (SQLSTATE P0001)'),'UNEXPECTED_SQL_FAILURE');
 assert.equal(classifyCliFailure('CHAT_FIXTURE_ROLLBACK (SQLSTATE P0001) password authentication failed'),'AUTHENTICATION_FAILURE');
});

test('native SQL diagnostics expose only allowlisted states and bounded statement indexes',()=>{
 assert.deepEqual(diagnoseCliFailure('ERROR: ambiguous column (SQLSTATE 42702)\nAt statement: 6\nselect private_sql;'),{category:'UNEXPECTED_SQL_FAILURE',sqlstate:'42702',statement:6,stage:'OTHER_OR_UNKNOWN'});
 assert.deepEqual(diagnoseCliFailure('ERROR: transaction required (SQLSTATE 25P01)\nAt statement: 4\nlock table supabase_migrations.schema_migrations in share row exclusive mode;'),{category:'UNEXPECTED_SQL_FAILURE',sqlstate:'25P01',statement:4,stage:'MIGRATION_HISTORY_LOCK'});
 assert.deepEqual(diagnoseCliFailure('ERROR: 42501: permission denied to set role "authenticated"'),{category:'ROLE_PERMISSION_FAILURE',sqlstate:'42501',statement:null,stage:'FIXTURE_ROLE_SWITCH'});
 assert.deepEqual(diagnoseCliFailure('ERROR: CHAT_FIXTURE_ROLLBACK (SQLSTATE P0001)\nAt statement: 72\ndo private_sql;'),{category:'EXPECTED_SQL_ROLLBACK',sqlstate:'P0001',statement:72,stage:'ROLLBACK_SENTINEL'});
 const result=diagnoseCliFailure('ERROR: private-value (SQLSTATE ABCDE)\nAt statement: 123456\npostgres://private-user:private-password@host/db');
 assert.deepEqual(result,{category:'UNEXPECTED_SQL_FAILURE',sqlstate:'OTHER_OR_UNKNOWN',statement:null,stage:'OTHER_OR_UNKNOWN'});
 assert(!JSON.stringify(result).includes('private'));
});
test('CLI error classification is allowlisted and never echoes SQL, URLs or credentials',()=>{
 assert.equal(classifyCliFailure('CHAT_HISTORY_WORKSPACE_MISMATCH'),'LOCAL_HISTORY_WORKSPACE_FAILURE');
 assert.equal(classifyCliFailure('CHAT_NATIVE_CLI_SEED_HISTORY_REQUIRED'),'FIXTURE_CONFIGURATION_FAILURE');
 const cases=[['Remote migration versions not found in local migrations directory.','MISSING_LOCAL_HISTORY'],['Found local migration files to be inserted before the last migration on remote database.','MIGRATION_ORDER_FAILURE'],['password authentication failed (SQLSTATE 28P01)','AUTHENTICATION_FAILURE'],['connect ECONNREFUSED','TCP_FAILURE'],['ERROR: permission denied for schema (SQLSTATE 42501)','ROLE_PERMISSION_FAILURE'],['unknown flag --fixture','CLI_CONFIGURATION_FAILURE'],['opaque upstream text','UNCLASSIFIED_CLI_FAILURE']];
 for(const [raw,expected]of cases){const output=classifyCliFailure(raw+' postgres://fixture:do-not-echo@host/ SELECT private_sql;');assert.equal(output,expected);assert(/^[A-Z_]+$/.test(output));assert(!output.includes('do-not-echo'));}
});
test('isolated CLI workspace requires authentic applied files plus exactly one pending foundation',()=>{
 const directory=mkdtempSync(join(tmpdir(),'chat-history-check-')),folder=join(directory,'supabase/migrations');mkdirSync(folder,{recursive:true});
 const ledger=[{version:'20000101000000',name:'ci_fixture_baseline'},{version:'20990101000000',name:'ci_fixture_later'}];
 const pending=`${manifest.version}_${manifest.name}.sql`,created=[];
 const put=(name,body)=>{writeFileSync(join(folder,name),body);created.push(name);};
 try{
  put(pending,'select 1;');assert.throws(()=>verifyHistoryWorkspace(directory,ledger,{pending:true}),/WORKSPACE_MISMATCH/);
  for(const row of ledger)put(`${row.version}_${row.name}.sql`,'create table fixture_real_source(id integer);');
  assert.equal(verifyHistoryWorkspace(directory,ledger,{pending:true}),3);
  put('unreviewed.sql','select 1;');assert.throws(()=>verifyHistoryWorkspace(directory,ledger,{pending:true}),/WORKSPACE_MISMATCH/);
  unlinkSync(join(folder,'unreviewed.sql'));created.pop();
  writeFileSync(join(folder,`${ledger[0].version}_${ledger[0].name}.sql`),'');assert.throws(()=>verifyHistoryWorkspace(directory,ledger,{pending:true}),/INVALID_FILE/);
  assert.throws(()=>verifyHistoryWorkspace(directory,[{version:'20000101000000',name:'../invalid'}]),/INVALID_LEDGER/);
 }finally{for(const file of created)unlinkSync(join(folder,file));rmdirSync(folder);rmdirSync(join(directory,'supabase'));rmdirSync(directory);}
});
test('native negative and hosted positive paths reconcile history without repair or placeholders',()=>{
 const native=readFileSync(new URL('../../scripts/ci/run-chat-inbox-pg17.sh',import.meta.url),'utf8');
 const hosted=readFileSync(new URL('../../scripts/release/protected-inbox-release.mjs',import.meta.url),'utf8');
 assert(native.includes('task_negative_class != EXPECTED_SQL_ROLLBACK'));
 assert(native.includes('migration fetch'));assert(native.includes('rollback-check.sql'));
 assert(hosted.includes("['migration','fetch'"));assert(hosted.includes('verifyHistoryWorkspace(isolated,approvedLedger,{pending:true})'));
 assert(!/migration['", ]+repair/.test(hosted));assert(!/insert into supabase_migrations/.test(hosted));
});
test('native fixture generation records genuine seed migrations before planning the pending foundation',()=>{
 const directory=mkdtempSync(join(tmpdir(),'chat-inbox-native.'));
 const run=phase=>spawnSync(process.execPath,['--import',new URL('./offline-guard.mjs',import.meta.url).href,fileURLToPath(new URL('../../scripts/ci/prepare-chat-inbox-cli-fixture.mjs',import.meta.url)),directory,phase],{encoding:'utf8'});
 try{
  assert.equal(run('seed').status,0);
  const prepare=readFileSync(join(directory,'prepare.sql'),'utf8');assert(!prepare.includes('insert into supabase_migrations.schema_migrations'));
  assert(prepare.includes('grant anon, authenticated to postgres with inherit false, set true;'));
  assert(!prepare.includes('alter role postgres superuser'));
  const names=readdirSync(join(directory,'seed/supabase/migrations')).sort();assert.equal(names.length,2);
  const ledger=names.map(name=>{const body=readFileSync(join(directory,'seed/supabase/migrations',name),'utf8');assert(body.includes('create table app_security.inbox_cli_'));return {version:name.slice(0,14),name:name.slice(15,-4),statementsSha256:hash(JSON.stringify([body]))};});
  writeFileSync(join(directory,'history.json'),JSON.stringify(ledger));
  assert.notEqual(run('plan').status,0); // Missing fetched versions must stop planning.
  for(const name of names)copyFileSync(join(directory,'seed/supabase/migrations',name),join(directory,'supabase/migrations',name));
  assert.equal(run('plan').status,0);
  assert.equal(verifyHistoryWorkspace(directory,ledger,{pending:true}),3);
  assert(!readFileSync(join(directory,'approved.sql'),'utf8').includes('insert into supabase_migrations'));
  const rollback=readFileSync(join(directory,'rollback-check.sql'),'utf8');
  assert.equal((rollback.match(/to_regclass\(/g)??[]).length,8);
  assert(rollback.includes('pg_trigger'));assert(rollback.includes('app_security.chat_v2_flags'));
  assert(rollback.includes('pg_proc'));assert(rollback.includes(JSON.stringify(ledger)));
  assert(rollback.includes('inbox_cli_baseline_fixture'));assert(rollback.includes('inbox_cli_later_fixture'));
  assert(rollback.startsWith('begin transaction read only;'));
 }finally{
  assert.equal(resolve(directory),directory);assert.equal(resolve(directory,'..'),resolve(tmpdir()));assert(basename(directory).startsWith('chat-inbox-native.'));
  rmSync(directory,{recursive:true,force:true});
 }
});

test('automatic history capture is environment-bound, PG17, read-only and metadata-only',()=>{
 for(const environment of ['fairswaptest','fairswapprod']){
  const sql=historyCaptureSql(environment);
  assert(sql.startsWith('begin transaction isolation level repeatable read read only;'));
  assert(sql.includes(manifest.environments[environment].projectRef));assert(sql.includes('CHAT_PG17_REQUIRED'));
  assert(sql.includes('statementsSha256'));assert(!/select.*messages|password|insert into|update /i.test(sql));
 }
 const capture={...input,reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/actions'};assert.deepEqual(parseHistoryCapture(JSON.stringify(capture)),capture);
 for(const output of ['',JSON.stringify({ledger:[]}),JSON.stringify(capture)+'\n'+JSON.stringify(capture),'{bad'])assert.throws(()=>parseHistoryCapture(output),/CHAT_HISTORY_CAPTURE_INVALID/);
 const plan=buildPlan('fairswaptest',capture);assert(plan.execution.includes('CHAT_EXACT_LEDGER_MISMATCH'));assert(plan.postflight.includes('CHAT_POST_LEDGER_DRIFT'));
});

test('single-dispatch orchestration captures each current ledger and gates Production on same-run Test evidence',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'chat-one-dispatch-')),previous=process.cwd();
 const bundle=bundleHash(),certPaths=new Set(),events=[],testFixture=await auditFixture('FairSwapTest',bundle),prodFixture=await auditFixture('FairSwapProd',bundle);
 const context={PATH:process.env.PATH,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:testFixture.evidence.sourceCommit,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',CHAT_RELEASE_ENABLED:'true',CHAT_ENVIRONMENT_ENABLED:'true',CHAT_WEB_FLAG_OFF_CONFIRMED:'true',CHAT_DB_POOLER_HOST:'aws-0-ap-south-1.pooler.supabase.com',CHAT_DB_SSL_ROOT_CERT_PEM:fixturePem,CHAT_DATABASE_PASSWORD:'synthetic-offline-password',CHAT_RELEASE_AUDIT_TOKEN:'fixture-token'};
 const makeRunner=(environment,{drift=false,wrongIdentity=false,badPost=false,failure,failureAt='capture'}={})=>{
  const snapshot={...input,observedAt:new Date().toISOString(),projectRef:manifest.environments[environment].projectRef,reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/actions'};
  // Distinct histories, including a later version, must never be interchanged.
  if(environment==='fairswaptest')snapshot.ledger=[...snapshot.ledger,{version:'20261028091220',name:'digilocker_fixture',statementsSha256:hash('digilocker fixture')}];
  assert.equal(snapshot.ledger.some(row=>row.version==='20261028091220'),environment==='fairswaptest');
  if(environment==='fairswapprod')snapshot.ledger=[...snapshot.ledger,{version:'20990101000000',name:'later_release',statementsSha256:hash('later')}];
  let preflights=0;
  return (binary,args,sql,childEnv)=>{
   const expectedHost=environment==='fairswaptest'?'aws-0-ap-south-1.pooler.supabase.com':'aws-1-eu-central-1.pooler.supabase.com';
   assert.equal(childEnv.PGHOST,expectedHost);assert.equal(childEnv.PGUSER,'postgres.'+manifest.environments[environment].projectRef);
   assert.equal(childEnv.PGPORT,'5432');assert.equal(childEnv.PGDATABASE,'postgres');assert.equal(childEnv.PGSSLMODE,'verify-full');
   certPaths.add(childEnv.PGSSLROOTCERT);
   assert.equal(readFileSync(childEnv.PGSSLROOTCERT,'utf8'),(environment==='fairswaptest'?fixturePem:prodFixturePem).trim()+'\n');
   assert(!Object.hasOwn(childEnv,'CHAT_DB_SSL_ROOT_CERT_PEM'));
   if(process.platform!=='win32'){assert.equal(statSync(childEnv.PGSSLROOTCERT).mode&0o777,0o600);assert.equal(statSync(resolve(childEnv.PGSSLROOTCERT,'..')).mode&0o777,0o700);}assert.equal(childEnv.PGPASSWORD,context.CHAT_DATABASE_PASSWORD);
   assert.equal(childEnv.SUPABASE_DB_PASSWORD,context.CHAT_DATABASE_PASSWORD);
   assert(!JSON.stringify([args,sql]).includes(context.CHAT_DATABASE_PASSWORD));
   if(args.includes('--db-url')){
    const uri=new URL(args[args.indexOf('--db-url')+1]);
    assert.equal(uri.hostname,childEnv.PGHOST);assert.equal(uri.username,childEnv.PGUSER);assert.equal(uri.port,childEnv.PGPORT);
    assert.equal(uri.pathname,'/'+childEnv.PGDATABASE);assert.equal(uri.password,'');assert.equal(uri.searchParams.get('sslmode'),childEnv.PGSSLMODE);
    assert.equal(uri.searchParams.get('sslrootcert'),childEnv.PGSSLROOTCERT);assert.equal(uri.searchParams.get('connect_timeout'),childEnv.PGCONNECT_TIMEOUT);
   }
   if(failure&&((failureAt==='capture'&&binary==='psql')||(failureAt==='apply'&&args[1]==='up'&&!args.includes('--help'))||(failureAt==='fetch'&&args[1]==='fetch'&&!args.includes('--help'))))throw failure;
   if(args[0]==='--version')return '2.117.0';
   if(args.includes('--help'))return '--include-all --db-url';
   if(sql===historyCaptureSql(environment)){events.push(environment+':capture');return JSON.stringify({...snapshot,projectRef:wrongIdentity?'foreign':snapshot.projectRef});}
   if(binary==='psql'&&sql.endsWith('rollback;\n')){
    assert(sql.includes(JSON.stringify(snapshot.ledger)));events.push(environment+':preflight');
    if(drift&&++preflights===2)throw {stderr:'ERROR: CHAT_EXACT_LEDGER_MISMATCH (SQLSTATE P0001)'};
    return '';
   }
   if(binary==='supabase'&&args[1]==='fetch'){
    const isolated=args[args.indexOf('--workdir')+1];
    for(const row of snapshot.ledger)writeFileSync(join(isolated,'supabase/migrations',row.version+'_'+row.name+'.sql'),'select 1;');
    events.push(environment+':fetch');return '';
   }
   if(binary==='supabase'&&args[1]==='up'){
    const isolated=args[args.indexOf('--workdir')+1],execution=readFileSync(join(isolated,'supabase/migrations',manifest.version+'_'+manifest.name+'.sql'),'utf8');
    assert(execution.includes('CHAT_EXACT_LEDGER_MISMATCH'));assert(execution.includes(JSON.stringify(snapshot.ledger)));assert(args.includes('--include-all'));events.push(environment+':up');return '';
   }
   if(binary==='psql'&&sql.includes('CHAT_POST_LEDGER_DRIFT')){events.push(environment+':postflight');return JSON.stringify({version:manifest.version,flagsOff:badPost?4:5,postgresVersionNum:170006,historySha256:'a'.repeat(64)});}
   assert.fail('unexpected mocked operation');
  };
 };
 try{
  mkdirSync(join(directory,'test'));process.chdir(join(directory,'test'));
  const testReceipt=await release('fairswaptest',bundle,undefined,{context,fetcher:fixtureApi(testFixture.responses),runner:makeRunner('fairswaptest')});
  assert.equal(testReceipt.schema,3);assert.equal(testReceipt.capturedLedgerSha256,testReceipt.ledgerSha256);
  const receiptFile=join(process.cwd(),'release-receipt/receipt.json');
  mkdirSync(join(directory,'prod/test-evidence'),{recursive:true});copyFileSync(receiptFile,join(directory,'prod/test-evidence/receipt.json'));process.chdir(join(directory,'prod'));
  const prodContext={...context,CHAT_DB_POOLER_HOST:'aws-1-eu-central-1.pooler.supabase.com',CHAT_DB_SSL_ROOT_CERT_PEM:prodFixturePem};
  await assert.rejects(()=>release('fairswapprod',bundle,'0'.repeat(64),{context:prodContext,fetcher:()=>assert.fail('no API before receipt validation'),runner:()=>assert.fail('no DB')}),/SAME_RUN_TEST/);
  const prodReceipt=await release('fairswapprod',bundle,testReceipt.capturedLedgerSha256,{context:prodContext,fetcher:fixtureApi(prodFixture.responses),runner:makeRunner('fairswapprod')});
  assert.notEqual(prodReceipt.capturedLedgerSha256,testReceipt.capturedLedgerSha256);
  for(const path of certPaths)assert(!existsSync(path));
  assert(!JSON.stringify([testReceipt,prodReceipt]).includes('BEGIN CERTIFICATE'));
  assert(!JSON.stringify([testReceipt,prodReceipt]).includes('root.crt'));
  assert(events.indexOf('fairswaptest:postflight')<events.indexOf('fairswapprod:capture'));
  for(const [name,options,expected]of [['drift',{drift:true},/UNEXPECTED_SQL_FAILURE/],['identity',{wrongIdentity:true},/CHAT_/],['postflight',{badPost:true},/POSTFLIGHT_RECEIPT_INVALID/],['network',{failure:{code:'ENOTFOUND',stderr:'lookup failed '+context.CHAT_DATABASE_PASSWORD}},/^Error: CHAT_SUBPROCESS_HISTORY_CAPTURE_DNS_FAILURE_RECOVERY_REVIEW$/],['auth',{failure:{stderr:'failed SASL auth '+context.CHAT_DATABASE_PASSWORD}},/^Error: CHAT_SUBPROCESS_HISTORY_CAPTURE_AUTHENTICATION_FAILURE_RECOVERY_REVIEW$/],['tls',{failure:{stderr:'failed to connect: x509: certificate signed by unknown authority '+fixturePem}},/^Error: CHAT_SUBPROCESS_HISTORY_CAPTURE_TLS_CERTIFICATE_FAILURE_RECOVERY_REVIEW$/],['tcp',{failure:{code:'ECONNREFUSED',stderr:context.CHAT_DATABASE_PASSWORD}},/^Error: CHAT_SUBPROCESS_HISTORY_CAPTURE_TCP_FAILURE_RECOVERY_REVIEW$/],['apply',{failureAt:'apply',failure:{stderr:'ERROR: private SQL (SQLSTATE 42601) '+context.CHAT_DATABASE_PASSWORD}},/^Error: CHAT_SUBPROCESS_MIGRATION_APPLY_UNEXPECTED_SQL_FAILURE_RECOVERY_REVIEW$/],['fetch',{failureAt:'fetch',failure:{code:'ENOTFOUND',stderr:context.CHAT_DATABASE_PASSWORD}},/^Error: CHAT_SUBPROCESS_HISTORY_FETCH_DNS_FAILURE_RECOVERY_REVIEW$/]]){
   mkdirSync(join(directory,name));process.chdir(join(directory,name));const start=events.length;
   await assert.rejects(()=>release('fairswaptest',bundle,undefined,{context,fetcher:fixtureApi(testFixture.responses),runner:makeRunner('fairswaptest',options)}),expected);
   if(name!=='postflight')assert(!events.slice(start).includes('fairswaptest:up'));
   assert(!readdirSync('.').includes('release-receipt'));
   for(const path of certPaths)assert(!existsSync(path));
  }
 }finally{
  process.chdir(previous);assert.equal(resolve(directory,'..'),resolve(tmpdir()));assert(basename(directory).startsWith('chat-one-dispatch-'));rmSync(directory,{recursive:true,force:true});
 }
});

test('session pooler configuration fixes endpoint, project user, port and verified TLS for both clients',()=>{
 const password='synthetic:/?@#% secret';
 for(const [environment,host]of [['fairswaptest','aws-0-ap-south-1.pooler.supabase.com'],['fairswapprod','aws-1-eu-central-1.pooler.supabase.com']]){
  const {connection,env}=databaseConnection(environment,{CHAT_DB_POOLER_HOST:host,CHAT_DATABASE_PASSWORD:password,PGHOST:'attacker.invalid',PGUSER:'postgres.other',PGSSLMODE:'disable',PGSSLROOTCERT:'/bad'},fixtureRoot),uri=new URL(connection);
  assert.equal(uri.hostname,host);assert.equal(uri.username,'postgres.'+manifest.environments[environment].projectRef);
  assert.equal(uri.port,'5432');assert.equal(uri.pathname,'/postgres');assert.equal(uri.password,'');assert(!connection.includes(password));
  assert.equal(uri.searchParams.get('sslmode'),'verify-full');assert.equal(env.PGSSLMODE,'verify-full');
  assert.equal(uri.searchParams.get('sslrootcert'),env.PGSSLROOTCERT);assert.equal(env.PGSSLROOTCERT,fixtureRoot);
  assert.equal(env.PGHOST,uri.hostname);assert.equal(env.PGUSER,uri.username);assert.equal(env.PGPORT,uri.port);
  assert.equal(env.PGPASSWORD,password);assert.equal(env.SUPABASE_DB_PASSWORD,password);
 }
});
test('missing or malformed pooler hosts fail closed without echoing input or using direct-host fallback',async()=>{
 for(const host of [undefined,'',null,42,' aws-0-ap-south-1.pooler.supabase.com','aws-0-ap-south-1.pooler.supabase.com:6543','db.'+manifest.environments.fairswaptest.projectRef+'.supabase.co','postgresql://private:password@aws-0-ap-south-1.pooler.supabase.com:5432/postgres','aws-0-ap-south-1.pooler.supabase.com.attacker.invalid','attacker.invalid','127.0.0.1','[::1]','aws-0-ap-south-1.pooler.supabase.com?sslmode=disable','aws-0-ap-south-1.pooler.supabase.com\n']){
  assert.throws(()=>databaseConnection('fairswaptest',{CHAT_DB_POOLER_HOST:host,CHAT_DATABASE_PASSWORD:'private'}),error=>/^CHAT_DB_POOLER_HOST_(REQUIRED|INVALID)$/.test(error.message));
 }
 const host='aws-0-ap-south-1.pooler.supabase.com';
 assert.throws(()=>databaseConnection('fairswaptest',{CHAT_DB_POOLER_HOST:host}),/^Error: CHAT_DATABASE_PASSWORD_REQUIRED$/);
 const fixture=await auditFixture('FairSwapTest',bundleHash());
 const context={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:fixture.evidence.sourceCommit,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',CHAT_RELEASE_ENABLED:'true',CHAT_ENVIRONMENT_ENABLED:'true',CHAT_WEB_FLAG_OFF_CONFIRMED:'true',CHAT_DATABASE_PASSWORD:'private'};
 await assert.rejects(()=>release('fairswaptest',bundleHash(),undefined,{context,fetcher:()=>assert.fail('No API without pooler config'),runner:()=>assert.fail('No DB without pooler config')}),/^Error: CHAT_DB_POOLER_HOST_REQUIRED$/);
 const privateUri='postgresql://private-user:private-password@attacker.invalid:5432/postgres';
 const child=spawnSync(process.execPath,['--import',new URL('./offline-guard.mjs',import.meta.url).href,fileURLToPath(new URL('../../scripts/release/protected-inbox-release.mjs',import.meta.url)),'fairswaptest',bundleHash()],{encoding:'utf8',env:{PATH:process.env.PATH,...context,CHAT_DB_POOLER_HOST:privateUri}});
 assert.equal(child.status,1);assert.equal(child.stdout,'');assert(child.stderr.includes('CHAT_DB_POOLER_HOST_INVALID'));
 for(const privateText of [privateUri,'private-password','private-user','attacker.invalid'])assert(!child.stderr.includes(privateText));
});
test('pooler DNS and network failures remain distinct from authentication and expose only allowlisted categories',()=>{
 const cases=[['could not translate host name "private-host" to address: Name or service not known','DNS_FAILURE'],['Temporary failure in name resolution','DNS_FAILURE'],['lookup private-host: no such host','DNS_FAILURE'],['EAI_AGAIN','DNS_FAILURE'],['ETIMEDOUT','TCP_FAILURE'],['ENETUNREACH','TCP_FAILURE'],['ECONNRESET','TCP_FAILURE'],['certificate verify failed','TLS_CERTIFICATE_FAILURE'],['failed to connect: failed SASL auth','AUTHENTICATION_FAILURE'],['FATAL: Tenant or user not found','AUTHENTICATION_FAILURE'],['SCRAM authentication failed','AUTHENTICATION_FAILURE'],['ERROR: password authentication failed (SQLSTATE 28P01)','AUTHENTICATION_FAILURE']];
 for(const [raw,expected]of cases){
  const category=classifyCliFailure(raw+' postgresql://private-user:private-password@private-host:5432/postgres');
  assert.equal(category,expected);assert(!category.includes('private'));assert(/^[A-Z_]+$/.test(category));
 }
});
test('only protected deploy jobs receive their environment-scoped pooler hostname',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-release.yml',import.meta.url),'utf8');
 const jobs=workflow.slice(workflow.indexOf('jobs:')).split(/\n(?=  [a-z_]+:\n)/).slice(1);
 for(const job of jobs){
  const deploy=/^  (?:test|production):/.test(job);
  assert.equal(job.includes('CHAT_DB_POOLER_HOST: ${{ vars.CHAT_DB_POOLER_HOST }}'),deploy);
  assert.equal(job.includes('CHAT_DB_SSL_ROOT_CERT_PEM: ${{ secrets.CHAT_DB_SSL_ROOT_CERT_PEM }}'),deploy);
 }
 assert(workflow.includes('environment: FairSwapTest'));assert(workflow.includes('environment: FairSwapProd'));
});

test('project PEM is temporary, private, identical for both clients and removed after success or failure',async()=>{
 const context={CHAT_DB_POOLER_HOST:'aws-0-ap-south-1.pooler.supabase.com',CHAT_DATABASE_PASSWORD:'synthetic-private',CHAT_DB_SSL_ROOT_CERT_PEM:fixturePem};
 for(const fails of [false,true]){
  let path;
  const execute=()=>withDatabaseConnection('fairswaptest',context,async({connection,env})=>{
   path=env.PGSSLROOTCERT;assert(existsSync(path));assert.equal(readFileSync(path,'utf8'),fixturePem.trim()+'\n');
   assert.equal(new URL(connection).searchParams.get('sslrootcert'),path);assert.equal(env.PGSSLMODE,'verify-full');
   assert(!Object.hasOwn(env,'CHAT_DB_SSL_ROOT_CERT_PEM'));assert(!connection.includes(fixturePem));
   if(process.platform!=='win32'){assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(resolve(path,'..')).mode&0o777,0o700);}
   if(fails)throw Error('CHAT_SYNTHETIC_ACTION_FAILURE');return 'ok';
  });
  if(fails)await assert.rejects(execute,/CHAT_SYNTHETIC_ACTION_FAILURE/);else assert.equal(await execute(),'ok');
  assert(path);assert(!existsSync(path));assert(!existsSync(resolve(path,'..')));
 }
});
test('certificate configuration rejects missing, malformed, expired and non-PEM input without residue',async()=>{
 const context={CHAT_DB_POOLER_HOST:'aws-0-ap-south-1.pooler.supabase.com',CHAT_DATABASE_PASSWORD:'synthetic-private'};
 const directories=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('chat-inbox-tls-')).sort();
 const before=directories();
 for(const pem of [undefined,'',null,'private-value','-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----',fixturePem+'private-value',fixturePem+fixturePem,fixturePem.replaceAll('\n','\\n'),'-----BEGIN CERTIFICATE-----\ninvalidbase64\n-----END CERTIFICATE-----','x'.repeat(65537)]){
  await assert.rejects(()=>withDatabaseConnection('fairswaptest',{...context,CHAT_DB_SSL_ROOT_CERT_PEM:pem},()=>assert.fail('Invalid certificate must not reach action')),error=>/^CHAT_DB_SSL_ROOT_CERT_(REQUIRED|INVALID)$/.test(error.message));
 }
 assert.deepEqual(directories(),before);
 const cert=new X509Certificate(fixturePem);
 assert.throws(()=>validateRootCertificate(fixturePem,Date.parse(cert.validFrom)-1),/CHAT_DB_SSL_ROOT_CERT_INVALID/);
 assert.throws(()=>validateRootCertificate(fixturePem,Date.parse(cert.validTo)+1),/CHAT_DB_SSL_ROOT_CERT_INVALID/);
 assert.equal(validateRootCertificate(fixturePem.replaceAll('\n','\r\n')),fixturePem.trim()+'\n');
 assert.throws(()=>databaseConnection('fairswaptest',context),/CHAT_DB_SSL_ROOT_CERT_FILE_REQUIRED/);
});
test('TLS and DNS diagnostics win over generic connection prefixes and expose no upstream content',()=>{
 for(const [raw,category]of [['failed to connect: x509: certificate signed by unknown authority','TLS_CERTIFICATE_FAILURE'],['ERROR: certificate verify failed (SQLSTATE 08001)','TLS_CERTIFICATE_FAILURE'],['SSL error: certificate has expired','TLS_CERTIFICATE_FAILURE'],['root certificate file does not exist','TLS_CERTIFICATE_FAILURE'],['TLS: failed to verify certificate','TLS_CERTIFICATE_FAILURE'],['ERROR: could not translate host name (SQLSTATE 08001)','DNS_FAILURE'],['dial tcp: i/o timeout','TCP_FAILURE'],['ERROR: connection refused (SQLSTATE 08006)','TCP_FAILURE'],['ERROR: migration syntax (SQLSTATE 42601)','UNEXPECTED_SQL_FAILURE']]){
  const result=diagnoseCliFailure(raw+' postgresql://private-user:private-password@private-host/postgres '+fixturePem);
  assert.equal(result.category,category);assert(!JSON.stringify(result).includes('private'));assert(!JSON.stringify(result).includes('BEGIN CERTIFICATE'));
 }
});
