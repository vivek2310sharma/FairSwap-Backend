-- Operator rollback step, not a migration and not part of an automatic batch.
-- Keep category IDs, definitions, saved drafts and the final-row guard intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
update public.categories set is_active=false,new_listing_enabled=false,
  updated_at=pg_catalog.clock_timestamp()
where slug in (
  'fashion-men','fashion-women','fashion-kids','fashion-watches','fashion-accessories',
  'strollers-prams','baby-furniture','baby-gear','toys-games','school-essentials',
  'tvs-video','audio-home-theatre','power-backup-solar','other-home-appliances','kitchenware-utensils'
);
commit;
