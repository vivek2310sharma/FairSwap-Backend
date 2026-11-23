begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Availability for five chooser identities only. Never change category flags,
-- ordinary_goods_available_v3, insert policies, contracts or lifecycle functions.
-- Reconciled read-only against FairSwapProd 2026-11-23 and the installed
-- 20261022110410 release (historical reference de4121b4c88b8e579ccde475e8c7e515112223a4).
create function app_security.canonical_family_chooser_v1(p_slug text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare
  v_family text; contract_key text; expected_hash text; expected_count integer;
  versions text; contracts text; version_id uuid; definition jsonb;
  eligible integer; total integer; policy_hash text; policy_contract text;
  scope text; policy_key text; submit_signature text; status_signature text;
begin
  case p_slug
    when 'v2-cars' then v_family:='cars';
    when 'v2-motorcycles-scooters' then v_family:='two-wheelers';
    when 'v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms' then v_family:='property';
    else return false;
  end case;
  -- Canonical identities remain non-writable, including through the V3 intake.
  if not exists (
    select 1 from app_security.impl_taxonomy_v2_expected_nodes() e
    join public.categories c on c.id=e.seed_id and c.slug=e.slug and c.posting_flow=e.posting_flow
    join public.categories r on r.id=c.parent_id and r.slug=e.parent_slug
    where c.slug=p_slug and c.status in ('coming_soon','live') and not c.new_listing_enabled
      and r.status='live' and r.is_active
      and not exists(select 1 from app_security.ordinary_goods_contracts_v3 g where g.category_id=c.id and g.enabled)
  ) then return false; end if;
  -- Detect a complete installed lifecycle, never a caller-controlled mode. A
  -- partial/ambiguous Production installation cannot downgrade to Test checks.
  if pg_catalog.to_regclass('app_security.production_submission_policies') is not null
    or pg_catalog.to_regprocedure('public.seller_submit_family_listing(uuid,integer)') is not null
    or pg_catalog.to_regprocedure('app_security.production_submission_lifecycle()') is not null then
    if pg_catalog.to_regclass('app_security.test_submission_policies') is not null then return false; end if;
    scope:='production'; policy_key:='production-family-submission-v1';
    submit_signature:='public.seller_submit_family_listing(uuid,integer)';
    status_signature:='public.get_seller_production_submission_status(uuid)';
  else
    if pg_catalog.to_regclass('app_security.test_submission_policies') is null
      or pg_catalog.to_regprocedure('public.seller_submit_listing(uuid,integer)') is null then return false; end if;
    scope:='test'; policy_key:='test-submission-v1';
    submit_signature:='public.seller_submit_listing(uuid,integer)';
    status_signature:='public.get_seller_submission_status(uuid)';
  end if;
  execute pg_catalog.format('select definition_hash,contract_key from app_security.%I where family=$1 and policy_key=$2 and enabled and not maintenance',scope||'_submission_policies')
    into strict policy_hash,policy_contract using v_family,policy_key;
  if policy_hash is null then return false; end if;
  if v_family='cars' then
    versions:='car_contract_versions'; contracts:='car_category_contracts';
    contract_key:='cars-draft-v1'; expected_hash:='2367a928f0ac3c6f20111151a7d30aa7'; expected_count:=9;
  elsif v_family='two-wheelers' then
    versions:='vehicle_contract_versions'; contracts:='vehicle_category_contracts';
    contract_key:='two-wheeler-draft-v1'; expected_hash:='132b54253fed78983c3f103d218f7477'; expected_count:=9;
  else
    versions:='property_contract_versions'; contracts:='property_category_contracts';
    contract_key:='property-rental-draft-v1'; expected_hash:='1c08a4ec26d95f398565e2ffe240c887'; expected_count:=10;
  end if;
  if policy_hash<>expected_hash or policy_contract<>contract_key then return false; end if;
  execute pg_catalog.format('select id,definition from public.%I where contract_key=$1 and new_assignment_enabled',versions)
    into strict version_id,definition using contract_key;
  if pg_catalog.md5(definition::text)<>expected_hash or pg_catalog.jsonb_array_length(definition->'paths')<>expected_count
    then return false; end if;
  execute pg_catalog.format('select count(*) from public.%I where version_id=$1',contracts) into total using version_id;
  if total<>expected_count then return false; end if;
  execute pg_catalog.format($query$
    select count(distinct p.source_path) from public.%I p
    join public.categories c on c.id=p.category_id
    where p.version_id=$1 and c.is_active and c.new_listing_enabled and c.macro_category=$3
      and exists(select 1 from pg_catalog.jsonb_array_elements($2->'paths') d
        where d->>'slug'=c.slug and d->'path'=p.source_path and d->'fields'=p.fields
          and ($3<>'property' or d=pg_catalog.to_jsonb(p)->'definition'))
  $query$,contracts) into eligible using version_id,definition,case when v_family='property' then 'property' else 'vehicles' end;
  if eligible<>expected_count then return false; end if;
  if exists (
    select 1 from (values
      ('public.listing_vehicle_contexts'),('public.listing_car_contexts'),('public.listing_property_contexts'),
      ('app_security.'||scope||'_submission_policies'),('app_security.'||scope||'_submission_permits'),('app_security.family_review_permits')
    ) required(relation)
    left join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass(required.relation)
    where c.oid is null or not c.relrowsecurity
      or pg_catalog.has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
  ) then return false; end if;
  -- The same installed submit, revision/fingerprint review and lifecycle guards
  -- remain authoritative. Loss of a function, secure search path or trigger fails closed.
  if exists (
    select 1 from (values
      ('app_security.impl_submit_'||scope||'_family(uuid,integer)'),
      ('app_security.impl_get_staff_family_review(uuid)'),
      ('app_security.impl_moderate_family_reviewed(uuid,text,text,integer,text)')
    ) required(signature)
    left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(required.signature)
    where p.oid is null or not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'],false)
  ) then return false; end if;
  if exists (
    select 1 from (values
      (submit_signature),
      (status_signature),
      ('public.get_staff_family_review(uuid)'),
      ('public.moderate_family_reviewed(uuid,text,text,integer,text)')
    ) required(signature)
    where pg_catalog.to_regprocedure(required.signature) is null
      or not pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure(required.signature),'EXECUTE')
      or pg_catalog.has_function_privilege('anon',pg_catalog.to_regprocedure(required.signature),'EXECUTE')
  ) then return false; end if;
  if exists (
    select 1 from (values
      ('public.listings','z_0_'||scope||'_submission_lifecycle','app_security.'||scope||'_submission_lifecycle()'),
      ('public.listings','z_vehicle_listing_guard','app_security.vehicle_listing_guard()'),
      ('public.listings','zz_car_listing_guard','app_security.car_listing_guard()'),
      ('public.listings','zzz_property_listing_guard','app_security.property_listing_guard()'),
      ('public.listing_vehicle_contexts','zz_'||scope||'_submission_child','app_security.'||scope||'_submission_child_change()'),
      ('public.listing_car_contexts','zz_'||scope||'_submission_child','app_security.'||scope||'_submission_child_change()'),
      ('public.listing_property_contexts','zz_'||scope||'_submission_child','app_security.'||scope||'_submission_child_change()'),
      ('public.listing_media','zz_'||scope||'_submission_child','app_security.'||scope||'_submission_child_change()')
    ) required(relation,name,signature)
    where not exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=pg_catalog.to_regclass(required.relation)
      and t.tgname=required.name and t.tgenabled='O' and t.tgfoid=pg_catalog.to_regprocedure(required.signature))
  ) then return false; end if;
  if not exists(select 1 from pg_catalog.pg_proc p
    where p.oid=pg_catalog.to_regprocedure('app_security.'||scope||'_submission_lifecycle()')
      and p.prosecdef and p.proconfig @> array['search_path=""']
      and pg_catalog.strpos(p.prosrc,'family_review_permits')>0) then return false; end if;
  return true;
