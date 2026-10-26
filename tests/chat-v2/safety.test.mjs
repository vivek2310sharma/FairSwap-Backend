import './offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyIndiaChatSafety, findIndiaFraudSignals} from '../../src/lib/moderation/v2/india-fraud.ts';
import {runChatSafetyBatch} from '../../src/lib/chat-v2/safety-worker.ts';

const cases = [
  ['Send your OTP now', ['OTP_PIN']],
  ['Paise receive karne ke liye QR scan karke UPI PIN dalo', ['OTP_PIN','QR_RECEIVE']],
  ['अपना OTP और UPI PIN मुझे भेजें', ['OTP_PIN']],
  ['देखने से पहले ₹500 टोकन UPI से भेजें', ['ADVANCE_VIEWING']],
  ['Main CRPF officer hoon refundable transfer fee bhejo', ['ADVANCE_DELIVERY','IMPERSONATION_FEE']],
  ['Pay advance for courier delivery', ['ADVANCE_DELIVERY']],
  ['Send payment to seller@okaxis', ['UPI_COLLECT']],
  ['Accept this UPI collect request to receive money', ['UPI_COLLECT']],
  ['Pay booking at https://payments.example/collect', ['PAYMENT_LINK']],
  ['WhatsApp me at +91 98765 43210', ['OFF_PLATFORM']],
  ['व्हाट्सऐप पर बात करो', ['OFF_PLATFORM']],
  ['Never share your OTP', []],
  ['To receive UPI money, you do not need to enter your UPI PIN', []],
  ['UPI PIN डालने की जरूरत नहीं है', []],
  ['UPI PIN dalna ki zarurat nahi hai', []],
  ['OTP ya UPI PIN kabhi share mat karo', []],
  ['UPI PIN किसी को शेयर मत करें', []],
  ['Do not pay an advance for courier delivery', []],
  ['Never click payment links at https://payments.example', []],
  ['Is the bicycle available?', []],
  ['Army green bicycle with local pickup', []],
  ['UPI accepted after inspection', []],
  ['Meet at https://www.google.com/maps/place/Metro', []],
  ['Pay booking at https://google.com.maps.evil.example/collect', ['PAYMENT_LINK']],
  ['Never share OTP. Send OTP now', ['OTP_PIN']],
  ["Don't worry, send OTP now", ['OTP_PIN']],
  ['Send O\u200bTP now', ['OTP_PIN']],
  ['Ｓｅｎｄ ＯＴＰ now', ['OTP_PIN']],
];
for (const [input, expected] of cases) test(input, () => {
  const result = classifyIndiaChatSafety(input);
  assert.equal(result.rule_version, 'chat_india_v1');
  assert.deepEqual(result.rule_ids, expected.slice().sort());
  assert.deepEqual(Object.keys(result).sort(), ['rule_ids','rule_version']);
});
test('bounded input and unchanged listing rules', () => {
  assert.deepEqual(classifyIndiaChatSafety('x'.repeat(2001)).rule_ids, []);
  assert.deepEqual(findIndiaFraudSignals('WhatsApp me at 9876543210'), []);
});
const job = {message_id:'11111111-1111-4111-8111-111111111111',lease_token:'22222222-2222-4222-8222-222222222222',content:'Send OTP now'};
test('worker completes only by message ID and token, never forwards content', async () => {
  const calls = [];
  const result = await runChatSafetyBatch({rpc:async(name,args)=>{
    calls.push({name,args}); return {data:name==='chat_safety_claim'?[job]:true,error:null};
  }});
  assert.deepEqual(result,{claimed:1,completed:1,failed:0});
  assert.deepEqual(calls[1],{name:'chat_safety_complete',args:{message_id:job.message_id,lease_token:job.lease_token,rule_ids:['OTP_PIN']}});
});
test('bad claim fails closed with generic error', async () => {
  await assert.rejects(runChatSafetyBatch({rpc:async()=>({data:[{...job,lease_token:'forged'}],error:null})}), /CHAT_SAFETY_CLAIM_FAILED/);
});
test('claim transport errors never expose the upstream body', async () => {
  await assert.rejects(runChatSafetyBatch({rpc:async()=>{throw new Error('private upstream body');}}),
    (error)=>error.message==='CHAT_SAFETY_CLAIM_FAILED');
});
test('per-message failure leaves retry to the lease; does not stop the batch', async () => {
  let completions=0;
  const result=await runChatSafetyBatch({rpc:async(name)=>{
    if(name==='chat_safety_claim') return {data:[job,{...job,message_id:'33333333-3333-4333-8333-333333333333'}],error:null};
    if(++completions===1) throw new Error('untrusted upstream body');
    return {data:true,error:null};
  }});
  assert.deepEqual(result,{claimed:2,completed:1,failed:1});
});
test('a truthy non-boolean completion is a failure', async () => {
  assert.equal((await runChatSafetyBatch({rpc:async(name)=>({data:name==='chat_safety_claim'?[job]:'true',error:null})})).failed,1);
});
