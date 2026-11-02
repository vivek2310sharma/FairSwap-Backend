// Disposable, in-memory PostgreSQL contract checks. No network, env files, Docker
// or hosted credentials. Existing helpers are explicit fixture substitutes;
// the real installed submission function is tested, not the hosted queue worker.
// node scripts/ci/test-posting-v2.mjs <absolute FairSwap-Web path>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(resolve(process.argv[2]??'../FairSwap-Web','package.json'));
const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();let checks=0;
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const test=async(label,fn)=>{await fn();checks++;console.log(`ok ${checks} - ${label}`);};
const rejects=async(sql,args=[])=>assert.rejects(()=>db.query(sql,args));
const functionFrom=(file,name)=>{const source=readFileSync(resolve(root,'supabase/migrations',file),'utf8');const start=source.toLowerCase().indexOf(`create or replace function ${name.toLowerCase()}(`);assert(start>=0);const part=source.slice(start);const dollar=part.match(/\$(?:function)?\$/)[0];const first=part.indexOf(dollar);const end=part.indexOf(dollar,first+dollar.length)+dollar.length;return part.slice(0,end)+';';};
try {
 await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema app_security;create schema storage;
 grant usage on schema public,auth,app_security,storage to anon,authenticated,service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.user',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt',true),''),'{}')::jsonb$$;
 create type public.staff_role_enum as enum('administrator','moderator','content_editor','support_agent');
 create function app_security.get_account_status(uuid) returns text language sql stable as $$select coalesce(nullif(current_setting('request.account',true),''),'active')::text$$;
 create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql stable as $$select coalesce(current_setting('request.policy',true),'true')='true'$$;
 create function app_security.is_active_staff_aal2(public.staff_role_enum) returns boolean language sql stable as $$select coalesce(current_setting('request.staff',true),'false')='true'$$;
 create function app_security.is_listing_publicly_visible(uuid) returns boolean language sql stable as $$select false$$;
 create function app_security.submission_family(uuid,uuid) returns text language sql stable as $$select null::text$$;
 create function app_security.log_audit_event(text,text,uuid,jsonb) returns void language plpgsql as $$begin end$$;
 create table auth.users(id uuid primary key);
 create table public.categories(id uuid primary key default gen_random_uuid(),slug text unique,name text,description text,sort_order integer,is_active boolean,macro_category text,new_listing_enabled boolean);
 create table public.category_attributes(category_id uuid,name text,label text,is_required boolean);
 create table public.cities(id uuid primary key,is_active boolean);
 create table public.localities(id uuid primary key,city_id uuid references public.cities,is_active boolean);
 create table public.postal_pincode_localities(pincode text,locality_id uuid references public.localities);
 create type public.listing_status_enum as enum('draft','pending_review','active','reserved','sold','rejected','paused','expired','removed');
 create type public.listing_price_type_enum as enum('fixed','negotiable','free');
 create type public.listing_condition_enum as enum('new','like_new','good','fair','poor');
 create type public.media_processing_status_enum as enum('uploading','processing','ready','failed');
 create table public.listings(id uuid primary key,seller_id uuid references auth.users,category_id uuid references public.categories,city_id uuid references public.cities,locality_id uuid references public.localities,pin_code text,title text,description text,condition public.listing_condition_enum,price_type public.listing_price_type_enum,price_paise integer,category_attributes jsonb,status public.listing_status_enum default 'draft',revision integer default 1,cover_photo_id uuid,rejection_reason text,submitted_at timestamptz,updated_at timestamptz);
 create table public.listing_media(id uuid primary key,listing_id uuid references public.listings,uploader_id uuid,original_filename text,content_type text,file_size_bytes integer,original_storage_path text,thumbnail_storage_path text,medium_storage_path text,large_storage_path text,width integer,height integer,processing_status public.media_processing_status_enum,display_order integer default 0,created_at timestamptz default now());
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
 `);
 await db.exec(functionFrom('20261012120000_post_ad_current_base_compatibility.sql','app_security.impl_seller_submit_listing'));
 await db.exec(functionFrom('20260914000008_create_listing_rpcs.sql','public.seller_submit_listing'));
 await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/posting-v2/supabase/migrations/20261025131116_posting_v2_mobiles.sql'),'utf8'));
 // Existing no-photo sessions have unknown local drafts; the new default must protect them.
 await db.exec(`insert into public.posting_upload_sessions(id,owner_id) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')`);
 await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql'),'utf8'));
 await test('legacy no-photo sessions backfill to protected, without empty-draft certification',async()=>{
  assert.equal(await scalar(`select draft_protected from public.posting_upload_sessions where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`),true);
  assert.equal(await scalar(`select empty_request_id from public.posting_upload_sessions where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`),null);
 });
 await db.exec(`delete from public.posting_upload_sessions where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`);

 const u='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333',media='44444444-4444-4444-8444-444444444444';
 await db.query(`insert into auth.users values($1),($2)`,[u,other]);
 await db.query(`select set_config('request.user',$1,false)`,[u]);
 await test('release defaults disabled',async()=>assert.equal(await scalar(`select enabled from public.posting_category_definitions`),false));
 await test('disabled route rejects session creation',()=>rejects(`select public.posting_v2_session($1,'create')`,[session]));
 await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql'),'utf8'));
 await test('21 independently searchable brands',async()=>assert.equal(await scalar('select count(*)::int from public.phone_brands'),21));
 await test('private staged bucket',async()=>assert.equal(await scalar(`select public from storage.buckets where id='posting-staged'`),false));
 await test('all seven tables enforce RLS',async()=>assert.equal(await scalar(`select count(*)::int from pg_class where relname in ('posting_category_definitions','phone_brands','phone_models','posting_upload_sessions','posting_staged_media','listing_mobile_contexts','listing_phone_risk_flags') and relrowsecurity and relforcerowsecurity`),7));
 await test('clients have no staged-media write or service completion grant',async()=>{assert.equal(await scalar(`select has_table_privilege('authenticated','public.posting_staged_media','INSERT')`),false);assert.equal(await scalar(`select has_function_privilege('authenticated','public.posting_v2_media_ready(uuid,uuid,uuid,integer,integer,integer)','EXECUTE')`),false);});
 await test('creates an idempotent owner session',async()=>{const a=await scalar(`select public.posting_v2_session($1,'create')`,[session]);const b=await scalar(`select public.posting_v2_session($1,'create')`,[session]);assert.equal(a.session.id,b.session.id);});
 await db.query(`select set_config('request.user',$1,false)`,[other]);
 await test('cross-account session access rejected',()=>rejects(`select public.posting_v2_session($1,'read')`,[session]));
 await db.exec('set role authenticated');
 await test('owner RLS hides another account session',async()=>assert.equal(await scalar(`select count(*)::int from public.posting_upload_sessions`),0));
 await db.exec('reset role');await db.query(`select set_config('request.user',$1,false)`,[u]);
 await test('stale policy fails closed',async()=>{await db.exec(`select set_config('request.policy','false',false)`);await rejects(`select public.posting_v2_session($1,'read')`,[session]);await db.exec(`select set_config('request.policy','true',false)`);});
 let snapshot=await scalar(`select public.posting_v2_session($1,'reserve',$2)`,[session,media]);
 await test('same upload cannot acquire a second live lease',()=>rejects(`select public.posting_v2_session($1,'reserve',$2)`,[session,media]));
 await test('session enforces eight slots even before uploads finish',async()=>{const ids=[];for(let i=0;i<7;i++){const id=await scalar('select gen_random_uuid()');ids.push(id);await scalar(`select public.posting_v2_session($1,'reserve',$2)`,[session,id]);}await rejects(`select public.posting_v2_session($1,'reserve',gen_random_uuid())`,[session]);for(const id of ids)await scalar(`select public.posting_v2_session($1,'remove',$2)`,[session,id]);});
 await test('expired upload lease rotates its immutable attempt namespace',async()=>{const old=snapshot.media[0].attempt;await db.query(`update public.posting_staged_media set lease_until=now()-interval '1 second' where id=$1`,[media]);snapshot=await scalar(`select public.posting_v2_session($1,'reserve',$2)`,[session,media]);assert.notEqual(snapshot.media[0].attempt,old);});
 await test('untrusted caller cannot mark a photo ready',()=>rejects(`select public.posting_v2_media_ready($1,$2,$3,1000,800,600)`,[session,media,snapshot.media[0].attempt]));
 await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`);
 await test('trusted media completion succeeds',async()=>assert.equal(await scalar(`select public.posting_v2_media_ready($1,$2,$3,1000,800,600)`,[session,media,snapshot.media[0].attempt]),true));
 await test('lost-response media completion retries are idempotent',async()=>assert.equal(await scalar(`select public.posting_v2_media_ready($1,$2,$3,1000,800,600)`,[session,media,snapshot.media[0].attempt]),true));
 await db.exec(`select set_config('request.jwt','{}',false)`);
 await test('phone specs do not trigger contact blocking',()=>db.query(`select app_security.phone_content_guard('iPhone 15 Pro 128 GB 8 GB RAM 5000 mAh')`));
 await test('contact numbers and courier advance blocked',async()=>{await rejects(`select app_security.phone_content_guard('call 98765 43210')`);await rejects(`select app_security.phone_content_guard('courier fee pay now')`);await rejects(`select app_security.phone_content_guard('pay seller@okaxis')`);});
 await test('catalogue mutation requires staff MFA',()=>rejects(`select public.admin_phone_catalogue('brand','{}')`));
 await db.exec(`select set_config('request.staff','true',false)`);
 await test('catalogue cannot carry security metadata',()=>rejects(`select public.admin_phone_catalogue('brand','{"name":"unsafe","disable_rls":true}')`));
 await db.exec(`select set_config('request.staff','false',false)`);
 const model=(await db.query(`select m.id,m.brand_id from public.phone_models m join public.phone_brands b on b.id=m.brand_id where b.name='Apple' and m.name='iPhone 15'`)).rows[0];
 const city='55555555-5555-4555-8555-555555555555',locality='66666666-6666-4666-8666-666666666666';
 await db.query(`insert into public.cities values($1,true)`,[city]);await db.query(`insert into public.localities values($1,$2,true)`,[locality,city]);await db.query(`insert into public.postal_pincode_localities values('560034',$1)`,[locality]);
 const payload={selection:{category:'mobiles',subcategory:'mobile-phones',version:2},session_id:session,trade:'sell',brand_id:model.brand_id,model_id:model.id,other_model:'',storage:'128 GB',ram:'',condition:'good',included:[],warranty_until:'',title:'iPhone 15 128 GB',description:'Carefully used with no repairs.',price_paise:2000000,negotiable:false,pin_code:'560034',city_id:city,locality_id:locality,media_ids:[media],plan_id:'free-v1'};
 snapshot=await scalar(`select public.posting_v2_session($1,'prepare')`,[session]);
 await test('missing canonical selection is rejected before any storage check',async()=>{const bad={...payload};delete bad.selection;await assert.rejects(()=>db.query('select public.submit_mobile_v2($1::jsonb)',[JSON.stringify(bad)]),/Invalid posting contract/);});
 await test('prepared session freezes photo removal',()=>rejects(`select public.posting_v2_session($1,'remove',$2)`,[session,media]));
 await test('missing storage rolls back the entire listing transaction',async()=>{await rejects('select public.submit_mobile_v2($1::jsonb)',[JSON.stringify(payload)]);assert.equal(await scalar('select count(*)::int from public.listings'),0);assert.equal(await scalar('select count(*)::int from public.listing_mobile_contexts'),0);});
 const base=`${snapshot.session.listing_id}/${media}/`;
 for(const name of ['original','thumb','medium','large'])await db.query(`insert into storage.objects values($1,$2)`,[name==='original'?'listing-originals':'listing-derivatives',base+name+'.webp']);
 await test('giveaway with a price rejected server-side',()=>rejects('select public.submit_mobile_v2($1::jsonb)',[JSON.stringify({...payload,trade:'giveaway'})]));
 await test('invalid PIN/locality mapping rejected',()=>rejects('select public.submit_mobile_v2($1::jsonb)',[JSON.stringify({...payload,pin_code:'110001'})]));
 await test('atomic finalizer enters existing pending review lifecycle',async()=>{const result=await scalar('select public.submit_mobile_v2($1::jsonb)',[JSON.stringify(payload)]);assert.equal(result.success,true);assert.equal(await scalar('select status from public.listings'),'pending_review');assert.equal(await scalar('select count(*)::int from public.listing_media where processing_status=\'ready\''),1);});
 await test('lost-response finalization retry does not duplicate listing',async()=>{await scalar('select public.submit_mobile_v2($1::jsonb)',[JSON.stringify(payload)]);assert.equal(await scalar('select count(*)::int from public.listings'),1);});
 await db.exec('set role authenticated');
 await test('clients cannot alter seller-declared context or risk flags',async()=>{await rejects(`update public.listing_mobile_contexts set fulfillment='courier'`);await rejects('delete from public.listing_phone_risk_flags');});
 await db.exec('reset role');
 await test('cleanup is service-only',()=>rejects(`select public.posting_v2_cleanup('claim')`));
 await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false); update public.posting_upload_sessions set cleanup_after=now()-interval '1 second'`);
 await test('cleanup preserves committed listing media',async()=>{const claims=await scalar(`select public.posting_v2_cleanup('claim')`);assert.equal(claims[0].submitted,true);await scalar(`select public.posting_v2_cleanup('ack',$1)`,[session]);assert.equal(await scalar('select count(*)::int from public.listing_media'),1);});
 // V2.1.2: real migration/RPC/RLS checks in this disposable engine only.
 const call=(id,op)=>scalar(`select public.posting_v2_session($1,$2)`,[id,op]);
 const activeCount=()=>scalar(`select count(*)::int from public.posting_upload_sessions where owner_id=$1 and state in ('open','finalizing') and expires_at>now()`,[u]);
 const setup=async()=>{await db.exec(`reset role; select set_config('request.jwt','{}',false); select set_config('request.account','active',false); select set_config('request.policy','true',false)`);await db.query(`select set_config('request.user',$1,false)`,[u]);await db.exec(`delete from public.posting_upload_sessions`);};
 const sessionTest=async(label,fn)=>{await setup();await test(label,fn);};
 const five=async()=>{const ids=[];for(let i=0;i<5;i++){const id=await scalar('select gen_random_uuid()');await call(id,'create');ids.push(id);}return ids;};
 const rejectsCode=(id,op,code,message)=>assert.rejects(()=>call(id,op),e=>e.code===code&&e.message===message);
 await sessionTest('five-session cap returns a stable error without reclaiming any session',async()=>{
  await five();await rejectsCode(await scalar('select gen_random_uuid()'),'create','PT429','UPLOAD_SESSION_LIMIT');assert.equal(await activeCount(),5);
 });
 await sessionTest('lost-response create and serialized multi-tab retries reuse the same owned id at capacity',async()=>{
  const ids=await five();const before=await call(ids[0],'read');const results=await Promise.all([call(ids[0],'create'),call(ids[0],'create')]);
  assert(results.every(r=>r.session.listing_id===before.session.listing_id));assert.equal(await activeCount(),5);
 });
 await sessionTest('recovery listing is read-only, bounded and contains only safe owner metadata',async()=>{
  await five();const before=await activeCount();await db.exec('set role authenticated');const result=await call(null,'list_recovery');
  assert.equal(result.limit,5);assert.equal(result.sessions.length,5);assert(result.sessions.every(s=>s.can_abandon));
  assert.deepEqual(Object.keys(result.sessions[0]).sort(),['can_abandon','can_rotate','created_at','draft_protected','expires_at','id','state']);await db.exec('reset role');assert.equal(await activeCount(),before);
 });
 await sessionTest('another account cannot enumerate or release sessions or read their media through RLS',async()=>{
  const ids=await five();await db.query(`select set_config('request.user',$1,false)`,[other]);await db.exec('set role authenticated');
  assert.deepEqual((await call(null,'list_recovery')).sessions,[]);assert.equal(await scalar('select count(*)::int from public.posting_upload_sessions'),0);
  await rejectsCode(ids[0],'abandon_empty','42501','UPLOAD_SESSION_UNAVAILABLE');await rejectsCode(ids[0],'create','42501','UPLOAD_SESSION_UNAVAILABLE');
  assert.equal(await scalar('select count(*)::int from public.posting_staged_media'),0);await db.exec('reset role');assert.equal(await activeCount(),5);
 });
 await sessionTest('explicit empty release is idempotent, keeps its tombstone and frees exactly one slot',async()=>{
  const ids=await five();const before=await call(ids[0],'read');await db.exec('set role authenticated');const a=await call(ids[0],'abandon_empty');const b=await call(ids[0],'abandon_empty');
  assert.equal(a.session.state,'expired');assert.equal(b.session.listing_id,before.session.listing_id);await db.exec('reset role');assert.equal(await activeCount(),4);
  assert.equal(await scalar('select count(*)::int from public.posting_upload_sessions'),5);await call(await scalar('select gen_random_uuid()'),'create');assert.equal(await activeCount(),5);
 });
 await sessionTest('stale recovery choice cannot release a session that acquired an upload lease',async()=>{
  const ids=await five();assert((await call(null,'list_recovery')).sessions.find(s=>s.id===ids[0]).can_abandon);
  await scalar(`select public.posting_v2_session($1,'reserve',gen_random_uuid())`,[ids[0]]);
  await rejectsCode(ids[0],'abandon_empty','PT409','UPLOAD_SESSION_PROTECTED');assert.equal(await activeCount(),5);
  assert.equal((await call(null,'list_recovery')).sessions.find(s=>s.id===ids[0]).can_abandon,false);
 });
 await sessionTest('ready and removed photo history are both protected, without object or draft deletion',async()=>{
  const ids=await five();for(const state of ['ready','removed']){
   const id=await scalar('select gen_random_uuid()');await scalar(`select public.posting_v2_session($1,'reserve',$2)`,[ids[0],id]);
   await db.query('update public.posting_staged_media set state=$1 where id=$2',[state,id]);
   await rejectsCode(ids[0],'abandon_empty','PT409','UPLOAD_SESSION_PROTECTED');
  }assert.equal(await scalar('select count(*)::int from public.posting_staged_media'),2);assert.equal(await activeCount(),5);
 });
 await sessionTest('finalizing and submitted sessions cannot be abandoned, including an empty one',async()=>{
  const ids=await five();await call(ids[0],'prepare');await rejectsCode(ids[0],'abandon_empty','PT409','UPLOAD_SESSION_PROTECTED');
  await db.query(`update public.posting_upload_sessions set state='submitted' where id=$1`,[ids[1]]);await rejectsCode(ids[1],'abandon_empty','PT409','UPLOAD_SESSION_PROTECTED');
  assert.equal((await call(ids[0],'read')).session.state,'finalizing');assert.equal((await call(ids[1],'read')).session.state,'submitted');
 });
 await sessionTest('release wins before a later reserve: stale tabs cannot resurrect the session',async()=>{
  const ids=await five();await call(ids[0],'abandon_empty');await assert.rejects(()=>scalar(`select public.posting_v2_session($1,'reserve',gen_random_uuid())`,[ids[0]]),e=>e.code==='PT410');
  await rejectsCode(ids[0],'create','PT410','UPLOAD_SESSION_EXPIRED');assert.equal(await activeCount(),4);
 });
 await sessionTest('expired sessions do not consume capacity and cannot be reopened by retry',async()=>{
  const ids=await five();await db.query(`update public.posting_upload_sessions set expires_at=now()-interval '1 second' where id=$1`,[ids[0]]);
  await call(await scalar('select gen_random_uuid()'),'create');assert.equal(await activeCount(),5);
  await rejectsCode(ids[0],'create','PT410','UPLOAD_SESSION_EXPIRED');await rejectsCode(ids[0],'read','PT410','UPLOAD_SESSION_EXPIRED');
  assert.equal((await call(null,'list_recovery')).sessions.some(s=>s.id===ids[0]),false);
 });
 await sessionTest('account and current-policy guards also protect listing and explicit release',async()=>{
  const ids=await five();for(const [setting,value] of [['request.account','suspended'],['request.policy','false']]){
   await db.query('select set_config($1,$2,false)',[setting,value]);await assert.rejects(()=>call(null,'list_recovery'),e=>e.code==='42501');await assert.rejects(()=>call(ids[0],'abandon_empty'),e=>e.code==='42501');
   await db.query('select set_config($1,$2,false)',[setting,setting==='request.account'?'active':'true']);
  }assert.equal(await activeCount(),5);
 });
 await sessionTest('anonymous callers have no RPC grants and authenticated callers cannot update session tables',async()=>{
  await db.exec('set role anon');await rejects(`select public.posting_v2_session(null,'list_recovery')`);await db.exec('reset role;set role authenticated');
  await rejects(`update public.posting_upload_sessions set state='expired'`);await rejects(`update public.posting_upload_sessions set draft_protected=false`);await rejects('delete from public.posting_upload_sessions');await db.exec('reset role');
  assert.equal(await scalar(`select prosecdef from pg_proc where oid='public.posting_v2_session(uuid,text,uuid)'::regprocedure`),false);
  assert.equal(await scalar(`select proconfig @> array['search_path=""'] from pg_proc where oid='app_security.impl_posting_v2_session(uuid,text,uuid)'::regprocedure`),true);
 });
 // Automatic rotation: only a server-minted empty id can start unprotected.
 const blanks=async()=>{const ids=[];for(let i=0;i<5;i++){
  const nonce=await scalar('select gen_random_uuid()');const result=await call(nonce,'create_empty');ids.push(result.session.id);
  await db.query(`update public.posting_upload_sessions set created_at=now()-($2::int*interval '1 minute') where id=$1`,[result.session.id,10-i]);
 }return ids;};
 const state=id=>scalar('select state from public.posting_upload_sessions where id=$1',[id]);
 await sessionTest('sixth request atomically rotates the oldest certified blank and retains five active sessions',async()=>{
  const ids=await blanks();const next=await scalar('select gen_random_uuid()');await call(next,'create');
  assert.equal(await state(ids[0]),'expired');assert.equal(await state(next),'open');assert.equal(await activeCount(),5);
  assert.equal(await scalar('select count(*)::int from public.posting_upload_sessions'),6);
  assert.equal(await scalar('select draft_protected from public.posting_upload_sessions where id=$1',[next]),true);
 });
 await sessionTest('oldest eligible selection skips an older meaningful local draft claim',async()=>{
  const ids=await blanks();await call(ids[0],'claim_draft');await call(await scalar('select gen_random_uuid()'),'create');
  assert.equal(await state(ids[0]),'open');assert.equal(await state(ids[1]),'expired');assert.equal(await activeCount(),5);
 });
 await sessionTest('empty certification mints a new id and retries cannot downgrade a claimed draft',async()=>{
  const nonce=await scalar('select gen_random_uuid()');const first=await call(nonce,'create_empty');assert.notEqual(first.session.id,nonce);assert.equal(first.session.draft_protected,false);
  await call(first.session.id,'claim_draft');const retry=await call(nonce,'create_empty');assert.equal(retry.session.id,first.session.id);assert.equal(retry.session.draft_protected,true);
  assert.equal(await activeCount(),1);
 });
 await sessionTest('legacy create/read and media reservation permanently protect a certified blank before work',async()=>{
  const ids=await blanks();await call(ids[0],'create');await call(ids[1],'read');
  await scalar(`select public.posting_v2_session($1,'reserve',gen_random_uuid())`,[ids[2]]);
  for(const id of ids.slice(0,3))assert.equal(await scalar('select draft_protected from public.posting_upload_sessions where id=$1',[id]),true);
  await call(await scalar('select gen_random_uuid()'),'create');assert.equal(await state(ids[3]),'expired');assert.equal(await activeCount(),5);
 });
 await sessionTest('all meaningful or unknown local drafts return recovery instead of rotation',async()=>{
  const ids=await five();await rejectsCode(await scalar('select gen_random_uuid()'),'create','PT429','UPLOAD_SESSION_LIMIT');
  assert((await call(null,'list_recovery')).sessions.every(s=>s.draft_protected&&!s.can_rotate));
  for(const id of ids)assert.equal(await state(id),'open');
  // An existing local UUID cannot be laundered into an empty certificate.
  await rejectsCode(ids[0],'create_empty','PT429','UPLOAD_SESSION_LIMIT');assert.equal(await activeCount(),5);
 });
 await sessionTest('rotation refuses photos, removed history, active uploads and finalization even with stale blank metadata',async()=>{
  const ids=await blanks();for(let i=0;i<3;i++)await db.query(`insert into public.posting_staged_media(id,session_id,state) values(gen_random_uuid(),$1,$2)`,[ids[i],['uploading','ready','removed'][i]]);
  await db.query(`update public.posting_upload_sessions set state='finalizing' where id=$1`,[ids[3]]);await call(ids[4],'claim_draft');
  await rejectsCode(await scalar('select gen_random_uuid()'),'create','PT429','UPLOAD_SESSION_LIMIT');assert.equal(await scalar('select count(*)::int from public.posting_staged_media'),3);assert.equal(await activeCount(),5);
 });
 await sessionTest('parallel replacement requests serialize without exceeding capacity or retiring the same victim',async()=>{
  const ids=await blanks();const a=await scalar('select gen_random_uuid()'),b=await scalar('select gen_random_uuid()');
  await Promise.all([call(a,'create'),call(b,'create')]);assert.equal(await activeCount(),5);assert.equal(await state(ids[0]),'expired');assert.equal(await state(ids[1]),'expired');
  assert.equal(await state(a),'open');assert.equal(await state(b),'open');
 });
 await sessionTest('parallel lost-response retries create one replacement and retire exactly one blank',async()=>{
  const ids=await blanks();const next=await scalar('select gen_random_uuid()');const result=await Promise.all([call(next,'create'),call(next,'create')]);
  assert.equal(result[0].session.listing_id,result[1].session.listing_id);assert.equal(await activeCount(),5);assert.equal(await state(ids[0]),'expired');assert.equal(await state(ids[1]),'open');
 });
 await sessionTest('claim-before-rotation is protected; rotation-before-claim returns expiry without accepting new work',async()=>{
  const ids=await blanks();await call(ids[0],'claim_draft');await call(await scalar('select gen_random_uuid()'),'create');assert.equal(await state(ids[0]),'open');
  await rejectsCode(ids[1],'claim_draft','PT410','UPLOAD_SESSION_EXPIRED');
 });
 await sessionTest('no seller can rotate another account eligible blanks to make room for their own drafts',async()=>{
  const own=await five();await db.query(`select set_config('request.user',$1,false)`,[other]);const theirs=await blanks();
  await db.query(`select set_config('request.user',$1,false)`,[u]);await rejectsCode(await scalar('select gen_random_uuid()'),'create','PT429','UPLOAD_SESSION_LIMIT');
  for(const id of [...own,...theirs])assert.equal(await state(id),'open');
 });
 await sessionTest('failed replacement rolls back retirement and preserves all five original active sessions',async()=>{
  const ids=await blanks();await assert.rejects(()=>call(null,'create'));assert.equal(await activeCount(),5);for(const id of ids)assert.equal(await state(id),'open');
 });
 await sessionTest('retired empty cleanup is retry-safe and never touches replacement or committed listing media',async()=>{
  const ids=await blanks();const next=await scalar('select gen_random_uuid()');await call(next,'create');const originalMedia=await scalar('select count(*)::int from public.listing_media');
  await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`);
  for(let i=0;i<2;i++){const claim=await scalar(`select public.posting_v2_cleanup('claim')`);assert.equal(claim.length,1);assert.equal(claim[0].id,ids[0]);assert.deepEqual(claim[0].media,[]);assert.equal(claim[0].submitted,false);}
  await scalar(`select public.posting_v2_cleanup('ack',$1)`,[ids[0]]);await scalar(`select public.posting_v2_cleanup('ack',$1)`,[ids[0]]);
  assert.equal(await state(next),'open');assert.equal(await activeCount(),5);assert.equal(await scalar('select count(*)::int from public.listing_media'),originalMedia);
 });
 await sessionTest('one eligible slot permits exactly one of two competing sixth-session requests',async()=>{
  const ids=await blanks();for(const id of ids.slice(1))await call(id,'claim_draft');
  const a=await scalar('select gen_random_uuid()'),b=await scalar('select gen_random_uuid()');const result=await Promise.allSettled([call(a,'create'),call(b,'create')]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected'&&r.reason.code==='PT429').length,1);
  assert.equal(await activeCount(),5);assert.equal(await state(ids[0]),'expired');assert.equal(await scalar('select count(*)::int from public.posting_upload_sessions'),6);
 });
 await sessionTest('an existing meaningful local-draft UUID cannot be certified empty even below capacity',async()=>{
  const original=await scalar('select gen_random_uuid()');await call(original,'create');const fresh=await call(original,'create_empty');
  assert.notEqual(fresh.session.id,original);assert.equal(await scalar('select draft_protected from public.posting_upload_sessions where id=$1',[original]),true);
  assert.equal(fresh.session.draft_protected,false);assert.equal(await activeCount(),2);
 });
 console.log(`PASS ${checks} disposable PostgreSQL checks (fixture helpers; hosted queue not tested)`);
}finally{await db.close();}
