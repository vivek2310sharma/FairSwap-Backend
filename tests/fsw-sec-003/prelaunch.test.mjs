import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyCandidate,verifyDryRun,FILE,SHA,VERSION,refs,sha} from './release-gate.mjs';
import {safeFailure,exposure,verifyTestReceipt,backupWaiver,subprocessOutput} from '../../scripts/release/fsw-sec-003-prelaunch.mjs';
import {spawnSync} from 'node:child_process';
test('CLI version uses exact stdout while preserving stderr diagnostics',()=>{
 const run=(stdout,stderr,status=0)=>spawnSync(process.execPath,['-e',`process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${status};`],{encoding:'utf8'});
 const notice='A new version of Supabase CLI is available\n';
 const pinned=run('2.117.0\n',notice);
 assert.equal(subprocessOutput(pinned,'tools').trim(),'2.117.0');
 assert.equal(subprocessOutput(pinned,'tools',true),'2.117.0\n'+notice);
 for(const stdout of ['2.118.0\n','','2.117.0\nextra\n']) {
  assert.notEqual(subprocessOutput(run(stdout,'2.117.0\n'),'tools').trim(),'2.117.0');
 }
 assert.throws(()=>subprocessOutput(run('2.117.0\n','certificate verify failed SECRET',1),'tools'),/FSW_SUBPROCESS_TOOLS_TLS_FAILED/);
 assert.throws(()=>subprocessOutput({status:null,stdout:'2.117.0',stderr:'',error:{code:'ENOENT'}},'tools'),/FSW_SUBPROCESS_TOOLS_TOOL_MISSING_FAILED/);
});
test('approved immutable candidate and exact single pending version',()=>{
 verifyCandidate();assert.equal(VERSION,'20261031110408');assert.equal(SHA,'b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd');
 assert.throws(()=>verifyCandidate(Buffer.from('changed')));verifyDryRun(FILE);
 assert.throws(()=>verifyDryRun(FILE+' 20261031110409_extra.sql'));
});
test('errors provide phase guidance without raw assertion data',()=>{
 const message=safeFailure(Error('password=SECRET actual user data'),'postflight');
 assert.match(message,/history and ACL/);assert.doesNotMatch(message,/SECRET|user data|FSW_VALIDATION_FAILED/);
});
test('public-only effective exposure and intended project',async()=>{
 let target;const response=db_schema=>async url=>{target=url;return {ok:true,headers:new Headers(),json:async()=>({db_schema})};};
 await exposure('FairSwapTest','fake',response('public'));assert.ok(target.includes(refs.FairSwapTest));
 await assert.rejects(exposure('FairSwapProd','fake',response('public,app_security')),/PUBLIC_ONLY/);
});
test('Production requires complete fresh same-run Test proof without writer evidence',()=>{
 const c={GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1'};
 const r={schema:1,status:'PASS',environment:'FairSwapTest',projectRef:refs.FairSwapTest,sourceCommit:c.GITHUB_SHA,runId:'1',runAttempt:'1',sha256:SHA,version:VERSION,migrationAttempted:true,phase:'postflight',postflight:true,cliVersion:'2.117.0',tls:'verify-full',completedAt:new Date().toISOString(),backupRecovery:backupWaiver('FairSwapTest')};
 for(const k of ['beforeSha256','afterSha256','schemaSecuritySha256','protectionSha256','exposureSha256'])r[k]='b'.repeat(64);
 const check=x=>{const b=JSON.stringify(x);return verifyTestReceipt(b,sha(b),c);};
 check(r);assert.throws(()=>check({...r,runAttempt:'2'}));assert.throws(()=>check({...r,status:'FAIL'}));assert.throws(()=>check({...r,cliVersion:'latest'}));
});
test('workflow retains ordered protected deployment and disables legacy',()=>{
 const w=readFileSync('.github/workflows/fsw-sec-003-prelaunch.yml','utf8');
 assert.match(w,/environment: FairSwapTest/);assert.match(w,/environment: FairSwapProd/);assert.match(w,/needs: \[verify, test, verify_test\]/);
 assert.doesNotMatch(w,/AUTHORITY|install-fsw-sec-003-pg/);
 assert.match(readFileSync('.github/workflows/fsw-sec-003-protected-release.yml','utf8'),/false && github.repository/);
});

test('both ubuntu jobs use authenticated noble PGDG client installation',()=>{
 const workflow=readFileSync('.github/workflows/fsw-sec-003-prelaunch.yml','utf8');
 assert.equal(workflow.match(/run: bash scripts\/release\/install-fsw-sec-003-client.sh/g)?.length,2);
 const installer=readFileSync('scripts/release/install-fsw-sec-003-client.sh','utf8');
 for(const pin of ['noble-pgdg','signed-by=','B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8','--no-install-recommends postgresql-client-17','/usr/lib/postgresql/17/bin/psql --version'])assert.ok(installer.includes(pin));
 assert.doesNotMatch(installer,/make|configure|apt-key|trusted=yes/);
 const production=workflow.slice(workflow.indexOf('  production:'));
 assert.match(production,/needs.test.result == 'success' && needs.verify_test.result == 'success'/);
 assert.doesNotMatch(production,/always\(\).*needs.test|continue-on-error/);
});
