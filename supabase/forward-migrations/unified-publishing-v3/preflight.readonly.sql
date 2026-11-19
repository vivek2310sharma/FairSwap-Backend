-- Read-only foundation preflight. This is NOT a migration or activation file.
-- Expected current inventory: 15 roots, 63 leaves, three specialist contracts.
with catalogue as (
 select public.get_category_catalogue_v2() as value
), nodes as (
 select n.* from catalogue c cross join lateral pg_catalog.jsonb_to_recordset(c.value->'nodes')
 as n(id uuid,parent_id uuid,slug text,status text,posting_enabled boolean)
)
select pg_catalog.jsonb_build_object(
 'configuration_revision',(select value->>'configuration_revision' from catalogue),
 'roots',(select count(*) from nodes where parent_id is null),
 'leaves',(select count(*) from nodes where parent_id is not null),
 'posting_slugs',(select pg_catalog.jsonb_agg(slug order by slug) from nodes where posting_enabled),
 'services_jobs_disabled',(select count(*)=2 and not pg_catalog.bool_or(posting_enabled)
   from nodes where slug in ('v2-services','v2-jobs') and parent_id is null and status='coming_soon'),
 'no_unverified_leaf_enabled',not exists(select 1 from nodes
   where parent_id is not null and slug not in ('mobile-phones','tablets','wearables') and posting_enabled),
 'no_generic_specialist_insert',not exists(select 1 from public.categories
   where slug in ('mobile-phones','tablets','wearables') and new_listing_enabled),
 'media_buckets_private',(select count(*)=3 and not pg_catalog.bool_or(public)
   from storage.buckets where id in ('posting-staged','listing-originals','listing-derivatives')),
 'listing_guard_enabled',exists(select 1 from pg_catalog.pg_trigger t
   where t.tgrelid='public.listings'::regclass and not t.tgisinternal and t.tgenabled='O'
    and t.tgfoid='app_security.impl_taxonomy_v2_listing_guard()'::regprocedure)
) as unified_publishing_v3_preflight;
