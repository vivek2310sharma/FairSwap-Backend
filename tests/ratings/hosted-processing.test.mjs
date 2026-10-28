import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runHostedProcessing} from './hosted-processing.mjs';
const env={RATINGS_ACCEPTANCE_TARGET:'FairSwapTest',RATINGS_ACCEPTANCE_URL:'https://wpppxlnbzqynvhpeuavd.supabase.co',RATINGS_ACCEPTANCE_TRADE_ID:'00000000-0000-4000-8000-000000000001',RATINGS_ACCEPTANCE_SERVICE_KEY:'synthetic-key'};
test('missing inputs, Prod and arbitrary URLs fail before transport',async()=>{
 let calls=0;const transport=async()=>{calls++;throw new Error('must not run');};
 for(const override of [{RATINGS_ACCEPTANCE_TARGET:'FairSwapProd'},{RATINGS_ACCEPTANCE_URL:'https://example.invalid'},{RATINGS_ACCEPTANCE_TRADE_ID:''},{RATINGS_ACCEPTANCE_SERVICE_KEY:''}])await assert.rejects(()=>runHostedProcessing({...env,...override},transport),/INPUTS_REQUIRED/);
 assert.equal(calls,0);
});
test('only the scoped fixture RPC is called and replay must return zero',async()=>{
 let calls=0;await runHostedProcessing(env,async(url,options)=>{
  assert.equal(url,env.RATINGS_ACCEPTANCE_URL+'/rest/v1/rpc/ratings_process_fixture');
  assert.deepEqual(JSON.parse(options.body),{trade_id:env.RATINGS_ACCEPTANCE_TRADE_ID});assert.equal(options.redirect,'error');
  return {ok:true,json:async()=>calls++===0?1:0};
 });assert.equal(calls,2);
 await assert.rejects(()=>runHostedProcessing(env,async()=>({ok:true,json:async()=>1})));
});
test('modern secret API keys are never used as bearer JWTs',async()=>{
 await runHostedProcessing({...env,RATINGS_ACCEPTANCE_SERVICE_KEY:'sb_secret_synthetic'},async(_url,options)=>{
  assert.equal(options.headers.apikey,'sb_secret_synthetic');assert.equal(options.headers.Authorization,undefined);
  return {ok:true,json:async()=>0};
 });
});
