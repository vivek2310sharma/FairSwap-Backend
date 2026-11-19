-- Operator-only, separate from migrations. Invoke with psql -v slug=... -v web_commit=... -v moderation_mode=five_check|staff_intake
-- Set these only after verifying the deployed Web SHA and leaf-specific automated acceptance.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select set_config('app.goods_v3_slug', :'slug', true), set_config('app.goods_v3_web_commit', :'web_commit', true);
select set_config('app.goods_v3_moderation_mode', :'moderation_mode', true);
do $$
declare g app_security.ordinary_goods_contracts_v3;
  mode text := current_setting('app.goods_v3_moderation_mode',true);
begin
  if coalesce(current_setting('app.goods_v3_web_commit',true),'') !~ '^[a-f0-9]{40}$' then
    raise exception 'VERIFIED_WEB_COMMIT_REQUIRED';
  end if;
  select * into strict g from app_security.ordinary_goods_contracts_v3
  where slug=current_setting('app.goods_v3_slug',true) for update;
  if g.draft_only and not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid='public.listings'::regclass and t.tgname='regulated_vehicle_draft_guard_v3'
      and t.tgenabled in ('O','A') and t.tgfoid='app_security.regulated_vehicle_draft_guard_v3()'::regprocedure
  ) then raise exception 'GOODS_DRAFT_ONLY_GUARD_MISSING'; end if;
  if g.posting_flow in ('specialist:car','specialist:two_wheeler') and not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid='app_security.ordinary_goods_sessions_v3'::regclass
      and t.tgname='pin_specialist_vehicle_draft_v3' and t.tgenabled in ('O','A')
      and t.tgfoid='app_security.pin_specialist_vehicle_draft_v3()'::regprocedure
  ) then raise exception 'GOODS_SPECIALIST_DRAFT_BINDING_GUARD_MISSING'; end if;
  if mode is null or mode not in ('five_check','staff_intake')
    or (g.macro_category in ('vehicles','property') and mode<>'staff_intake')
    or g.slug in ('v2-baby-gear-car-seats','v2-other-items') or g.enabled or g.revision<>1 or not exists (
    select 1 from public.categories c join public.categories p on p.id=c.parent_id
    where c.id=g.category_id and c.slug=g.slug and p.slug=g.parent_slug and p.is_active and p.status='live'
      and c.posting_flow=g.posting_flow and c.macro_category=g.macro_category and not c.is_active
      and c.status='coming_soon' and not c.new_listing_enabled
  ) then raise exception 'GOODS_CATEGORY_DRIFT'; end if;
  if pg_catalog.to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') is null
    or (select count(*) from pg_catalog.pg_trigger t
    where not t.tgisinternal and t.tgenabled in ('O','A') and
    ((t.tgrelid='public.listings'::regclass and t.tgfoid='app_security.ordinary_goods_listing_guard_v3()'::regprocedure)
      or (t.tgname='trg_identity_gate' and t.tgfoid=case t.tgrelid
        when 'public.listings'::regclass then pg_catalog.to_regprocedure('app_security.trg_identity_gate_listings()')
        when 'public.listing_media'::regclass then pg_catalog.to_regprocedure('app_security.trg_identity_gate_by_listing()')
        when 'public.posting_upload_sessions'::regclass then pg_catalog.to_regprocedure('app_security.trg_identity_gate_posting_session()')
        when 'public.posting_staged_media'::regclass then pg_catalog.to_regprocedure('app_security.trg_identity_gate_staged_media()')
      end))) <> 5
  then raise exception 'GOODS_LISTING_OR_IDENTITY_GUARDS_MISSING'; end if;
  if not app_security.v3_seller_identity_enforced() then
    raise exception 'GOODS_SELLER_IDENTITY_ENFORCEMENT_OFF';
  end if;
  if not exists (select 1 from public.app_system_settings where setting_key='moderation_automation_enabled' and setting_value='true')
    or (mode='five_check' and not exists (select 1 from public.app_system_settings
      where setting_key='moderation_azure_enabled' and setting_value='true')) then
    raise exception 'GOODS_FIVE_CHECK_MODERATION_NOT_READY';
  end if;
  update public.categories set status='live', is_active=true where id=g.category_id;
  update app_security.ordinary_goods_contracts_v3 set enabled=true,moderation_mode=mode where category_id=g.category_id;
  if not app_security.ordinary_goods_available_v3(g.category_id) then raise exception 'GOODS_ACTIVATION_INCOMPLETE'; end if;
  raise notice 'Ordinary Goods category enabled: %',g.slug;
end $$;
commit;
