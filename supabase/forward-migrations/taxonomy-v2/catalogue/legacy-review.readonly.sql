-- Review only; no automatic listing reassignment or legacy retirement.
-- Run locally on fixtures, or later by the authorized release owner. Codex does
-- not run this against hosted environments. Contains category IDs/counts only.
begin read only;
set local statement_timeout='30s';
select jsonb_build_object('retained_identity_map',jsonb_agg(jsonb_build_object(
 'slug',e.slug,'actual_id',c.id,'deterministic_fallback_id',e.seed_id,
 'decision','retain_existing_specialist_uuid','reference_updates',0) order by e.sort_order))
from app_security.impl_taxonomy_v2_expected_nodes() e join public.categories c on c.slug=e.slug where e.legacy_slug is not null;
select jsonb_build_object('legacy_review',coalesce(jsonb_agg(jsonb_build_object(
 'id',c.id,'slug',c.slug,'name',c.name,'is_active',c.is_active,'new_listing_enabled',c.new_listing_enabled,
 'listing_reference_count',(select count(*) from public.listings l where l.category_id=c.id),
 'decision',case when exists(select 1 from public.car_category_contracts x where x.category_id=c.id)
  or exists(select 1 from public.vehicle_category_contracts x where x.category_id=c.id)
  or exists(select 1 from public.property_category_contracts x where x.category_id=c.id)
  then 'retain_versioned_specialist_subtype' else 'retain_ambiguous_or_unreviewed_legacy' end,
 'v2_visibility','hidden_from_v2_reader','compatibility_flags','unchanged','listing_reclassification','none') order by c.slug),'[]'::jsonb))
from public.categories c where not exists(select 1 from app_security.impl_taxonomy_v2_expected_nodes() e where e.slug=c.slug);
commit;
