// Real PG17 connections/transaction barriers for Wearables V1. Never accepts a URL or live target.
// Covers: concurrent creation, ownership, cross-category isolation, duplicate submission, locking, moderation bypass attempts.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {installPostingFixture} from '../../scripts/ci/posting-v2-fixture.mjs';
import {NativeFixture,literal} from '../posting-v212/native-adapter.mjs';
const webArg=process.argv.slice(4).find(a=>a.startsWith('--web='));
const web=resolve(webArg?webArg.slice(6):'../FairSwap-Web');
const catalogue=JSON.parse(readFileSync(resolve(web,'src/lib/listings/wearables/catalogue.generated.json'),'utf8'));
const db=new NativeFixture(process.argv[2],process.argv[3]);let checks=0;
const u=randomUUID(),other=randomUUID(),city=randomUUID(),locality=randomUUID();
const ctx=(owner=u,name='w_client',role='authenticated')=>({owner,role,name});
const ws=(id,op,media=null)=>`select public.wearable_v1_session(${literal(id)},${literal(op)},${literal(media)}) as value`;
const ps=(id,op,media=null)=>`select public.posting_v2_session(${literal(id)},${literal(op)},${literal(media)}) as value`;
const run=async(sql,owner=u,name='w_client',role='authenticated')=>(await db.query(sql,[],ctx(owner,name,role))).rows[0].value;
const wcall=(id,op,owner=u,name='w_client',media=null)=>run(ws(id,op,media),owner,name);
const pcall=(id,op,owner=u,name='p_client',media=null)=>run(ps(id,op,media),owner,name);
const row=async id=>(await db.query('select * from public.posting_upload_sessions where id=$1',[id])).rows[0];
const n=async(sql,args=[])=>(await db.query(`select count(*)::int as n from (${sql}) q`,args)).rows[0].n;
const hold=async(body,name,owner=u,role='authenticated')=>{const h=db.start(body,ctx(owner,name,role),true);await db.wait(h,r=>r.state==='idle in transaction');return h;};
const model=t=>catalogue.models.find(m=>m.type===t);
const payload=(sessionId,mediaIds,over={})=>{const m=model('smartwatch');return {selection:{category:'mobiles',subcategory:'wearables',version:1},session_id:sessionId,catalogue_revision:catalogue.revision,device_type:'smartwatch',brand_id:m.brand_id,other_brand:'',model_id:m.id,other_model:'',generation:'',case_size_mm:44,connectivity:'bluetooth',phone_os:['android'],finish:'',condition:'good',screen:'minor_scratches',controls:'working',sensors:'working',charging:'working',battery_mode:'not_tested',strap:'good',included:['charger'],purchase_month:'2024-05',warranty_until:'',pairing_status:'reset_ready',transfer_ack:false,ownership_confirmed:true,title:'Smartwatch in good condition',description:'Used for one year, always with a case. Charger included.',trade:'sell',price_paise:500000,negotiable:true,pin_code:'560034',city_id:city,locality_id:locality,media_ids:mediaIds,plan_id:'free-v1',...over};};
const submitSql=p=>`select public.submit_wearable_v1(${literal(JSON.stringify(p))}::jsonb) as value`;
async function stage(owner=u,over={}){
 const id=randomUUID(),media=randomUUID();await wcall(id,'create',owner);
 const reserved=await wcall(id,'reserve',owner,'w_stage',media);const attempt=reserved.media[0].attempt;
 await db.exec(`insert into storage.objects values('posting-staged',${literal(owner+'/'+id+'/'+media+'/'+attempt+'/medium.webp')})`);
 await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`).catch(()=>{});
 await db.start(`select public.posting_v2_media_ready(${literal(id)},${literal(media)},${literal(attempt)},1000,800,600)`,{owner,role:'service_role',jwt:'{"role":"service_role"}',name:'w_ready'}).done;
 const prepared=await wcall(id,'prepare',owner);
 for(const nm of ['original','thumb','medium','large'])await db.exec(`insert into storage.objects values(${literal(nm==='original'?'listing-originals':'listing-derivatives')},${literal(prepared.session.listing_id+'/'+media+'/'+nm+'.webp')})`);
 return {id,media,listing:prepared.session.listing_id,payload:payload(id,[media],over)};
}
const test=async(label,fn)=>{await db.exec('truncate public.listing_media,public.listing_wearable_risk_flags_v1,public.listing_wearable_contexts_v1,public.listings,public.posting_upload_sessions,storage.objects cascade');await fn();checks++;console.log(`ok ${checks} - ${label}`);};
const ts=(id,op)=>`select public.tablet_v1_session(${literal(id)},${literal(op)}) as value`;
const tcall=(id,op,owner=u,name='t_client')=>run(ts(id,op),owner,name);
async function stageTablet(owner=u){
 const id=randomUUID(),media=randomUUID();await tcall(id,'create',owner);
 const reserved=await pcall(id,'reserve',owner,'t_stage',media);const attempt=reserved.media[0].attempt;
 await db.exec(`insert into storage.objects values('posting-staged',${literal(owner+'/'+id+'/'+media+'/'+attempt+'/medium.webp')})`);
 await db.start(`select public.posting_v2_media_ready(${literal(id)},${literal(media)},${literal(attempt)},1000,800,600)`,{owner,role:'service_role',jwt:'{"role":"service_role"}',name:'t_ready'}).done;
 const prepared=await pcall(id,'prepare',owner);
 for(const nm of ['original','thumb','medium','large'])await db.exec(`insert into storage.objects values(${literal(nm==='original'?'listing-originals':'listing-derivatives')},${literal(prepared.session.listing_id+'/'+media+'/'+nm+'.webp')})`);
 const m=(await db.query("select id,brand_id from public.tablet_models_v1 where name='iPad (9th generation)'")).rows[0];
 return {id,media,listing:prepared.session.listing_id,payload:{selection:{category:'mobiles',subcategory:'tablets',version:1},session_id:id,brand_id:m.brand_id,model_id:m.id,other_model:'',storage:'64 GB',connectivity:'wifi',ram:'',colour:'',hardware_model_number:'A2602',condition:'good',screen_touch_status:'working',battery_charging_status:'normal',transfer_lock_status:'clear',powers_on:'yes',repair_history:'none',other_defects:'',included:[],stylus_description:'',keyboard_description:'',warranty_until:'',title:'iPad 9th generation 64 GB Wi-Fi',description:'Carefully used tablet with no repairs.',trade:'sell',price_paise:1000000,negotiable:false,pin_code:'560034',city_id:city,locality_id:locality,media_ids:[media],plan_id:'free-v1'}};
}
const submitTabletSql=p=>`select public.submit_tablet_v1(${literal(JSON.stringify(p))}::jsonb) as value`;
const code=c=>e=>e.code===c||String(e.message).includes(c);
try{
 const version=await db.verify();await installPostingFixture(db);
 const f='supabase/forward-migrations/';
 await db.exec(`alter table public.listings add column slug text,add column created_at timestamptz default now(),add column published_at timestamptz,add column expires_at timestamptz,add column search_vector tsvector;alter table public.categories add column icon text;alter table public.cities add column name text default 'Bengaluru',add column state text default 'Karnataka';alter table public.localities add column name text default 'Koramangala';create table public.user_accounts(user_id uuid primary key,account_status text)`);
 for(const p of ['posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql','posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql','accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql','tablets-v1/supabase/migrations/20261102165946_posting_v2_tablets.sql','tablets-v1/activation/supabase/migrations/20261102170611_activate_tablets_v1.sql','wearables-v1/supabase/migrations/20261104120000_posting_v2_wearables.sql','wearables-v1/activation/supabase/migrations/20261104230000_activate_wearables_v1.sql'])await db.exec(readFileSync(resolve(f+p),'utf8'));
 await db.exec(`insert into auth.users values(${literal(u)}),(${literal(other)});insert into public.user_accounts values(${literal(u)},'active'),(${literal(other)},'active');insert into public.cities values(${literal(city)},true);insert into public.localities values(${literal(locality)},${literal(city)},true);insert into public.postal_pincode_localities values('560034',${literal(locality)})`);
 // Worst case for the trigger tests: clients/service CAN update listing status, so only the guard stands in the way.
 await db.exec('grant select,update(status) on public.listings to authenticated,service_role');
 const blanks=async(owner=u)=>{const ids=[];for(let i=0;i<5;i++){const r=await wcall(randomUUID(),'create_empty',owner);ids.push(r.session.id);await db.exec(`update public.posting_upload_sessions set created_at=now()-interval '${10-i} minutes' where id=${literal(r.session.id)}`);}return ids;};

 await test('concurrent wearable creations at capacity serialize on the seller lock and each is bound',async()=>{
  const ids=await blanks();const a=randomUUID(),b=randomUUID();const held=await hold(ws(a,'create'),'w_create_a');
  const waiting=db.start(ws(b,'create'),ctx(u,'w_create_b'));const blocked=await db.blocked(waiting,held);assert.equal(blocked.wait_event,'advisory');
  await held.finish();await waiting.done;
  assert.equal(await n("select 1 from public.posting_upload_sessions where owner_id=$1 and state in ('open','finalizing') and expires_at>now()",[u]),5);
  assert.equal((await row(ids[0])).state,'expired');assert.equal((await row(ids[1])).state,'expired');
  for(const id of [a,b])assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[id]),1);
 });
 await test('same-id concurrent wearable retries create exactly one session, one binding and one listing id',async()=>{
  const id=randomUUID();const held=await hold(ws(id,'create'),'w_retry_a');const waiting=db.start(ws(id,'create'),ctx(u,'w_retry_b'));await db.blocked(waiting,held);
  const first=JSON.parse(await held.finish());const second=JSON.parse(await waiting.done);assert.equal(first.session.listing_id,second.session.listing_id);
  assert.equal(await n('select 1 from public.posting_upload_sessions where id=$1',[id]),1);assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[id]),1);
 });
 await test('cross-category race on one id: wearable first binds it and the phone path is refused; phone first and the wearable path is refused',async()=>{
  let id=randomUUID();let held=await hold(ws(id,'create'),'w_first');let waiting=db.start(ps(id,'create'),ctx(u,'p_second'));await db.blocked(waiting,held);await held.finish();
  await assert.rejects(waiting.done,code('UPLOAD_SESSION_UNAVAILABLE'));assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[id]),1);
  id=randomUUID();held=await hold(ps(id,'create'),'p_first');waiting=db.start(ws(id,'create'),ctx(u,'w_second'));await db.blocked(waiting,held);await held.finish();
  await assert.rejects(waiting.done,code('UPLOAD_SESSION_UNAVAILABLE'));assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[id]),0);
 });
 await test('ownership: another seller cannot read, claim, release, reserve, remove or create on a wearable session; RLS and bindings are closed',async()=>{
  const id=randomUUID();await wcall(id,'create');
  for(const op of ['read','claim_draft','abandon_empty','create','prepare'])await assert.rejects(()=>wcall(id,op,other,'w_other'),code('UPLOAD_SESSION_UNAVAILABLE'));
  for(const op of ['reserve','remove'])await assert.rejects(()=>wcall(id,op,other,'w_other',randomUUID()),code('UPLOAD_SESSION_UNAVAILABLE'));
  assert.equal((await db.query('select count(*)::int as n from public.posting_upload_sessions',[],ctx(other))).rows[0].n,0);
  assert.equal((await wcall(null,'list_recovery',other)).sessions.length,0);
  for(const sql of ['select * from public.wearable_session_bindings_v1','insert into public.wearable_session_bindings_v1 values(gen_random_uuid(),gen_random_uuid())','delete from public.wearable_session_bindings_v1'])await assert.rejects(()=>db.start(sql,ctx(u)).done,code('42501'));
 });
 await test('forged settings and direct internal calls grant nothing to any client role',async()=>{
  const id=randomUUID();await wcall(id,'create');
  const forged=`select set_config('app_security.session_ctx','wearables',true),set_config('app.is_system_transition','true',true);`;
  for(const op of ['read','create','prepare','abandon_empty'])await assert.rejects(()=>db.start(forged+ps(id,op),ctx(u,'p_forged')).done,code('UPLOAD_SESSION_UNAVAILABLE'));
  for(const role of ['authenticated','anon','service_role'])await assert.rejects(()=>db.start(`select app_security.impl_posting_session_core_v1(${literal(id)},'read',null,gen_random_uuid())`,ctx(u,'w_direct',role)).done,code('42501'));
  for(const role of ['anon','service_role'])await assert.rejects(()=>db.start(ws(id,'read'),ctx(u,'w_anon',role)).done,code('42501'));
 });
 await test('duplicate concurrent submission: the second waits on the session lock and returns the same listing; one listing, context and photo exist',async()=>{
  const s=await stage(u,{pairing_status:'still_paired',transfer_ack:true});
  const held=await hold(submitSql(s.payload),'w_submit_a');const waiting=db.start(submitSql(s.payload),ctx(u,'w_submit_b'));await db.blocked(waiting,held);
  const first=JSON.parse(await held.finish());const second=JSON.parse(await waiting.done);assert.equal(first.listing_id,second.listing_id);assert.equal(first.listing_id,s.listing);
  assert.equal(await n('select 1 from public.listings where id=$1',[s.listing]),1);assert.equal(await n('select 1 from public.listing_wearable_contexts_v1 where listing_id=$1',[s.listing]),1);
  assert.equal(await n('select 1 from public.listing_media where listing_id=$1',[s.listing]),1);
  assert.deepEqual((await db.query('select signal from public.listing_wearable_risk_flags_v1 where listing_id=$1',[s.listing])).rows.map(r=>r.signal),['still_paired']);
  assert.equal((await row(s.id)).state,'submitted');
 });
 await test('a rolled-back submission leaves nothing behind and the waiting duplicate then succeeds exactly once',async()=>{
  const s=await stage();const held=await hold(submitSql(s.payload),'w_rb_a');const waiting=db.start(submitSql(s.payload),ctx(u,'w_rb_b'));await db.blocked(waiting,held);
  await held.finish(false);const r=JSON.parse(await waiting.done);assert.equal(r.listing_id,s.listing);assert.equal(await n('select 1 from public.listings where id=$1',[s.listing]),1);assert.equal(await n('select 1 from public.listing_wearable_contexts_v1'),1);
 });
 await test('locking: a phone-path prepare or a photo removal waits for an in-flight submission and then cannot alter it',async()=>{
  const s=await stage();const held=await hold(submitSql(s.payload),'w_lock_a');
  const phone=db.start(ps(s.id,'prepare'),ctx(u,'p_lock_b'));await db.blocked(phone,held);
  const remove=db.start(ws(s.id,'remove',s.media),ctx(u,'w_lock_c'));await db.blocked(remove,held);
  await held.finish();await assert.rejects(phone.done,code('UPLOAD_SESSION_UNAVAILABLE'));await remove.done;
  assert.equal((await db.query('select state from public.posting_staged_media where id=$1',[s.media])).rows[0].state,'ready');assert.equal(await n('select 1 from public.listing_media where listing_id=$1',[s.listing]),1);
 });
 await test('another seller and an unbound/phone session cannot submit a wearable listing; invalid payloads leave no rows',async()=>{
  const s=await stage();await assert.rejects(()=>db.start(submitSql(s.payload),ctx(other,'w_foreign')).done,code('Upload session unavailable'));
  const phone=randomUUID();await pcall(phone,'create');await assert.rejects(()=>db.start(submitSql(payload(phone,[randomUUID()])),ctx(u,'w_phone')).done,code('Cross-category'));
  for(const bad of [{pairing_status:'locked'},{ownership_confirmed:false},{ram:'8 GB'},{catalogue_revision:'0000000000000000'}])await assert.rejects(()=>db.start(submitSql({...s.payload,...bad}),ctx(u,'w_bad')).done,code('P0001'));
  assert.equal(await n('select 1 from public.listings'),0);assert.equal(await n('select 1 from public.listing_wearable_contexts_v1'),0);
 });
 await test('moderation bypass attempts fail for seller, service role, forged settings and anon; only a moderator can activate a flagged listing',async()=>{
  const s=await stage(u,{pairing_status:'unknown'});await db.start(submitSql(s.payload),ctx(u,'w_mod_submit')).done;
  const activate=`update public.listings set status='active' where id=${literal(s.listing)}`;
  assert.equal((await db.query('select status from public.listings where id=$1',[s.listing])).rows[0].status,'pending_review');
  await assert.rejects(()=>db.start(activate,ctx(u,'seller')).done,code('requires staff review'));
  await assert.rejects(()=>db.start(`select set_config('app.is_system_transition','true',true);select set_config('request.staff','false',true);`+activate,ctx(u,'seller_forged')).done,code('requires staff review'));
  await assert.rejects(()=>db.start(activate,ctx(u,'svc','service_role')).done,code('requires staff review'));
  await assert.rejects(()=>db.start(activate,ctx(u,'anon','anon')).done,code('42501'));
  assert.equal((await db.query('select status from public.listings where id=$1',[s.listing])).rows[0].status,'pending_review');
  // race: a moderator's activation that is rolled back must not let a waiting seller activate afterwards
  const mod=await hold(`select set_config('request.staff','true',true);${activate}`,'mod_hold',other);
  const seller=db.start(activate,ctx(u,'seller_wait'));await db.blocked(seller,mod);await mod.finish(false);
  await assert.rejects(seller.done,code('requires staff review'));assert.equal((await db.query('select status from public.listings where id=$1',[s.listing])).rows[0].status,'pending_review');
  await db.start(`select set_config('request.staff','true',true);${activate}`,ctx(other,'mod')).done;
  assert.equal((await db.query('select status from public.listings where id=$1',[s.listing])).rows[0].status,'active');
 });
 await test('risk flags are append-only and unreadable by sellers, service role and anon; unflagged listings are not blocked',async()=>{
  const s=await stage(u,{pairing_status:'still_paired',transfer_ack:true});await db.start(submitSql(s.payload),ctx(u,'w_flag')).done;
  for(const role of ['authenticated','service_role','anon'])for(const sql of [`update public.listing_wearable_risk_flags_v1 set signal='other_model'`,`delete from public.listing_wearable_risk_flags_v1`,`insert into public.listing_wearable_risk_flags_v1(listing_id,signal) values(${literal(s.listing)},'other_model')`])await assert.rejects(()=>db.start(sql,ctx(u,'flags',role)).done,code('42501'));
  assert.equal((await db.query('select count(*)::int as n from public.listing_wearable_risk_flags_v1',[],ctx(u,'flag_read'))).rows[0].n,0); // RLS: staff only
  for(const role of ['service_role','anon'])await assert.rejects(()=>db.start('select * from public.listing_wearable_risk_flags_v1',ctx(u,'flags_sel',role)).done,code('42501'));
  const t=await stage();await db.start(submitSql(t.payload),ctx(u,'w_clean')).done;await db.start(`update public.listings set status='active' where id=${literal(t.listing)}`,ctx(u,'clean')).done;
  assert.equal((await db.query('select status from public.listings where id=$1',[t.listing])).rows[0].status,'active');
 });
 await test('a wearable session cannot be turned into a phone-category listing even while its wearable submission is in flight',async()=>{
  const s=await stage();const phoneCat=(await db.query("select id from public.categories where slug='mobile-phones'")).rows[0].id;
  const held=await hold(submitSql(s.payload),'w_x_a');
  const ins=`insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes) values(${literal(s.listing)},${literal(u)},${literal(phoneCat)},${literal(city)},${literal(locality)},'560034','Some title here','A long enough description for listing','good','fixed',1000,'{}')`;
  const racing=db.start(ins,{role:'posting_fixture_admin',owner:u,name:'x_phone_insert'});
  await held.finish();await assert.rejects(racing.done,e=>/Cross-category|duplicate key/.test(String(e.message)));
  assert.equal(await n('select 1 from public.listings where id=$1 and category_id=$2',[s.listing,phoneCat]),0);
 });

 // ---- Tablets V1 + Wearables V1 coexistence (both installed and enabled; real concurrent backends)
 await test('tablet vs wearable race on one id: the first binder wins; the other path is refused, in both orders',async()=>{
  let id=randomUUID();let held=await hold(ws(id,'create'),'tw_w_first');let waiting=db.start(ts(id,'create'),ctx(u,'tw_t_second'));await db.blocked(waiting,held);await held.finish();
  await assert.rejects(waiting.done,code('Cross-category session'));assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[id]),1);assert.equal(await n('select 1 from public.tablet_session_bindings_v1 where session_id=$1',[id]),0);
  id=randomUUID();held=await hold(ts(id,'create'),'tw_t_first');waiting=db.start(ws(id,'create'),ctx(u,'tw_w_second'));await db.blocked(waiting,held);await held.finish();
  await assert.rejects(waiting.done,code('UPLOAD_SESSION_UNAVAILABLE'));assert.equal(await n('select 1 from public.tablet_session_bindings_v1 where session_id=$1',[id]),1);assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[id]),0);
 });
 await test('seller capacity lock is shared across categories: concurrent tablet and wearable creations at capacity serialize and each is bound to its own category',async()=>{
  const ids=await blanks();const t=randomUUID(),w=randomUUID();const held=await hold(ts(t,'create'),'tw_cap_t');
  const waiting=db.start(ws(w,'create'),ctx(u,'tw_cap_w'));const blocked=await db.blocked(waiting,held);assert.equal(blocked.wait_event,'advisory');
  await held.finish();await waiting.done;
  assert.equal(await n("select 1 from public.posting_upload_sessions where owner_id=$1 and state in ('open','finalizing') and expires_at>now()",[u]),5);
  assert.equal((await row(ids[0])).state,'expired');assert.equal((await row(ids[1])).state,'expired');
  assert.equal(await n('select 1 from public.tablet_session_bindings_v1 where session_id=$1',[t]),1);assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[t]),0);
  assert.equal(await n('select 1 from public.wearable_session_bindings_v1 where session_id=$1',[w]),1);assert.equal(await n('select 1 from public.tablet_session_bindings_v1 where session_id=$1',[w]),0);
 });
 await test('a tablet and a wearable submission by the same seller run concurrently without deadlock; each commits exactly one listing and one context',async()=>{
  const t=await stageTablet(),w=await stage();
  const a=db.start(submitTabletSql(t.payload),ctx(u,'tw_sub_t'));const b=db.start(submitSql(w.payload),ctx(u,'tw_sub_w'));
  const [ra,rb]=await Promise.all([a.done,b.done]);assert.equal(JSON.parse(ra).success,true);assert.equal(JSON.parse(rb).success,true);
  assert.equal(await n('select 1 from public.listings'),2);assert.equal(await n('select 1 from public.listing_tablet_contexts where listing_id=$1',[t.listing]),1);assert.equal(await n('select 1 from public.listing_wearable_contexts_v1 where listing_id=$1',[w.listing]),1);
  assert.equal(await n('select 1 from public.listing_tablet_contexts where listing_id=$1',[w.listing]),0);assert.equal(await n('select 1 from public.listing_wearable_contexts_v1 where listing_id=$1',[t.listing]),0);
 });
 await test('cross-category submissions by the owner are refused while the right path stays usable: wearable payload on a tablet session and tablet payload on a wearable session',async()=>{
  const t=await stageTablet(),w=await stage();
  await assert.rejects(db.start(submitSql({...w.payload,session_id:t.id,media_ids:[t.media]}),ctx(u,'tw_x1')).done,code('Cross-category session'));
  await assert.rejects(db.start(submitTabletSql({...t.payload,session_id:w.id,media_ids:[w.media]}),ctx(u,'tw_x2')).done,code('Cross-category session'));
  assert.equal(await n('select 1 from public.listings'),0);
  assert.equal(JSON.parse(await db.start(submitTabletSql(t.payload),ctx(u,'tw_ok1')).done).success,true);assert.equal(JSON.parse(await db.start(submitSql(w.payload),ctx(u,'tw_ok2')).done).success,true);
 });
 console.log(JSON.stringify({status:'PASS',postgres_version_num:version,checks,transport:'independent psql backends, private Unix socket',barriers:'observed pg_stat_activity lock waits; explicit commit/rollback',observations:db.observations.length}));
}finally{db.close();}
