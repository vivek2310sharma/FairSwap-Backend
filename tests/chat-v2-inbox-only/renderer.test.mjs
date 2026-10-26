import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {candidate,manifest,render} from '../../scripts/release/chat-v2-inbox-only.mjs';
const input={projectRef:manifest.environments.fairswaptest.projectRef,baseCommit:manifest.baseCommit,observedAt:new Date().toISOString(),reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/58',ledger:[{version:'20260914000011',name:'create_communication',statementsSha256:'a'.repeat(64)}]};
test('rendered environment artifacts have distinct fixed identities and transactional boundaries',()=>{
 for(const environment of ['fairswaptest','fairswapprod']){
  const sql=render(environment,{...input,projectRef:manifest.environments[environment].projectRef});
  assert(sql.apply.includes(manifest.environments[environment].projectRef));assert(sql.apply.includes('CHAT_EXACT_LEDGER_MISMATCH'));
  assert(sql.preflight.includes('begin transaction read only;'));assert(sql.apply.endsWith('commit;\n'));
  assert(sql.rollback.includes("set enabled=false where name='inbox'"));assert(!sql.rollback.includes('drop table'));
  assert(!sql.apply.includes('net.http_post'));assert(!sql.apply.includes('cron.schedule'));assert(!sql.apply.includes('set enabled=true'));
 }
});
test('candidate byte checks retain the source transaction boundaries',()=>{
 const source=candidate();assert(source.sql.includes('\nbegin;\n'));assert(source.sql.endsWith('commit;\n'));assert(!source.body.includes('\nbegin;\n'));assert(!source.body.endsWith('commit;\n'));
});
test('the isolated package resolves the pinned engine without root dependency edits',()=>{
 const require=createRequire(new URL('./engine.mjs',import.meta.url));
 const resolved=require.resolve('@electric-sql/pglite');assert(resolved.replaceAll('\\','/').includes('/tests/chat-v2-inbox-only/node_modules/'));
 const pkg=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));assert.equal(pkg.devDependencies['@electric-sql/pglite'],'0.5.8');
});
test('CLI rejects malformed metadata without printing its content or opening a network path',()=>{
 const directory=mkdtempSync(join(tmpdir(),'chat-inbox-renderer-'));
 try{
  const file=join(directory,'malformed.json'),sensitiveFixture='fixture-do-not-echo-123';writeFileSync(file,sensitiveFixture);
  const result=spawnSync(process.execPath,['--import',new URL('./offline-guard.mjs',import.meta.url).href,fileURLToPath(new URL('../../scripts/release/chat-v2-inbox-only.mjs',import.meta.url)),'fairswaptest',file],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stderr.trim(),'CHAT_PREPARATION_FAILED');assert(!result.stdout.includes(sensitiveFixture));assert(!result.stderr.includes(sensitiveFixture));
 }finally{unlinkSync(join(directory,'malformed.json'));rmdirSync(directory);}
});
