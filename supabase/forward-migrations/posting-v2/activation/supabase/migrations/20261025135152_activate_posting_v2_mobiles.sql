-- Release owner only, AFTER compatible Admin/Web source is deployed with the
-- Web route flag still off and the automated release checks have passed.
-- Apply separately in Test, then repeat the reviewed release in Production.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
do $$ begin
 if to_regprocedure('public.submit_mobile_v2(jsonb)') is null
  or to_regprocedure('public.posting_v2_media_ready(uuid,uuid,uuid,integer,integer,integer)') is null
  or to_regprocedure('public.admin_phone_catalogue(text,jsonb)') is null
  or to_regprocedure('public.posting_v2_cleanup(text,uuid)') is null
  or not exists(select 1 from storage.buckets where id='posting-staged' and public=false)
  or not exists(select 1 from public.phone_models m join public.phone_brands b on b.id=m.brand_id where m.enabled and b.enabled)
 then raise exception 'Posting V2 foundation unavailable; leave the route disabled'; end if;
end $$;
update public.posting_category_definitions d set enabled=true
from public.categories c where d.listing_category_id=c.id and c.slug='mobile-phones' and c.is_active
 and d.category_key='mobiles' and d.subcategory_key='mobile-phones' and d.version=2;
-- new_listing_enabled remains false: generic creation stays closed; the typed
-- submit_mobile_v2 contract is the only released phone creation path.
commit;
