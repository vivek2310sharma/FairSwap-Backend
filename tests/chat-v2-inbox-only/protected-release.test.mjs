import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditProtection} from '../../scripts/release/inbox-protection.mjs';
import {buildPlan,hash} from '../../scripts/release/protected-inbox-plan.mjs';
import {verifyTestReceipt} from '../../scripts/release/protected-inbox-release.mjs';
import {manifest} from '../../scripts/release/chat-v2-inbox-only.mjs';
const input={projectRef:manifest.environments.fairswaptest.projectRef,baseCommit:manifest.baseCommit,observedAt:new Date().toISOString(),reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/60',ledger:[{version:'20260914000011',name:'create_communication',statementsSha256:hash(JSON.stringify(['fixture baseline']))}]};
test('hosted execution removes custom history writes and keeps exact source identity',()=>{
 const plan=buildPlan('fairswaptest',input);assert(!/insert into supabase_migrations/i.test(plan.execution));assert(plan.execution.includes('CHAT_EXACT_LEDGER_MISMATCH'));assert(plan.postflight.includes('CHAT_CLI_HISTORY_REQUIRED'));assert.equal(plan.sourceSha256,manifest.sha256);assert.equal(plan.executionSha256,hash(plan.execution));
});
test('existing foundation must use a protected recovery receipt, never silent history repair',()=>{
 assert.throws(()=>buildPlan('fairswaptest',{...input,ledger:[...input.ledger,{version:manifest.version,name:manifest.name,statementsSha256:hash(JSON.stringify([readFileSync(new URL('../../releases/candidates/chat-v2-inbox-only/supabase/migrations/20261025204922_chat_v2_inbox_and_safety.sql',import.meta.url),'utf8')]))}]}),/PROTECTED_RECOVERY/);
});
test('Production requires successful Test evidence from this exact run, attempt and source',()=>{
 const expected={sha:'a'.repeat(40),runId:'1',runAttempt:'1',bundle:'b'.repeat(64)};
 const receipt={environment:'FairSwapTest',status:'verified',sourceCommit:expected.sha,runId:'1',runAttempt:'1',bundleSha256:expected.bundle,sourceSha256:manifest.sha256,flagsOff:5,historySha256:'c'.repeat(64)};
 verifyTestReceipt(receipt,expected);
 for(const delta of [{runId:'2'},{runAttempt:'2'},{status:'failed'},{environment:'FairSwapProd'},{flagsOff:4},{sourceCommit:'d'.repeat(40)},{bundleSha256:'e'.repeat(64)}])assert.throws(()=>verifyTestReceipt({...receipt,...delta},expected),/SAME_RUN_TEST/);
});
test('unavailable administration APIs block before credentials can be used for DB work',async()=>{
 await assert.rejects(()=>auditProtection('FairSwapTest','fixture',async()=>({ok:false})),/UNVERIFIABLE/);
});
test('workflow is manual/default-off and has separately gated Test and Production environments',()=>{
 const sql=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-release.yml',import.meta.url),'utf8');
 assert(sql.includes('workflow_dispatch:'));assert(!sql.includes('schedule:'));assert(!sql.includes('pull_request:'));assert(sql.includes('default: false'));assert(sql.includes('environment: FairSwapTest'));assert(sql.includes('environment: FairSwapProd'));assert(sql.includes('needs: [verify, test]'));assert(sql.includes('inputs.approved_sha == github.sha'));assert(sql.includes('overwrite: false'));assert(!sql.includes('db push'));
});
test('complete protections pass; self approval, bypass, pagination and repository secrets fail',async()=>{
 const responses={
  '':{visibility:'public'},
  '/environments/FairSwapTest':{protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{reviewer:{id:1}}]}],deployment_branch_policy:{custom_branch_policies:true},can_admins_bypass:false},
  '/rules/branches/main':[{type:'pull_request',ruleset_id:1,parameters:{required_approving_review_count:1,dismiss_stale_reviews_on_push:true}},{type:'required_status_checks',ruleset_id:1,parameters:{required_status_checks:[{context:'backend-ci-success'},{context:'chat-inbox-native-pg17'}]}}],
  '/environments/FairSwapTest/deployment-branch-policies?per_page=100':{total_count:1,branch_policies:[{name:'main',type:'branch'}]},
  '/environments/FairSwapTest/secrets?per_page=100':{total_count:2,secrets:[{name:'CHAT_DATABASE_PASSWORD'},{name:'CHAT_RELEASE_AUDIT_TOKEN'}]},
  '/actions/secrets?per_page=100':{total_count:0,secrets:[]},'/rulesets/1':{enforcement:'active',bypass_actors:[]},
 };
 const api=object=>async url=>({ok:true,json:async()=>object[url.replace('https://api.github.com/repos/vivek2310sharma/FairSwap-Backend','')]});
 assert.equal((await auditProtection('FairSwapTest','fixture',api(responses))).protected,true);
 for(const mutate of [x=>{x['/environments/FairSwapTest'].can_admins_bypass=true;},x=>{x['/actions/secrets?per_page=100']={total_count:1,secrets:[{name:'CHAT_DATABASE_PASSWORD'}]};},x=>{x['/actions/secrets?per_page=100'].total_count=999;},x=>{x['/rulesets/1'].bypass_actors=[{actor_id:1}];}]){
  const copy=structuredClone(responses);mutate(copy);await assert.rejects(()=>auditProtection('FairSwapTest','fixture',api(copy)),/CHAT_/);
 }
});
