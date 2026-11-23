// Real existing Test-family SQL on disposable PGlite. No Production objects,
// schema copies from Production, new authorization, credentials or network.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setupOrdinaryGoodsFixture} from '../ordinary-goods/fixture.mjs';
import {verifyRemotePostflight} from '../../scripts/release/reusable-supabase-release.mjs';
export async function verifyExistingTestLifecycle(PGlite,migration){
 const db=new PGlite();
 const read=p=>readFileSync(p,'utf8');
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const slugs=['v2-cars','v2-motorcycles-scooters','v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms'];
 const ready=slug=>scalar('select app_security.canonical_family_chooser_v1($1)',[slug]);
 try{
  await setupOrdinaryGoodsFixture(sql=>db.exec(sql),{beforeV3:async()=>{
   // Replace only the shared fixture's empty contract placeholders with the real
   // existing family foundations. This database is new, isolated and disposable.
   await db.exec('drop table public.car_category_contracts,public.vehicle_category_contracts,public.car_contract_versions,public.vehicle_contract_versions');
   for(const file of ['20261009201151_two_wheeler_draft_v1.sql','20261009202059_two_wheeler_catalogue_lookup.sql','20261009203141_two_wheeler_unresolved_mapping_correction.sql','20261010064518_car_draft_v1.sql','20261010084523_property_rental_draft_v1.sql'])
    await db.exec(read('supabase/migrations/'+file));
   await db.exec('drop function app_security.submission_family(uuid,uuid)');
   await db.exec(read('supabase/migrations/20261011092234_test_family_submission_v1.sql'));
   await db.exec(read('supabase/migrations/20261011095100_enable_test_family_submission_v1.sql'));
   await db.exec(read('releases/production/vehicles-property-launch-v1/test-family-review-install.sql'));
   // Existing Test-only assignment activations, never the Production lifecycle.
   for(const file of ['20261009203412_enable_test_two_wheeler_draft_categories.sql','20261010064519_enable_test_car_draft_categories.sql','20261010084524_enable_test_property_rental_drafts.sql'])
    await db.exec(read('supabase/migrations/'+file));
  }});
  // Verify the exact 43 reviewed Goods nodes remain byte-identical in the RPC.
  const goods=JSON.parse(read('scripts/release/v3-goods-allowlist.json')).map(g=>g.slug);
  await db.query('update app_security.ordinary_goods_contracts_v3 set enabled=true where slug=any($1)',[goods]);
  await db.query("update public.categories set status='live',is_active=true where slug=any($1)",[goods]);
  const before=(await scalar('select public.get_category_catalogue_v2()')).nodes;
  const snapshot=async()=>scalar(`select jsonb_build_object(
   'categories',(select jsonb_agg(to_jsonb(c) order by id) from public.categories c),
   'policies',(select jsonb_agg(to_jsonb(p) order by family) from app_security.test_submission_policies p),
   'rls',(select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname in ('public','app_security')),
   'guards',(select jsonb_agg(jsonb_build_array(t.tgname,t.tgrelid,t.tgenabled,pg_get_triggerdef(t.oid)) order by t.oid) from pg_trigger t where not t.tgisinternal),
   'submit',(select pg_get_functiondef('public.seller_submit_listing(uuid,integer)'::regprocedure)),
   'review',(select pg_get_functiondef('app_security.impl_moderate_family_reviewed(uuid,text,text,integer,text)'::regprocedure)))`);
  const securityBefore=await snapshot();
  await db.exec(read(migration));
  assert.deepEqual(await snapshot(),securityBefore,'chooser migration must not alter existing authorization or categories');
  assert.equal(await scalar("select to_regclass('app_security.production_submission_policies') is null and to_regprocedure('public.seller_submit_family_listing(uuid,integer)') is null"),true);
  for(const slug of slugs)assert.equal(await ready(slug),true,'Test readiness: '+slug);
  const after=(await scalar('select public.get_category_catalogue_v2()')).nodes;
  assert.deepEqual(after.filter(n=>!slugs.includes(n.slug)),before.filter(n=>!slugs.includes(n.slug)));
  for(const slug of slugs){
   const node=after.find(n=>n.slug===slug);assert.equal(node.posting_enabled,true);assert.equal(node.status,'live');
   await assert.rejects(()=>db.query('insert into public.listings(category_id,title) values($1,$2)',[node.id,'Synthetic canonical direct write']));
  }
  let sql;
  await verifyRemotePostflight('FairSwapTest','canonical-family-chooser-v1','unused',{},(_cmd,args)=>{
   sql=args.at(-1);return JSON.stringify({environment_lifecycle:true,private_helper:true,no_direct_writes:true,positive_readiness:true});
  });
  const postflight=async()=> (await db.exec(sql)).flatMap(r=>r.rows??[])[0].jsonb_build_object;
  assert.deepEqual(await postflight(),{environment_lifecycle:true,private_helper:true,no_direct_writes:true,positive_readiness:true});
  const negative=async(change,slug='v2-cars')=>{
   await db.exec('begin');try{await db.exec(change);assert.equal(await ready(slug),false,change);}finally{await db.exec('rollback');}
  };
  await negative("update app_security.test_submission_policies set enabled=false where family='cars'");
  await negative("update app_security.test_submission_policies set maintenance=true where family='cars'");
  await negative('alter table public.listings disable trigger z_0_test_submission_lifecycle');
  await negative('alter table public.listing_car_contexts disable trigger zz_test_submission_child');
  await negative('drop table app_security.family_review_permits');
  await negative('grant execute on function public.moderate_family_reviewed(uuid,text,text,integer,text) to anon');
  await negative("alter function app_security.impl_moderate_family_reviewed(uuid,text,text,integer,text) security invoker");
  // A stray Production marker is never permission to ignore missing Production safeguards.
  await negative("create table app_security.production_submission_policies(family text)");
  // An all-disabled result cannot pass postflight simply by agreeing with itself.
  await db.exec('update app_security.test_submission_policies set enabled=false');
  assert.equal((await postflight()).positive_readiness,false);
  await db.exec('update app_security.test_submission_policies set enabled=true');
  // Existing public RPC authorization is exercised, not bypassed to get positive readiness.
  for(const role of ['anon','authenticated']){
   await db.exec('set role '+role);
   await assert.rejects(()=>db.query("select public.seller_submit_listing(gen_random_uuid(),1)"));
   await assert.rejects(()=>db.query("select public.moderate_family_reviewed(gen_random_uuid(),'approve',null,1,repeat('0',64))"));
   await assert.rejects(()=>db.query("select app_security.canonical_family_chooser_v1('v2-cars')"));
   await db.exec('reset role');
  }
  console.log('PASS: existing Test lifecycle only; 5 positive mappings, positive postflight, readiness/security negatives, 43 Goods and authorization unchanged.');
 }finally{await db.close();}
}
