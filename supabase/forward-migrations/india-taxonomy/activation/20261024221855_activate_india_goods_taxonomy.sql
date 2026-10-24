-- Separate operator-controlled migration. NEVER bundle with the disabled seed.
-- Apply only after compatible Web is deployed to the specified environment.
-- Session settings are operator release attestations, not app authorization.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $activate$
declare
  supported constant text[] := array[
    'fashion-men','fashion-women','fashion-kids','fashion-watches','fashion-accessories',
    'strollers-prams','baby-furniture','baby-gear','toys-games','school-essentials',
    'tvs-video','audio-home-theatre','power-backup-solar','other-home-appliances','kitchenware-utensils'
  ];
  release_sha text := pg_catalog.current_setting('app.india_taxonomy_verified_web_release',true);
  project_ref text := pg_catalog.current_setting('app.india_taxonomy_target_project',true);
  changed integer;
begin
  if release_sha is null or release_sha !~ '^[0-9a-f]{40}$' or release_sha=pg_catalog.repeat('0',40)
     or project_ref is null or project_ref not in ('wpppxlnbzqynvhpeuavd','kriuhwppxgxsyyrbjsau') then
    raise exception 'INDIA_TAXONOMY_WEB_DEPLOYMENT_ATTESTATION_REQUIRED';
  end if;
  lock table public.categories in share row exclusive mode;
  lock table public.category_attributes in share mode;
  if (select count(*) from public.categories where slug=any(supported) and macro_category='goods'
      and not is_active and not new_listing_enabled)<>15 then
    raise exception 'INDIA_TAXONOMY_DISABLED_SEED_MISMATCH';
  end if;
  if exists (
    select 1 from public.categories c where c.slug=any(supported) and (
      (select count(*) from public.category_attributes a where a.category_id=c.id)<>2 or
      (select count(*) from public.category_attributes a where a.category_id=c.id
        and a.name in ('item_type','brand') and a.value_type::text='text'
        and a.is_required=(a.name='item_type') and a.options is null
        and a.validation_rules='{"contract":"india_goods_v1","max_length":100}'::jsonb)<>2
    )
  ) then raise exception 'INDIA_TAXONOMY_ATTRIBUTE_CONTRACT_MISMATCH'; end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.listings'::regclass
      and t.tgname='india_goods_listing_guard' and not t.tgisinternal
      and t.tgtype=21 -- AFTER ROW, INSERT + UPDATE (all columns)
      and t.tgenabled in ('O','A') and t.tgqual is null and t.tgattr::text=''
      and t.tgfoid=pg_catalog.to_regprocedure('app_security.india_goods_listing_guard()')
  ) then raise exception 'INDIA_TAXONOMY_FINAL_ROW_GUARD_REQUIRED'; end if;
  -- Reuse the exact seeded UUIDs. Nothing else is made visible/assignable.
  update public.categories set is_active=true,new_listing_enabled=true,
    updated_at=pg_catalog.clock_timestamp() where slug=any(supported);
  get diagnostics changed = row_count;
  if changed<>15 or (select count(*) from public.categories where slug=any(supported)
      and macro_category='goods' and is_active and new_listing_enabled)<>15 then
    raise exception 'INDIA_TAXONOMY_ACTIVATION_INCOMPLETE';
  end if;
  -- Clear acknowledgements after use; they are not permanent environment flags.
  perform pg_catalog.set_config('app.india_taxonomy_verified_web_release','',false);
  perform pg_catalog.set_config('app.india_taxonomy_target_project','',false);
end $activate$;
commit;
