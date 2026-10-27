import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditProtection} from '../../scripts/release/inbox-protection.mjs';
import {buildPlan,hash,classifyCliFailure,diagnoseCliFailure,verifyHistoryWorkspace} from '../../scripts/release/protected-inbox-plan.mjs';
import {verifyTestReceipt} from '../../scripts/release/protected-inbox-release.mjs';
import {manifest} from '../../scripts/release/chat-v2-inbox-only.mjs';
import {auditFixture,fixtureApi} from './audit-fixture.mjs';
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
 const receipt={schema:2,approvedLedgerSha256:expected.testLedgerSha256,governanceOwner:'vivek2310sharma',actor:'vivek2310sharma',triggeringActor:'vivek2310sharma',environment:'FairSwapTest',status:'verified',sourceCommit:expected.sha,runId:'1',runAttempt:'1',bundleSha256:expected.bundle,sourceSha256:manifest.sha256,flagsOff:5,historySha256:'c'.repeat(64),protectionSnapshotSha256:'d'.repeat(64),ownerAttestationSha256:'e'.repeat(64)};
 verifyTestReceipt(receipt,expected);
 for(const delta of [{runId:'2'},{runAttempt:'2'},{status:'failed'},{environment:'FairSwapProd'},{flagsOff:4},{sourceCommit:'d'.repeat(40)},{bundleSha256:'e'.repeat(64)}])assert.throws(()=>verifyTestReceipt({...receipt,...delta},expected),/SAME_RUN_TEST/);
 for(const field of ['protectionSnapshotSha256','ownerAttestationSha256'])assert.throws(()=>verifyTestReceipt({...receipt,[field]:undefined},expected),/SAME_RUN_TEST/);
 for(const delta of [{schema:1},{actor:'contributor'},{triggeringActor:'contributor'},{governanceOwner:'contributor'},{approvedLedgerSha256:'0'.repeat(64)}])assert.throws(()=>verifyTestReceipt({...receipt,...delta},expected),/SAME_RUN_TEST/);
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
 const cases=[['Remote migration versions not found in local migrations directory.','MISSING_LOCAL_HISTORY'],['Found local migration files to be inserted before the last migration on remote database.','MIGRATION_ORDER_FAILURE'],['password authentication failed (SQLSTATE 28P01)','AUTHENTICATION_FAILURE'],['connect ECONNREFUSED','CONNECTION_FAILURE'],['ERROR: permission denied for schema (SQLSTATE 42501)','ROLE_PERMISSION_FAILURE'],['unknown flag --fixture','CLI_CONFIGURATION_FAILURE'],['opaque upstream text','UNCLASSIFIED_CLI_FAILURE']];
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
