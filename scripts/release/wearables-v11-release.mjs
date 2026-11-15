// Read-only integrity gates used by the existing reusable Supabase release runner.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('../../supabase/forward-migrations/wearables-v11/catalogue-manifest.json',import.meta.url)));
const metadata=`jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,md5(p.prosrc)) order by p.oid) from pg_proc p where p.pronamespace in ('public'::regnamespace,'app_security'::regnamespace)),
 'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c where c.relnamespace='public'::regnamespace),
 'columns',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl,a.attnotnull,a.atttypid) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='public'::regnamespace and a.attnum>0),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgrelid='public.listings'::regclass))`;
function query(exec) {
 const result=JSON.parse(exec(`begin read only;set local statement_timeout='15s';select jsonb_build_object(
 'metadata',${metadata},
 'revision',(select revision from public.wearable_catalogue_revision_v1),
 'digest',(select md5(string_agg(concat_ws('|',id,brand_id,device_type,series,name,status,coalesce(reason,''),source_row,sort_order),E'\n' order by id)) from public.wearable_models_v1),
 'enabled',(select enabled from public.wearable_release_v1),
 'intact',(select count(*)=7 and bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in
 (select to_regclass('public.'||t) from unnest(array['wearable_release_v1','wearable_catalogue_revision_v1','wearable_brands_v1','wearable_models_v1','wearable_session_bindings_v1','listing_wearable_contexts_v1','listing_wearable_risk_flags_v1'])t))
 and not exists(select from pg_attribute c cross join lateral aclexplode(c.attacl)a where c.attrelid in(select to_regclass('public.'||t) from unnest(array['wearable_models_v1','wearable_brands_v1','wearable_catalogue_revision_v1'])t) and a.grantee in(0,(select oid from pg_roles where rolname='anon'),(select oid from pg_roles where rolname='authenticated'),(select oid from pg_roles where rolname='service_role')) and a.privilege_type in('INSERT','UPDATE','REFERENCES'))
 and not exists(select from public.listing_wearable_contexts_v1 c left join public.wearable_models_v1 m on m.id=c.model_id where c.model_id is not null and m.id is null)
 and not exists(select from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a
 where c.relname like '%wearable%v1' and c.relnamespace='public'::regnamespace
 and a.grantee in(0,(select oid from pg_roles where rolname='anon'),(select oid from pg_roles where rolname='authenticated'),(select oid from pg_roles where rolname='service_role'))
 and a.privilege_type in('INSERT','UPDATE','DELETE','TRUNCATE'))
 )::text;commit;`));
 if(!result || result.intact!==true || !result.metadata || typeof result.enabled!=='boolean')throw Error('WEARABLES_V11_INTEGRITY_FAILED');
 return result;
}
export function runWearablesV11Preflight(exec) {
 const before=query(exec);
 if(before.revision!==manifest.oldRevision || before.digest!==manifest.oldDigest)throw Error('WEARABLES_V11_BASELINE_DRIFT');
 return before;
}
export function runWearablesV11Postflight(before,exec) {
 if(!before)throw Error('WEARABLES_V11_PREFLIGHT_REQUIRED');
 const after=query(exec);
 if(after.revision!==manifest.revision || after.digest!==manifest.digest || after.enabled!==before.enabled)throw Error('WEARABLES_V11_CATALOGUE_MISMATCH');
 assert.deepEqual(after.metadata,before.metadata,'WEARABLES_V11_METADATA_CHANGED');
 return {verified:true,revision:after.revision};
}
