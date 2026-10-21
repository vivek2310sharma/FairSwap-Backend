import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runFreeShadowEvaluation} from '../../src/lib/moderation/v2/shadow-evaluator.ts';

const all = ['harassment','harassment/threatening','hate','hate/threatening','illicit','illicit/violent','sexual/minors','sexual','self-harm','self-harm/intent','self-harm/instructions','violence','violence/graphic'];
const response={model:'omni-moderation-2024-09-26',results:[{flagged:false,categories:Object.fromEntries(all.map(k=>[k,false])),category_scores:Object.fromEntries(all.map(k=>[k,0]))}]};
const canonical=Uint8Array.from([82,73,70,70,8,0,0,0,87,69,66,80,0,0,0,0]);
const sha=createHash('sha256').update(canonical).digest('hex');
const input={listingId:'listing-uuid',generationId:'generation-uuid',revision:1,title:'Used smartphone',description:'OTP ya UPI PIN kabhi share mat karo',media:[{mediaId:'photo1',sha256:sha}]};
const deps={provider:{apiKey:'test_fake_key_123',fetcher:async()=>new Response(JSON.stringify(response))},readCanonical:async()=>canonical,isCurrent:async()=>true};

test('clean shadow review never grants publish authority',async()=>{
 const res=await runFreeShadowEvaluation(input,deps);
 assert.equal(res.authority,'SHADOW_ONLY_NEVER_PUBLISH');
 assert.equal(res.route,'no_harm_flags');
 assert.equal(res.checks.length,3);
 assert.deepEqual(res.fraud.description,[]);
});

test('scam signals route for manual review even without OpenAI harm flags',async()=>{
 const res=await runFreeShadowEvaluation({...input,description:'देखने से पहले ₹500 टोकन UPI से भेजें'},deps);
 assert.equal(res.route,'review');
 assert.equal(res.fraud.description[0].id,'ADVANCE_VIEWING');
});

test('stale listing snapshot is never publishable',async()=>{
 const res=await runFreeShadowEvaluation(input,{...deps,isCurrent:async()=>false});
 assert.equal(res.stale,true);
 assert.equal(res.route,'retry');
});

test('provider failure fails closed',async()=>{
 const res=await runFreeShadowEvaluation(input,{...deps,provider:{...deps.provider,fetcher:async()=>new Response('error',{status:503})}});
 assert.equal(res.route,'retry');
});
