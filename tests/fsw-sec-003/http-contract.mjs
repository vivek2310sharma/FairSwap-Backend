import assert from 'node:assert/strict';
import { createHmac,randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync,readFileSync,openSync,closeSync } from 'node:fs';
import path from 'node:path';
import { NativeDatabase } from './native-adapter.mjs';
export async function verifyHttp(bin,socket,postgrest) {
 const db=new NativeDatabase(bin,socket);
 await db.exec('create role search_http_auth login noinherit; grant anon, authenticated to search_http_auth;');
 const port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const jwtSecret=randomBytes(48).toString('hex');
 const config=path.join(socket,'postgrest.conf');
 writeFileSync(config,`db-uri = "postgresql://search_http_auth@/postgres?host=${encodeURIComponent(socket)}&port=5432"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = ${port}\njwt-secret = "${jwtSecret}"\nlog-level = "crit"\n`,{mode:0o600});
 const fd=openSync(path.join(socket,'postgrest.log'),'w',0o600);
 const child=spawn(postgrest,[config],{stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,...(process.platform==='darwin'?{DYLD_LIBRARY_PATH:path.resolve(bin,'../lib')}:{})}});
 let spawnError; child.on('error',e=>{spawnError=e;});
 const base=`http://127.0.0.1:${port}`;
 const token=()=>{
  const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({role:'authenticated',sub:'00000000-0000-0000-0000-000000000001',exp:Math.floor(Date.now()/1000)+120})).toString('base64url');
  return `${head}.${payload}.${createHmac('sha256',jwtSecret).update(`${head}.${payload}`).digest('base64url')}`;
 };
 let tests=0;
 try {
  let ready=false;
  for(let i=0;i<100;i++) {
   if(spawnError) throw spawnError;
   if(child.exitCode!==null||child.signalCode!==null) throw Error('PostgREST fixture exited: '+readFileSync(path.join(socket,'postgrest.log'),'utf8'));
   try {const r=await fetch(base+'/',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}} catch {}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready,'PostgREST startup required');
  for(const authenticated of [false,true]) {
   const headers={'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${token()}`}:{})};
   const rpc=async(payload,route='search_public_listings',extra={})=>{
    const r=await fetch(`${base}/rpc/${route}`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});
    return {status:r.status,body:await r.json()};
   };
   const valid=await rpc({query:'laptop',page:1,per_page:12});
   assert.equal(valid.status,200); assert.equal(valid.body.total_count,119);
   assert.deepEqual(Object.keys(valid.body).sort(),['items','page','per_page','total_count','total_pages']);
   assert.equal(valid.body.items.length,12); assert.equal(valid.body.page,1); assert.equal(valid.body.per_page,12); assert.equal(valid.body.total_pages,10);
   assert.ok(valid.body.items.every(i=>!('pin_code' in i)&&!('landmark' in i)&&i.status==='active')); tests++;
   for(const payload of [{},{query:'साइकिल'},{query:'अ'.repeat(100)},{page:1000,per_page:50}]) {assert.equal((await rpc(payload)).status,200);tests++;}
   assert.equal((await rpc({query:'साइकिल'})).body.total_count,1);tests++;
   for(const payload of [{query:'a'.repeat(101)},{query:' '.repeat(4097)},{page:0},{page:1001},{page:2147483647},{condition:'invalid'},{category_slug:'missing'},{price_min:-1},{price_min:200,price_max:100},{sort:'invalid'}]) {
    const r=await rpc(payload);assert.equal(r.status,400);assert.equal(r.body.code,'22023');tests++;
   }
   for(const payload of [{page:'oops'},{city_id:'bad'}]) {const r=await rpc(payload);assert.equal(r.status,400);assert.equal(r.body.code,'22P02');tests++;}
   const internal=await rpc({},'impl_search_public_listings');assert.equal(internal.status,404);tests++;
   const privateSchema=await rpc({},'impl_search_public_listings',{'Content-Profile':'app_security'});assert.equal(privateSchema.status,406);tests++;
  }
  assert.equal(tests,40);
  console.log(JSON.stringify({status:'PASS',httpChecks:tests,transport:'PostgREST 12.2.12 on disposable loopback; synthetic JWT only'}));
 } finally {
  child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null||spawnError) return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);});
  closeSync(fd);
 }
}
