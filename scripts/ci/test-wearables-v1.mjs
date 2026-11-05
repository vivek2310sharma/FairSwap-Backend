// Disposable in-process PostgreSQL only; never consumes a connection URL or environment credentials.
// Real candidate migrations + synthetic auth/storage fixture. This does NOT replace hosted DB security/E2E
// verification or multi-connection (native PG17) concurrency checks.
//   node scripts/ci/test-wearables-v1.mjs [--pglite-module=<path>] [--web=<FairSwap-Web path>]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {installPostingFixture} from './posting-v2-fixture.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const opt=n=>process.argv.slice(2).find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3);
for(const a of process.argv.slice(2))if(!/^--(pglite-module|web)=/.test(a))throw new Error('Use only --pglite-module=<path> and --web=<path>');
const web=resolve(opt('web')??resolve(root,'../FairSwap-Web'));
const require=createRequire(resolve(web,'package.json'));
const {PGlite}=opt('pglite-module')?await import(pathToFileURL(resolve(opt('pglite-module'))).href):require('@electric-sql/pglite');
const {nameKey,baseKey}=await import(pathToFileURL(resolve(web,'scripts/wearables/name-key.mjs')).href);
const catalogue=JSON.parse(readFileSync(resolve(web,'src/lib/listings/wearables/catalogue.generated.json'),'utf8'));
const fm=resolve(root,'supabase/forward-migrations');
const sql=p=>readFileSync(resolve(fm,p),'utf8');
const FILES={recovery:'posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql',phoneOn:'posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql',acc:'accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql',wear:'wearables-v1/supabase/migrations/20261104120000_posting_v2_wearables.sql',wearOn:'wearables-v1/activation/supabase/migrations/20261104220000_activate_wearables_v1.sql'};
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',city='55555555-5555-4555-8555-555555555555',locality='66666666-6666-4666-8666-666666666666';
let checks=0;const results=[];
async function base(upTo='acc'){
 const db=new PGlite();await installPostingFixture(db);
 await db.exec(`
 alter table public.listings add column if not exists slug text,add column if not exists created_at timestamptz default now(),add column if not exists published_at timestamptz,add column if not exists expires_at timestamptz,add column if not exists search_vector tsvector;
 alter table public.categories add column if not exists icon text;
 alter table public.cities add column if not exists name text default 'Bengaluru',add column if not exists state text default 'Karnataka';
 alter table public.localities add column if not exists name text default 'Koramangala';
 create table if not exists public.user_accounts(user_id uuid primary key,account_status text);
 create or replace function app_security.is_listing_publicly_visible(target uuid) returns boolean language sql stable security definer set search_path='' as $f$select exists(select 1 from public.listings l join public.user_accounts ua on ua.user_id=l.seller_id where l.id=target and l.status='active' and ua.account_status='active')$f$;
 grant select on public.categories,public.listings to anon,authenticated;`);
 await db.exec(sql(FILES.recovery));if(upTo==='recovery')return db;
 await db.exec(sql(FILES.acc));
 await db.query('insert into auth.users values($1),($2)',[A,B]);await db.query("insert into public.user_accounts values($1,'active'),($2,'active')",[A,B]);
 await db.query('insert into public.cities values($1,true)',[city]);await db.query('insert into public.localities values($1,$2,true)',[locality,city]);await db.query("insert into public.postal_pincode_localities values('560034',$1)",[locality]);
 return db;
}
const db=await base();
const q=async(s,a=[])=>Object.values((await db.query(s,a)).rows[0]??{x:null})[0];
const as=async(u)=>db.query("select set_config('request.user',$1,false)",[u??'']);
const role=async(r)=>db.exec(r?`set role ${r}`:'reset role');
const svc=async fn=>{await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`);try{return await fn();}finally{await db.exec(`select set_config('request.jwt','{}',false)`);}};
const test=async(name,fn)=>{try{await as(A);await freeSlots();await fn();}catch(e){console.error('FAILED:',name,String(e.message).slice(0,200));throw e;}finally{await role();await as(A);}console.log(`ok ${++checks} - ${name}`);};
const rejects=(s,a=[],re)=>assert.rejects(()=>db.query(s,a),re);
const ws=(id,op,media=null)=>q('select public.wearable_v1_session($1,$2,$3)',[id,op,media]);
const ps=(id,op,media=null)=>q('select public.posting_v2_session($1,$2,$3)',[id,op,media]);
const uuid=()=>q('select gen_random_uuid()');
const model=(type,name)=>catalogue.models.find(m=>m.type===type&&(!name||m.name===name));
const flags=async id=>(await db.query('select signal from public.listing_wearable_risk_flags_v1 where listing_id=$1 order by 1',[id])).rows.map(r=>r.signal);
async function stage(sessionFn,id,media){const s=await sessionFn(id,'reserve',media);await svc(()=>q('select public.posting_v2_media_ready($1,$2,$3,1000,800,600)',[id,media,s.media[0].attempt]));return s;}
const keep=[];
async function freeSlots(){await db.query("update public.posting_upload_sessions set state='expired',expires_at=now()-interval '1 second' where owner_id=$1 and state in ('open','finalizing') and id<>all($2::uuid[])",[A,keep]);}
async function prepW(over={},{skipPrepare=false}={}){
 const id=await uuid(),media=await uuid();
 await ws(id,'create');await stage(ws,id,media);
 const s=skipPrepare?(await ws(id,'read')):await ws(id,'prepare');
 if(!skipPrepare)for(const n of ['original','thumb','medium','large'])await db.query('insert into storage.objects values($1,$2)',[n==='original'?'listing-originals':'listing-derivatives',`${s.session.listing_id}/${media}/${n}.webp`]);
 return {id,media,listing:s.session.listing_id,payload:wpayload({session_id:id,media_ids:[media],...over})};
}
function wpayload(over={}){
 const m=model('smartwatch');
 return {selection:{category:'mobiles',subcategory:'wearables',version:1},session_id:null,catalogue_revision:catalogue.revision,device_type:'smartwatch',brand_id:m.brand_id,other_brand:'',model_id:m.id,other_model:'',generation:'',case_size_mm:44,connectivity:'bluetooth',phone_os:['android'],finish:'',condition:'good',screen:'minor_scratches',controls:'working',sensors:'working',charging:'working',battery_mode:'not_tested',strap:'good',included:['charger'],purchase_month:'2024-05',warranty_until:'',pairing_status:'reset_ready',transfer_ack:false,ownership_confirmed:true,title:'Smartwatch in good condition',description:'Used for one year, always with a case. Charger included.',trade:'sell',price_paise:500000,negotiable:true,pin_code:'560034',city_id:city,locality_id:locality,media_ids:[],plan_id:'free-v1',...over};
}
const submit=p=>q('select public.submit_wearable_v1($1::jsonb)',[JSON.stringify(p)]);
const bad=(p,re)=>assert.rejects(()=>submit(p),re);
const migFails=async(d,re)=>{await assert.rejects(()=>d.exec(sql(FILES.wear)),re);await d.exec('rollback');};
const sha=p=>createHash('sha256').update(readFileSync(resolve(fm,p))).digest('hex');
try{
 await db.exec(sql(FILES.phoneOn)); // phone posting installed AND enabled for the first phase
 await db.exec(sql(FILES.wear));
 await as(A);

 // ---- catalogue / seed parity
 await test('feature ships disabled; category inactive and generic creation closed',async()=>{
  assert.equal((await q('select public.wearables_v1_catalogue()')).enabled,false);
  assert.equal(await q("select is_active from public.categories where slug='wearables'"),false);
  assert.equal(await q("select new_listing_enabled from public.categories where slug='wearables'"),false);
 });
 await test('seed equals bundled JSON: revision, counts and the approved model set',async()=>{
  assert.equal((await q('select public.wearables_v1_catalogue()')).revision,catalogue.revision);
  const r=(await db.query('select * from public.wearable_catalogue_revision_v1')).rows[0];
  assert.equal(r.revision,catalogue.revision);assert.equal(r.csv_sha256,catalogue.csv_sha256);assert.equal(r.corrections_sha256,catalogue.corrections_sha256);
  assert.equal(Number(r.rows_total),catalogue.rows_total);assert.equal(Number(r.rows_approved),catalogue.rows_approved);
  const db_rows=(await db.query("select id,brand_id,device_type,series,name from public.wearable_models_v1 where status='approved' order by id")).rows;
  const js=[...catalogue.models].sort((a,b)=>a.id<b.id?-1:1).map(m=>({id:m.id,brand_id:m.brand_id,device_type:m.type,series:m.series,name:m.name}));
  assert.deepEqual(db_rows,js);
  assert.equal(catalogue.rows_total,607);
 });
 await test('SQL name_key/base_key equal the JS mirror for every row (including quarantined)',async()=>{
  const rows=(await db.query('select name,name_key,base_key from public.wearable_models_v1')).rows;assert.equal(rows.length,607);
  for(const x of rows){assert.equal(x.name_key,nameKey(x.name),x.name);assert.equal(x.base_key,baseKey(x.name),x.name);}
 });
 await test('quarantined/excluded rows are not selectable and reasons are not client-readable',async()=>{
  await role('authenticated');
  assert.equal(await q("select count(*)::int from public.wearable_models_v1 where name='Oura Ring Ceramic'"),0);
  await rejects('select reason from public.wearable_models_v1',[],/permission denied/);
  await rejects('select count(*) from public.wearable_session_bindings_v1',[],/permission denied/);
  await role();
 });
 await test('disabled release fails closed for sessions and submission',async()=>{
  await rejects("select public.wearable_v1_session($1,'create')",[await uuid()],/unavailable/);
  await rejects('select public.submit_wearable_v1($1::jsonb)',[JSON.stringify(wpayload({session_id:await uuid()}))],/unavailable|Upload session/);
 });
 await db.exec(sql(FILES.wearOn));
 await test('activation enables release and category',async()=>{assert.equal((await q('select public.wearables_v1_catalogue()')).enabled,true);});

 // ---- session lifecycle (wearable wrapper owns it)
 await test('wearable lifecycle: create, read, reserve, ready, remove, prepare, abandon',async()=>{
  const id=await uuid(),media=await uuid();
  await ws(id,'create');assert.equal(await q('select count(*)::int from public.wearable_session_bindings_v1 where session_id=$1',[id]),1);
  await stage(ws,id,media);assert.equal((await ws(id,'read')).media[0].state,'ready');
  await ws(id,'remove',media);assert.equal((await ws(id,'read')).media.length,0);
  const e=await uuid();const empty=await ws(e,'create_empty');assert.notEqual(empty.session.id,e);
  assert.equal(await q('select count(*)::int from public.wearable_session_bindings_v1 where session_id=$1',[empty.session.id]),1);
  assert.equal((await ws(e,'acquire_draft')).session.id,empty.session.id);
  await ws(empty.session.id,'abandon_empty');
 });
 await test('recovery lists are category-separated in both directions',async()=>{
  const wid=await uuid(),pid=await uuid();await ws(wid,'create');await ps(pid,'create');
  const w=(await ws(null,'list_recovery')).sessions.map(s=>s.id),p=(await ps(null,'list_recovery')).sessions.map(s=>s.id);
  assert(w.includes(wid)&&!w.includes(pid));assert(p.includes(pid)&&!p.includes(wid));
 });

 // ---- isolation: forged context, direct invocation, cross-category reuse, other users
 const W=await uuid(),P=await uuid(),Wm=await uuid(),Pm=await uuid();
 await ws(W,'create');await stage(ws,W,Wm);await ps(P,'create');keep.push(W,P);
 await test('forged session_ctx / system-transition settings grant nothing',async()=>{
  await db.exec("select set_config('app_security.session_ctx','wearables',false);select set_config('app.is_system_transition','true',false)");
  for(const op of ['read','create','claim_draft','prepare','abandon_empty'])await rejects('select public.posting_v2_session($1,$2,null)',[W,op],/UPLOAD_SESSION_UNAVAILABLE/);
  await rejects("select public.posting_v2_session($1,'reserve',$2)",[W,await uuid()],/UPLOAD_SESSION_UNAVAILABLE/);
  await db.exec("select set_config('app_security.session_ctx','',false);select set_config('app.is_system_transition','',false)");
 });
 await test('direct core invocation is denied to every client role',async()=>{
  for(const r of ['anon','authenticated','service_role']){await role(r);await rejects('select app_security.impl_posting_session_core_v1($1,$2,null,$3)',[W,'read',null],/permission denied/);await rejects('select app_security.impl_posting_session_core_v1($1,$2,null,$3)',[W,'read',await uuid()],/permission denied/);await role();}
 });
 await test('anonymous and service roles cannot use wearable session/submit entry points',async()=>{
  for(const r of ['anon','service_role']){await role(r);await rejects('select public.wearable_v1_session($1,$2,null)',[W,'read'],/permission denied/);await rejects('select public.submit_wearable_v1($1::jsonb)',['{}'],/permission denied/);await role();}
 });
 await test('cross-category matrix: wearable session via phone path and phone session via wearable path',async()=>{
  for(const op of ['create','read','claim_draft','prepare','abandon_empty','remove'])await rejects('select public.posting_v2_session($1,$2,$3)',[W,op,op==='remove'?Wm:null],/UPLOAD_SESSION_UNAVAILABLE/);
  for(const op of ['create','read','claim_draft','acquire_draft','prepare','abandon_empty','reserve','remove'])await rejects('select public.wearable_v1_session($1,$2,$3)',[P,op,['reserve','remove'].includes(op)?await uuid():null],/UPLOAD_SESSION_UNAVAILABLE/);
  assert.equal((await ps(P,'read')).session.id,P);assert.equal((await ws(W,'read')).session.id,W);
 });
 await test('other users cannot touch wearable sessions or media',async()=>{
  await as(B);
  for(const op of ['read','create','claim_draft','prepare','abandon_empty'])await rejects('select public.wearable_v1_session($1,$2,null)',[W,op],/UPLOAD_SESSION_UNAVAILABLE/);
  await rejects("select public.wearable_v1_session($1,'remove',$2)",[W,Wm],/UPLOAD_SESSION_UNAVAILABLE/);
  const own=await uuid();await ws(own,'create');
  await rejects("select public.wearable_v1_session($1,'reserve',$2)",[own,Wm],/duplicate key|violates/);
  await as(A);assert.equal((await ws(W,'read')).media[0].state,'ready');
 });
 await test('media completion with mismatched session/media/attempt changes nothing',async()=>{
  const id=await uuid(),m=await uuid();await ws(id,'create');const s=await ws(id,'reserve',m);
  await svc(async()=>{for(const args of [[W,m,s.media[0].attempt],[id,await uuid(),s.media[0].attempt],[id,m,await uuid()]]){try{assert.notEqual(await q('select public.posting_v2_media_ready($1,$2,$3,1000,800,600)',args),true);}catch(e){}}});
  assert.equal((await ws(id,'read')).media[0].state,'uploading');
 });

 // ---- submission validation and authorization
 await test('happy path: reset_ready listed model enters pending_review without flags; replay idempotent',async()=>{
  const t=await prepW();const a=await submit(t.payload),b=await submit(t.payload);assert.equal(a.listing_id,b.listing_id);
  assert.equal(await q('select status from public.listings where id=$1',[a.listing_id]),'pending_review');
  assert.deepEqual(await flags(a.listing_id),[]);
  const c=(await db.query('select * from public.listing_wearable_contexts_v1 where listing_id=$1',[a.listing_id])).rows[0];
  assert.equal(c.transfer_ready,true);assert.equal(c.other_model,false);assert.equal(c.catalogue_revision,catalogue.revision);
  assert(!('ram' in c.details)&&!('storage' in c.details));
 });
 await test('unauthorized submissions are rejected',async()=>{
  const t=await prepW();
  await as(B);await bad(t.payload,/Upload session unavailable/);await as(A);
  const open=await prepW({},{skipPrepare:true});await bad(open.payload,/Upload session unavailable/);
  const phone=await uuid(),pm=await uuid();await ps(phone,'create');await stage(ps,phone,pm);await ps(phone,'prepare');await bad(wpayload({session_id:phone,media_ids:[pm]}),/Cross-category/);
  await bad(wpayload({session_id:await uuid(),media_ids:[await uuid()]}),/Upload session unavailable/);
  await bad({...t.payload,media_ids:[await uuid()]},/ready photos/);await bad({...t.payload,media_ids:[t.media,t.media]},/ready photos/);
  await db.exec("update public.posting_upload_sessions set expires_at=now()-interval '1 minute' where id='"+t.id+"'");await bad(t.payload,/Upload session unavailable/);
 });
 await test('catalogue revision, ownership, locked, stolen and pairing rules',async()=>{
  const t=await prepW();
  await bad({...t.payload,catalogue_revision:'0000000000000000'},/CATALOGUE_REVISION_MISMATCH/);
  await bad({...t.payload,pairing_status:'locked'},/WEARABLE_LOCKED/);
  await bad({...t.payload,ownership_confirmed:false},/OWNERSHIP_UNCONFIRMED/);
  await bad({...t.payload,pairing_status:'still_paired',transfer_ack:false},/STILL_PAIRED_ACK_REQUIRED/);
  await bad({...t.payload,pairing_status:'signed_out',transfer_ack:true},/transfer acknowledgement/);
  await bad({...t.payload,pairing_status:'stolen'},/pairing status/);
 });
 await test('pairing states are distinct: exact flag sets and transfer readiness',async()=>{
  for(const [st,ack,flag,ready] of [['reset_ready',false,[],true],['signed_out',false,[],true],['still_paired',true,['still_paired'],false],['unknown',false,['unknown_pairing'],false]]){
   const t=await prepW({pairing_status:st,transfer_ack:ack});const r=await submit(t.payload);
   assert.deepEqual(await flags(r.listing_id),flag,st);assert.equal(await q('select transfer_ready from public.listing_wearable_contexts_v1 where listing_id=$1',[r.listing_id]),ready,st);
  }
 });
 await test('model ownership, per-type fields and strictness',async()=>{
  const t=await prepW(),ring=model('smart_ring'),other=catalogue.models.find(m=>m.type==='fitness_band'&&m.brand_id!==model('smartwatch').brand_id);
  await bad({...t.payload,model_id:ring.id},/Invalid model/);await bad({...t.payload,brand_id:other.brand_id},/Invalid model/);await bad({...t.payload,model_id:'wm_000000000000'},/Invalid model/);
  await bad({...t.payload,ram:'8 GB'},/Invalid wearable field/);await bad({...t.payload,storage:'64 GB'},/Invalid wearable field/);await bad({...t.payload,ring_size:'7'},/Invalid wearable field/);
  const {connectivity,...noConn}=t.payload;await bad(noConn,/Missing wearable field/);
  await bad({...t.payload,connectivity:'cellular'},/connectivity/);await bad({...t.payload,case_size_mm:80},/case size/);
  await bad({...t.payload,battery_mode:'health_percent',battery_health_percent:90,device_type:'fitness_band'},/./);
  await bad({...t.payload,battery_mode:'health_percent'},/Missing wearable field/);await bad({...t.payload,battery_mode:'health_percent',battery_health_percent:101},/battery health/);
  await bad({...t.payload,included:['charger','charging_case']},/included items/);await bad({...t.payload,phone_os:['windows']},/phone compatibility/);
  await bad({...t.payload,purchase_month:'2099-01'},/future/);await bad({...t.payload,warranty_until:'2020-01'},/Warranty/);
 });
 await test('rings, bands and sports watches take only their own fields',async()=>{
  const ring=model('smart_ring'),band=model('fitness_band'),sport=model('sports_gps_watch');
  const mk=async(m,over)=>{const t=await prepW({device_type:m.type,brand_id:m.brand_id,model_id:m.id,...over});return t.payload;};
  const rp=await mk(ring,{});for(const k of ['screen','controls','strap','case_size_mm','connectivity'])delete rp[k];rp.ring_size='9';rp.included=['charging_case'];
  assert.equal((await submit(rp)).success,true);
  const bp=await mk(band,{});delete bp.case_size_mm;delete bp.connectivity;assert.equal((await submit(bp)).success,true);
  const sp=await mk(sport,{});delete sp.connectivity;sp.gps_status='working';assert.equal((await submit(sp)).success,true);
  const bad1=await mk(ring,{});await bad(bad1,/Invalid wearable field/);
 });
 await test('Other model cannot launder quarantined, excluded or listed entries; unknown entries enter review',async()=>{
  const t=await prepW(),brand=(n)=>catalogue.brands.find(b=>b.name===n)?.id;
  const other=(m,b)=>({...t.payload,model_id:null,other_model:m,brand_id:b??t.payload.brand_id});
  await bad(other('Oura Ring Ceramic',brand('Oura')),/MODEL_NOT_ACCEPTED:possible_variant/);
  await bad(other('Ultrahuman Home',brand('Ultrahuman')),/not_a_wearable/);await bad(other('Home',brand('Ultrahuman')),/not_a_wearable/);
  await bad(other('Noise Luna Ring Gold',brand('Noise')),/possible_variant/);await bad(other('luna ring matte',brand('Noise')),/possible_variant/);
  await bad(other('Whoop 4.0',null),/./);await bad(other('Fitbit Ace 3',brand('Fitbit')),/kids_tracker/);await bad(other('Fitbit  ace-3',brand('Fitbit')),/kids_tracker/);
  await bad(other('Amazfit Helio Strap',brand('Amazfit')),/type_mismatch/);
  await bad(other(model('smartwatch').name,model('smartwatch').brand_id),/WEARABLE_MODEL_LISTED/);
  await bad({...t.payload,model_id:null,other_model:''},/model name/);
  const ok=await submit(other('Zephyr Z1 Prototype'));assert.deepEqual(await flags(ok.listing_id),['other_model']);
  const nb=await prepW();const ok2=await submit({...nb.payload,brand_id:null,other_brand:'Zephyr Labs',model_id:null,other_model:'Z2'});assert.deepEqual(await flags(ok2.listing_id),['other_brand','other_model']);
  await bad({...nb.payload,brand_id:null,other_brand:'Apple',model_id:null,other_model:'Z2'},/WEARABLE_BRAND_LISTED/);
 });
 await test('payment, contact and courier scams are blocked in every free-text field',async()=>{
  const t=await prepW();
  for(const [k,v] of [['title','Pay on upi://pay?pa=x@ok'],['description','Call me 98765 43210 for the watch right now'],['finish','pay via paytm.me/abc'],['generation','advance payment for courier'],['other_model','wa.me/919999999999']]){
   await bad({...t.payload,...(k==='other_model'?{model_id:null}:{}),[k]:v},/./);
  }
 });

 // ---- enforceable moderation
 await test('flagged listings cannot be activated by seller, system finalizer or forged settings; staff can',async()=>{
  const t=await prepW({pairing_status:'unknown'});const {listing_id}=await submit(t.payload);
  await assert.rejects(()=>db.exec(`update public.listings set status='active' where id='${listing_id}'`),/requires staff review/);
  await db.exec("select set_config('app.is_system_transition','true',false)");
  await assert.rejects(()=>db.exec(`update public.listings set status='active' where id='${listing_id}'`),/requires staff review/);
  await role('service_role');await assert.rejects(()=>db.exec(`update public.listings set status='active' where id='${listing_id}'`),/./);await role();
  await db.exec("select set_config('app.is_system_transition','',false)");
  await db.exec("select set_config('request.staff','true',false)");await db.exec(`update public.listings set status='active' where id='${listing_id}'`);await db.exec("select set_config('request.staff','false',false)");
  assert.equal(await q('select status from public.listings where id=$1',[listing_id]),'active');
 });
 await test('unflagged listings follow the normal path (guard does not block them)',async()=>{
  const t=await prepW();const {listing_id}=await submit(t.payload);await db.exec(`update public.listings set status='active' where id='${listing_id}'`);assert.equal(await q('select status from public.listings where id=$1',[listing_id]),'active');
 });
 await test('buyer search: visibility, each filter, transfer-ready, validation and no private fields',async()=>{
  const sw=async f=>q('select public.search_wearables_v1($1::jsonb)',[JSON.stringify(f)]);
  await db.exec("update public.listings set slug=id::text,published_at=now(),search_vector=to_tsvector('english',title||' '||description) where category_id=(select id from public.categories where slug='wearables')");
  const active=await q("select count(*)::int from public.listings l where status='active' and category_id=(select id from public.categories where slug='wearables')");
  assert(active>=2);
  await role('anon');
  const all=await sw({});assert.equal(all.total_count,active);assert.equal(all.items.length,Math.min(active,12));
  assert(!JSON.stringify(all).includes('pin_code')&&!JSON.stringify(all).includes('560034'));
  assert(all.items.every(i=>i.wearable&&['reset_ready','signed_out','still_paired','unknown'].includes(i.wearable.pairing_status)));
  const ready=await sw({transfer_ready:'true'});assert(ready.total_count<all.total_count&&ready.items.every(i=>i.wearable.transfer_ready===true));
  assert.equal((await sw({type:'smartwatch'})).total_count,active);assert.equal((await sw({type:'smart_ring'})).total_count,0);
  const m=model('smartwatch');assert.equal((await sw({brand_id:m.brand_id})).total_count,active);assert.equal((await sw({brand_id:'wb_nope'})).total_count,0);assert.equal((await sw({model_id:m.id})).total_count,active);
  assert.equal((await sw({connectivity:'bluetooth'})).total_count,active);assert.equal((await sw({connectivity:'lte'})).total_count,0);
  assert.equal((await sw({condition:'good'})).total_count,active);assert.equal((await sw({condition:'poor'})).total_count,0);
  assert.equal((await sw({price_min:400000,price_max:600000})).total_count,active);assert.equal((await sw({price_min:600001})).total_count,0);
  assert.equal((await sw({city_id:city,locality_id:locality})).total_count,active);assert.equal((await sw({city_id:await uuid()})).total_count,0);
  for(const bad of [{unknown:1},{type:'smartphone'},{condition:'broken'},{price_min:5,price_max:1},{transfer_ready:'false'},{connectivity:'wifi'},{sort:'random'},{q:5},{page:'x'}])await rejects('select public.search_wearables_v1($1::jsonb)',[JSON.stringify(bad)],/Invalid/);
  await role();
  await db.exec("update public.user_accounts set account_status='suspended' where user_id='"+A+"'");assert.equal((await sw({})).total_count,0);await db.exec("update public.user_accounts set account_status='active' where user_id='"+A+"'");
  await db.exec('update public.wearable_release_v1 set enabled=false');assert.equal((await sw({})).total_count,0);await db.exec('update public.wearable_release_v1 set enabled=true');
 });
 await test('flags are append-only and invisible to clients; context private columns hidden',async()=>{
  for(const r of ['authenticated','service_role','anon'])for(const priv of ['UPDATE','DELETE','INSERT'])assert.equal(await q('select has_table_privilege($1,$2,$3)',[r,'public.listing_wearable_risk_flags_v1',priv]),false);
  assert.equal(await q("select has_table_privilege('anon','public.listing_wearable_risk_flags_v1','SELECT')"),false);
  for(const r of ['authenticated','service_role','anon'])for(const priv of ['UPDATE','DELETE','INSERT'])assert.equal(await q('select has_table_privilege($1,$2,$3)',[r,'public.listing_wearable_contexts_v1',priv]),false);
  assert.equal(await q("select has_column_privilege('anon','public.listing_wearable_contexts_v1','details','SELECT')"),true);
 });
 await test('listings guard: wearable listing needs a bound session; wearable session cannot become another category',async()=>{
  const wid=await uuid(),sid=(await ws(wid,'create')).session.listing_id;
  const phoneCat=await q("select id from public.categories where slug='mobile-phones'"),wearCat=await q("select id from public.categories where slug='wearables'");
  const ins=(id,cat)=>db.query(`insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes) values($1,$2,$3,$4,$5,'560034','Some title here','A long enough description for listing',$6,'fixed',1000,'{}')`,[id,A,cat,city,locality,'good']);
  await assert.rejects(()=>ins(sid,phoneCat),/Cross-category session/);
  const fresh=await uuid();await assert.rejects(()=>ins(fresh,wearCat),/requires a wearable session/);
  const pid=await uuid(),plist=(await ps(pid,'create')).session.listing_id;await assert.rejects(()=>ins(plist,wearCat),/requires a wearable session/);
 });

 // ---- compatibility and gating
 await test('wearables work with phone posting OFF; phone path does not open because wearables is enabled',async()=>{
  await db.exec('update public.posting_category_definitions set enabled=false');
  const id=await uuid();await ws(id,'create');await rejects("select public.posting_v2_session($1,'create')",[await uuid()],/Posting unavailable/);
  await db.exec("update public.accessory_release_v1 set enabled=true;update public.categories set is_active=true where slug='mobile-accessories'");
  await ps(await uuid(),'create');
  await db.exec("update public.accessory_release_v1 set enabled=false;update public.categories set is_active=false where slug='mobile-accessories'");
  await db.exec('update public.posting_category_definitions set enabled=true');
 });
 await test('phone sessions behave as before: create/reserve/ready/prepare and recovery rotation',async()=>{
  const id=await uuid(),m=await uuid();await ps(id,'create');await stage(ps,id,m);assert.equal((await ps(id,'prepare')).session.state,'finalizing');
  const e=await uuid();assert.notEqual((await ps(e,'create_empty')).session.id,e);
 });
 await test('wearable release off again fails closed for sessions and submit; existing data retained',async()=>{
  await db.exec('update public.wearable_release_v1 set enabled=false');
  await rejects("select public.wearable_v1_session($1,'read')",[W],/unavailable/);await rejects('select public.submit_wearable_v1($1::jsonb)',['{}'],/./);
  assert(await q('select count(*)::int from public.listing_wearable_contexts_v1')>0);
  await db.exec('update public.wearable_release_v1 set enabled=true');
 });

 // ---- migration preconditions (fresh databases)
 await test('migration refuses to run without V2.1.2 / Accessories baseline, on drift, or twice',async()=>{
  const r=await base('recovery');try{await migFails(r,/WEARABLES_PREREQUISITE_MISSING: Accessories/);}finally{await r.close();}
  const d=await base();try{await d.exec("create or replace function app_security.impl_posting_v2_session(p_session_id uuid,p_operation text,p_media_id uuid default null) returns jsonb language sql as $f$select null::jsonb /* list_recovery */$f$");await migFails(d,/WEARABLES_BASELINE_DRIFT/);}finally{await d.close();}
  await migFails(db,/WEARABLES_ALREADY_INSTALLED/);
 });
 await test('existing wearables listings or open category state block install',async()=>{
  const d=await base();try{
   await d.exec("insert into public.categories(slug,name,is_active,macro_category,new_listing_enabled) values('wearables','x',false,'goods',true)");
   await migFails(d,/WEARABLES_CATEGORY_CONFLICT/);
  }finally{await d.close();}
 });
 await test('SHA256SUMS matches the immutable migration files',async()=>{
  const sums=readFileSync(resolve(fm,'wearables-v1/SHA256SUMS'),'utf8').trim().split('\n').map(l=>l.split(/\s+/));
  assert(sums.length>=2);for(const [h,p] of sums)assert.equal(sha(`wearables-v1/${p}`),h,p);
 });
 console.log(JSON.stringify({success:true,checks,engine:'PGlite; real candidate migrations, synthetic supporting auth/storage',not_covered:['multi-connection concurrency','hosted RLS/E2E','Tablets coexistence: see scripts/ci/test-wearables-tablets-v1.mjs']}));
}finally{await db.close();}
