import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {totp,withSessions} from './auth-sessions.mjs';
const env={RATINGS_AUTH_TARGET:'FairSwapTest',RATINGS_AUTH_URL:'https://wpppxlnbzqynvhpeuavd.supabase.co',RATINGS_AUTH_PUBLISHABLE_KEY:'sb_publishable_fixture',RATINGS_AUTH_STAFF_FACTOR_ID:'factor',RATINGS_AUTH_STAFF_TOTP_SECRET:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'};
for(const role of ['SELLER','BUYER','OUTSIDER','STAFF'])for(const field of ['EMAIL','PASSWORD'])env[`RATINGS_AUTH_${role}_${field}`]='fixture';
test('RFC 6238 vector (six digit truncation)',()=>assert.equal(totp(env.RATINGS_AUTH_STAFF_TOTP_SECRET,59000),'287082'));
test('all prerequisites checked before client creation',async()=>{
 for(const override of [{RATINGS_AUTH_URL:'https://example.invalid'},{RATINGS_AUTH_PUBLISHABLE_KEY:'sb_secret_fixture'},{RATINGS_AUTH_BUYER_PASSWORD:''},{RATINGS_AUTH_STAFF_TOTP_SECRET:''}]) {
  let calls=0;await assert.rejects(()=>withSessions({...env,...override},()=>{},()=>{calls++;}));assert.equal(calls,0);
 }
});
test('genuine SDK flow retains AAL1, upgrades same client and cleans all local sessions',async()=>{
 let count=0,cleaned=0;const factory=()=>{const n=++count;return {auth:{
  signInWithPassword:async()=>({data:{session:{access_token:`session${n}`}}}),
  mfa:{listFactors:async()=>({data:{totp:[{id:'factor',status:'verified'}]}}),challenge:async()=>({data:{id:'challenge'}}),verify:async({code})=>{assert.match(code,/^\d{6}$/);return {data:{access_token:'upgraded'}};}},
  signOut:async({scope})=>{assert.equal(scope,'local');cleaned++;return {};}
 }}};
 await withSessions(env,async e=>{assert.equal(e.RATINGS_AUTH_STAFF_AAL1_TOKEN,'session4');assert.equal(e.RATINGS_AUTH_STAFF_AAL2_TOKEN,'upgraded');},factory);
 assert.equal(cleaned,4);
 await assert.rejects(()=>withSessions(env,async()=>{throw Error('acceptance failed');},factory));assert.equal(cleaned,8);
});
