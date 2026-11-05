// Disposable in-process PostgreSQL only; never consumes a connection URL or environment credentials.
// Cross-category regression: Mobile Phones + Accessories + Tablets V1 + Wearables V1 installed TOGETHER, in both
// migration orders. Real candidate migrations + synthetic auth/storage fixture. Does NOT replace hosted DB
// verification or multi-connection (native PG17) concurrency checks (see tests/wearables-v1/native.mjs).
//   node scripts/ci/test-wearables-tablets-v1.mjs [--pglite-module=<path>] [--web=<FairSwap-Web path>]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {installPostingFixture} from './posting-v2-fixture.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const opt=n=>process.argv.slice(2).find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3);
for(const a of process.argv.slice(2))if(!/^--(pglite-module|web)=/.test(a))throw new Error('Use only --pglite-module=<path> and --web=<path>');
const web=resolve(opt('web')??resolve(root,'../FairSwap-Web'));
const require=createRequire(resolve(web,'package.json'));
const {PGlite}=opt('pglite-module')?await import(pathToFileURL(resolve(opt('pglite-module'))).href):require('@electric-sql/pglite');
const catalogue=JSON.parse(readFileSync(resolve(web,'src/lib/listings/wearables/catalogue.generated.json'),'utf8'));
const fm=resolve(root,'supabase/forward-migrations');
const sql=p=>readFileSync(resolve(fm,p),'utf8');
const FILES={
 recovery:'posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql',
 phoneOn:'posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql',
 acc:'accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql',
 tab:'tablets-v1/supabase/migrations/20261102165946_posting_v2_tablets.sql',
 tabOn:'tablets-v1/activation/supabase/migrations/20261102170611_activate_tablets_v1.sql',
 wear:'wearables-v1/supabase/migrations/20261104120000_posting_v2_wearables.sql',
 wearOn:'wearables-v1/activation/supabase/migrations/20261104230000_activate_wearables_v1.sql',
 wearOff:'wearables-v1/rollback/disable_wearables_v1.sql',
 wearRestore:'wearables-v1/rollback/restore_accessories_session_baseline.sql'};
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',city='55555555-5555-4555-8555-555555555555',locality='66666666-6666-4666-8666-666666666666';
let checks=0;
async function build(order){
 const db=new PGlite();await installPostingFixture(db);
 await db.exec(`
 alter table public.listings add column if not exists slug text,add column if not exists created_at timestamptz default now(),add column if not exists published_at timestamptz,add column if not exists expires_at timestamptz,add column if not exists search_vector tsvector;
 alter table public.categories add column if not exists icon text;
 alter table public.cities add column if not exists name text default 'Bengaluru',add column if not exists state text default 'Karnataka';
 alter table public.localities add column if not exists name text default 'Koramangala';
 create table if not exists public.user_accounts(user_id uuid primary key,account_status text);
 create or replace function app_security.is_listing_publicly_visible(target uuid) returns boolean language sql stable security definer set search_path='' as $f$select exists(select 1 from public.listings l join public.user_accounts ua on ua.user_id=l.seller_id where l.id=target and l.status='active' and ua.account_status='active')$f$;
 grant select on public.categories,public.listings to anon,authenticated;`);
 await db.exec(sql(FILES.recovery));await db.exec(sql(FILES.acc));
 await db.exec(sql(FILES.phoneOn));
 const phoneBefore=(await db.query("select oid::text oid,md5(prosrc) h from pg_proc where oid='app_security.impl_submit_mobile_v2(jsonb)'::regprocedure")).rows[0];
 if(order==='tablets-first'){await db.exec(sql(FILES.tab));await db.exec(sql(FILES.wear));}
 else{await db.exec(sql(FILES.wear));await db.exec(sql(FILES.tab));}
 await db.query('insert into auth.users values($1),($2)',[A,B]);await db.query("insert into public.user_accounts values($1,'active'),($2,'active')",[A,B]);
 await db.query('insert into public.cities values($1,true)',[city]);await db.query('insert into public.localities values($1,$2,true)',[locality,city]);await db.query("insert into public.postal_pincode_localities values('560034',$1)",[locality]);
 return {db,phoneBefore};
}
const wmodel=type=>catalogue.models.find(m=>m.type===type);
async function suite(order){
 const {db,phoneBefore}=await build(order);
 const q=async(s,a=[])=>Object.values((await db.query(s,a)).rows[0]??{x:null})[0];
 const as=u=>db.query("select set_config('request.user',$1,false)",[u??'']);
 const role=r=>db.exec(r?`set role ${r}`:'reset role');
 const svc=async fn=>{await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`);try{return await fn();}finally{await db.exec(`select set_config('request.jwt','{}',false)`);}};
 const rejects=(s,a=[],re)=>assert.rejects(()=>db.query(s,a),re);
 const uuid=()=>q('select gen_random_uuid()');
 const ws=(id,op,media=null)=>q('select public.wearable_v1_session($1,$2,$3)',[id,op,media]);
 const ts=(id,op)=>q('select public.tablet_v1_session($1,$2)',[id,op]);
 const ps=(id,op,media=null)=>q('select public.posting_v2_session($1,$2,$3)',[id,op,media]);
 const free=async(...owners)=>{for(const o of owners)await db.query("update public.posting_upload_sessions set state='expired',expires_at=now()-interval '1 second' where owner_id=$1 and state in ('open','finalizing')",[o]);};
 const test=async(name,fn)=>{try{await as(A);await free(A,B);await fn();}catch(e){console.error(`FAILED [${order}]:`,name,String(e.message).slice(0,240));throw e;}finally{await role();await as(A);}console.log(`ok ${++checks} - [${order}] ${name}`);};
 const tabletModel=(await db.query("select id,brand_id from public.tablet_models_v1 where name='iPad (9th generation)'")).rows[0];
 const tpayload=(over={})=>({selection:{category:'mobiles',subcategory:'tablets',version:1},session_id:null,brand_id:tabletModel.brand_id,model_id:tabletModel.id,other_model:'',storage:'64 GB',connectivity:'wifi',ram:'',colour:'',hardware_model_number:'A2602',condition:'good',screen_touch_status:'working',battery_charging_status:'normal',transfer_lock_status:'clear',powers_on:'yes',repair_history:'none',other_defects:'',included:[],stylus_description:'',keyboard_description:'',warranty_until:'',title:'iPad 9th generation 64 GB Wi-Fi',description:'Carefully used tablet with no repairs.',trade:'sell',price_paise:1000000,negotiable:false,pin_code:'560034',city_id:city,locality_id:locality,media_ids:[],plan_id:'free-v1',...over});
 const wpayload=(over={})=>{const m=wmodel('smartwatch');return {selection:{category:'mobiles',subcategory:'wearables',version:1},session_id:null,catalogue_revision:catalogue.revision,device_type:'smartwatch',brand_id:m.brand_id,other_brand:'',model_id:m.id,other_model:'',generation:'',case_size_mm:44,connectivity:'bluetooth',phone_os:['android'],finish:'',condition:'good',screen:'minor_scratches',controls:'working',sensors:'working',charging:'working',battery_mode:'not_tested',strap:'good',included:['charger'],purchase_month:'2024-05',warranty_until:'',pairing_status:'reset_ready',transfer_ack:false,ownership_confirmed:true,title:'Smartwatch in good condition',description:'Used for one year, always with a case. Charger included.',trade:'sell',price_paise:500000,negotiable:true,pin_code:'560034',city_id:city,locality_id:locality,media_ids:[],plan_id:'free-v1',...over};};
 const submitT=p=>q('select public.submit_tablet_v1($1::jsonb)',[JSON.stringify(p)]);
 const submitW=p=>q('select public.submit_wearable_v1($1::jsonb)',[JSON.stringify(p)]);
 const storage=async(listing,media)=>{for(const n of ['original','thumb','medium','large'])await db.query('insert into storage.objects values($1,$2)',[n==='original'?'listing-originals':'listing-derivatives',`${listing}/${media}/${n}.webp`]);};
 // Tablets reserve/prepare through the shared phone session function; wearables through their own wrapper.
 async function prep(kind){
  const id=await uuid(),media=await uuid();
  const open=kind==='tablet'?ts:ws,media_=kind==='tablet'?ps:ws;
  await open(id,'create');
  const s=await media_(id,'reserve',media);
  await svc(()=>q('select public.posting_v2_media_ready($1,$2,$3,1000,800,600)',[id,media,s.media[0].attempt]));
  const f=await media_(id,'prepare');await storage(f.session.listing_id,media);
  return {id,media,listing:f.session.listing_id};
 }
 const insertListing=(id,cat,seller=A)=>db.query(`insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes) values($1,$2,$3,$4,$5,'560034','Some title here','A long enough description for listing','good','fixed',1000,'{}')`,[id,seller,cat,city,locality]);
 const cat=slug=>q('select id from public.categories where slug=$1',[slug]);

 await as(A);
 await test('both features ship disabled and fail closed independently of each other',async()=>{
  assert.equal(await q('select enabled from public.tablet_release_v1'),false);assert.equal(await q('select enabled from public.wearable_release_v1'),false);
  await rejects("select public.tablet_v1_session($1,'create')",[await uuid()],/unavailable/);
  await rejects("select public.wearable_v1_session($1,'create')",[await uuid()],/unavailable/);
 });
 await test('installing wearables leaves the tablet-wrapped phone implementation identical',async()=>{
  const after=(await db.query("select oid::text oid,md5(prosrc) h from pg_proc where oid='app_security.impl_submit_mobile_v2(jsonb)'::regprocedure")).rows[0];
  if(order==='tablets-first'){assert.equal(after.oid,phoneBefore.oid);assert.notEqual(after.h,phoneBefore.h);} // tablets wrapper in place, same OID
  assert.equal(await q("select count(*)::int from pg_proc where oid=to_regprocedure('app_security.impl_submit_mobile_v2_before_tablets(jsonb)')"),1);
  assert.equal(await q("select count(*)::int from pg_proc where proname in ('impl_submit_mobile_v2','impl_posting_v2_session') and pronamespace='app_security'::regnamespace"),2);
 });
 await db.exec(sql(FILES.tabOn));await db.exec(sql(FILES.wearOn));
 await test('activation of both categories is independent and idempotent-safe',async()=>{
  assert.equal(await q('select enabled from public.tablet_release_v1'),true);assert.equal((await q('select public.wearables_v1_catalogue()')).enabled,true);
 });

 await test('each category binds only its own sessions; phone sessions are unbound',async()=>{
  const t=await uuid(),w=await uuid(),p=await uuid();await ts(t,'create');await ws(w,'create');await ps(p,'create');
  assert.equal(await q('select count(*)::int from public.tablet_session_bindings_v1 where session_id=any($1::uuid[])',[[t,w,p]]),1);
  assert.equal(await q('select count(*)::int from public.wearable_session_bindings_v1 where session_id=any($1::uuid[])',[[t,w,p]]),1);
  assert.equal(await q('select session_id from public.tablet_session_bindings_v1 where session_id=any($1::uuid[])',[[t,w,p]]),t);
  assert.equal(await q('select session_id from public.wearable_session_bindings_v1 where session_id=any($1::uuid[])',[[t,w,p]]),w);
 });
 await test('recovery lists never leak a wearable session into tablet or phone lists, nor the reverse',async()=>{
  const t=await uuid(),w=await uuid(),p=await uuid();await ts(t,'create');await ws(w,'create');await ps(p,'create');
  const T=(await ts(null,'list_recovery')).sessions.map(s=>s.id),W=(await ws(null,'list_recovery')).sessions.map(s=>s.id),P=(await ps(null,'list_recovery')).sessions.map(s=>s.id);
  assert.deepEqual(T,[t]);assert.deepEqual(W,[w]);assert(!P.includes(w));assert(P.includes(p));
 });
 await test('cross-category session matrix: every operation on the other category session is refused',async()=>{
  const t=await uuid(),w=await uuid();await ts(t,'create');await ws(w,'create');
  for(const op of ['create','read','claim_draft','acquire_draft','abandon_empty'])await rejects('select public.tablet_v1_session($1,$2)',[w,op],/Cross-category session/);
  for(const op of ['create','read','claim_draft','prepare','abandon_empty'])await rejects('select public.posting_v2_session($1,$2,null)',[w,op],/UPLOAD_SESSION_UNAVAILABLE/);
  await rejects("select public.posting_v2_session($1,'reserve',$2)",[w,await uuid()],/UPLOAD_SESSION_UNAVAILABLE/);
  await rejects("select public.posting_v2_session($1,'remove',$2)",[w,await uuid()],/UPLOAD_SESSION_UNAVAILABLE/);
  for(const op of ['create','read','claim_draft','acquire_draft','prepare','abandon_empty'])await rejects('select public.wearable_v1_session($1,$2,null)',[t,op],/UPLOAD_SESSION_UNAVAILABLE/);
  for(const op of ['reserve','remove'])await rejects('select public.wearable_v1_session($1,$2,$3)',[t,op,await uuid()],/UPLOAD_SESSION_UNAVAILABLE/);
  assert.equal((await ts(t,'read')).session.id,t);assert.equal((await ws(w,'read')).session.id,w);
 });
 await test('ownership: another seller cannot read, claim, reserve or submit either category session',async()=>{
  const t=await uuid(),w=await uuid();await ts(t,'create');await ws(w,'create');await as(B);
  await rejects('select public.tablet_v1_session($1,$2)',[t,'read'],/./);await rejects('select public.wearable_v1_session($1,$2,null)',[w,'read'],/UPLOAD_SESSION_UNAVAILABLE/);
  await rejects('select public.wearable_v1_session($1,$2,null)',[w,'claim_draft'],/UPLOAD_SESSION_UNAVAILABLE/);
  await rejects("select public.wearable_v1_session($1,'reserve',$2)",[w,await uuid()],/UPLOAD_SESSION_UNAVAILABLE/);
  await rejects('select public.submit_wearable_v1($1::jsonb)',[JSON.stringify(wpayload({session_id:w,media_ids:[await uuid()]}))],/Upload session unavailable/);
  await rejects('select public.submit_tablet_v1($1::jsonb)',[JSON.stringify(tpayload({session_id:t,media_ids:[await uuid()]}))],/Upload session unavailable/);
  assert.equal(await q('select count(*)::int from public.listings'),0);
  const own=await uuid();await ws(own,'create');assert.equal((await ws(own,'read')).session.id,own); // B's own session still works
 });
 await test('cross-category submissions are refused and create no listing, context or flag',async()=>{
  const t=await prep('tablet'),w=await prep('wearable');
  await rejects('select public.submit_wearable_v1($1::jsonb)',[JSON.stringify(wpayload({session_id:t.id,media_ids:[t.media]}))],/Cross-category session/);
  await rejects('select public.submit_tablet_v1($1::jsonb)',[JSON.stringify(tpayload({session_id:w.id,media_ids:[w.media]}))],/Cross-category session/);
  // phone contract against either bound session
  await rejects('select app_security.impl_submit_mobile_v2($1::jsonb)',[JSON.stringify({...tpayload({session_id:t.id,media_ids:[t.media]}),selection:{category:'mobiles',subcategory:'mobile-phones',version:2}})],/./);
  await rejects('select app_security.impl_submit_mobile_v2($1::jsonb)',[JSON.stringify({...wpayload({session_id:w.id,media_ids:[w.media]}),selection:{category:'mobiles',subcategory:'mobile-phones',version:2}})],/./);
  for(const tbl of ['listings','listing_tablet_contexts','listing_wearable_contexts_v1','listing_wearable_risk_flags_v1'])assert.equal(await q(`select count(*)::int from public.${tbl}`),0,tbl);
  assert.equal(await q("select state from public.posting_upload_sessions where id=$1",[t.id]),'finalizing');
  assert.equal(await q("select state from public.posting_upload_sessions where id=$1",[w.id]),'finalizing');
 });
 await test('listing guards: a listing id minted by one category session cannot become another category',async()=>{
  const t=await uuid(),w=await uuid(),tl=(await ts(t,'create')).session.listing_id,wl=(await ws(w,'create')).session.listing_id;
  const [phone,tablet,wear]=[await cat('mobile-phones'),await cat('tablets'),await cat('wearables')];
  await assert.rejects(()=>insertListing(wl,phone),/Cross-category session/);await assert.rejects(()=>insertListing(wl,tablet),/Cross-category session/);
  await assert.rejects(()=>insertListing(tl,wear),/Cross-category session|requires a wearable session/); // tablet guard fires first (zz_tablet < zz_wearable)
  const fresh=await uuid();await assert.rejects(()=>insertListing(fresh,wear),/requires a wearable session/);
  assert.equal(await q('select count(*)::int from public.listings'),0);
 });
 await test('shared five-session capacity counts tablet and wearable sessions together (no bypass via category)',async()=>{
  const ids=[];for(const [k,f] of [['t',ts],['t',ts],['w',ws],['w',ws],['p',ps]]){const id=await uuid();await f(id,'create');ids.push(id);}
  for(const [f,name] of [[()=>ts(uuid_(),'create'),'tablet'],[()=>ws(uuid_(),'create'),'wearable'],[()=>ps(uuid_(),'create'),'phone']])await assert.rejects(()=>f(),(e)=>e.code==='PT429'||/UPLOAD_SESSION_LIMIT/.test(e.message),name);
  await db.query("update public.posting_upload_sessions set state='expired',expires_at=now()-interval '1 second' where id=$1",[ids[0]]);
  await ws(uuid_(),'create'); // one freed slot admits exactly one
  await assert.rejects(()=>ts(uuid_(),'create'),(e)=>e.code==='PT429'||/UPLOAD_SESSION_LIMIT/.test(e.message));
  function uuid_(){return crypto.randomUUID();}
 });
 await test('same seller publishes one tablet and one wearable; each context lands in its own table only',async()=>{
  const t=await prep('tablet'),w=await prep('wearable');
  const a=await submitT(tpayload({session_id:t.id,media_ids:[t.media]})),b=await submitW(wpayload({session_id:w.id,media_ids:[w.media]}));
  assert.equal(a.success,true);assert.equal(b.success,true);assert.notEqual(a.listing_id,b.listing_id);
  assert.equal((await submitT(tpayload({session_id:t.id,media_ids:[t.media]}))).listing_id,a.listing_id); // replay idempotent
  assert.equal((await submitW(wpayload({session_id:w.id,media_ids:[w.media]}))).listing_id,b.listing_id);
  assert.equal(await q('select count(*)::int from public.listings'),2);
  assert.equal(await q('select c.slug from public.listings l join public.categories c on c.id=l.category_id where l.id=$1',[a.listing_id]),'tablets');
  assert.equal(await q('select c.slug from public.listings l join public.categories c on c.id=l.category_id where l.id=$1',[b.listing_id]),'wearables');
  assert.equal(await q('select count(*)::int from public.listing_tablet_contexts where listing_id=$1',[a.listing_id]),1);
  assert.equal(await q('select count(*)::int from public.listing_wearable_contexts_v1 where listing_id=$1',[a.listing_id]),0);
  assert.equal(await q('select count(*)::int from public.listing_wearable_contexts_v1 where listing_id=$1',[b.listing_id]),1);
  assert.equal(await q('select count(*)::int from public.listing_tablet_contexts where listing_id=$1',[b.listing_id]),0);
  assert.equal(await q("select count(*)::int from public.listing_wearable_risk_flags_v1 where listing_id=$1",[a.listing_id]),0);
 });
 await test('a tablet listing cannot be edited into wearables or vice versa',async()=>{
  const [tab,wear]=[await cat('tablets'),await cat('wearables')];
  const t=(await db.query("select l.id from public.listings l where l.category_id=$1",[tab])).rows[0].id,w=(await db.query("select l.id from public.listings l where l.category_id=$1",[wear])).rows[0].id;
  await assert.rejects(()=>db.query('update public.listings set category_id=$1 where id=$2',[wear,t]),/./);
  await assert.rejects(()=>db.query('update public.listings set category_id=$1 where id=$2',[tab,w]),/./);
 });
 await test('anonymous and service roles cannot reach either category entry point',async()=>{
  const id=await uuid();
  for(const r of ['anon','service_role']){await role(r);
   await rejects('select public.tablet_v1_session($1,$2)',[id,'create'],/permission denied/);await rejects('select public.wearable_v1_session($1,$2,null)',[id,'create'],/permission denied/);
   await rejects('select public.submit_tablet_v1($1::jsonb)',['{}'],/permission denied/);await rejects('select public.submit_wearable_v1($1::jsonb)',['{}'],/permission denied/);await role();}
  for(const r of ['anon','authenticated','service_role']){await role(r);await rejects('select app_security.impl_posting_session_core_v1($1,$2,null,null)',[id,'read'],/permission denied/);await role();}
 });
 await test('release isolation: disabling one category leaves the other fully working',async()=>{
  await db.exec('update public.wearable_release_v1 set enabled=false');
  await rejects("select public.wearable_v1_session($1,'create')",[await uuid()],/unavailable/);await ts(await uuid(),'create');
  await db.exec('update public.wearable_release_v1 set enabled=true;update public.tablet_release_v1 set enabled=false');
  await rejects("select public.tablet_v1_session($1,'create')",[await uuid()],/unavailable/);await ws(await uuid(),'create');
  await db.exec('update public.tablet_release_v1 set enabled=true');
  await free(A);await ts(await uuid(),'create');await ws(await uuid(),'create');
 });
 await test('wearables rollback scripts keep tablets, phones and retained data working',async()=>{
  const before=await q('select count(*)::int from public.listings');
  await db.exec(sql(FILES.wearOff));
  await rejects("select public.wearable_v1_session($1,'create')",[await uuid()],/unavailable/);
  await ts(await uuid(),'create');await ps(await uuid(),'create');
  await free(A,B);await db.exec(sql(FILES.wearRestore));
  const t=await uuid();await ts(t,'create');assert.equal((await ts(t,'read')).session.id,t);
  const p=await uuid();await ps(p,'create');assert.equal((await ps(p,'read')).session.id,p);
  assert.equal(await q('select count(*)::int from public.listings'),before);
  assert.equal(await q('select count(*)::int from public.listing_wearable_contexts_v1'),1); // retained, not dropped
  await rejects("select public.wearable_v1_session($1,'create')",[await uuid()],/unavailable|UPLOAD_SESSION/);
 });
 await db.close();
}
try{
 await suite('tablets-first');
 await suite('wearables-first');
 console.log(JSON.stringify({success:true,checks,engine:'PGlite; real candidate migrations, synthetic supporting auth/storage',orders:['tablets-first','wearables-first'],not_covered:['multi-connection concurrency (see tests/wearables-v1/native.mjs)','hosted RLS/E2E']}));
}catch(e){console.error(e);process.exit(1);}
