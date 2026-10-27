import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuration,verifyAuth} from './auth-test-only.mjs';
const env={RATINGS_AUTH_TARGET:'FairSwapTest',RATINGS_AUTH_URL:'https://wpppxlnbzqynvhpeuavd.supabase.co',RATINGS_AUTH_PUBLISHABLE_KEY:'fixture-key',
 RATINGS_AUTH_SELLER_TOKEN:'seller',RATINGS_AUTH_BUYER_TOKEN:'buyer',RATINGS_AUTH_OUTSIDER_TOKEN:'outsider',RATINGS_AUTH_STAFF_AAL1_TOKEN:'staff1',RATINGS_AUTH_STAFF_AAL2_TOKEN:'staff2'};
test('hosted verifier refuses Production and missing inputs before transport',async()=>{
 for(const override of [{RATINGS_AUTH_TARGET:'FairSwapProd'},{RATINGS_AUTH_URL:'https://kriuhwppxgxsyyrbjsau.supabase.co'},{RATINGS_AUTH_BUYER_TOKEN:''}]){
  let requests=0;await assert.rejects(()=>verifyAuth({...env,...override},async()=>{requests++;}));assert.equal(requests,0);
 }
 assert(configuration(env));
});
const transport=(change=x=>x)=>async(url,options)=>{
 const token=options.headers.Authorization.slice(7);let status=200,data;
 if(url.endsWith('/auth/v1/user')){
  if(token==='invalid-token'){status=401;data={};}else data={id:token.startsWith('staff')?'staff':token};
 }else if(url.includes('/rpc/admin_ratings_cases')){status=403;data={message:token==='staff2'?'RATINGS_STAFF_DISABLED':'RATINGS_ACCESS_DENIED'};}
 else if(url.includes('/rpc/ratings_pending')){status=400;data={code:'55000',message:'RATINGS_DISABLED'};}
 else {status=403;data={code:'42501'};}
 return change({status,json:async()=>data},url);
};
test('hosted verifier exercises four identities and 25 read denials with fake transport',async()=>{
 assert.deepEqual(await verifyAuth(env,transport()),{identities:4,tokens:5,directReadDenials:25});
});
test('hosted verifier fails if direct reads unexpectedly succeed',async()=>{
 await assert.rejects(()=>verifyAuth(env,transport((r,url)=>url.includes('?select=')?{status:200,json:async()=>[]}:r)));
});
