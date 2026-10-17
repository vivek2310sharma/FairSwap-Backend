begin;
set local lock_timeout='5s'; set local statement_timeout='30s';
grant execute on function app_security.vehicle_compatibility(jsonb,jsonb,jsonb) to authenticated;
create function public.lookup_two_wheeler_catalogue(p_category_id uuid,p_version_id uuid,p_brand_id uuid default null,p_search text default '',p_offset integer default 0,p_limit integer default 25,p_view text default 'mapped',p_selected_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare path jsonb; definition jsonb; snapshot uuid; result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_limit is null or p_limit not between 1 and 25 or p_offset is null or p_offset not between 0 and 10000 or p_search is null or length(p_search)>100 or p_view is null or p_view not in ('mapped','unresolved','review') then raise exception 'Invalid bounded catalogue query'; end if;
  select p.source_path,v.definition,v.snapshot_id into strict path,definition,snapshot from public.vehicle_category_contracts p join public.vehicle_contract_versions v on v.id=p.version_id where p.category_id=p_category_id and p.version_id=p_version_id;
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
revoke all on function public.lookup_two_wheeler_catalogue(uuid,uuid,uuid,text,integer,integer,text,uuid) from public,anon,service_role;
grant execute on function public.lookup_two_wheeler_catalogue(uuid,uuid,uuid,text,integer,integer,text,uuid) to authenticated;
commit;
