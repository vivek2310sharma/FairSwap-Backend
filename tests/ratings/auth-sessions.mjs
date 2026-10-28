import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createReadStream,fstatSync} from 'node:fs';

// A trusted operator supplies an inherited pipe, never argv, terminal echo or a
// stored code. Open/read it only after Auth has created the actual challenge.
async function pipeCode(fd,signal) {
 console.error('Test MFA challenge ready; supply one code through the inherited secure pipe.');
 return new Promise((resolve,reject)=>{
  const input=createReadStream(null,{fd:Number(fd),autoClose:true,highWaterMark:8,signal});
  let text='';
  input.on('data',chunk=>{
   text+=chunk.toString('utf8');
   if(text.length>8){input.destroy(new Error('Invalid code input'));return;}
   if(text.includes('\n')){resolve(text.replace(/\r?\n$/,''));input.destroy();}
  });
  input.on('end',()=>resolve(text));input.on('error',reject);
 });
}

async function challengeCode(env,provider) {
 const controller=new AbortController();let timer;
 try {
  return await Promise.race([
   Promise.resolve().then(()=>provider?provider(controller.signal):pipeCode(env.RATINGS_AUTH_STAFF_TOTP_CODE_FD,controller.signal)),
   new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Code input timed out'));},30000);})
  ]);
 } finally {clearTimeout(timer);controller.abort();}
}

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

export function sessionInputs(env,codeProvider) {
 target(env);
 for(const role of ['SELLER','BUYER','OUTSIDER','STAFF'])for(const field of ['EMAIL','PASSWORD'])assert(typeof env[`RATINGS_AUTH_${role}_${field}`]==='string'&&env[`RATINGS_AUTH_${role}_${field}`].trim().length>0,`Missing RATINGS_AUTH_${role}_${field}`);
 assert(typeof env.RATINGS_AUTH_STAFF_FACTOR_ID==='string'&&env.RATINGS_AUTH_STAFF_FACTOR_ID.trim(),'Missing RATINGS_AUTH_STAFF_FACTOR_ID');
 const mode=env.RATINGS_AUTH_STAFF_TOTP_MODE??'seed';
 assert(['seed','code'].includes(mode),'Invalid TOTP input mode');
 if(mode==='seed') {
  assert(!env.RATINGS_AUTH_STAFF_TOTP_CODE_FD&&!codeProvider,'Ambiguous TOTP input');
  totp(env.RATINGS_AUTH_STAFF_TOTP_SECRET||'');
 } else {
  assert(!env.RATINGS_AUTH_STAFF_TOTP_SECRET,'Ambiguous TOTP input');
  assert(codeProvider===undefined||typeof codeProvider==='function','Invalid code provider');
  assert(!(codeProvider&&env.RATINGS_AUTH_STAFF_TOTP_CODE_FD),'Ambiguous code input');
  assert(codeProvider||/^(?:[3-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/.test(env.RATINGS_AUTH_STAFF_TOTP_CODE_FD??''),'Secure code pipe required');
  if(!codeProvider) {
   const stat=fstatSync(Number(env.RATINGS_AUTH_STAFF_TOTP_CODE_FD));
   // Windows anonymous stdio pipes report FIFO mode, but isFIFO() is false.
   assert(stat.isFIFO()||stat.isSocket()||(process.platform==='win32'&&(stat.mode&0xf000)===0x1000),'Inherited code pipe required');
  }
 }
 return mode;
}

// Existing explicitly supplied accounts/factor only. No admin API, enrollment,
// role grants, password changes, persistence, automatic refresh or email delivery.
async function acquireSessions(env,accept,clientFactory,codeProvider) {
 const mode=sessionInputs(env,codeProvider);
 const factory=clientFactory??(await import('@supabase/supabase-js')).createClient;
 const clients=[];const result={RATINGS_AUTH_TARGET:env.RATINGS_AUTH_TARGET,
  RATINGS_AUTH_URL:env.RATINGS_AUTH_URL,RATINGS_AUTH_PUBLISHABLE_KEY:env.RATINGS_AUTH_PUBLISHABLE_KEY};
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
    let code=mode==='seed'?totp(env.RATINGS_AUTH_STAFF_TOTP_SECRET):await challengeCode(env,codeProvider);
    assert(typeof code==='string'&&/^\d{6}$/.test(code),'Invalid one-time code');
    const verified=await client.auth.mfa.verify({factorId:env.RATINGS_AUTH_STAFF_FACTOR_ID,challengeId:challenge.data.id,code});
    code=undefined;
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
export async function withSessions(env,accept,clientFactory,codeProvider) {
 try {return await acquireSessions(env,accept,clientFactory,codeProvider);}
 catch {throw new Error('Test-only Auth session acquisition or cleanup failed (details suppressed)');}
}
