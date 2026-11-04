// Disposable in-memory PostgreSQL or a fresh native Unix socket fixture. Supporting auth/storage fixture helpers are substitutes.
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {openTabletPg17} from './tablets-local-pg17.mjs';
import {installPostingFixture} from './posting-v2-fixture.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(resolve(process.argv[2]??'../FairSwap-Web','package.json'));
const v2=process.argv.includes('--with-v2');
const nativeBin=process.argv.find(arg=>arg.startsWith('--native-bin='))?.slice('--native-bin='.length);
const db=nativeBin?await openTabletPg17(nativeBin,require('pg')):new (require('@electric-sql/pglite').PGlite)();
let count=0;
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const test=async(label,fn)=>{await fn();console.log(`PASS ${++count}: ${label}`);};
const reject=(sql,args=[])=>assert.rejects(()=>db.query(sql,args));
try{
 await installPostingFixture(db);
 await db.exec('grant select on public.listings to anon,authenticated');
 await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql'),'utf8'));
 if(process.argv.includes('--with-accessories'))await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql'),'utf8'));
 const dir=resolve(root,'supabase/forward-migrations/tablets-v1/supabase/migrations');await db.exec(readFileSync(resolve(dir,readdirSync(dir).find(f=>f.endsWith('.sql'))),'utf8'));
 const u='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333',media='44444444-4444-4444-8444-444444444444',city='55555555-5555-4555-8555-555555555555',locality='66666666-6666-4666-8666-666666666666';
 await db.query('insert into auth.users values($1),($2)',[u,other]);await db.query(`select set_config('request.user',$1,false)`,[u]);
 await test('tablets default disabled',async()=>assert.equal(await scalar('select enabled from public.tablet_release_v1'),false));
 await test('disabled tablet session fails closed',()=>reject(`select public.tablet_v1_session($1,'create')`,[session]));
 await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql'),'utf8'));
 await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/tablets-v1/activation/supabase/migrations/20261102170611_activate_tablets_v1.sql'),'utf8')); 
 if(v2){
  const dir=resolve(root,'supabase/forward-migrations/tablets-v2/supabase/migrations');
  const migration=readFileSync(resolve(dir,readdirSync(dir).find(file=>file.endsWith('.sql'))),'utf8');
  const ids=async table=>(await db.query(`select id from public.${table} order by id`)).rows.map(row=>row.id);
  const installed=await ids('tablet_models_v1');
  const installedBrands=await ids('tablet_brands_v1');
  const functionContracts=async()=>(await db.query(`
   select oid,proname,proacl,proowner,prosecdef,proconfig from pg_proc
   where proname in ('validate_tablet_v1','impl_submit_tablet_v1','submit_tablet_v1','tablets_v1_catalogue') order by oid
  `)).rows;
  const originalContracts=await functionContracts();
  await test('V2 migration preserves V1 UUIDs, execution contracts and release gate',async()=>{
   await db.exec(migration);
   const modelIds=await ids('tablet_models_v1'),brandIds=await ids('tablet_brands_v1');
   assert.ok(installed.every(id=>modelIds.includes(id)));
   assert.ok(installedBrands.every(id=>brandIds.includes(id)));
   assert.deepEqual(await functionContracts(),originalContracts);
   assert.equal(await scalar('select enabled from public.tablet_release_v1'),true);
  });
  await test('V2 migration is rerun-safe and every brand has one Other model',async()=>{
   const models=await ids('tablet_models_v1'),brands=await ids('tablet_brands_v1');
   await db.exec(migration);
   assert.deepEqual(await ids('tablet_models_v1'),models);
   assert.deepEqual(await ids('tablet_brands_v1'),brands);
   assert.equal(await scalar(`select count(*)::int from public.tablet_brands_v1 b
    where (select count(*) from public.tablet_models_v1 m where m.brand_id=b.id and m.other)<>1`),0);
   assert.equal(await scalar(`select count(*)::int from public.tablet_models_v1 m
    join public.tablet_brands_v1 b on b.id=m.brand_id where b.name='Other' and not m.other`),0);
   const catalogue=await scalar('select public.tablets_v1_catalogue()');
   assert.equal(catalogue.brands.at(-1).name,'Other');
   for(const brand of catalogue.brands)assert.equal(catalogue.models.filter(model=>model.brand_id===brand.id).at(-1).other,true);
   const serialized=JSON.stringify(catalogue);
   console.log(`Catalogue: ${brands.length} brands, ${models.length} models, ${Buffer.byteLength(serialized)} bytes (${gzipSync(serialized).length} gzip)`);
  });
 }
 await test('five new tables enforce forced RLS',async()=>assert.equal(await scalar(`select count(*)::int from pg_class where relname in ('tablet_release_v1','tablet_brands_v1','tablet_models_v1','tablet_session_bindings_v1','listing_tablet_contexts') and relrowsecurity and relforcerowsecurity`),5));
 await test('anonymous cannot submit or acquire sessions',async()=>{await db.exec('set role anon');await reject(`select public.tablet_v1_session($1,'create')`,[session]);await reject(`select public.submit_tablet_v1('{}')`);await db.exec('reset role');});
 await test('clients cannot modify contexts, catalogue or binding',async()=>{for(const t of ['listing_tablet_contexts','tablet_models_v1','tablet_session_bindings_v1'])assert.equal(await scalar(`select has_table_privilege('authenticated',$1,'INSERT')`,['public.'+t]),false);});
 const phone='77777777-7777-4777-8777-777777777777';await scalar(`select public.posting_v2_session($1,'create')`,[phone]);
 await test('phone session cannot be rebound to tablets',()=>reject(`select public.tablet_v1_session($1,'create')`,[phone]));
 let snapshot=await scalar(`select public.tablet_v1_session($1,'create')`,[session]);
 await test('same tablet session retries reuse identity',async()=>assert.equal((await scalar(`select public.tablet_v1_session($1,'create')`,[session])).session.id,session));
 await db.query(`select set_config('request.user',$1,false)`,[other]);await test('cross-owner session recovery denied',()=>reject(`select public.tablet_v1_session($1,'read')`,[session]));await db.query(`select set_config('request.user',$1,false)`,[u]);
 await test('policy and suspended account denied',async()=>{for(const [key,val] of [['request.policy','false'],['request.account','suspended']]){await db.query('select set_config($1,$2,false)',[key,val]);await reject(`select public.tablet_v1_session($1,'read')`,[session]);await db.query('select set_config($1,$2,false)',[key,key==='request.policy'?'true':'active']);}});
 const m=(await db.query(`select m.id,m.brand_id from public.tablet_models_v1 m where name='iPad (9th generation)'`)).rows[0];
 await db.query('insert into public.cities values($1,true)',[city]);await db.query('insert into public.localities values($1,$2,true)',[locality,city]);await db.query(`insert into public.postal_pincode_localities values('560034',$1)`,[locality]);
 const p={selection:{category:'mobiles',subcategory:'tablets',version:1},session_id:session,brand_id:m.brand_id,model_id:m.id,other_model:'',storage:'64 GB',connectivity:'wifi',ram:'',colour:'',hardware_model_number:'A2602',condition:'good',screen_touch_status:'working',battery_charging_status:'normal',transfer_lock_status:'clear',powers_on:'yes',repair_history:'none',other_defects:'',included:[],stylus_description:'',keyboard_description:'',warranty_until:'',title:'iPad 9th generation 64 GB Wi-Fi',description:'Carefully used tablet with no repairs.',trade:'sell',price_paise:1000000,negotiable:false,pin_code:'560034',city_id:city,locality_id:locality,media_ids:[media],plan_id:'free-v1'};
 await test('recovery choices include only tablet-bound sessions',async()=>{const r=await scalar("select public.tablet_v1_session(null,'list_recovery')");assert.deepEqual(r.sessions.map(s=>s.id),[session]);});
 const valid=(v)=>db.query('select app_security.validate_tablet_v1($1::jsonb)',[JSON.stringify(v)]);
 await test('valid tablet contract',()=>valid(p));
 await test('locks, forged specs, identifiers and scams rejected',async()=>{for(const patch of [{transfer_lock_status:'locked'},{transfer_lock_status:'unknown'},{connectivity:v2?'bogus':'five_g'},{storage:v2?'9000 MB':'2 TB'},{serial:'secret'},{hardware_model_number:'123456789012345'},{description:'Pay courier fee before pickup'},{description:'Pay an advance to reserve'},{description:'contact seller@okaxis'},{description:'serial: ABC123456789'},{condition:'poor'},{powers_on:'no'},{included:['Under warranty']},{screen_touch_status:'fault'}])await assert.rejects(()=>valid({...p,...patch}));});
 if(v2)await test('cached V1 and V2 use global specs and reject forged additive fields',async()=>{
  await valid({...p,storage:'2 TB',connectivity:'five_g'});
  await valid({...p,other_brand:'',storage:'Not sure',storage_other:'8 GB',ram_other:'1 GB',connectivity:'unknown',connectivity_other:'Wi-Fi + 3G'});
  const fallbacks=(await db.query(`select b.name, b.id brand_id, m.id model_id from public.tablet_models_v1 m join public.tablet_brands_v1 b on b.id=m.brand_id where m.other`)).rows;
  for(const {name,...pair} of fallbacks)await valid({...p,...pair,other_brand:name==='Other'?'Example':'',other_model:'Legacy Tab'});
  const {name:otherName,...pair}=fallbacks.find(row=>row.name==='Other');
  assert.equal(otherName,'Other');
  const unknown={...p,...pair,other_model:'Legacy Tab'};
  await valid(unknown);
  for(const patch of [{other_brand:''},{other_brand:'x'},{other_brand:'x'.repeat(101)},{other_brand:'123456789012345'},{other_brand:'password: mysecret'},{other_brand:'Example',other_model:'x'},{other_brand:'Example',other_model:'x'.repeat(101)},{other_brand:'Example',model_id:p.model_id}])await assert.rejects(()=>valid({...unknown,...patch}));
  for(const patch of [{other_brand:'Example'},{other_brand:null},{storage_other:'8 GB'},{other_brand:'',storage_other:'8 GB'},{other_brand:'',connectivity:'unknown',connectivity_other:'https://paytm.me/scam'},{other_brand:'',ram_other:'2TB'}])await assert.rejects(()=>valid({...p,...patch}));
 });
 await test('phone contract cannot finalize tablet session',()=>reject(`select app_security.impl_submit_mobile_v2($1::jsonb)`,[JSON.stringify({...p,selection:{category:'mobiles',subcategory:'mobile-phones',version:2}})]));
 snapshot=await scalar(`select public.posting_v2_session($1,'reserve',$2)`,[session,media]);await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`);await scalar(`select public.posting_v2_media_ready($1,$2,$3,1000,800,600)`,[session,media,snapshot.media[0].attempt]);await db.exec(`select set_config('request.jwt','{}',false)`);snapshot=await scalar(`select public.posting_v2_session($1,'prepare')`,[session]);
 await test('missing prepared storage rolls back',async()=>{await reject(`select public.submit_tablet_v1($1::jsonb)`,[JSON.stringify(p)]);assert.equal(await scalar('select count(*)::int from public.listings'),0);});
 for(const n of ['original','thumb','medium','large'])await db.query('insert into storage.objects values($1,$2)',[n==='original'?'listing-originals':'listing-derivatives',`${snapshot.session.listing_id}/${media}/${n}.webp`]);
 await test('invalid PIN and duplicate or cross-session media rejected',async()=>{for(const patch of [{pin_code:'110001'},{media_ids:[media,media]},{media_ids:[phone]},{session_id:phone}])await reject(`select public.submit_tablet_v1($1::jsonb)`,[JSON.stringify({...p,...patch})]);});
 await test('atomic submission and lost-response retry create one listing',async()=>{for(let i=0;i<2;i++)assert.equal((await scalar(`select public.submit_tablet_v1($1::jsonb)`,[JSON.stringify(p)])).success,true);assert.equal(await scalar('select count(*)::int from public.listings'),1);assert.equal(await scalar('select status::text from public.listings'),'pending_review');});
 await test('owner can read approved fields but cannot mutate context or read private review flags',async()=>{await db.exec('set role authenticated');assert.equal(await scalar('select count(listing_id)::int from public.listing_tablet_contexts'),1);await reject("update public.listing_tablet_contexts set details='{}'");await reject('delete from public.listing_tablet_contexts');await reject('select review_required from public.listing_tablet_contexts');await db.exec('reset role');});
 await test('public projection excludes session, media and location identifiers',async()=>{const d=await scalar('select details from public.listing_tablet_contexts');for(const k of ['session_id','pin_code','city_id','locality_id','media_ids','serial','imei'])assert.equal(k in d,false);});
 await test('condition and category cannot drift on legacy edits',async()=>{await reject(`update public.listings set condition='fair'`);await reject(`update public.listings set description='serial: AB1234567890'`);await reject(`update public.listings set category_id=(select listing_category_id from public.posting_category_definitions)`);});
 await db.exec("select set_config('request.user','',false);set role anon");await test('unpublished context hidden from anonymous buyers',async()=>assert.equal(await scalar('select count(listing_id)::int from public.listing_tablet_contexts'),0));await db.exec('reset role');
 await db.query(`select set_config('request.user',$1,false)`,[other]);await db.exec('set role authenticated');await test('other seller cannot see unpublished context',async()=>assert.equal(await scalar('select count(listing_id)::int from public.listing_tablet_contexts'),0));await db.exec('reset role');
 await db.exec("create or replace function app_security.is_listing_publicly_visible(uuid) returns boolean language sql stable as $$select exists(select 1 from public.listings where id=$1 and status='active')$$;update public.listings set status='active';select set_config('request.user','',false);set role anon");
 await test('approved public tablet exposes only the permitted buyer projection',async()=>{assert.equal(await scalar('select count(listing_id)::int from public.listing_tablet_contexts'),1);await reject('select review_required from public.listing_tablet_contexts');});await db.exec('reset role');
 if(v2)await test('typed Other brand is stored with its canonical IDs and needs staff approval',async()=>{
  await db.query("select set_config('request.user',$1,false)",[u]);
  const newSession='33333333-3333-4333-8333-333333333334',newMedia='44444444-4444-4444-8444-444444444445';
  await scalar("select public.tablet_v1_session($1,'create')",[newSession]);
  const reserved=await scalar("select public.posting_v2_session($1,'reserve',$2)",[newSession,newMedia]);
  await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`);
  await scalar("select public.posting_v2_media_ready($1,$2,$3,1000,800,600)",[newSession,newMedia,reserved.media[0].attempt]);
  await db.exec(`select set_config('request.jwt','{}',false)`);
  const prepared=await scalar("select public.posting_v2_session($1,'prepare')",[newSession]);
  for(const n of ['original','thumb','medium','large'])await db.query('insert into storage.objects values($1,$2)',[n==='original'?'listing-originals':'listing-derivatives',`${prepared.session.listing_id}/${newMedia}/${n}.webp`]);
  const pair=(await db.query(`select b.id brand_id,m.id model_id from public.tablet_models_v1 m join public.tablet_brands_v1 b on b.id=m.brand_id where b.name='Other' and m.other`)).rows[0];
  const payload={...p,...pair,session_id:newSession,media_ids:[newMedia],other_brand:' Example ',other_model:' Legacy Tab ',storage:'Not sure',storage_other:' 8 GB ',connectivity:'unknown',connectivity_other:'Wi-Fi + 3G',ram_other:'1 GB'};
  const submitSql='select public.submit_tablet_v1($1::jsonb) as result';
  const args=[JSON.stringify(payload)];
  let result;
  if(db.newConnection){
   const peer=await db.newConnection();
   try{
    await peer.query("select set_config('request.user',$1,false)",[u]);
    const [a,b]=await Promise.all([scalar(submitSql,args),peer.query(submitSql,args)]);
    result=a;
    assert.deepEqual(b.rows[0].result,a);
   }finally{await peer.end();}
  }else result=await scalar(submitSql,args);
  assert.equal(result.success,true);
  assert.equal(await scalar('select count(*)::int from public.listing_tablet_contexts where listing_id=$1',[result.listing_id]),1);
  const [row]=(await db.query('select * from public.listing_tablet_contexts where listing_id=$1',[result.listing_id])).rows;
  assert.equal(row.brand_name,'Example');
  assert.equal(row.model_name,'Legacy Tab');
  assert.equal(row.brand_id,pair.brand_id);
  assert.equal(row.model_id,pair.model_id);
  assert.equal(row.review_required,true);
  assert.equal(row.details.storage_other,'8 GB');
  assert.equal(row.details.ram_other,'1 GB');
  assert.equal(row.details.connectivity_other,'Wi-Fi + 3G');
  assert.equal('other_brand' in row.details,false);
  await reject("update public.listings set status='active' where id=$1",[result.listing_id]);
  await db.exec("select set_config('request.user','',false);set role anon");
  assert.equal(await scalar('select count(listing_id)::int from public.listing_tablet_contexts where listing_id=$1',[result.listing_id]),0);
  await db.exec('reset role');
 });
 console.log(`${count} tablet SQL checks passed (${db.version??"PGlite"}, fixture auth/storage helpers).`);
}finally{await db.close();}
