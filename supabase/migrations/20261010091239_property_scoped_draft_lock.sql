begin;
set local lock_timeout='5s';set local statement_timeout='30s';
-- Lock an owned draft without requesting private location SELECT privileges.
create or replace function public.save_property_draft(p_listing_id uuid,p_listing jsonb,p_version_id uuid,p_financial jsonb,p_society_name text) returns uuid language plpgsql security invoker set search_path='' as $$
declare lid uuid;p public.property_category_contracts%rowtype;l public.listings%rowtype;cid uuid;
begin
 if auth.uid() is null or app_security.get_account_status(auth.uid())::text<>'active' or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Active policy-approved owner required'; end if;
 if p_listing is null or jsonb_typeof(p_listing)<>'object' or p_listing-'title'-'category_id'-'city_id'-'locality_id'-'description'-'condition'-'price_type'-'price_paise'-'pin_code'-'landmark'-'category_attributes'<>'{}' then raise exception using errcode='22023',message='Unexpected Property draft metadata'; end if;
 if p_listing->>'price_paise' is not null or p_listing->>'price_type' is not null or p_listing->>'condition' is not null then raise exception using errcode='22023',message='Property item price/type/condition must be NULL'; end if;
 begin cid:=(p_listing->>'category_id')::uuid; exception when invalid_text_representation then raise exception using errcode='22023',message='Property category reference unavailable'; end;
 select * into p from public.property_category_contracts where category_id=cid and version_id=p_version_id;
 if not found then raise exception using errcode='22023',message='Property category/version reference unavailable'; end if;
 if p_listing_id is not null then
  perform 1 from public.listings where id=p_listing_id and seller_id=auth.uid() and status='draft' for update;
  if not found or not exists(select 1 from public.listing_property_contexts where listing_id=p_listing_id) then raise exception using errcode='42501',message='Owned Property draft required'; end if;
  lid:=p_listing_id;
  update public.listings set title=p_listing->>'title',category_id=cid,city_id=(p_listing->>'city_id')::uuid,locality_id=(p_listing->>'locality_id')::uuid,description=p_listing->>'description',condition=null,price_type=null,price_paise=null,pin_code=p_listing->>'pin_code',landmark=p_listing->>'landmark',category_attributes=coalesce(p_listing->'category_attributes','{}') where id=lid;
 else
  insert into public.listings(title,category_id,city_id,locality_id,description,condition,price_type,price_paise,pin_code,landmark,category_attributes) values(p_listing->>'title',cid,(p_listing->>'city_id')::uuid,(p_listing->>'locality_id')::uuid,p_listing->>'description',null,null,null,p_listing->>'pin_code',p_listing->>'landmark',coalesce(p_listing->'category_attributes','{}')) returning id into lid;
 end if;
 insert into public.listing_property_contexts(listing_id,category_id,version_id,financial,society_name) values(lid,cid,p_version_id,p_financial,p_society_name) on conflict(listing_id) do update set category_id=excluded.category_id,version_id=excluded.version_id,financial=excluded.financial,society_name=excluded.society_name;
 return lid;
end $$;

commit;
