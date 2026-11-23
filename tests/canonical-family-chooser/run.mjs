// Disposable PGlite regression; reuses the existing pinned test dependency.
// Review RPC/trigger stubs model availability only, never hosted authorization.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {setupOrdinaryGoodsFixture} from '../ordinary-goods/fixture.mjs';
import {verifyExistingTestLifecycle} from './test-lifecycle.mjs';
import {verifyRemotePostflight} from '../../scripts/release/reusable-supabase-release.mjs';
const require=createRequire(resolve(process.argv[2]??'tests/ratings','package.json'));
const {PGlite}=require('@electric-sql/pglite');
const db=new PGlite();
const migration='supabase/forward-migrations/unified-publishing-v3/supabase/migrations/20261123123000_canonical_family_chooser_v1.sql';
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const slugs=['v2-cars','v2-motorcycles-scooters','v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms'];
const ready=slug=>scalar('select app_security.canonical_family_chooser_v1($1)',[slug]);
let cases=0;
const negative=async(change,slug='v2-cars')=>{
 await db.exec('begin');
 try{await db.exec(change);assert.equal(await ready(slug),false,change);cases++;}
 finally{await db.exec('rollback');}
};
try{
 await setupOrdinaryGoodsFixture(sql=>db.exec(sql));
 // Seed only the existing immutable contract definitions, without executing the
 // historical Production implementation or any of its activation SQL.
 for(const [prefix,key,file] of [
  ['car','cars-draft-v1','20261010064518_car_draft_v1.sql'],
  ['vehicle','two-wheeler-draft-v1','20261009201151_two_wheeler_draft_v1.sql'],
  ['property','property-rental-draft-v1','20261010084523_property_rental_draft_v1.sql'],
 ]){
  const source=readFileSync('supabase/migrations/'+file,'utf8');
  const start=source.indexOf(`'{"key":"${key}"`),end=source.indexOf("'::jsonb",start);
  assert(start>=0&&end>start,'existing definition must be present');
  const definition=JSON.parse(source.slice(start+1,end).replaceAll("''","'"));
  if(prefix==='property')await db.exec(`create table public.property_contract_versions(id uuid primary key,contract_key text);
   create table public.property_category_contracts(category_id uuid,version_id uuid,source_path jsonb,fields jsonb);`);
  await db.exec(`alter table public.${prefix}_contract_versions add column definition jsonb,add column new_assignment_enabled boolean default true;
   alter table public.${prefix}_category_contracts add column definition jsonb;`);
  if(prefix==="vehicle")definition.mappings=definition.mappings.filter(m=>m.leaf!==null&&m.leaf!==undefined);
  const version=await scalar(`insert into public.${prefix}_contract_versions(id,contract_key,definition) values(gen_random_uuid(),$1,$2) returning id`,[key,definition]);
  for(const path of definition.paths){
   const id=await scalar(`insert into public.categories(slug,name,macro_category,is_active,new_listing_enabled) values($1,$2,$3,true,true) returning id`,[path.slug,path.path[2],prefix==='property'?'property':'vehicles']);
   await db.query(`insert into public.${prefix}_category_contracts(category_id,version_id,source_path,fields,definition) values($1,$2,$3,$4,$5)`,[id,version,path.path,path.fields,path]);
  }
 }
 await db.exec(`create table app_security.production_submission_policies(family text,contract_key text,definition_hash text,policy_key text default 'production-family-submission-v1',enabled boolean default true,maintenance boolean default false);
  insert into app_security.production_submission_policies(family,contract_key,definition_hash)
   select 'cars',contract_key,md5(definition::text) from public.car_contract_versions union all
   select 'two-wheelers',contract_key,md5(definition::text) from public.vehicle_contract_versions union all
   select 'property',contract_key,md5(definition::text) from public.property_contract_versions;
  create table public.listing_car_contexts(listing_id uuid);
  create table public.listing_vehicle_contexts(listing_id uuid);
  create table public.listing_property_contexts(listing_id uuid);`);
 await db.exec(`create table app_security.production_submission_permits(listing_id uuid);
  create table app_security.family_review_permits(listing_id uuid);`);
 for(const table of ['public.listing_vehicle_contexts','public.listing_car_contexts','public.listing_property_contexts','app_security.production_submission_policies','app_security.production_submission_permits','app_security.family_review_permits'])
  await db.exec(`alter table ${table} enable row level security;revoke all on ${table} from public,anon;`);
 for(const [name,args] of [['impl_submit_production_family','uuid,integer'],['impl_get_staff_family_review','uuid'],['impl_moderate_family_reviewed','uuid,text,text,integer,text']])
  await db.exec(`create function app_security.${name}(${args}) returns jsonb language sql security definer set search_path='' as $$select '{}'::jsonb$$`);
 for(const [name,args] of [['seller_submit_family_listing','uuid,integer'],['get_seller_production_submission_status','uuid'],['get_staff_family_review','uuid'],['moderate_family_reviewed','uuid,text,text,integer,text']])
  await db.exec(`create function public.${name}(${args}) returns jsonb language sql set search_path='' as $$select '{}'::jsonb$$;
   revoke all on function public.${name}(${args}) from public,anon;grant execute on function public.${name}(${args}) to authenticated;`);
 for(const [name,fn] of [['z_0_production_submission_lifecycle','production_submission_lifecycle'],['z_vehicle_listing_guard','vehicle_listing_guard'],['zz_car_listing_guard','car_listing_guard'],['zzz_property_listing_guard','property_listing_guard']])
  await db.exec(`create function app_security.${fn}() returns trigger language plpgsql security definer set search_path='' as $$begin /* Metadata fixture for family_review_permits; not an authorization implementation. */ return new;end$$;
   create trigger ${name} before insert or update on public.listings for each row execute function app_security.${fn}();`);
 await db.exec(`create function app_security.production_submission_child_change() returns trigger language plpgsql security definer set search_path='' as $$begin return new;end$$;`);
 for(const table of ['listing_media','listing_car_contexts','listing_vehicle_contexts','listing_property_contexts'])
  await db.exec(`create trigger zz_production_submission_child before insert or update on public.${table} for each row execute function app_security.production_submission_child_change();`);
 // Activate exactly the existing reviewed 43 Goods for the preservation regression.
 const goods=JSON.parse(readFileSync('scripts/release/v3-goods-allowlist.json','utf8')).map(g=>g.slug);
 assert.equal(goods.length,43);
 await db.query('update app_security.ordinary_goods_contracts_v3 set enabled=true where slug=any($1)',[goods]);
 await db.query("update public.categories set status='live',is_active=true where slug=any($1)",[goods]);
 assert.equal(await scalar("select count(*)::integer from app_security.ordinary_goods_contracts_v3 where enabled"),43);
 const before=(await scalar('select public.get_category_catalogue_v2()')).nodes;
 await db.exec(readFileSync(migration,'utf8'));
 for(const slug of slugs){assert.equal(await ready(slug),true,slug);cases++;}
 const after=(await scalar('select public.get_category_catalogue_v2()')).nodes;
 assert.deepEqual(after.filter(n=>!slugs.includes(n.slug)),before.filter(n=>!slugs.includes(n.slug)));
 assert.equal(after.filter(n=>slugs.includes(n.slug)&&n.posting_enabled&&n.status==='live').length,5);
 assert.equal(await scalar("select count(*)::integer from public.categories where slug=any($1) and new_listing_enabled",[slugs]),0);
 let postflightSql;
 await verifyRemotePostflight('FairSwapProd','canonical-family-chooser-v1','unused',{},(_cmd,args)=>{
  postflightSql=args.at(-1);return JSON.stringify({environment_lifecycle:true,private_helper:true,no_direct_writes:true,positive_readiness:true});
 });
 const postflight=(await db.exec(postflightSql)).flatMap(r=>r.rows??[])[0].jsonb_build_object;
 assert.deepEqual(postflight,{environment_lifecycle:true,private_helper:true,no_direct_writes:true,positive_readiness:true});
 for(const slug of slugs){
  const categoryId=await scalar('select id from public.categories where slug=$1',[slug]);
  await assert.rejects(()=>db.query('insert into public.listings(category_id,title) values($1,$2)',[categoryId,'Synthetic canonical direct write']));
  assert.equal(await scalar('select app_security.impl_taxonomy_v2_can_post(id) from public.categories where slug=$1',[slug]),false);
  assert.equal(await scalar('select app_security.ordinary_goods_available_v3(id) from public.categories where slug=$1',[slug]),false);
 }
 for(const slug of ['v2-commercial-vehicles','v2-bicycles','v2-other-items','v2-shops-offices','v2-land-plots','v2-warehouses-godowns','v2-dogs','v2-services','v2-jobs'])assert.equal(await ready(slug),false);
 await negative("update app_security.production_submission_policies set enabled=false where family='cars'");
 await negative("update app_security.production_submission_policies set maintenance=true where family='cars'");
 await negative("delete from app_security.production_submission_policies where family='cars'");
 await negative("update app_security.production_submission_policies set contract_key='unsupported' where family='cars'");
 await negative("update public.car_contract_versions set new_assignment_enabled=false");
 await negative("update app_security.production_submission_policies set definition_hash=repeat('0',32) where family='cars'");
 await negative("delete from public.car_category_contracts where category_id=(select id from public.categories where slug='car-sedan')");
 await negative("insert into public.car_category_contracts select * from public.car_category_contracts limit 1");
 await negative("update public.car_contract_versions set definition=definition||'{\"changed\":true}'::jsonb");
 await negative("update public.categories set new_listing_enabled=false where slug='car-sedan'");
 await negative("update public.car_category_contracts set fields='[]'::jsonb where category_id=(select id from public.categories where slug='car-sedan')");
 await negative("alter table public.listings disable trigger z_0_production_submission_lifecycle");
 await negative("alter table public.listing_media disable trigger zz_production_submission_child");
 await negative("drop function public.moderate_family_reviewed(uuid,text,text,integer,text)");
 await negative("grant execute on function public.moderate_family_reviewed(uuid,text,text,integer,text) to anon");
 await negative("alter function app_security.impl_moderate_family_reviewed(uuid,text,text,integer,text) security invoker");
 await negative("alter function app_security.impl_get_staff_family_review(uuid) set search_path=public");
 await negative("drop table app_security.production_submission_policies");
 await negative("alter table app_security.family_review_permits disable row level security");
 await negative("grant select on public.listing_car_contexts to anon");
 await negative("update app_security.ordinary_goods_contracts_v3 set enabled=true where slug='v2-cars'");
 // Each family fails independently; all rental choices fail together on rental drift.
 await db.exec("update app_security.production_submission_policies set enabled=false where family='cars'");
 assert.equal(await ready('v2-motorcycles-scooters'),true);assert.equal(await ready('v2-houses-apartments'),true);
 await negative("update public.property_category_contracts set definition=definition||'{\"sale\":true}'::jsonb",'v2-houses-apartments');
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  await assert.rejects(()=>db.query("select app_security.canonical_family_chooser_v1('v2-cars')"));
  assert.equal((await scalar('select public.get_category_catalogue_v2()')).nodes.length,78);
  await db.exec('reset role');
 }
 console.log(`PASS: 5 positive chooser mappings, ${cases-5} readiness negatives, 43 Goods unchanged, unsupported/direct-write IDs denied.`);
}finally{await db.close();}
await verifyExistingTestLifecycle(PGlite,migration).catch(error=>{console.error('FAIL Test lifecycle:',error.message,error.code,error.detail??'',error.where??'');process.exitCode=1;});
