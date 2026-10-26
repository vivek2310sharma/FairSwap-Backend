import './offline-guard.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {dispatchChatSafety,TARGETS} from '../../scripts/chat-safety/scheduler.mjs';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const config={target:'test',enabled:'true',secret:'a'.repeat(64),runId:'123'};
const success=()=>Response.json({state:'completed',claimed:1,completed:1,failed:0});
test('disabled scheduler never sends or requires a secret',async()=>{let calls=0;assert.equal((await dispatchChatSafety({target:'test',enabled:'false'},{fetch:()=>{calls++;}})).attempts,0);assert.equal(calls,0);});
for(const target of ['test','prod'])test(`fixed ${target} URL, redirect denial and stable invocation without DB key`,async()=>{
  const value={...config,target};let captured;
  const result=await dispatchChatSafety(value,{fetch:async(url,options)=>{captured={url,options};return success();}});
  assert.equal(captured.url,TARGETS[target].url);assert.equal(captured.options.redirect,'error');assert.equal(captured.options.method,'POST');
  assert.equal(captured.options.headers.Authorization,`Bearer ${config.secret}`);assert.equal(captured.options.headers['x-chat-safety-invocation-id'],`gha:123:${target}`);
  assert.equal(captured.options.headers['x-chat-safety-target'],target);assert(!captured.url.includes(config.secret));assert.equal(result.completed,1);
});
for(const bad of [{target:'__proto__'},{target:'https://evil.invalid'},{enabled:'TRUE'},{secret:'sb_secret_not_a_jwt'},{runId:'123\nunsafe'}])test(`invalid configuration ${Object.keys(bad)[0]} cannot deliver`,async()=>{
  await assert.rejects(dispatchChatSafety({...config,...bad},{fetch:()=>assert.fail('network attempted')}),e=>e.code==='INVALID_CONFIGURATION');
});
test('transient retries are bounded and preserve the idempotency key',async()=>{
  const requests=[],waits=[];const result=await dispatchChatSafety(config,{fetch:async(_,options)=>{requests.push(options.headers['x-chat-safety-invocation-id']);return requests.length<3?new Response('private upstream text',{status:503}):success();},wait:async ms=>waits.push(ms)});
  assert.deepEqual(requests,['gha:123:test','gha:123:test','gha:123:test']);assert.deepEqual(waits,[1000,3000]);assert.equal(result.attempts,3);
});
test('authentication failure is terminal and never reflects response text',async()=>{let calls=0;await assert.rejects(dispatchChatSafety(config,{fetch:async()=>{calls++;return new Response(config.secret,{status:401});}}),e=>e.code==='AUTH_OR_CONFIGURATION_REJECTED'&&!e.message.includes(config.secret));assert.equal(calls,1);});
test('transport exceptions never leak credentials; three attempts maximum',async()=>{let calls=0;await assert.rejects(dispatchChatSafety(config,{fetch:async()=>{calls++;throw Error(config.secret);},wait:async()=>{}}),e=>e.code==='DELIVERY_RETRY_EXHAUSTED'&&!e.message.includes(config.secret));assert.equal(calls,3);});
for(const data of [{state:'completed',claimed:21,completed:21,failed:0},{state:'completed',claimed:1,completed:0,failed:1},{state:'disabled',claimed:1,completed:1,failed:0},{state:'completed',claimed:0,completed:0,failed:0,secret:'private'}])test('untrusted success payload fails closed',async()=>{
  await assert.rejects(dispatchChatSafety(config,{fetch:async()=>Response.json(data)}),e=>e.code==='INVALID_RESPONSE');
});
test('oversized response is bounded',async()=>{await assert.rejects(dispatchChatSafety(config,{fetch:async()=>new Response('x'.repeat(2049))}),e=>e.code==='INVALID_RESPONSE');});
test('workflow is protected, default-off, environment-isolated and never receives a service-role key',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/chat-safety-scheduler.yml',import.meta.url),'utf8');
  for(const text of ['environment: chat-safety-test','environment: chat-safety-prod',"github.ref == 'refs/heads/main'",'CHAT_SAFETY_TEST_SCHEDULER_ENABLED','CHAT_SAFETY_PROD_SCHEDULER_ENABLED','cancel-in-progress: false','runs-on: ubuntu-slim'])assert(workflow.includes(text));
  assert(!/pull_request|secrets\.SUPABASE|continue-on-error/.test(workflow));assert(!workflow.includes(config.secret));
});
for(const name of ['fairswaptest','fairswapprod'])test(`${name} inactive manifest agrees with the workflow and fixed endpoint`,()=>{
  const config=JSON.parse(readFileSync(new URL(`../../supabase/forward-migrations/chat-v2/release/external/${name}.json`,import.meta.url),'utf8'));
  const workflow=readFileSync(new URL('../../.github/workflows/chat-safety-scheduler.yml',import.meta.url),'utf8');
  assert.equal(config.enabled,false);assert.equal(config.project_ref,TARGETS[config.target].project);assert(workflow.includes(`environment: ${config.github_environment}`));assert(workflow.includes(config.cron_utc));
  assert.equal(config.attempts,3);assert.equal(config.request_timeout_ms,15000);assert.deepEqual(config.backoff_ms,[1000,3000]);
});
test('CLI rejects injected service credentials without network or secret output',()=>{
  const entry=fileURLToPath(new URL('../../scripts/chat-safety/run-scheduler.mjs',import.meta.url)),guard=new URL('./offline-guard.mjs',import.meta.url).href;
  const r=spawnSync(process.execPath,['--import',guard,entry],{encoding:'utf8',env:{PATH:process.env.PATH,CHAT_SAFETY_TARGET:'test',CHAT_SAFETY_SCHEDULER_ENABLED:'true',CHAT_SAFETY_WORKER_SECRET:config.secret,GITHUB_RUN_ID:'123',SUPABASE_SERVICE_ROLE_KEY:'synthetic-forbidden-credential'}});
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'CHAT_SAFETY_SCHEDULER_FAILED:UNAVAILABLE');assert(!r.stderr.includes(config.secret));assert(!r.stderr.includes('synthetic-forbidden'));
});
