import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuration,verifyAuth} from './auth-test-only.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
// Deliberately unsigned offline fixtures; never sent to a hosted service.
const jwt=(n,aal='aal1',extra={})=>'e30.'+Buffer.from(JSON.stringify({iss:'https://wpppxlnbzqynvhpeuavd.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',sub:id(n),session_id:id(n+10),aal,iat:Math.floor(Date.now()/1000)-10,exp:Math.floor(Date.now()/1000)+600,...extra})).toString('base64url')+'.fixture';
const env={RATINGS_AUTH_TARGET:'FairSwapTest',RATINGS_AUTH_URL:'https://wpppxlnbzqynvhpeuavd.supabase.co',RATINGS_AUTH_PUBLISHABLE_KEY:'sb_publishable_fixture',
 RATINGS_AUTH_SELLER_TOKEN:jwt(1),RATINGS_AUTH_BUYER_TOKEN:jwt(2),RATINGS_AUTH_OUTSIDER_TOKEN:jwt(3),RATINGS_AUTH_STAFF_AAL1_TOKEN:jwt(4),RATINGS_AUTH_STAFF_AAL2_TOKEN:jwt(4,'aal2')};
const transport=(change=x=>x)=>async(url,options)=>{
 assert.equal(options.redirect,'error');assert(options.signal);assert.equal(options.method,url.endsWith('/auth/v1/user')||url.includes('?select=')?'GET':'POST');
 const token=options.headers.Authorization.slice(7);let status=200,data;
 const c=token==='invalid-token'?null:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
 if(!c){status=401;data={code:'invalid_token'};}
 else if(url.endsWith('/auth/v1/user'))data={id:c.sub,is_anonymous:false};
 else if(url.includes('/rpc/admin_ratings_cases')){
  assert.deepEqual(JSON.parse(options.body),{kind:'dispute'});
  status=c.sub===id(4)&&c.aal==='aal2'?500:403;
  data={code:status===500?'55000':'42501',message:status===500?'RATINGS_STAFF_DISABLED':'RATINGS_ACCESS_DENIED'};
 }else if(url.includes('/rpc/ratings_pending')){status=500;data={code:'55000',message:'RATINGS_DISABLED'};}
 else {status=403;data={code:'42501'};}
 return change({status,json:async()=>data},url,options);
};
test('all missing inputs and unsafe configurations fail before transport',async()=>{
 const overrides=Object.keys(env).map(n=>({[n]:''}));
 overrides.push({RATINGS_AUTH_TARGET:'FairSwapProd'},{RATINGS_AUTH_URL:'https://kriuhwppxgxsyyrbjsau.supabase.co'},
 {RATINGS_AUTH_PUBLISHABLE_KEY:'sb_secret_fixture'},
 {RATINGS_AUTH_PUBLISHABLE_KEY:jwt(1,'aal1',{role:'service_role',ref:'wpppxlnbzqynvhpeuavd'})},
 {RATINGS_AUTH_PUBLISHABLE_KEY:jwt(1,'aal1',{role:'anon',ref:'kriuhwppxgxsyyrbjsau'})},
 ...[{exp:0},{iss:'https://wrong.invalid/auth/v1'},{role:'service_role'},{aud:'anon'},{is_anonymous:true},{session_id:null},{nbf:9999999999},{iat:9999999999}].map(c=>({RATINGS_AUTH_BUYER_TOKEN:jwt(2,'aal1',c)})),
 {RATINGS_AUTH_BUYER_TOKEN:env.RATINGS_AUTH_SELLER_TOKEN},{RATINGS_AUTH_STAFF_AAL2_TOKEN:jwt(5,'aal2')},
 {RATINGS_AUTH_STAFF_AAL1_TOKEN:jwt(4,'aal2')},{RATINGS_AUTH_STAFF_AAL2_TOKEN:jwt(4)},
 {RATINGS_AUTH_BUYER_TOKEN:'malformed'}, {RATINGS_AUTH_BUYER_TOKEN:' secret '});
 for(const override of overrides){let requests=0;await assert.rejects(()=>verifyAuth({...env,...override},async()=>{requests++;}));assert.equal(requests,0);}
 assert(configuration(env));
 assert(configuration({...env,RATINGS_AUTH_PUBLISHABLE_KEY:jwt(1,'aal1',{iss:'supabase',role:'anon',ref:'wpppxlnbzqynvhpeuavd'})}));
});
test('real request matrix with offline transport and safe receipt',async()=>{
 let requests=0;
 const result=await verifyAuth(env,transport((r)=>{requests++;return r;}));
 assert.deepEqual(result,{identities:4,tokens:5,directReadDenials:25});assert.equal(requests,42);
 assert(!JSON.stringify(result).includes(id(1)));
});
test('authorization, identity and response regressions fail closed',async()=>{
 for(const mutate of [
  (r,u)=>u.includes('?select=')?{status:200,json:async()=>[]}:r,
  (r,u)=>u.includes('/rpc/')?{...r,status:200}:r,
  (r,u)=>u.includes('admin_ratings')?{...r,json:async()=>({code:'42501',message:'RATINGS_ACCESS_DENIED'})}:r,
  (r,u)=>u.endsWith('/auth/v1/user')?{...r,json:async()=>({id:id(9)})}:r,
  r=>({...r,json:async()=>{throw Error('secret response');}}),
  r=>({...r,json:async()=>null}),
 ])await assert.rejects(()=>verifyAuth(env,transport(mutate)),{message:'Test-only Auth acceptance failed (details suppressed)'});
});
test('transport failures cannot leak credentials through exported errors',async()=>{
 await assert.rejects(()=>verifyAuth(env,async()=>{throw Error(env.RATINGS_AUTH_SELLER_TOKEN);}),e=>{
  assert.equal(e.message,'Test-only Auth acceptance failed (details suppressed)');assert.equal(e.cause,undefined);return true;
 });
});
