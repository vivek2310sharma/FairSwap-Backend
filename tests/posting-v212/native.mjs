// Real PG17 connections/transaction barriers. Never accepts a URL or live target.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {installPostingFixture} from '../../scripts/ci/posting-v2-fixture.mjs';
import {NativeFixture,literal} from './native-adapter.mjs';
const db=new NativeFixture(...process.argv.slice(2));let checks=0;const u=randomUUID(),other=randomUUID();
const context=(owner=u,name='posting_client')=>({owner,role:'authenticated',name});
const sql=(id,op,media=null)=>`select public.posting_v2_session(${literal(id)},${literal(op)},${literal(media)}) as value`;
const call=async(id,op,owner=u,name='posting_client')=>(await db.query(sql(id,op),[],context(owner,name))).rows[0].value;
const count=async(owner=u)=>(await db.query(`select count(*)::int as n from public.posting_upload_sessions where owner_id=$1 and state in ('open','finalizing') and expires_at>now()`,[owner])).rows[0].n;
const row=async id=>(await db.query('select * from public.posting_upload_sessions where id=$1',[id])).rows[0];
const blanks=async(owner=u)=>{const ids=[];for(let i=0;i<5;i++){const result=await call(randomUUID(),'create_empty',owner);ids.push(result.session.id);await db.exec(`update public.posting_upload_sessions set created_at=now()-interval '${10-i} minutes' where id=${literal(result.session.id)}`);}return ids;};
const hold=async(body,name,owner=u)=>{const handle=db.start(body,context(owner,name),true);await db.wait(handle,r=>r.state==='idle in transaction');return handle;};
const test=async(label,fn)=>{await db.exec('delete from public.posting_upload_sessions');await fn();checks++;console.log(`ok ${checks} - ${label}`);};
try {
 const version=await db.verify();await installPostingFixture(db);
 await db.exec(readFileSync(resolve('supabase/forward-migrations/posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql'),'utf8'));
 await db.exec(readFileSync(resolve('supabase/forward-migrations/posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql'),'utf8'));
 if(process.argv[4]==='--accessories-v1'){const folder=resolve('supabase/forward-migrations/accessories-v1/foundation/supabase/migrations');await db.exec(readFileSync(resolve(folder,readdirSync(folder).find(f=>f.endsWith('.sql'))),'utf8'));}
 await db.exec(`insert into auth.users values(${literal(u)}),(${literal(other)})`);
 await test('two connections create different sessions at capacity and retire the oldest distinct blanks',async()=>{
  const ids=await blanks();const a=randomUUID(),b=randomUUID();const held=await hold(sql(a,'create'),'posting_create_a');
  const waiting=db.start(sql(b,'create'),context(u,'posting_create_b'));const blocked=await db.blocked(waiting,held);assert.equal(blocked.wait_event,'advisory');
  assert.equal(await count(),5);assert.equal((await row(ids[0])).state,'open'); // uncommitted retirement is invisible
  await held.finish();await waiting.done;assert.equal(await count(),5);assert.equal((await row(ids[0])).state,'expired');assert.equal((await row(ids[1])).state,'expired');
  assert.equal((await row(a)).state,'open');assert.equal((await row(b)).state,'open');
 });
 await test('same-id concurrent lost-response retries retire one victim and reuse one listing id',async()=>{
  const ids=await blanks();const id=randomUUID();const held=await hold(sql(id,'create'),'posting_retry_a');const waiting=db.start(sql(id,'create'),context(u,'posting_retry_b'));
  await db.blocked(waiting,held);await held.finish();const retry=JSON.parse(await waiting.done);assert.equal(retry.session.id,id);assert.equal(retry.session.listing_id,(await row(id)).listing_id);
  assert.equal((await row(ids[0])).state,'expired');assert.equal((await row(ids[1])).state,'open');assert.equal(await count(),5);
 });
 await test('one eligible slot permits one winner; the blocked sixth request returns PT429',async()=>{
  const ids=await blanks();for(const id of ids.slice(1))await call(id,'claim_draft');const a=randomUUID(),b=randomUUID();
  const held=await hold(sql(a,'create'),'posting_single_a');const waiting=db.start(sql(b,'create'),context(u,'posting_single_b'));await db.blocked(waiting,held);
  await held.finish();await assert.rejects(waiting.done,e=>e.code==='PT429');assert.equal(await count(),5);assert.equal(await row(b),undefined);assert.equal((await row(a)).state,'open');
 });
 await test('committed draft claim wins before rotation; next-oldest blank is selected',async()=>{
  const ids=await blanks();const held=await hold(sql(ids[0],'claim_draft'),'posting_claim_a');const created=randomUUID();const waiting=db.start(sql(created,'create'),context(u,'posting_claim_b'));
  await db.blocked(waiting,held);await held.finish();await waiting.done;assert.equal((await row(ids[0])).draft_protected,true);assert.equal((await row(ids[0])).state,'open');assert.equal((await row(ids[1])).state,'expired');
 });
 await test('rotation wins before a competing claim; stale client receives expiry',async()=>{
  const ids=await blanks();const held=await hold(sql(randomUUID(),'create'),'posting_rotate_a');const waiting=db.start(sql(ids[0],'claim_draft'),context(u,'posting_rotate_b'));
  await db.blocked(waiting,held);await held.finish();await assert.rejects(waiting.done,e=>e.code==='PT410');assert.equal(await count(),5);
 });
 await test('rolled-back allocation restores its victim before a waiting claim proceeds',async()=>{
  const ids=await blanks();const created=randomUUID();const held=await hold(sql(created,'create'),'posting_rollback_a');const waiting=db.start(sql(ids[0],'claim_draft'),context(u,'posting_rollback_b'));
  await db.blocked(waiting,held);await held.finish(false);await waiting.done;assert.equal(await row(created),undefined);assert.equal((await row(ids[0])).state,'open');assert.equal((await row(ids[0])).draft_protected,true);assert.equal(await count(),5);
 });
 await test('concurrent empty request nonce is idempotent across independent connections',async()=>{
  const nonce=randomUUID();const held=await hold(sql(nonce,'create_empty'),'posting_empty_a');const waiting=db.start(sql(nonce,'create_empty'),context(u,'posting_empty_b'));
  await db.blocked(waiting,held);const first=JSON.parse(await held.finish());const second=JSON.parse(await waiting.done);assert.equal(first.session.id,second.session.id);assert.notEqual(first.session.id,nonce);assert.equal(await count(),1);
 });
 await test('different sellers do not share a capacity lock or retire each other sessions',async()=>{
  const own=await blanks();const theirs=await blanks(other);const held=await hold(sql(randomUUID(),'create'),'posting_owner_a');
  const result=await Promise.race([call(randomUUID(),'create',other,'posting_owner_b'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Cross-owner lock blocked independent seller')),3000);t.unref();})]);
  assert.equal(result.session.owner_id,other);assert.equal((await row(theirs[0])).state,'expired');assert.equal((await row(own[0])).state,'open');await held.finish();assert.equal(await count(),5);assert.equal(await count(other),5);
 });
 await test('RLS and RPC ownership isolate a foreign claim, release and creation attempt',async()=>{
  const ids=await blanks();for(const operation of ['claim_draft','abandon_empty','create'])await assert.rejects(()=>call(ids[0],operation,other),e=>e.code==='42501');
  assert.equal((await db.query('select count(*)::int as n from public.posting_upload_sessions',[],context(other))).rows[0].n,0);
  await assert.rejects(()=>db.start('update public.posting_upload_sessions set draft_protected=false',context()).done,e=>e.code==='42501');
  assert.equal((await call(null,'list_recovery',other)).sessions.length,0);assert.equal(await count(),5);
 });
 await test('an upload row lock protects media before a waiting rotation rechecks its candidate',async()=>{
  const ids=await blanks();const media=randomUUID();const held=await hold(sql(ids[0],'reserve',media),'posting_media_a');const created=randomUUID();const waiting=db.start(sql(created,'create'),context(u,'posting_media_b'));
  const blocked=await db.blocked(waiting,held);assert.notEqual(blocked.wait_event,'advisory'); // reserve holds a row, not the seller advisory lock
  await held.finish();await waiting.done;assert.equal((await row(ids[0])).state,'open');assert.equal((await row(ids[0])).draft_protected,true);assert.equal((await row(ids[1])).state,'expired');
  assert.equal((await db.query('select state from public.posting_staged_media where id=$1',[media])).rows[0].state,'uploading');assert.equal(await count(),5);
 });
 await test('media completion plus concurrent allocation preserves ready photos and object inventory',async()=>{
  const ids=await blanks();const media=randomUUID();const reserved=(await db.query(sql(ids[0],'reserve',media),[],context())).rows[0].value;
  const attempt=reserved.media[0].attempt;await db.exec(`insert into storage.objects values('posting-staged',${literal(u+'/'+ids[0]+'/'+media+'/'+attempt+'/medium.webp')})`);
  const complete=`select public.posting_v2_media_ready(${literal(ids[0])},${literal(media)},${literal(attempt)},100,10,10)`;
  const held=db.start(complete,{owner:u,role:'service_role',jwt:'{"role":"service_role"}',name:'posting_complete_a'},true);await db.wait(held,r=>r.state==='idle in transaction');
  await call(randomUUID(),'create',u,'posting_complete_b');await held.finish();assert.equal((await row(ids[0])).state,'open');assert.equal((await db.query('select state from public.posting_staged_media where id=$1',[media])).rows[0].state,'ready');assert.equal((await db.query('select count(*)::int as n from storage.objects')).rows[0].n,1);
 });
 await test('failed replacement is atomic and leaves original sessions and media intact',async()=>{
  const ids=await blanks();await assert.rejects(()=>call(null,'create'),e=>e.code==='23502');for(const id of ids)assert.equal((await row(id)).state,'open');assert.equal(await count(),5);
 });
 await test('meaningful, unknown, removed-media and finalizing work cannot be automatically rotated',async()=>{
  const ids=await blanks();await call(ids[0],'claim_draft');await call(ids[1],'create');await call(ids[2],'read');
  const media=randomUUID();await db.query(sql(ids[3],'reserve',media),[],context());await db.query(sql(ids[3],'remove',media),[],context());await call(ids[4],'prepare');
  await assert.rejects(()=>call(randomUUID(),'create'),e=>e.code==='PT429');assert.equal(await count(),5);assert.equal((await row(ids[4])).state,'finalizing');
  assert.equal((await db.query('select state from public.posting_staged_media where id=$1',[media])).rows[0].state,'removed');
 });
 console.log(JSON.stringify({status:'PASS',postgres_version_num:version,checks,transport:'independent psql backends, private Unix socket',barriers:'observed pg_stat_activity lock waits; explicit commit/rollback',observations:db.observations}));
} finally {db.close();}
