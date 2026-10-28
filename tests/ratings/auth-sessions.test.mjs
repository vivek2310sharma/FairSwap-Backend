import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
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

const codeEnv={...env,RATINGS_AUTH_STAFF_TOTP_MODE:'code',RATINGS_AUTH_STAFF_TOTP_SECRET:undefined};
function codeFlow({challengeError=false,verifyError=false}={}) {
 const steps=[];let cleaned=0;
 const factory=()=>({auth:{
  signInWithPassword:async()=>{steps.push('password');return {data:{session:{access_token:'session'}}};},
  mfa:{listFactors:async()=>({data:{totp:[{id:'factor',status:'verified'}]}}),
   challenge:async()=>{steps.push('challenge');return challengeError?{error:{}}:{data:{id:'challenge'}};},
   verify:async({code})=>{steps.push('verify');assert.equal(code,'123456');return verifyError?{error:{}}:{data:{access_token:'upgraded'}};}},
  signOut:async()=>{cleaned++;return {};}
 }});
 return {factory,steps,cleaned:()=>cleaned};
}
test('code is requested once after actual challenge and callback receives no credentials',async()=>{
 const flow=codeFlow();let requested=0;
 await withSessions(codeEnv,e=>{
  assert.deepEqual(Object.keys(e).sort(),['RATINGS_AUTH_TARGET','RATINGS_AUTH_URL','RATINGS_AUTH_PUBLISHABLE_KEY',
   ...['SELLER','BUYER','OUTSIDER','STAFF_AAL1','STAFF_AAL2'].map(r=>`RATINGS_AUTH_${r}_TOKEN`)].sort());
 },flow.factory,async signal=>{
  assert(signal instanceof AbortSignal);assert.equal(signal.aborted,false);requested++;
  assert.deepEqual(flow.steps,['password','password','password','password','challenge']);return '123456';
 });
 assert.equal(requested,1);assert.equal(flow.cleaned(),4);
});
test('ambiguous, missing and unsafe code inputs fail before creating sessions',async()=>{
 for(const override of [{RATINGS_AUTH_STAFF_TOTP_MODE:'other'},
  {RATINGS_AUTH_STAFF_TOTP_SECRET:env.RATINGS_AUTH_STAFF_TOTP_SECRET},
  ...[undefined,'','0','1','2','256','3x',' 3'].map(fd=>({RATINGS_AUTH_STAFF_TOTP_CODE_FD:fd}))]) {
  let calls=0;await assert.rejects(()=>withSessions({...codeEnv,...override},()=>{},()=>{calls++;}));assert.equal(calls,0);
 }
});
test('invalid, rejected and failed code inputs clean every session and redact errors',async()=>{
 for(const provider of [async()=>'',async()=>123456,async()=> '12345',async()=> '123456\n',async()=>{throw Error('private');}]) {
  const flow=codeFlow();await assert.rejects(()=>withSessions(codeEnv,()=>assert.fail(),flow.factory,provider),
   e=>e.message==='Test-only Auth session acquisition or cleanup failed (details suppressed)'&&e.cause===undefined);
  assert(!flow.steps.includes('verify'));assert.equal(flow.cleaned(),4);
 }
 for(const opts of [{challengeError:true},{verifyError:true}]) {
  const flow=codeFlow(opts);let requested=0;
  await assert.rejects(()=>withSessions(codeEnv,()=>assert.fail(),flow.factory,async()=>{requested++;return '123456';}));
  assert.equal(requested,opts.challengeError?0:1);assert.equal(flow.cleaned(),4);
 }
});
test('code input has a bounded wait and aborts the supplier',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const flow=codeFlow();let inputSignal;
 const result=assert.rejects(()=>withSessions(codeEnv,()=>assert.fail(),flow.factory,signal=>{
  inputSignal=signal;return new Promise(()=>{});
 }));
 for(let n=0;n<30&&!inputSignal;n++)await Promise.resolve();
 assert(inputSignal);t.mock.timers.tick(30000);await result;
 assert(inputSignal.aborted);assert.equal(flow.cleaned(),4);
});

test('inherited code pipe is read at challenge time without echo or credential output',async()=>{
 const script=`import './tests/ratings/offline-guard.mjs';
  import {withSessions} from './tests/ratings/auth-sessions.mjs';
  const factory=()=>({auth:{
   signInWithPassword:async()=>({data:{session:{access_token:'fixture-token'}}}),
   mfa:{listFactors:async()=>({data:{totp:[{id:'factor',status:'verified'}]}}),
    challenge:async()=>{console.log('challenge-ready');return {data:{id:'challenge'}};},
    verify:async({code})=>{if(code!=='123456')throw Error('bad code');return {data:{access_token:'fixture-upgrade'}};}},
   signOut:async()=>({})
  }});
  try {await withSessions(${JSON.stringify({...codeEnv,RATINGS_AUTH_STAFF_TOTP_CODE_FD:'3'})},()=>{},factory);console.log('done');}
  catch {process.exitCode=1;}`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{
  cwd:new URL('../../',import.meta.url),windowsHide:true,stdio:['ignore','pipe','pipe','pipe'],
  env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH}
 });
 let output='',errors='',sent=false;
 const timeout=setTimeout(()=>child.kill(),10000);
 try {
  child.stdout.on('data',chunk=>{
   output+=chunk.toString();if(!sent&&output.includes('challenge-ready\n')){sent=true;child.stdio[3].end('123456\n');}
  });
  child.stderr.on('data',chunk=>{errors+=chunk.toString();});
  const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(status,0);assert.equal(errors,'Test MFA challenge ready; supply one code through the inherited secure pipe.\n');
  assert.equal(output,'challenge-ready\ndone\n');assert(sent);
 } finally {clearTimeout(timeout);child.kill();}
});
