import './offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createChatSafetyHandler} from '../../supabase/functions/_shared/chat-safety-worker-handler.ts';
const token='a'.repeat(64); // synthetic credential, never a hosted token
function harness({verification={data:true,error:null},config={supabaseUrl:'https://wpppxlnbzqynvhpeuavd.supabase.co',serviceRoleKey:'synthetic-service-key-only'},failure,begin={state:'claimed',lease_token:'11111111-1111-4111-8111-111111111111'},finish=true}={}){
  const calls=[];
  const handler=createChatSafetyHandler({getConfiguration:()=>{calls.push('config');return config;},createClient:()=>{
    calls.push('client');return{rpc:async(name,args)=>{calls.push(name);
      if(name==='verify_chat_safety_worker_digest'){assert.deepEqual(args,{candidate_sha256:createHash('sha256').update(token).digest('hex')});assert.notEqual(args.candidate_sha256,token);if(failure)throw Error('private upstream text');return verification;}
      if(name==='chat_safety_schedule_begin')return{data:begin,error:null};if(name==='chat_safety_schedule_finish')return{data:finish,error:null};assert.equal(name,'chat_safety_claim');return{data:[],error:null};
    }};
  }});
  return{calls,handler};
}
const request=(method='POST',headers={'x-chat-safety-worker-secret':token})=>new Request('https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-chat-safety',{method,headers:{'x-chat-safety-invocation-id':'gha:123:test','x-chat-safety-target':'test',...headers}});
for(const method of ['GET','PUT','DELETE','OPTIONS'])test(`reject ${method} before configuration/client`,async()=>{
  const h=harness();const response=await h.handler(request(method));assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'POST');assert.deepEqual(h.calls,[]);
});
for(const value of [undefined,'short','A'.repeat(64),'sb_secret_synthetic','sb_publishable_synthetic','a'.repeat(65)])test(`invalid credential format ${String(value).length}`,async()=>{
  const h=harness();const response=await h.handler(request('POST',value?{'x-chat-safety-worker-secret':value}:{Authorization:'Bearer synthetic'}));assert.equal(response.status,401);assert.deepEqual(h.calls,[]);
});
for(const data of [false,null,'true',1,{}])test(`Vault result must be boolean true: ${JSON.stringify(data)}`,async()=>{
  const h=harness({verification:{data,error:null}});const response=await h.handler(request());assert.equal(response.status,401);assert(!h.calls.includes('chat_safety_claim'));assert(!(await response.text()).includes(token));
});
test('Vault RPC error fails closed even if data true',async()=>{const h=harness({verification:{data:true,error:{message:'private upstream text'}}});assert.equal((await h.handler(request())).status,401);assert(!h.calls.includes('chat_safety_claim'));});
test('Vault exception returns generic response and never claims',async()=>{const h=harness({failure:true});const r=await h.handler(request());assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'Unauthorized'});assert(!h.calls.includes('chat_safety_claim'));});
test('invalid server configuration prevents client creation',async()=>{const h=harness({config:{supabaseUrl:'http://internal',serviceRoleKey:'short'}});assert.equal((await h.handler(request())).status,503);assert.deepEqual(h.calls,['config']);});
for(const prefix of ['sb_secret_','sb_publishable_'])test(`new API key ${prefix} never becomes a Bearer JWT`,async()=>{
  const h=harness({config:{supabaseUrl:'https://wpppxlnbzqynvhpeuavd.supabase.co',serviceRoleKey:prefix+'synthetic-not-a-jwt'}});
  assert.equal((await h.handler(request())).status,503);assert.deepEqual(h.calls,['config']);
});
test('Vault verification is the only DB call before authorized claim',async()=>{
  const h=harness();const response=await h.handler(request());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(h.calls,['config','client','verify_chat_safety_worker_digest','chat_safety_schedule_begin','chat_safety_claim','chat_safety_schedule_finish']);assert.deepEqual(await response.json(),{state:'completed',claimed:0,completed:0,failed:0});
});
test('authorized batch failure is generic, never reflected upstream data',async()=>{
  const handler=createChatSafetyHandler({getConfiguration:()=>({supabaseUrl:'https://wpppxlnbzqynvhpeuavd.supabase.co',serviceRoleKey:'synthetic-service-key-only'}),createClient:()=>({rpc:async(name)=>name==='verify_chat_safety_worker_digest'?{data:true,error:null}:{data:null,error:{message:'private message body'}}})});
  const response=await handler(request());assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'Worker unavailable'});
});
test('opaque Bearer authentication reaches the same hash-only verifier',async()=>{
  const h=harness();assert.equal((await h.handler(request('POST',{Authorization:`Bearer ${token}`}))).status,200);
});
test('conflicting authentication and malformed invocation fail before client creation',async()=>{
  const h=harness();assert.equal((await h.handler(request('POST',{Authorization:`Bearer ${token}`,'x-chat-safety-worker-secret':token}))).status,401);
  assert.equal((await h.handler(request('POST',{'x-chat-safety-worker-secret':token,'x-chat-safety-invocation-id':'gha:123:prod'}))).status,400);
  assert.deepEqual(h.calls,[]);
});
for(const [state,status] of [['disabled',200],['busy',409],['failed',503],['exhausted',422]])test(`schedule ${state} never claims messages`,async()=>{
  const h=harness({begin:{state}});assert.equal((await h.handler(request())).status,status);assert(!h.calls.includes('chat_safety_claim'));
});
test('completed replay returns cached counts without a second batch',async()=>{
  const h=harness({begin:{state:'completed',claimed:1,completed:1,failed:0}});const r=await h.handler(request());assert.equal(r.status,200);assert(!h.calls.includes('chat_safety_claim'));
});
test('stale invocation completion is not acknowledged as successful',async()=>{
  const h=harness({finish:false});assert.equal((await h.handler(request())).status,503);
});
