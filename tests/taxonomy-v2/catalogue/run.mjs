import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {snapshotSql,postflightSql,verifyCataloguePostflight} from '../../../scripts/release/taxonomy-v2-catalogue-release.mjs';
const MIGRATION='supabase/forward-migrations/taxonomy-v2/catalogue/supabase/migrations/20261118092010_taxonomy_v2_catalogue.sql';
const expected=JSON.parse(readFileSync(new URL('./expected.json',import.meta.url),'utf8'));
const OWNER='11111111-1111-4111-8111-111111111111';
export async function verifyPackage2(db,{read,categoryCount}) {
 let checks=0;
 const q=async sql=>(await db.query(sql)).rows;
 const value=async sql=>Object.values((await q(sql))[0])[0];
 const ok=(label,condition)=>{assert(condition,label);console.log(`ok package2 ${++checks} - ${label}`);};
 const rejects=async(label,sql,code)=>{
  let error;try{await db.exec(sql);}catch(e){error=e;await db.exec('rollback');}
  assert(error,label+' unexpectedly succeeded');if(code)assert.equal(error.code,code,label);ok(label,true);
 };
 // Genuine legacy subtypes/contracts, broad ambiguities and nonempty typed contexts.
 await db.exec('alter table public.listings add column landmark text');
 await db.exec(read('supabase/migrations/20261010084523_property_rental_draft_v1.sql'));
 await db.exec(`delete from public.categories where slug like 'legacy-extra-%';
 insert into public.categories(slug,name,description,is_active,macro_category,new_listing_enabled) values
 ('electronics','Electronics','Phones, computers and gadgets',true,'goods',true),
 ('books','Books','Fiction, textbooks and stationery',true,'goods',true),
 ('tvs-video','TVs & Video','Televisions, projectors and video equipment',true,'goods',true),
 ('audio-home-theatre','Audio & Home Theatre','Headphones, speakers and audio',true,'goods',true),
 ('baby-gear','Baby Gear & Accessories','Excludes car seats',true,'goods',true),
 ('property','Property','Broad property reference',false,'property',false);
 insert into public.category_attributes(category_id,name,label,value_type,is_required,validation_rules)
 select id,'item_type','Item type','text',true,'{"contract":"india_goods_v1","max_length":100}' from public.categories where slug in ('tvs-video','audio-home-theatre','baby-gear');
 insert into public.listings(seller_id,category_id,title,category_attributes)
 select '${OWNER}',id,'Historical ambiguous fixture','{"item_type":"fixture"}' from public.categories where slug in ('electronics','books','tvs-video','audio-home-theatre','baby-gear','property');
 update public.categories set is_active=true where slug in ('mobile-phones','tablets','wearables');
 update public.posting_category_definitions set enabled=true;
 update public.tablet_release_v1 set enabled=true;
 update public.wearable_release_v1 set enabled=${categoryCount===53?'true':'false'};
 update public.categories set is_active=true,new_listing_enabled=true where id in
 (select category_id from public.car_category_contracts union select category_id from public.vehicle_category_contracts union select category_id from public.property_category_contracts);
 update public.car_contract_versions set new_assignment_enabled=true;
 update public.vehicle_contract_versions set new_assignment_enabled=true;
 update public.property_contract_versions set new_assignment_enabled=true;
 select set_config('request.user','${OWNER}',false);
 begin;
 insert into public.listings(id,seller_id,category_id,title)
 select 'dddddddd-0000-4000-8000-000000000001','${OWNER}',category_id,'Historical car fixture' from public.car_category_contracts order by display_order limit 1;
 insert into public.listing_car_contexts(listing_id,category_id,version_id,mode)
 select l.id,l.category_id,c.version_id,'unanswered' from public.listings l join public.car_category_contracts c on c.category_id=l.category_id where l.title='Historical car fixture';
 insert into public.listings(id,seller_id,category_id,title)
 select 'dddddddd-0000-4000-8000-000000000002','${OWNER}',category_id,'Historical motorcycle fixture' from public.vehicle_category_contracts order by display_order limit 1;
 insert into public.listing_vehicle_contexts(listing_id,category_id,version_id,mode)
 select l.id,l.category_id,c.version_id,'unanswered' from public.listings l join public.vehicle_category_contracts c on c.category_id=l.category_id where l.title='Historical motorcycle fixture';
 insert into public.listings(id,seller_id,category_id,title)
 select 'dddddddd-0000-4000-8000-000000000003','${OWNER}',category_id,'Historical rental fixture' from public.property_category_contracts order by display_order limit 1;
 insert into public.listing_property_contexts(listing_id,category_id,version_id,financial)
 select l.id,l.category_id,c.version_id,jsonb_build_object('currency','INR','period','month','rent',jsonb_build_object('state','unanswered'),'basis',coalesce(c.definition->>'basis','advertised_room')) from public.listings l join public.property_category_contracts c on c.category_id=l.category_id where l.title='Historical rental fixture';
 commit;
 insert into public.listings(id,seller_id,category_id,title,price_type,price_paise,condition)
 select 'dddddddd-0000-4000-8000-000000000004','${OWNER}',id,'Historical phone fixture','fixed',1000,'good' from public.categories where slug='mobile-phones';
 insert into public.listing_mobile_contexts(listing_id,category_id,brand_id,model_id,brand_name,model_name,storage)
 select l.id,l.category_id,b.id,m.id,b.name,m.name,'64 GB' from public.listings l cross join public.phone_models m join public.phone_brands b on b.id=m.brand_id where l.title='Historical phone fixture' limit 1;
 insert into public.listings(id,seller_id,category_id,title,price_type,price_paise,condition)
 select 'dddddddd-0000-4000-8000-000000000005','${OWNER}',id,'Historical tablet fixture','fixed',1000,'good' from public.categories where slug='tablets';
 insert into public.listing_tablet_contexts(listing_id,category_id,brand_id,model_id,brand_name,model_name,details,review_required)
 select l.id,l.category_id,b.id,m.id,b.name,m.name,'{"condition":"good","transfer_lock_status":"clear"}',false from public.listings l cross join public.tablet_models_v1 m join public.tablet_brands_v1 b on b.id=m.brand_id where l.title='Historical tablet fixture' limit 1;
 insert into public.posting_upload_sessions(id,owner_id,listing_id) values('dddddddd-0000-4000-8000-000000000016','${OWNER}','dddddddd-0000-4000-8000-000000000006');
 insert into public.wearable_session_bindings_v1(session_id,category_id) select 'dddddddd-0000-4000-8000-000000000016',id from public.categories where slug='wearables';
 insert into public.listings(id,seller_id,category_id,title,price_type,price_paise,condition)
 select 'dddddddd-0000-4000-8000-000000000006','${OWNER}',id,'Historical wearable fixture','fixed',1000,'good' from public.categories where slug='wearables';
 insert into public.listing_wearable_contexts_v1(listing_id,category_id,device_type,brand_id,model_id,brand_name,model_name,other_model,catalogue_revision,pairing_status,transfer_ready,details)
 select l.id,l.category_id,m.device_type,b.id,m.id,b.name,m.name,false,r.revision,'reset_ready',true,'{"condition":"good"}'
 from public.listings l cross join public.wearable_models_v1 m join public.wearable_brands_v1 b on b.id=m.brand_id cross join public.wearable_catalogue_revision_v1 r where l.title='Historical wearable fixture' and m.status='approved' limit 1;
 `);
 const count=await value('select count(*)::int from public.categories');
 assert(count<=categoryCount,`base fixture ${count} exceeds ${categoryCount}`);
 await db.exec(`insert into public.categories(slug,name) select 'p2-extra-'||n,'Inert legacy '||n from generate_series(1,${categoryCount-count}) n`);
 ok('synthetic inventory contains '+categoryCount+' categories',await value('select count(*)::int from public.categories')===categoryCount);
 const tables=['phone_brands','phone_models','tablet_brands_v1','tablet_models_v1','wearable_brands_v1','wearable_models_v1','car_brands','car_models','vehicle_brands','vehicle_models','listing_mobile_contexts','listing_tablet_contexts','listing_wearable_contexts_v1','listing_car_contexts','listing_vehicle_contexts','listing_property_contexts','category_attributes','listing_media','posting_category_definitions','tablet_release_v1','wearable_release_v1','car_category_contracts','vehicle_category_contracts','property_category_contracts','posting_upload_sessions','posting_staged_media','accessory_release_v1','listing_accessory_contexts','accessory_types_v1','car_contract_versions','vehicle_contract_versions','property_contract_versions','wearable_catalogue_revision_v1'];
 const snapshot=async()=>({
  categories:await q('select * from public.categories order by id'),listings:await q('select * from public.listings order by id'),
  rows:await Promise.all(tables.map(async t=>[t,await q(`select * from public.${t} order by to_jsonb(${t})::text`)])),
  functions:await q(`select p.oid,pg_get_functiondef(p.oid) as body,p.proacl,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_security') and p.prokind='f' and p.proname not in ('impl_taxonomy_v2_listing_guard','impl_get_category_catalogue_v2') order by p.oid`),
  security:await q(`select * from pg_policies where schemaname='public' order by tablename,policyname`),
 });
 const releaseValue=async sql=>{const out=await db.exec(sql);return typeof out==='string'?JSON.parse(out):out.find(r=>r.rows?.[0]?.jsonb_build_object)?.rows[0].jsonb_build_object;};
 const releaseBefore=await releaseValue(snapshotSql);
 const before=await snapshot();
 const sql=read(MIGRATION);
 await rejects('deterministic UUID collision fails atomically',`begin;insert into public.categories(id,slug,name) values('${expected[0].seed_id}','seed-id-collision','Unrelated legacy');`+sql,'23505');
 assert.deepEqual(await snapshot(),before);
 await rejects('pre-existing canonical slug conflict fails atomically',`begin;insert into public.categories(slug,name) values('v2-books','Conflicting legacy');`+sql,'P0001');
 assert.deepEqual(await snapshot(),before);
 await rejects('specialist binding/name drift fails atomically',`begin;update public.categories set name='Unreviewed phone meaning' where slug='mobile-phones';`+sql,'P0001');
 assert.deepEqual(await snapshot(),before);
 await rejects('unreviewed managed nodes fail closed',`begin;insert into public.categories(slug,name,status,is_active) values('unreviewed-managed','Unreviewed','coming_soon',false);`+sql,'P0001');
 assert.deepEqual(await snapshot(),before);
 await db.exec(sql);
 const after=await snapshot();
 assert.equal(verifyCataloguePostflight(releaseBefore,await releaseValue(snapshotSql),await releaseValue(postflightSql)).status,'PASS');
 ok('actual release snapshot/postflight SQL preserves contracts and validates the seeded catalogue',true);
 assert.deepEqual(after.listings,before.listings);assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.security,before.security);
 assert.deepEqual(after.functions.filter(f=>before.functions.some(x=>x.oid===f.oid)),before.functions);
 ok('all listing IDs, attributes, media, six typed contexts, catalogues, contracts and RLS preserved',true);
 const bySlug=Object.fromEntries(after.categories.map(c=>[c.slug,c]));
 const canonical=after.categories.filter(c=>c.status!==null);
 ok('exactly 78 canonical nodes; only 75 category rows added',canonical.length===78&&after.categories.length===categoryCount+75);
 for(const node of expected){
  const c=bySlug[node.slug];assert(c,node.slug);
  assert.equal(c.name,node.name);assert.equal(c.posting_flow,node.posting_flow);assert.equal(c.catalogue_mode,node.catalogue_mode);assert.equal(c.sort_order,node.sort_order);
  assert.equal(c.parent_id,node.parent_slug?bySlug[node.parent_slug].id:null);
  if(!node.legacy_slug)assert.equal(c.id,node.seed_id);
 }
 ok('exact labels, order, flows, capabilities and deterministic 75 UUIDs match specification',true);
 ok('15 roots and 63 leaves',canonical.filter(c=>!c.parent_id).length===15&&canonical.filter(c=>c.parent_id).length===63);
 const modes=Object.fromEntries(['brand_model','brand_only','none'].map(mode=>[mode,canonical.filter(c=>c.parent_id&&c.catalogue_mode===mode).length]));
 assert.deepEqual(modes,{brand_model:35,brand_only:17,none:11});ok('35 brand_model, 17 brand_only and 11 none',true);
 for(const c of before.categories){
  const now=bySlug[c.slug];assert.equal(now.id,c.id);
  if(['mobile-phones','tablets','wearables'].includes(c.slug)){
   for(const key of Object.keys(c).filter(k=>!['parent_id','status','posting_flow','catalogue_mode','sort_order','taxonomy_parent_is_root'].includes(k)))assert.deepEqual(now[key],c[key],c.slug+'.'+key);
  }else assert.deepEqual(now,c,c.slug);
 }
 ok('only three proven specialist rows gain metadata; all broad/unknown legacy rows unchanged',true);
 ok('existing generic INSERT flags remain false on specialist categories',['mobile-phones','tablets','wearables'].every(s=>!bySlug[s].new_listing_enabled));
 ok('all unimplemented leaves remain inactive, coming soon and not generically postable',canonical.filter(c=>c.parent_id&&!['mobile-phones','tablets','wearables'].includes(c.slug)).every(c=>c.status==='coming_soon'&&!c.is_active&&!c.new_listing_enabled));
 ok('Services and Jobs are childless coming-soon roots',['v2-services','v2-jobs'].every(s=>bySlug[s].status==='coming_soon'&&!canonical.some(c=>c.parent_id===bySlug[s].id)));
 const review=await db.exec(read('supabase/forward-migrations/taxonomy-v2/catalogue/legacy-review.readonly.sql'));
 const reviewObjects=typeof review==='string'?review.split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)):review.flatMap(x=>x.rows??[]).map(x=>x.jsonb_build_object).filter(Boolean);
 assert.equal(reviewObjects[0].retained_identity_map.length,3);
 assert.equal(reviewObjects[1].legacy_review.length,categoryCount-3);
 assert.deepEqual(reviewObjects[1].legacy_review.map(c=>c.id).sort(),before.categories.filter(c=>!['mobile-phones','tablets','wearables'].includes(c.slug)).map(c=>c.id).sort());
 ok('review manifest explicitly covers every unresolved original category and all three identity mappings',true);
 const api=await value('select public.get_category_catalogue_v2()');
 assert.deepEqual(api.nodes.map(n=>n.slug),expected.map(n=>n.slug));
 ok('public node order exactly matches the specified group/leaf order',true);
 const anon=await db.exec(`begin;set local role anon;select jsonb_build_object('api_count',jsonb_array_length(public.get_category_catalogue_v2()->'nodes'),'old_visible',(select count(*)::int from public.categories where slug='v2-laptops')) as evidence;rollback;`);
 const evidence=typeof anon==='string'?JSON.parse(anon.split('\n').find(x=>x.startsWith('{'))):anon.find(r=>r.rows?.[0]?.evidence)?.rows[0].evidence;
 ok('anonymous V2 reader exposes Coming Soon labels while old category RLS keeps them hidden',evidence.api_count===78&&evidence.old_visible===0);
 ok('reader returns all 78 visible nodes and new revision',api.nodes.length===78&&api.taxonomy_revision==='catalogue-2'&&api.api_version===2&&/^[a-f0-9]{32}$/.test(api.configuration_revision));
 ok('reader hides every unresolved legacy category',api.nodes.every(n=>expected.some(e=>e.slug===n.slug)));
 ok('only genuinely released specialist leaves advertise posting',api.nodes.filter(n=>n.posting_enabled).map(n=>n.slug).sort().join(',')===(categoryCount===53?'mobile-phones,tablets,wearables':'mobile-phones,tablets'));
 ok('parents, pets and Services/Jobs never advertise posting',api.nodes.filter(n=>!n.parent_id||['v2-dogs','v2-other-pets'].includes(n.slug)).every(n=>!n.posting_enabled));
 const five=['v2-tvs','v2-projectors','v2-speakers-home-theatre','v2-cameras-lenses','v2-other-electronics-gadgets'];
 ok('TV/audio/camera leaves have five distinct IDs',new Set(five.map(s=>bySlug[s].id)).size===5);
 await db.exec(sql);assert.deepEqual(await snapshot(),after);
 ok('replaying the complete seed is a no-op on every saved row and contract',true);
 await rejects('replay refuses later activation instead of overwriting it',`begin;update public.categories set status='live',is_active=true,new_listing_enabled=true where slug='v2-laptops';`+sql,'P0001');
 assert.deepEqual(await snapshot(),after);
 const root=bySlug['v2-mobiles-tablets'].id;
 const soon=bySlug['v2-laptops'].id;
 await rejects('privileged root posting denied',`insert into public.listings(seller_id,category_id,title) values('${OWNER}','${root}','Denied root')`,'23514');
 await rejects('privileged Coming Soon posting denied',`insert into public.listings(seller_id,category_id,title) values('${OWNER}','${soon}','Denied upcoming')`,'23514');
 await rejects('live-animal commercial assignment stays unavailable',`insert into public.listings(seller_id,category_id,title) values('${OWNER}','${bySlug['v2-dogs'].id}','Denied pet')`,'23514');
 await rejects('unreviewed canonical rename denied even to direct privileged writer',`update public.categories set name='Changed name' where slug='v2-books'`,'23514');
 await rejects('unreviewed canonical capability change denied',`update public.categories set catalogue_mode='brand_model' where slug='v2-books'`,'23514');
 await rejects('third level rejected by composite self FK',`update public.categories set parent_id='${soon}' where slug='v2-books'`,'23514');
 await rejects('cycle rejected by composite self FK',`update public.categories set parent_id=id,posting_flow='generic',catalogue_mode='none' where slug='v2-other'`,'23514');
 await rejects('generic brand import into specialist leaf denied',`insert into public.generic_product_brands(category_id,name) values('${bySlug['mobile-phones'].id}','Fixture')`,'23514');
 const ownerResult=await db.exec(`begin;set local role authenticated;select set_config('request.user','${OWNER}',true);
 select public.get_seller_listing_category_context('dddddddd-0000-4000-8000-000000000001') as context;rollback;`);
 const context=typeof ownerResult==='string'?JSON.parse(ownerResult.split('\n').find(line=>line.startsWith('{'))):ownerResult.find(r=>r.rows?.[0]?.context)?.rows[0].context;
 assert.equal(context.category.id,before.listings.find(l=>l.title==='Historical car fixture').category_id);
 ok('owner seller-context retains the exact legacy category',true);
 await rejects('ordinary clients cannot update categories',`begin;set local role authenticated;update public.categories set status='live' where slug='v2-dogs';commit;`,'42501');
 await rejects('anonymous cannot update categories',`begin;set local role anon;update public.categories set parent_id=null where slug='v2-books';commit;`,'42501');
 await rejects('private eligibility helper cannot be called by clients',`begin;set local role authenticated;select app_security.impl_taxonomy_v2_can_post('${soon}');commit;`,'42501');
 await db.exec(`update public.listings set title='Historical draft still editable' where id='dddddddd-0000-4000-8000-000000000001'`);
 ok('retained legacy draft editing remains supported',await value("select title from public.listings where id='dddddddd-0000-4000-8000-000000000001'")==='Historical draft still editable');
 for(const [slug,lid] of [['mobile-phones','004'],['tablets','005']]){
  await db.exec(`begin;update public.listings set status='pending_review' where id='dddddddd-0000-4000-8000-000000000${lid}';rollback;`);
  ok(slug+' existing typed context can still enter review with generic flag false',true);
 }
 if(categoryCount===53){await db.exec(`begin;update public.listings set status='pending_review' where id='dddddddd-0000-4000-8000-000000000006';rollback;`);ok('released wearable typed context can still enter review',true);}
 else await rejects('disabled wearable route remains disabled',`update public.listings set status='pending_review' where id='dddddddd-0000-4000-8000-000000000006'`,'23514');
 await rejects('deactivated phone route immediately fails closed',`begin;update public.posting_category_definitions set enabled=false;update public.listings set status='pending_review' where id='dddddddd-0000-4000-8000-000000000004';commit;`,'23514');
 ok('both generic lookup tables remain empty',await value('select count(*)::int from public.generic_product_brands')===0&&await value('select count(*)::int from public.generic_product_models')===0);
 console.log('PASS Package 2: '+checks+' assertions; configuration_revision='+api.configuration_revision);
 return {checks,configurationRevision:api.configuration_revision};
}
