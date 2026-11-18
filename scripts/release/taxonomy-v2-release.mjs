// Candidate-only read verification. Snapshots contain digests/counts, never listing rows.
// Invoked by the existing release runner; importing this module performs no I/O.
import assert from 'node:assert/strict';
import {getCandidate,PROJECT_REFS} from './reusable-candidates.mjs';
export const TAXONOMY_CANDIDATE='taxonomy-v2-foundation';
export const TAXONOMY_SCOPE='taxonomy-v2-foundation-integrity';
const fail=code=>{throw Error(`REUSABLE_RELEASE_TAXONOMY_${code}`);};
const newTables=['generic_product_brands','generic_product_models','listing_generic_product_identity'];
const excludedTables=newTables.map(x=>`'${x}'`).join(',');
const catalogueTables=['phone_brands','phone_models','tablet_brands_v1','tablet_models_v1','wearable_brands_v1','wearable_models_v1','car_brands','car_models','vehicle_brands','vehicle_models',
 'listing_mobile_contexts','listing_tablet_contexts','listing_wearable_contexts_v1','listing_car_contexts','listing_vehicle_contexts','posting_category_definitions'];
const fingerprints=catalogueTables.map(t=>`'${t}',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) from public.${t} x)`).join(',');
export const snapshotSql=`-- taxonomy-v2-preservation
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
select jsonb_build_object(
 'categories',(select md5(coalesce(jsonb_agg(to_jsonb(c)-array['parent_id','status','posting_flow','catalogue_mode','taxonomy_is_root','taxonomy_parent_is_root'] order by c.id),'[]'::jsonb)::text) from public.categories c),
 'listings',(select md5(coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb)::text) from public.listings l),
 'catalogues',jsonb_build_object(${fingerprints}),
 'security',jsonb_build_object(
  'tables',(select jsonb_agg(jsonb_build_array(c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.relname)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname not in (${excludedTables})),
  'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where p.schemaname='public' and p.tablename not in (${excludedTables})),
  'columnGrants',(select jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl::text) order by c.relname,a.attname)
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname not in (${excludedTables}) and a.attnum>0 and not a.attisdropped
    and not (c.relname='categories' and a.attname=any(array['parent_id','status','posting_flow','catalogue_mode','taxonomy_is_root','taxonomy_parent_is_root']))),
  'functions',(select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text,p.proowner) order by p.oid)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_security') and p.prokind='f'
    and p.proname not like 'impl_taxonomy_v2_%' and p.proname not in ('impl_get_category_catalogue_v2','get_category_catalogue_v2')),
  'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and not t.tgisinternal and c.relname not in (${excludedTables}) and t.tgname not like 'taxonomy_v2_%')),
 'installed',to_regclass('public.generic_product_brands') is not null or to_regclass('public.generic_product_models') is not null
  or to_regclass('public.listing_generic_product_identity') is not null
  or exists(select 1 from information_schema.columns where table_schema='public' and table_name='categories' and column_name='status')
);
COMMIT;`;
export const postflightSql=`-- taxonomy-v2-postflight
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
select jsonb_build_object(
 'empty',(select count(*)=0 from public.generic_product_brands) and (select count(*)=0 from public.generic_product_models) and (select count(*)=0 from public.listing_generic_product_identity),
 'legacy',(select count(*)=0 from public.categories where status is not null or parent_id is not null or posting_flow is not null or catalogue_mode is not null),
 'rls',(select count(*)=3 from pg_class where oid in ('public.generic_product_brands'::regclass,'public.generic_product_models'::regclass,'public.listing_generic_product_identity'::regclass) and relrowsecurity and relforcerowsecurity),
 'lookupReadOnly',not has_table_privilege('authenticated','public.generic_product_brands','INSERT,UPDATE,DELETE,TRUNCATE') and not has_table_privilege('anon','public.generic_product_brands','INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('authenticated','public.generic_product_models','INSERT,UPDATE,DELETE,TRUNCATE') and not has_table_privilege('anon','public.generic_product_models','INSERT,UPDATE,DELETE,TRUNCATE'),
 'identityGrants',not has_table_privilege('anon','public.listing_generic_product_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_column_privilege('authenticated','public.listing_generic_product_identity','created_at','UPDATE')
  and not has_column_privilege('authenticated','public.listing_generic_product_identity','listing_id','UPDATE'),
 'api',public.get_category_catalogue_v2()->>'api_version'='2' and public.get_category_catalogue_v2()->>'taxonomy_revision'='foundation-1' and public.get_category_catalogue_v2()->'nodes'='[]'::jsonb,
 'depthFK',exists(select 1 from pg_constraint where conrelid='public.categories'::regclass and conname='categories_taxonomy_parent_fk' and contype='f' and convalidated),
 'listingGuard',exists(select 1 from pg_trigger where tgrelid='public.listings'::regclass and tgname='taxonomy_v2_listing_guard' and tgenabled='O' and not tgisinternal)
);
COMMIT;`;
const parse=raw=>{try{return JSON.parse(String(raw).trim());}catch{fail('INVALID_RESPONSE');}};
export function readTaxonomySnapshot(query) {
 const value=parse(query(snapshotSql));
 if(!value || typeof value.installed!=='boolean' || !value.security || !value.catalogues ||
  !/^[a-f0-9]{32}$/.test(value.categories??'') || !/^[a-f0-9]{32}$/.test(value.listings??'') ||
  catalogueTables.some(t=>!/^[a-f0-9]{32}$/.test(value.catalogues[t]??''))) fail('INVALID_SNAPSHOT');
 return value;
}
export function runTaxonomyPreflight(query) {
 const before=readTaxonomySnapshot(query);
 if(before.installed) fail('PARTIAL_OR_EXISTING_STATE');
 return before;
}
export function verifyTaxonomyPostflight(before,after,checks) {
 if(!before || before.installed || !after?.installed) fail('BASELINE_REQUIRED');
 try {assert.deepEqual({...after,installed:false},before);}catch{fail('PRESERVATION_FAILED');}
 const keys=['empty','legacy','rls','lookupReadOnly','identityGrants','api','depthFK','listingGuard'];
 if(!checks || keys.some(key=>checks[key]!==true)) fail('POSTFLIGHT_FAILED');
 return {status:'PASS',scope:TAXONOMY_SCOPE};
}
export function runTaxonomyPostflight(before,query) {
 return verifyTaxonomyPostflight(before,readTaxonomySnapshot(query),parse(query(postflightSql)));
}
export function verifyTaxonomyTestReceipt(receipt,context,candidateId=TAXONOMY_CANDIDATE,scope=TAXONOMY_SCOPE) {
 const c=getCandidate(candidateId);
 if(!/^[a-f0-9]{40}$/.test(context.GITHUB_SHA??'') || !/^[1-9]\d*$/.test(context.GITHUB_RUN_ID??'') || !/^[1-9]\d*$/.test(context.GITHUB_RUN_ATTEMPT??'') ||
  receipt?.environment!=='FairSwapTest' || receipt.projectRef!==PROJECT_REFS.FairSwapTest || receipt.candidateId!==c.id || receipt.migrationVersion!==c.version || receipt.migrationFile!==c.filename ||
  receipt.migrationSha256!==c.sha256 || receipt.reviewedCommit!==context.GITHUB_SHA || receipt.releaseWorkflowRun!==context.GITHUB_RUN_ID || receipt.releaseWorkflowAttempt!==context.GITHUB_RUN_ATTEMPT ||
  receipt.status!=='APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' || receipt.postflightVerified!==true || receipt.postflightScope!==scope ||
  !Array.isArray(receipt.dryRunPending) || receipt.dryRunPending.length!==1 || receipt.dryRunPending[0]!==c.filename || !/^[a-f0-9]{64}$/.test(receipt.ledgerStatementsSha256??'')) fail('TEST_RECEIPT_INVALID');
 return receipt.ledgerStatementsSha256;
}
