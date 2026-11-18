// Local-import-safe release verification. No provider/database work runs on import.
import assert from 'node:assert/strict';
import {snapshotSql as foundationSnapshot,verifyTaxonomyTestReceipt} from './taxonomy-v2-release.mjs';
export const CATALOGUE_CANDIDATE='taxonomy-v2-catalogue';
export const CATALOGUE_SCOPE='taxonomy-v2-catalogue-integrity';
export const CONFIGURATION_REVISION='e3013229e6f960c3044bcd4efa79df0e';
const fail=code=>{throw Error('REUSABLE_RELEASE_TAXONOMY_CATALOGUE_'+code);};
const oldCategories="(select md5(coalesce(jsonb_agg(to_jsonb(c)-array['parent_id','status','posting_flow','catalogue_mode','taxonomy_is_root','taxonomy_parent_is_root'] order by c.id),'[]'::jsonb)::text) from public.categories c)";
const newCategories=`(select jsonb_object_agg(c.id,jsonb_build_object('slug',c.slug,
 'stable',md5((to_jsonb(c)-array['parent_id','status','posting_flow','catalogue_mode','taxonomy_is_root','taxonomy_parent_is_root','sort_order'])::text),
 'sort_order',c.sort_order,'parent_id',c.parent_id,'status',c.status,'posting_flow',c.posting_flow,'catalogue_mode',c.catalogue_mode)) from public.categories c)`;
if(!foundationSnapshot.includes(oldCategories))fail('SNAPSHOT_SOURCE_DRIFT');
export const snapshotSql=foundationSnapshot.replace('-- taxonomy-v2-preservation','-- taxonomy-v2-catalogue-preservation')
 .replace(oldCategories,newCategories).replace(" 'installed',",` 'package2Integrity',jsonb_build_object(
  'phoneSessions',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.posting_upload_sessions x),
  'stagedMedia',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.posting_staged_media x),
  'accessoryRelease',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.accessory_release_v1 x),
  'accessoryContexts',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.listing_accessory_contexts x),
  'accessoryTypes',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.accessory_types_v1 x),
  'tabletRelease',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.tablet_release_v1 x),
  'wearableRelease',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.wearable_release_v1 x),
  'wearableRevision',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.wearable_catalogue_revision_v1 x),
  'carVersions',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.car_contract_versions x),
  'bikeVersions',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.vehicle_contract_versions x),
  'rentalVersions',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.property_contract_versions x),
  'attributes',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb)::text) from public.category_attributes x),
  'media',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb)::text) from public.listing_media x),
  'rentals',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.listing_id),'[]'::jsonb)::text) from public.listing_property_contexts x),
  'carContracts',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.car_category_contracts x),
  'bikeContracts',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.vehicle_category_contracts x),
  'rentalContracts',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.property_category_contracts x)),
 'taxonomyRevision',public.get_category_catalogue_v2()->>'taxonomy_revision',
 'managedCount',(select count(*) from public.categories where status is not null),
 'empty',(select count(*)=0 from public.generic_product_brands) and (select count(*)=0 from public.generic_product_models) and (select count(*)=0 from public.listing_generic_product_identity),
 'installed',`);
