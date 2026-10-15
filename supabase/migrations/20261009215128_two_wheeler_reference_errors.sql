-- Correct only expected absent category/version references; preserve signatures and grants.
begin;
set local lock_timeout='5s'; set local statement_timeout='30s';
create or replace function app_security.vehicle_context_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare l public.listings; v public.vehicle_contract_versions; p public.vehicle_category_contracts; r public.vehicle_catalogue_rows; m public.vehicle_models; state text; retained boolean:=false;
begin
  select * into strict l from public.listings where id=new.listing_id;
  if l.category_id<>new.category_id or l.status<>'draft' then raise exception 'Vehicle context must match a draft category'; end if;
  select * into v from public.vehicle_contract_versions where id=new.version_id;
  if not found then raise exception using errcode='22023', message='Vehicle contract version unavailable'; end if;
  select * into p from public.vehicle_category_contracts where category_id=new.category_id and version_id=new.version_id;
  if not found then raise exception using errcode='22023', message='Vehicle category/version reference unavailable'; end if;
  if tg_op='UPDATE' then
    if new.listing_id<>old.listing_id then raise exception 'Listing context identity is immutable'; end if;
    if old.category_id=new.category_id and old.version_id<>new.version_id then raise exception 'Saved contract version cannot silently change'; end if;
    retained:=old.category_id=new.category_id and old.version_id=new.version_id and old.mode=new.mode and old.model_id is not distinct from new.model_id and old.brand_id is not distinct from new.brand_id and old.brand_text is not distinct from new.brand_text and old.model_text is not distinct from new.model_text;
  end if;
  if not retained and (not v.new_assignment_enabled or not exists(select 1 from public.categories c where c.id=new.category_id and c.is_active and c.new_listing_enabled)) then raise exception 'Vehicle category/version closed for new assignment'; end if;
  new.classification_review_required:=new.mode='unresolved';
  if new.mode='not_listed' then
    -- Exact trimmed/case-insensitive recognition, no guessed aliases or fuzzy certification.
    select x.* into m from public.vehicle_models x join public.vehicle_brands b on b.id=x.brand_id where lower(btrim(b.label))=lower(btrim(new.brand_text)) and lower(btrim(x.label))=lower(btrim(new.model_text));
    if found then new.model_id:=m.id; raise exception 'Known brand/model must use its catalogue or unresolved route'; end if;
  elsif new.mode in ('catalogue','unresolved') then
    select * into strict r from public.vehicle_catalogue_rows where snapshot_id=v.snapshot_id and model_id=new.model_id;
    select * into strict m from public.vehicle_models where id=new.model_id and brand_id=new.brand_id;
    state:=app_security.vehicle_compatibility(r.raw,p.source_path,v.definition);
    if state='incompatible' then raise exception 'Known model type, powertrain or mapping incompatible'; end if;
    if not retained and (r.raw->>'status'='Upcoming' or not r.selection_enabled) then raise exception 'Model unavailable for new selection'; end if;
    if state<>(case when new.mode='catalogue' then 'mapped' else 'unresolved' end) then raise exception 'Incorrect model resolution mode'; end if;
  end if;
  return new;
end $$;

create or replace function public.lookup_two_wheeler_catalogue(p_category_id uuid,p_version_id uuid,p_brand_id uuid default null,p_search text default '',p_offset integer default 0,p_limit integer default 25,p_view text default 'mapped',p_selected_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare path jsonb; definition jsonb; snapshot uuid; result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_limit is null or p_limit not between 1 and 25 or p_offset is null or p_offset not between 0 and 10000 or p_search is null or length(p_search)>100 or p_view is null or p_view not in ('mapped','unresolved','review') then raise exception 'Invalid bounded catalogue query'; end if;
  select p.source_path,v.definition,v.snapshot_id into path,definition,snapshot from public.vehicle_category_contracts p join public.vehicle_contract_versions v on v.id=p.version_id where p.category_id=p_category_id and p.version_id=p_version_id;
  if not found then raise exception using errcode='22023', message='Vehicle category/version reference unavailable'; end if;
  with classified as (
    select m.id,m.brand_id,m.label,b.label brand,r.raw,r.selection_enabled,r.source_row,app_security.vehicle_compatibility(r.raw,path,definition) compatibility
    from public.vehicle_catalogue_rows r join public.vehicle_models m on m.id=r.model_id join public.vehicle_brands b on b.id=m.brand_id where r.snapshot_id=snapshot
  ), available as (
    select *,selection_enabled and raw->>'status' in ('Current','Discontinued') and compatibility in ('mapped','unresolved') eligible from classified
  ), scoped as (
    select * from available where case when p_view='review' then true else compatibility=p_view and eligible end
  ), filtered as (
    select * from scoped where brand_id=p_brand_id and position(lower(p_search) in lower(label))>0
  ), page as (select * from filtered order by label,id offset p_offset limit p_limit)
  select jsonb_build_object(
    'brands',coalesce((select jsonb_agg(x order by label) from (select distinct brand_id id,brand label from scoped) x),'[]'),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by label,id) from page),'[]'),
    'total',(select count(*) from filtered),'offset',p_offset,'limit',p_limit,
    'selected',(select to_jsonb(available) from available where id=p_selected_id)
  ) into result;
  return result;
end $$;
commit;
