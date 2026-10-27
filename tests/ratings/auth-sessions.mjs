import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';

export function target(env) {
 assert.equal(env.RATINGS_AUTH_TARGET,'FairSwapTest','Explicit Test target required');
 assert.equal(env.RATINGS_AUTH_URL,'https://wpppxlnbzqynvhpeuavd.supabase.co','Only FairSwapTest is allowed');
 assert(env.RATINGS_AUTH_PUBLISHABLE_KEY,'Missing RATINGS_AUTH_PUBLISHABLE_KEY');
 const key=env.RATINGS_AUTH_PUBLISHABLE_KEY;
 assert(typeof key==='string'&&key.trim()===key,'Test publishable/anon key required');
 if(!/^sb_publishable_[\w-]+$/.test(key)) {
  try {
   assert(/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key));
   const c=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8'));
   assert(c.role==='anon'&&c.ref==='wpppxlnbzqynvhpeuavd');
  } catch {throw new Error('Test publishable/anon key required');}
 }
}

// RFC 6238, SHA-1 / six digits / 30 seconds. Secret never leaves memory.
export function totp(secret,now=Date.now()) {
 assert(/^[A-Z2-7]{16,}={0,6}$/i.test(secret),'Invalid TOTP secret');
 let bits='';for(const c of secret.toUpperCase().replace(/=/g,''))bits+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5,'0');
 const key=Buffer.from((bits.match(/.{8}/g)||[]).map(b=>parseInt(b,2)));
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(now/30000)));
 const digest=createHmac('sha1',key).update(counter).digest();const offset=digest[19]&15;
 return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}

// Existing explicitly supplied accounts/factor only. No admin API, enrollment,
// role grants, password changes, persistence, automatic refresh or email delivery.
async function acquireSessions(env,accept,clientFactory) {
 target(env);
 for(const role of ['SELLER','BUYER','OUTSIDER','STAFF'])for(const field of ['EMAIL','PASSWORD'])assert(typeof env[`RATINGS_AUTH_${role}_${field}`]==='string'&&env[`RATINGS_AUTH_${role}_${field}`].trim().length>0,`Missing RATINGS_AUTH_${role}_${field}`);
 assert(typeof env.RATINGS_AUTH_STAFF_FACTOR_ID==='string'&&env.RATINGS_AUTH_STAFF_FACTOR_ID.trim(),'Missing RATINGS_AUTH_STAFF_FACTOR_ID');
 totp(env.RATINGS_AUTH_STAFF_TOTP_SECRET||'');
 const factory=clientFactory??(await import('@supabase/supabase-js')).createClient;
 const clients=[];const result={...env};
 try {
  for(const role of ['SELLER','BUYER','OUTSIDER','STAFF']) {
   const client=factory(env.RATINGS_AUTH_URL,env.RATINGS_AUTH_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(url,options)=>globalThis.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)})}});
   clients.push(client);
   const {data,error}=await client.auth.signInWithPassword({email:env[`RATINGS_AUTH_${role}_EMAIL`],password:env[`RATINGS_AUTH_${role}_PASSWORD`]});
   assert(!error&&data?.session?.access_token,'Test password authentication failed');
   result[`RATINGS_AUTH_${role==='STAFF'?'STAFF_AAL1':role}_TOKEN`]=data.session.access_token;
   if(role==='STAFF') {
    const factors=await client.auth.mfa.listFactors();
    assert(!factors.error&&factors.data?.totp?.some(f=>f.id===env.RATINGS_AUTH_STAFF_FACTOR_ID&&f.status==='verified'),'Authorized verified TOTP factor required');
    const challenge=await client.auth.mfa.challenge({factorId:env.RATINGS_AUTH_STAFF_FACTOR_ID});
    assert(!challenge.error&&challenge.data?.id,'TOTP challenge failed');
    const verified=await client.auth.mfa.verify({factorId:env.RATINGS_AUTH_STAFF_FACTOR_ID,challengeId:challenge.data.id,code:totp(env.RATINGS_AUTH_STAFF_TOTP_SECRET)});
    assert(!verified.error&&verified.data?.access_token,'TOTP verification failed');
    result.RATINGS_AUTH_STAFF_AAL2_TOKEN=verified.data.access_token;
   }
  }
  return await accept(result);
 } finally {
  let failed=false;
  for(const client of clients)try {const r=await client.auth.signOut({scope:'local'});if(r.error)failed=true;}catch{failed=true;}
  assert(!failed,'Test session cleanup failed');
 }
}

// Never propagate SDK/provider payloads or credential-bearing assertion errors.
export async function withSessions(env,accept,clientFactory) {
 try {return await acquireSessions(env,accept,clientFactory);}
 catch {throw new Error('Test-only Auth session acquisition or cleanup failed (details suppressed)');}
}