export const postflightSql=`-- taxonomy-v2-catalogue-postflight
begin read only;
set local statement_timeout='30s';
with canonical as (
 select c.*,e.seed_id,e.parent_slug,e.name expected_name,e.posting_flow expected_flow,e.catalogue_mode expected_mode,e.sort_order expected_order,e.legacy_slug,
  r.slug actual_parent from app_security.impl_taxonomy_v2_expected_nodes() e join public.categories c on c.slug=e.slug left join public.categories r on r.id=c.parent_id
), api as (select public.get_category_catalogue_v2() value)
select jsonb_build_object(
 'nodes',(select count(*)=78 from canonical),'roots',(select count(*)=15 from canonical where parent_id is null),
 'leaves',(select count(*)=63 from canonical where parent_id is not null),
 'modes',(select count(*) filter(where catalogue_mode='brand_model')=35 and count(*) filter(where catalogue_mode='brand_only')=17 and count(*) filter(where catalogue_mode='none')=11 from canonical where parent_id is not null),
 'config',not exists(select 1 from canonical where row(name,posting_flow,catalogue_mode,sort_order,actual_parent) is distinct from row(expected_name,expected_flow,expected_mode,expected_order,parent_slug)
  or (legacy_slug is null and id<>seed_id)),
 'unimplemented',not exists(select 1 from canonical where parent_id is not null and legacy_slug is null and (status<>'coming_soon' or is_active or new_listing_enabled)),
 'specialistGenericClosed',not exists(select 1 from canonical where legacy_slug is not null and new_listing_enabled),
 'rootClosed',not exists(select 1 from canonical where parent_id is null and (new_listing_enabled or posting_flow is not null or catalogue_mode is not null)),
 'servicesJobs',(select count(*)=2 from canonical c where slug in ('v2-services','v2-jobs') and parent_id is null and status='coming_soon' and not exists(select 1 from public.categories x where x.parent_id=c.id)),
 'api',(select value->>'taxonomy_revision'='catalogue-2' and value->>'configuration_revision'='${CONFIGURATION_REVISION}' and jsonb_array_length(value->'nodes')=78 from api),
 'guards',(select count(*)=2 from pg_trigger where tgenabled='O' and not tgisinternal and (
  (tgname='taxonomy_v2_listing_guard' and tgrelid='public.listings'::regclass and tgfoid='app_security.impl_taxonomy_v2_listing_guard()'::regprocedure)
  or (tgname='taxonomy_v2_config_guard' and tgrelid='public.categories'::regclass and tgfoid='app_security.impl_taxonomy_v2_config_guard()'::regprocedure))),
 'privateHelpers',not exists(select 1 from pg_proc where oid in ('app_security.impl_taxonomy_v2_expected_nodes()'::regprocedure,'app_security.impl_taxonomy_v2_can_post(uuid)'::regprocedure,'app_security.impl_taxonomy_v2_config_guard()'::regprocedure)
  and (has_function_privilege('anon',oid,'execute') or has_function_privilege('authenticated',oid,'execute'))),
 'rls',(select count(*)=5 from pg_class where oid in ('public.categories'::regclass,'public.listings'::regclass,'public.generic_product_brands'::regclass,'public.generic_product_models'::regclass,'public.listing_generic_product_identity'::regclass) and relrowsecurity),
 'empty',(select count(*)=0 from public.generic_product_brands) and (select count(*)=0 from public.generic_product_models)
);
commit;`;
const parse=raw=>{try{return JSON.parse(String(raw).trim());}catch{fail('INVALID_RESPONSE');}};
export function readCatalogueSnapshot(query){
 const value=parse(query(snapshotSql));
 if(!value?.installed||!value.categories||typeof value.categories!=='object'||Array.isArray(value.categories)||!value.security||!value.catalogues||!value.package2Integrity||!Number.isInteger(value.managedCount)||typeof value.empty!=='boolean')fail('INVALID_SNAPSHOT');
 return value;
}
export function runCataloguePreflight(query){
 const before=readCatalogueSnapshot(query);
 if(before.managedCount!==0||before.taxonomyRevision!=='foundation-1'||!before.empty)fail('PREREQUISITE_OR_PARTIAL_STATE');
 return before;
}
export function verifyCataloguePostflight(before,after,checks){
 if(!before?.installed||before.managedCount!==0||!before.empty||after?.managedCount!==78||after.taxonomyRevision!=='catalogue-2'||!after.empty)fail('BASELINE_REQUIRED');
 const required=['nodes','roots','leaves','modes','config','unimplemented','specialistGenericClosed','rootClosed','servicesJobs','api','guards','privateHelpers','rls','empty'];
 if(!checks||required.some(k=>checks[k]!==true))fail('POSTFLIGHT_FAILED');
 try{
  const omit=({categories,managedCount,taxonomyRevision,...rest})=>rest;
  assert.deepEqual(omit(after),omit(before));
  assert.equal(Object.keys(after.categories).length,Object.keys(before.categories).length+75);
  const three={'mobile-phones':[101,'specialist:phone'],'tablets':[102,'specialist:tablet'],'wearables':[103,'specialist:wearable']};
  for(const [id,old] of Object.entries(before.categories)){
   const now=after.categories[id];assert(now);assert.equal(now.stable,old.stable);assert.equal(now.slug,old.slug);
   if(three[old.slug]){
    assert.equal(now.sort_order,three[old.slug][0]);assert.equal(now.posting_flow,three[old.slug][1]);assert.equal(now.catalogue_mode,'brand_model');assert(now.parent_id);assert(['live','coming_soon'].includes(now.status));
   }else assert.deepEqual(now,old);
  }
 }catch{fail('PRESERVATION_FAILED');}
 return {status:'PASS',scope:CATALOGUE_SCOPE};
}
export function runCataloguePostflight(before,query){return verifyCataloguePostflight(before,readCatalogueSnapshot(query),parse(query(postflightSql)));}
export function verifyCatalogueTestReceipt(receipt,context){return verifyTaxonomyTestReceipt(receipt,context,CATALOGUE_CANDIDATE,CATALOGUE_SCOPE);}
