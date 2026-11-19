begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Installing the identity functions is insufficient. The direct IDV candidate
-- deliberately defaults its enforcement switch to off.
create function app_security.v3_seller_identity_enforced()
returns boolean language sql stable security definer set search_path='' as $$
  select pg_catalog.to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') is not null
    and exists (select 1 from public.app_system_settings
      where setting_key='identity_verification_required' and setting_value='true');
$$;
revoke all on function app_security.v3_seller_identity_enforced() from public,anon,authenticated,service_role;

do $$
declare def text;
  needle text := 'where g.category_id=p_category and g.enabled';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_available_v3(uuid)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'V3_IDENTITY_AVAILABILITY_DRIFT'; end if;
  execute replace(def,needle,needle || ' and app_security.v3_seller_identity_enforced()');
end $$;

do $$
declare def text;
  needle text := 'if pg_catalog.to_regprocedure(''app_security.enforce_verified_actor(uuid,boolean)'') is null then';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_actor_v3()'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'V3_IDENTITY_ACTOR_DRIFT'; end if;
  execute replace(def,needle,'if not app_security.v3_seller_identity_enforced() then');
end $$;
commit;
