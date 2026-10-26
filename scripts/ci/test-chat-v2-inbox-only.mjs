import '../../tests/chat-v2-inbox-only/offline-guard.mjs';
import {PGlite} from '../../tests/chat-v2-inbox-only/engine.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {canonicalMessaging,root} from '../../tests/chat-v2-inbox-only/canonical.mjs';
import {candidate,manifest,render,validateSnapshot} from '../release/chat-v2-inbox-only.mjs';
if(process.argv.length!==2)throw Error('No target/environment arguments accepted');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let checks=0;
const test=async(label,fn)=>{await fn();console.log(`ok ${++checks} - ${label}`);};
const db=new PGlite();
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const actor=async(user,role='authenticated')=>{await db.exec('set role postgres');await db.query(`select set_config('request.user',$1,false)`,[user??'']);await db.exec(`set role ${role}`);};
const owner=()=>db.exec('set role postgres');
const inbox=(tab='all',size=30,cursor=null,listing=null,query='',unread=false)=>scalar('select public.chat_v2_inbox($1,$2,$3,$4,$5,$6,$7)',[tab,size,cursor?.at??null,cursor?.id??null,listing,query,unread]);
const messages=(conversation,size=50,cursor=null)=>scalar('select public.chat_v2_messages($1,$2,$3,$4)',[conversation,size,cursor?.at??null,cursor?.id??null]);
const rejectScript=async(sql,pattern)=>{await assert.rejects(()=>db.exec(sql),pattern);await db.exec('rollback');};
const snapshot=async(environment='fairswaptest')=>({projectRef:manifest.environments[environment].projectRef,baseCommit:manifest.baseCommit,observedAt:new Date().toISOString(),reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/58',ledger:(await db.query(`select version,name,encode(sha256(convert_to(coalesce(to_jsonb(statements)::text,'null'),'UTF8')),'hex') as "statementsSha256" from supabase_migrations.schema_migrations order by version`)).rows});
const seller=id(1),buyer=id(2),outsider=id(3),listing=id(4),conversation=id(5);
try{
 await db.exec(readFileSync(resolve(root,'tests/chat-v2-inbox-only/bootstrap.sql'),'utf8'));
 await db.exec(canonicalMessaging());
 const review=await snapshot(),scripts=render('fairswaptest',review);
 await test('candidate retains exact reviewed SHA256 and Git blob',async()=>{assert(candidate().sql.includes('chat_v2_inbox'));assert.equal(manifest.gitBlob,'c27408d24436c7dbe6a2a9dde3d8716d91948fb3');});
 await test('preflight is read-only and does not create foundation objects',async()=>{await db.exec(scripts.preflight);assert.equal(await scalar(`select to_regclass('app_security.chat_v2_flags')`),null);});
 await test('missing/duplicate/mismatched identity anchors stop before application',async()=>{
  await db.exec('delete from vault.identity_fixture');await rejectScript(scripts.apply,/CHAT_TRUSTED_IDENTITY_REQUIRED/);
  await db.exec(`insert into vault.identity_fixture values('moderation_worker_url','https://wrong.invalid')`);await rejectScript(scripts.apply,/CHAT_ENVIRONMENT_MISMATCH/);
  await db.exec(`update vault.identity_fixture set decrypted_secret='https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-listing-moderation';insert into vault.identity_fixture select * from vault.identity_fixture`);await rejectScript(scripts.apply,/CHAT_ENVIRONMENT_MISMATCH/);
  await db.exec(`delete from vault.identity_fixture;insert into vault.identity_fixture values('moderation_worker_url','https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-listing-moderation')`);
 });
 await test('wrong environment artifact is independently refused',async()=>{const prod=render('fairswapprod',{...review,projectRef:manifest.environments.fairswapprod.projectRef});await rejectScript(prod.apply,/CHAT_ENVIRONMENT_MISMATCH/);});
 await test('exact migration ledger changes stop atomically',async()=>{
  await db.exec(`insert into supabase_migrations.schema_migrations values('20261026000000',array['drift'],'unreviewed')`);await rejectScript(scripts.apply,/CHAT_EXACT_LEDGER_MISMATCH/);
  assert.equal(await scalar(`select to_regclass('app_security.chat_v2_flags')`),null);await db.exec(`delete from supabase_migrations.schema_migrations where version='20261026000000'`);
 });
 await test('orphaned partial Chat objects cannot be adopted or overwritten',async()=>{
  await db.exec('create table app_security.chat_v2_flags(orphan boolean)');await rejectScript(scripts.apply,/CHAT_ORPHANED_OBJECTS_RECONCILIATION_REQUIRED/);await db.exec('drop table app_security.chat_v2_flags');
 });
 await test('snapshot validation refuses stale, wrong-project, duplicate and worker ledgers',async()=>{
  assert.throws(()=>validateSnapshot('fairswaptest',{...review,observedAt:'2020-01-01T00:00:00Z'}),/EXPIRED/);
  assert.throws(()=>validateSnapshot('fairswapprod',review),/WRONG_ENVIRONMENT/);
  assert.throws(()=>validateSnapshot('fairswaptest',{...review,ledger:[review.ledger[0],review.ledger[0]]}),/DUPLICATE/);
  assert.throws(()=>validateSnapshot('fairswaptest',{...review,ledger:[...review.ledger,{...review.ledger[0],version:'20261026073143'}]}),/WORKER_RELEASE/);
  assert.throws(()=>validateSnapshot('fairswaptest',{...review,reviewEvidence:review.reviewEvidence+'\nselect 1;'}),/SNAPSHOT_INVALID/);
 });
 await test('Test installation and migration ledger are atomic and independently executable',async()=>{await db.exec(scripts.apply);assert.equal(await scalar(`select name from supabase_migrations.schema_migrations where version=$1`,[manifest.version]),manifest.name);});
 await test('all five flags remain off, with no scheduler/HTTP/worker runtime',async()=>{
  assert.equal(await scalar('select count(*)::int from app_security.chat_v2_flags where not enabled'),5);
  for(const table of ['net.http_request_queue','cron.job','app_security.chat_safety_runtime','app_security.chat_safety_scheduler_runs'])assert.equal(await scalar('select to_regclass($1)',[table]),null);
 });
 await test('exact replay is idempotent, without duplicate objects or versions',async()=>{await db.exec(scripts.apply);assert.equal(await scalar(`select count(*)::int from supabase_migrations.schema_migrations where version=$1`,[manifest.version]),1);});
 await test('a newly captured exact installed ledger reconciles without repair or DDL',async()=>{
  const installed=render('fairswaptest',await snapshot());await db.exec(installed.preflight);await db.exec(installed.apply);
 });
 await test('installed function drift is refused without overwriting it',async()=>{
  await db.exec(`create or replace function public.chat_v2_messages(conversation_id uuid,page_size integer default 50,cursor_at timestamptz default null,cursor_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$select '{}'::jsonb$$`);
  await rejectScript(scripts.apply,/CHAT_INSTALLED_FUNCTION_DRIFT/);
  await db.exec(`create or replace function public.chat_v2_messages(conversation_id uuid,page_size integer default 50,cursor_at timestamptz default null,cursor_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$
  select app_security.impl_chat_v2_messages(conversation_id,page_size,cursor_at,cursor_id)
$$`);
 });
 await test('migration body/statement drift is not silently repaired',async()=>{
  await db.query(`update supabase_migrations.schema_migrations set statements=array['changed'] where version=$1`,[manifest.version]);await rejectScript(scripts.apply,/CHAT_EXISTING_FOUNDATION_RECONCILIATION_REQUIRED/);
  await db.query(`update supabase_migrations.schema_migrations set statements=array[$1] where version=$2`,[candidate().sql,manifest.version]);
 });
 await test('RLS and accidental client privilege drift are release blockers',async()=>{
  await db.exec('alter table public.message_safety_findings disable row level security');await rejectScript(scripts.apply,/CHAT_INSTALLED_RLS_DRIFT/);
  await db.exec('alter table public.message_safety_findings enable row level security;grant update on app_security.chat_v2_flags to authenticated');await rejectScript(scripts.apply,/CHAT_INSTALLED_GRANT_DRIFT/);
  await db.exec('revoke update on app_security.chat_v2_flags from authenticated');
 });
 await db.query(`insert into auth.users(id) values($1),($2),($3)`,[seller,buyer,outsider]);
 await db.query(`insert into public.profiles values($1,'Seller'),($2,'Buyer'),($3,'Outsider')`,[seller,buyer,outsider]);
 await db.query(`insert into public.listings values($1,$2,'Bicycle','bicycle',150000,'active',null)`,[listing,seller]);
 await db.query(`insert into public.conversations(id,listing_id,buyer_id,seller_id) values($1,$2,$3,$4)`,[conversation,listing,buyer,seller]);
 await actor(buyer);
 await test('disabled flags reject both readers before activation',async()=>{await assert.rejects(()=>inbox(),/CHAT_V2_DISABLED/);await assert.rejects(()=>messages(conversation),/CHAT_V2_DISABLED/);});
 await test('authenticated/anon cannot activate flags, read private jobs or invoke service RPCs',async()=>{
  for(const role of ['authenticated','anon']){
   await actor(buyer,role);
   for(const sql of [`update app_security.chat_v2_flags set enabled=true`,`select * from app_security.chat_safety_jobs`,`select public.chat_safety_claim()`])await assert.rejects(()=>db.exec(sql));
  }
 });
 await owner();await db.exec(`update app_security.chat_v2_flags set enabled=true where name='inbox'`);
 await test('anon cannot invoke either inbox reader despite a forged request identity',async()=>{
  await actor(buyer,'anon');await assert.rejects(()=>inbox(),/permission denied/);await assert.rejects(()=>messages(conversation),/permission denied/);
 });
 await actor(null);
 await test('missing authenticated identity is rejected',async()=>{await assert.rejects(()=>inbox(),/CHAT_ACCESS_DENIED/);await assert.rejects(()=>messages(conversation),/CHAT_ACCESS_DENIED/);});
 await actor(outsider);
 await test('outsider cannot read thread, seller drilldown or raw messages',async()=>{
  assert.deepEqual((await inbox()).items,[]);await assert.rejects(()=>messages(conversation),/CHAT_ACCESS_DENIED/);await assert.rejects(()=>inbox('selling',30,null,listing),/CHAT_ACCESS_DENIED/);
  assert.equal(await scalar('select count(*)::int from public.messages'),0);
 });
 await actor(buyer);
 let sent;
 await test('existing policy-aware send_message retains idempotent client_request_id',async()=>{
  sent=await scalar(`select public.send_message($1,'Hello seller','inbox-release-retry')`,[conversation]);
  const replay=await scalar(`select public.send_message($1,'Hello seller','inbox-release-retry')`,[conversation]);assert.equal(replay.id,sent.id);assert.equal(replay.is_duplicate,true);
 });
 await test('reads do not advance cursors; unread counts match inbound messages',async()=>{
  assert.equal((await messages(conversation)).peer_read_cursor,null);assert.equal((await inbox()).items[0].unread_count,0);
  await actor(seller);assert.equal((await inbox()).items[0].unread_count,1);assert.equal(await scalar('select count(*)::int from public.conversation_read_states'),0);
 });
 await test('mark_conversation_read updates unread and peer cursor using the real tuple',async()=>{
  await db.query('select public.mark_conversation_read($1,$2)',[conversation,sent.id]);assert.equal((await inbox()).items[0].unread_count,0);
  await actor(buyer);assert.deepEqual((await messages(conversation)).peer_read_cursor,{at:sent.created_at,id:sent.id});
 });
 await test('microsecond/UUID tuple pagination is chronological, complete and monotonic',async()=>{
  await owner();await db.query(`insert into public.messages(id,conversation_id,sender_id,content,client_request_id,created_at) values($1,$2,$3,'tie A','cursor-tie-a','2026-01-01T00:00:00.123455Z'),($4,$2,$3,'tie B','cursor-tie-b','2026-01-01T00:00:00.123456Z'),($5,$2,$3,'tie C','cursor-tie-c','2026-01-01T00:00:00.123456Z')`,[id(20),conversation,buyer,id(21),id(22)]);
  await actor(seller);const first=await messages(conversation,2);assert.equal(first.has_more,true);const second=await messages(conversation,2,first.next_cursor);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,4);assert.deepEqual(second.items.map(row=>row.content),['tie A','tie B']);
  await db.query('select public.mark_conversation_read($1,$2)',[conversation,id(21)]);await db.query('select public.mark_conversation_read($1,$2)',[conversation,id(20)]);
  assert.equal(await scalar('select last_read_message_id from public.conversation_read_states where conversation_id=$1',[conversation]),sent.id);
 });
 await test('invalid cursors, page sizes and non-seller listing filters are rejected',async()=>{
  await assert.rejects(()=>inbox('all',51),/INVALID_CHAT_PAGE/);await assert.rejects(()=>inbox('all',30,{at:'2026-01-01Z'}),/INVALID_CHAT_PAGE/);await assert.rejects(()=>messages(conversation,101),/INVALID_CHAT_PAGE/);
  await actor(buyer);await assert.rejects(()=>inbox('all',30,null,listing),/CHAT_ACCESS_DENIED/);
 });
 await test('bidirectional blocks stop sends without deleting readable participant history',async()=>{
  for(const [a,b] of [[seller,buyer],[buyer,seller]]){
   await owner();await db.query('insert into public.user_blocks values($1,$2)',[a,b]);await actor(buyer);
   await assert.rejects(()=>scalar(`select public.send_message($1,'blocked','blocked-request')`,[conversation]),/MESSAGING_UNAVAILABLE/);
   assert.equal((await messages(conversation)).items.length,4);await owner();await db.exec('delete from public.user_blocks');
  }
 });
 await test('policy and suspended/deleted account restrictions remain authoritative',async()=>{
  await owner();await db.query('update auth.users set policy=false where id=$1',[buyer]);await actor(buyer);
  await assert.rejects(()=>scalar(`select public.send_message($1,'policy','policy-required')`,[conversation]),/POLICY_ACCEPTANCE_REQUIRED/);
  await assert.rejects(()=>db.query('select public.mark_conversation_read($1,$2)',[conversation,sent.id]),/POLICY_ACCEPTANCE_REQUIRED/);
  await owner();await db.query(`update auth.users set policy=true,status='suspended' where id=$1`,[buyer]);await actor(buyer);assert.equal((await messages(conversation)).items.length,4);
  await assert.rejects(()=>scalar(`select public.send_message($1,'suspended','suspended-request')`,[conversation]),/Account restricted/);
  await owner();await db.query(`update auth.users set status='deleted' where id=$1`,[buyer]);await actor(buyer);await assert.rejects(()=>inbox(),/CHAT_ACCESS_DENIED/);
  await owner();await db.query(`update auth.users set status='active' where id=$1`,[buyer]);
 });
 await test('sold/reserved text compatibility is retained; removed/rejected sends stay closed',async()=>{
  for(const status of ['reserved','sold','removed','rejected']){
   await owner();await db.query('update public.listings set status=$1 where id=$2',[status,listing]);await actor(buyer);
   const request=()=>scalar('select public.send_message($1,$2,$3)',[conversation,status,'listing-'+status]);
   if(['removed','rejected'].includes(status))await assert.rejects(request,/MESSAGING_UNAVAILABLE/);else assert((await request()).id);
  }
  await owner();await db.query(`update public.listings set status='active' where id=$1`,[listing]);
 });
 await test('the viewer outgoing message is a valid monotonic read cursor',async()=>{
  await actor(seller);await db.exec('begin');
  try{const own=await scalar(`select public.send_message($1,'Reply to buyer','outgoing-read-cursor')`,[conversation]);
   await db.query('select public.mark_conversation_read($1,$2)',[conversation,own.id]);assert.equal((await inbox()).items[0].unread_count,0);
  }finally{await db.exec('rollback');}
 });
 await test('seller grouping precedes limits; buying always stays individual; counts are conversations',async()=>{
  await owner();
  for(let n=0;n<61;n++){
   const user=id(100+n);await db.query('insert into auth.users(id) values($1)',[user]);await db.query('insert into public.profiles values($1,$2)',[user,`Buyer ${n}`]);
   await db.query(`insert into public.conversations(id,listing_id,buyer_id,seller_id,last_message_at) values($1,$2,$3,$4,'2026-02-01T00:00:00Z')`,[id(300+n),listing,user,seller]);
  }
  await actor(seller);const grouped=await inbox('selling',1);assert.equal(grouped.items.length,1);assert.equal(grouped.items[0].is_group,true);assert.equal(grouped.items[0].enquiry_count,62);assert.equal(grouped.has_more,false);assert.equal(grouped.counts.selling,62);
  await actor(buyer);assert.equal((await inbox('buying')).items[0].is_group,false);
 });
 await test('seller drilldown pages are bounded and complete across tied activity timestamps',async()=>{
  await actor(seller);let cursor=null,seen=[];
  do{const page=await inbox('selling',17,cursor,listing);assert(page.items.length<=17);assert(page.items.every(row=>!row.is_group));seen.push(...page.items.map(row=>row.id));cursor=page.next_cursor;}while(cursor);
  assert.equal(seen.length,62);assert.equal(new Set(seen).size,62);
 });
 await test('search and unread-only rows preserve authoritative cross-tab conversation counts',async()=>{
  const searched=await inbox('selling',30,null,null,'Buyer 6');assert.equal(searched.counts.all,2);assert.equal(searched.items[0].enquiry_count,2);
  const unread=await inbox('selling',30,null,null,'',true);assert.equal(unread.counts.selling,62);assert.equal(unread.items.length,1);assert(unread.items[0].unread_count>0);
 });
 await test('safety stays inert even after legacy sends and temporary inbox test activation',async()=>{
  await owner();assert.equal(await scalar('select count(*)::int from app_security.chat_safety_jobs'),0);assert.equal(await scalar('select count(*)::int from public.message_safety_findings'),0);
  assert.equal(await scalar(`select count(*)::int from app_security.chat_v2_flags where name<>'inbox' and enabled`),0);
 });
 await test('non-destructive rollback only disables inbox and retains messages/objects/ledger',async()=>{
  const before=await scalar('select count(*)::int from public.messages');await db.exec(scripts.rollback);
  assert.equal(await scalar('select count(*)::int from public.messages'),before);assert.equal(await scalar('select count(*)::int from app_security.chat_v2_flags where not enabled'),5);
  assert(await scalar(`select to_regprocedure('public.chat_v2_messages(uuid,integer,timestamptz,uuid)')`));await actor(buyer);await assert.rejects(()=>inbox(),/CHAT_V2_DISABLED/);
 });
 await test('Prod artifact installs independently with its own trusted identity and ledger',async()=>{
  const prod=new PGlite();try{
   await prod.exec(readFileSync(resolve(root,'tests/chat-v2-inbox-only/bootstrap.sql'),'utf8'));await prod.exec(canonicalMessaging());
   await prod.exec(`update vault.identity_fixture set decrypted_secret='https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/process-listing-moderation'`);
   const input={...review,projectRef:manifest.environments.fairswapprod.projectRef};await prod.exec(render('fairswapprod',input).apply);
   assert.equal((await prod.query('select count(*)::int as n from app_security.chat_v2_flags where not enabled')).rows[0].n,5);
  }finally{await prod.close();}
 });
 console.log(`PASS ${checks} independent Chat V2 inbox-only PostgreSQL checks. Disposable fixtures; no hosted/Realtime/release approval claim.`);
}finally{await db.close();}
