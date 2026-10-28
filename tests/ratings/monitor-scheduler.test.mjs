import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invokeRatingsMonitor} from './monitor-scheduler.mjs';
test('external scheduler fixes both target URLs and never follows a protection redirect',async()=>{
 for(const [environment,origin] of [['FairSwapTest','https://fair-swap-git-staging-fairswap.vercel.app'],['FairSwapProd','https://fairswap.in']]){
  const result=await invokeRatingsMonitor({RATINGS_OPERATIONS_ENVIRONMENT:environment,CRON_SECRET:'x'.repeat(32),VERCEL_AUTOMATION_BYPASS_SECRET:'synthetic-bypass'},async(url,options)=>{
   assert.equal(url,origin+'/api/internal/ratings-monitor');assert.equal(options.redirect,'error');
   assert.equal(options.headers['x-vercel-protection-bypass'],'synthetic-bypass');return {ok:true,json:async()=>({ok:true,alerts:0})};
  });assert.equal(result,0);
 }
});
test('scheduler fails before transport on bad config and fails on non-2xx or invalid heartbeat',async()=>{
 let called=false;await assert.rejects(()=>invokeRatingsMonitor({},async()=>{called=true;}));assert.equal(called,false);
 const env={RATINGS_OPERATIONS_ENVIRONMENT:'FairSwapProd',CRON_SECRET:'x'.repeat(32)};
 for(const response of [{ok:false},{ok:true,json:async()=>({ok:true,alerts:NaN})},{ok:true,json:async()=>({ok:false,alerts:0})}])await assert.rejects(()=>invokeRatingsMonitor(env,async()=>response));
});