exception when others then return false;
end $$;
revoke all on function app_security.canonical_family_chooser_v1(text) from public,anon,authenticated,service_role;

-- Preserve the existing catalogue and posting_enabled guard. Only these five
-- payload nodes become live/actionable when their existing families are ready.
-- Stored canonical categories remain disabled for writes; specialist IDs are
-- selected inside the existing forms, with the existing seller RPCs and RLS.
do $$
declare def text; needle text := 'c.status,c.posting_flow';
  predicate text := 'app_security.impl_taxonomy_v2_can_post(c.id) as posting_enabled';
  chooser text := $expr$c.slug in ('v2-cars','v2-motorcycles-scooters','v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms')$expr$;
begin
  def:=pg_catalog.pg_get_functiondef('app_security.impl_get_category_catalogue_v2()'::regprocedure);
  if (length(def)-length(replace(def,needle,'')))<>length(needle)
    or (length(def)-length(replace(def,predicate,'')))<>length(predicate) then
    raise exception 'CANONICAL_FAMILY_CATALOGUE_DRIFT';
  end if;
  def:=replace(def,needle,'case when '||chooser||' and app_security.canonical_family_chooser_v1(c.slug) then ''live'' else c.status end as status,c.posting_flow');
  def:=replace(def,predicate,'case when '||chooser||' then app_security.canonical_family_chooser_v1(c.slug) else app_security.impl_taxonomy_v2_can_post(c.id) end as posting_enabled');
  execute def;
end $$;
commit;
