-- Operator-only rollback. Invoke with psql -v slug=...
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select set_config('app.goods_v3_slug', :'slug', true);
do $$
declare g app_security.ordinary_goods_contracts_v3;
begin
  select * into strict g from app_security.ordinary_goods_contracts_v3
  where slug=current_setting('app.goods_v3_slug',true) for update;
  update app_security.ordinary_goods_contracts_v3 set enabled=false where category_id=g.category_id;
  update public.categories set status='coming_soon', is_active=false where id=g.category_id and slug=g.slug;
  if app_security.ordinary_goods_available_v3(g.category_id) then raise exception 'GOODS_DEACTIVATION_FAILED'; end if;
end $$;
commit;
