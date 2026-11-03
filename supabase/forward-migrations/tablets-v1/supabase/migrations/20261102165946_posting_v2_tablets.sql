-- Tablets V1: additive; Posting V2 + V2.1.2 recovery required. Disabled until reviewed release.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='posting_upload_sessions' and column_name='draft_protected') then raise exception 'Posting V2.1.2 required';end if;
end $$;
create table public.tablet_release_v1(singleton boolean primary key default true check(singleton),category_id uuid not null unique references public.categories,enabled boolean not null default false);
create table public.tablet_brands_v1(id uuid primary key default gen_random_uuid(),name text unique not null,aliases text[] not null default '{}',sort_order integer not null);
create table public.tablet_models_v1(id uuid primary key default gen_random_uuid(),brand_id uuid not null references public.tablet_brands_v1,name text not null,aliases text[] not null default '{}',sort_order integer not null,other boolean not null default false,family text not null,generation text not null,screen_inches text not null,storage text[] not null,connectivity text[] not null,unique(brand_id,name),unique(id,brand_id));
create table public.tablet_session_bindings_v1(session_id uuid primary key references public.posting_upload_sessions on delete cascade,category_id uuid not null references public.categories);
create table public.listing_tablet_contexts(listing_id uuid primary key references public.listings on delete cascade,category_id uuid not null references public.categories,contract_version integer not null default 1 check(contract_version=1),brand_id uuid not null references public.tablet_brands_v1,model_id uuid not null,brand_name text not null,model_name text not null,details jsonb not null check(jsonb_typeof(details)='object'),review_required boolean not null,foreign key(model_id,brand_id) references public.tablet_models_v1(id,brand_id));
do $$ declare t text;begin foreach t in array array['tablet_release_v1','tablet_brands_v1','tablet_models_v1','tablet_session_bindings_v1','listing_tablet_contexts'] loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
end loop;end $$;
grant select on public.tablet_release_v1,public.tablet_brands_v1,public.tablet_models_v1 to authenticated;
create policy tablet_release_read on public.tablet_release_v1 for select to authenticated using(true);
create policy tablet_brands_read on public.tablet_brands_v1 for select to authenticated using(true);
create policy tablet_models_read on public.tablet_models_v1 for select to authenticated using(true);
grant select(listing_id,category_id,contract_version,brand_id,model_id,brand_name,model_name,details) on public.listing_tablet_contexts to anon,authenticated;
create policy tablet_context_read on public.listing_tablet_contexts for select to anon,authenticated using(app_security.is_listing_publicly_visible(listing_id) or exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid())) or app_security.is_active_staff_aal2('moderator'));
insert into public.categories(slug,name,description,sort_order,is_active,macro_category,new_listing_enabled) values('tablets','Tablets','iPads and Android tablets',22,false,'goods',false) on conflict(slug) do nothing;
do $$ begin
 if not exists(select 1 from public.categories where slug='tablets' and macro_category='goods' and not new_listing_enabled) or exists(select 1 from public.category_attributes a join public.categories c on c.id=a.category_id where c.slug='tablets' and a.is_required) or exists(select 1 from public.posting_category_definitions d join public.categories c on c.id=d.listing_category_id where c.slug='tablets') then raise exception 'Existing tablet category conflicts';end if;
end $$;
insert into public.tablet_release_v1(category_id) select id from public.categories where slug='tablets';
insert into public.tablet_brands_v1(name,sort_order) values('Apple',0);
insert into public.tablet_brands_v1(name,sort_order) values('Samsung',1);
insert into public.tablet_brands_v1(name,sort_order) values('Xiaomi',2);
insert into public.tablet_brands_v1(name,sort_order) values('Redmi',3);
insert into public.tablet_brands_v1(name,sort_order) values('OnePlus',4);
insert into public.tablet_brands_v1(name,sort_order) values('Lenovo',5);
insert into public.tablet_brands_v1(name,sort_order) values('realme',6);
insert into public.tablet_brands_v1(name,sort_order) values('Honor',7);
insert into public.tablet_brands_v1(name,sort_order) values('Motorola',8);
insert into public.tablet_brands_v1(name,sort_order) values('Nokia',9);
insert into public.tablet_brands_v1(name,sort_order) values('Other',10);
insert into public.tablet_models_v1(brand_id,name,sort_order,family,generation,screen_inches,storage,connectivity) select id,'iPad (9th generation)',0,'iPad','9th generation / 2021','10.2',array['64 GB','256 GB'],array['wifi','lte'] from public.tablet_brands_v1 where name='Apple';
insert into public.tablet_models_v1(brand_id,name,sort_order,family,generation,screen_inches,storage,connectivity) select id,'iPad (10th generation)',1,'iPad','10th generation / 2022','10.9',array['64 GB','256 GB'],array['wifi','five_g'] from public.tablet_brands_v1 where name='Apple';
insert into public.tablet_models_v1(brand_id,name,sort_order,family,generation,screen_inches,storage,connectivity) select id,'iPad Air (5th generation)',2,'iPad Air','5th generation / 2022','10.9',array['64 GB','256 GB'],array['wifi','five_g'] from public.tablet_brands_v1 where name='Apple';
insert into public.tablet_models_v1(brand_id,name,sort_order,family,generation,screen_inches,storage,connectivity) select id,'iPad mini (6th generation)',3,'iPad mini','6th generation / 2021','8.3',array['64 GB','256 GB'],array['wifi','five_g'] from public.tablet_brands_v1 where name='Apple';
insert into public.tablet_models_v1(brand_id,name,sort_order,family,generation,screen_inches,storage,connectivity) select id,'iPad Pro 11-inch (3rd generation)',4,'iPad Pro','3rd generation / 2021','11',array['128 GB','256 GB','512 GB','1 TB','2 TB'],array['wifi','five_g'] from public.tablet_brands_v1 where name='Apple';
insert into public.tablet_models_v1(brand_id,name,sort_order,family,generation,screen_inches,storage,connectivity) select id,'Galaxy Tab A9',5,'Galaxy Tab A','2023','8.7',array['64 GB','128 GB'],array['wifi','lte'] from public.tablet_brands_v1 where name='Samsung';
insert into public.tablet_models_v1(brand_id,name,sort_order,other,family,generation,screen_inches,storage,connectivity) select id,'Other model',1000,true,'Seller-declared','Not specified','Not specified',array['16 GB','32 GB','64 GB','128 GB','256 GB','512 GB','1 TB','2 TB','Not sure'],array['wifi','lte','five_g','unknown'] from public.tablet_brands_v1;
create function public.tablets_v1_catalogue() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('version',1,'revision','tablets-v1','selection','{"category":"mobiles","subcategory":"tablets","version":1}'::jsonb,'listing_category_id',r.category_id,'enabled',r.enabled and c.is_active,
 'brands',(select jsonb_agg(to_jsonb(b) order by b.sort_order) from public.tablet_brands_v1 b),'models',(select jsonb_agg(to_jsonb(m) order by m.sort_order) from public.tablet_models_v1 m)) from public.tablet_release_v1 r join public.categories c on c.id=r.category_id
$$;
revoke all on function public.tablets_v1_catalogue() from public,anon,authenticated,service_role;
grant execute on function public.tablets_v1_catalogue() to authenticated;
create function app_security.impl_tablet_v1_session(p_session_id uuid,p_operation text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor();existing uuid;result jsonb;cat uuid;begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,2));
 select category_id into cat from public.tablet_release_v1 r join public.categories c on c.id=r.category_id where r.enabled and c.is_active;
 if cat is null then raise exception 'Tablet category unavailable';end if;
 if p_operation='list_recovery' then
  result:=public.posting_v2_session(null,'list_recovery',null);
  return jsonb_set(result,'{sessions}',coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'sessions') x where exists(select 1 from public.tablet_session_bindings_v1 b where b.session_id=(x->>'id')::uuid and b.category_id=cat)),'[]'::jsonb));
 end if;
 if p_operation not in ('create','create_empty','claim_draft','acquire_draft','read','abandon_empty') then raise exception 'Invalid tablet session operation';end if;
 select id into existing from public.posting_upload_sessions where (id=p_session_id or empty_request_id=p_session_id) and owner_id=u for update;
 if existing is not null and not exists(select 1 from public.tablet_session_bindings_v1 where session_id=existing and category_id=cat) then raise exception 'Cross-category session';end if;
 if existing is null and p_operation in ('read','claim_draft','abandon_empty') then raise exception 'Tablet session unavailable';end if;
 result:=public.posting_v2_session(coalesce(existing,p_session_id),case when p_operation='acquire_draft' then case when existing is null then 'create' else 'claim_draft' end when p_operation='create_empty' and existing is not null then 'read' else p_operation end,null);
 insert into public.tablet_session_bindings_v1(session_id,category_id) values((result->'session'->>'id')::uuid,cat) on conflict do nothing;
 return result;
end $$;
create function public.tablet_v1_session(session_id uuid,operation text default 'create') returns jsonb language sql security invoker set search_path='' as $$select app_security.impl_tablet_v1_session(session_id,operation)$$;
revoke all on function app_security.impl_tablet_v1_session(uuid,text),public.tablet_v1_session(uuid,text) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_tablet_v1_session(uuid,text),public.tablet_v1_session(uuid,text) to authenticated;

create function app_security.tablet_content_guard_v1(p_text text) returns void language plpgsql set search_path='' as $$begin
 perform app_security.phone_content_guard(pg_catalog.normalize(p_text,'NFKC'));
 if pg_catalog.normalize(p_text,'NFKC') ~* '(pay|send|transfer|भेज|भुगतान).{0,40}(advance|deposit|booking|security|पहले|अग्रिम)|(advance|deposit|booking amount).{0,40}(required|reserve|first|pay)' then raise exception 'Remove advance payment requests';end if;
 if pg_catalog.normalize(p_text,'NFKC') ~* '(imei|serial( number)?|password|passcode)[[:space:]]*[:=#][[:space:]]*[^ ]+|\m(?=[a-z0-9]*[0-9])[a-z0-9]{10,}\M|https?://' or p_text ~ '[0-9]([ -]?[0-9]){13,}' then raise exception 'Remove personal identifiers or links';end if;
end $$;
revoke all on function app_security.tablet_content_guard_v1(text) from public,anon,authenticated,service_role;
create function app_security.validate_tablet_v1(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare keys text[];k text;m public.tablet_models_v1;v text;begin
 keys:=array['selection','session_id','brand_id','model_id','other_model','storage','connectivity','ram','colour','hardware_model_number','condition','screen_touch_status','battery_charging_status','transfer_lock_status','powers_on','repair_history','other_defects','included','stylus_description','keyboard_description','warranty_until','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id'];
 if jsonb_typeof(p) is distinct from 'object' or p-keys<>'{}' or not(p?&keys) or p->'selection' is distinct from '{"category":"mobiles","subcategory":"tablets","version":1}'::jsonb or p->>'plan_id' is distinct from 'free-v1' then raise exception 'Invalid tablet contract';end if;
 foreach k in array keys loop
  if k not in ('selection','price_paise','negotiable','included','media_ids') and jsonb_typeof(p->k) is distinct from 'string' then raise exception 'Invalid tablet field type';end if;
 end loop;
 if jsonb_typeof(p->'price_paise') is distinct from 'number' or (p->>'price_paise')!~'^[0-9]+$' or (p->>'price_paise')::numeric>100000000 or jsonb_typeof(p->'negotiable') is distinct from 'boolean' then raise exception 'Invalid price';end if;
 if p->>'trade' not in ('sell','giveaway') or p->>'trade'='sell' and (p->>'price_paise')::integer<1 or p->>'trade'='giveaway' and ((p->>'price_paise')::integer<>0 or (p->>'negotiable')::boolean) then raise exception 'Invalid trade';end if;
 select * into m from public.tablet_models_v1 where id=(p->>'model_id')::uuid and brand_id=(p->>'brand_id')::uuid;
 if m.id is null or not(p->>'storage'=any(m.storage)) or not(p->>'connectivity'=any(m.connectivity)) or (m.other and length(trim(p->>'other_model')) not between 2 and 100) or (not m.other and p->>'other_model'<>'') then raise exception 'Invalid tablet catalogue selection';end if;
 if p->>'ram' !~ '^(2|3|4|6|8|12|16) GB$|^$' or length(p->>'colour')>40 or p->>'hardware_model_number'!~'^[A-Za-z][A-Za-z0-9-]{1,19}$|^$' then raise exception 'Invalid tablet specification';end if;
 if p->>'condition' not in ('new','like_new','good','fair') or p->>'powers_on' not in ('yes','untested') or p->>'screen_touch_status' not in ('working','marked','fault','unknown') or p->>'battery_charging_status' not in ('normal','reduced','charging_fault','untested') or p->>'transfer_lock_status'<>'clear' or p->>'repair_history' not in ('none','screen','battery','other','unknown') then raise exception 'Invalid condition or unresolved transfer lock';end if;
 if (p->>'screen_touch_status'<>'working' or p->>'battery_charging_status'<>'normal' or p->>'repair_history'='other') and length(trim(p->>'other_defects'))<3 then raise exception 'Describe faults and uncertainty';end if;
 if length(p->>'other_defects')>1000 or length(p->>'stylus_description')>100 or length(p->>'keyboard_description')>100 or length(trim(p->>'title')) not between 3 and 150 or length(trim(p->>'description')) not between 10 and 5000 then raise exception 'Invalid tablet text length';end if;
 if jsonb_typeof(p->'included') is distinct from 'array' or jsonb_array_length(p->'included')>8 then raise exception 'Invalid accessories';end if;
 if exists(select 1 from jsonb_array_elements(p->'included') x where jsonb_typeof(x)<>'string') or exists(select 1 from jsonb_array_elements_text(p->'included') x where x not in ('Original box','Bill/invoice','Charger','Charging cable','Stylus/pen','Keyboard','Protective cover/case','Under warranty')) or (select count(distinct x) from jsonb_array_elements_text(p->'included') x)<>jsonb_array_length(p->'included') then raise exception 'Invalid accessories';end if;
 if not(p->'included' ? 'Stylus/pen') and p->>'stylus_description'<>'' or not(p->'included' ? 'Keyboard') and p->>'keyboard_description'<>'' then raise exception 'Accessory detail without accessory';end if;
 v:=p->>'warranty_until';
 if p->'included' ? 'Under warranty' then
  if v!~'^[0-9]{4}-(0[1-9]|1[0-2])$' or v<to_char(current_date,'YYYY-MM') or left(v,4)::integer>extract(year from current_date)+10 then raise exception 'Invalid warranty';end if;
 elsif v<>'' then raise exception 'Warranty not included';end if;
 if jsonb_typeof(p->'media_ids') is distinct from 'array' or jsonb_array_length(p->'media_ids') not between 1 and 8 or exists(select 1 from jsonb_array_elements(p->'media_ids') x where jsonb_typeof(x)<>'string') then raise exception 'Invalid media';end if;
 perform app_security.tablet_content_guard_v1(concat_ws(' ',p->>'other_model',p->>'colour',p->>'hardware_model_number',p->>'other_defects',p->>'stylus_description',p->>'keyboard_description',p->>'title',p->>'description'));
end $$;
revoke all on function app_security.validate_tablet_v1(jsonb) from public,anon,authenticated,service_role;
create function app_security.impl_submit_tablet_v1(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor();s public.posting_upload_sessions;r public.tablet_release_v1;photo public.posting_staged_media;ids uuid[];photo_id uuid;base text;result jsonb;city uuid;locality uuid;pin text;begin
 perform app_security.validate_tablet_v1(p_payload);
 select * into s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='Upload session unavailable';end if;
 if not exists(select 1 from public.tablet_session_bindings_v1 b where b.session_id=s.id and b.category_id=(select category_id from public.tablet_release_v1)) then raise exception 'Cross-category session';end if;
 if s.state='submitted' then
  if not exists(select 1 from public.listing_tablet_contexts where listing_id=s.listing_id) then raise exception 'Cross-category session';end if;
  return jsonb_build_object('success',true,'listing_id',s.listing_id);
 end if;
 if s.state<>'finalizing' or s.expires_at<=now() then raise exception 'Upload session unavailable';end if;
 select r1.* into r from public.tablet_release_v1 r1 join public.categories c on c.id=r1.category_id where r1.enabled and c.is_active for share of r1,c;
 if r.category_id is null then raise exception 'Tablet category unavailable';end if;
 city:=(p_payload->>'city_id')::uuid;locality:=(p_payload->>'locality_id')::uuid;pin:=p_payload->>'pin_code';
 if pin!~'^[1-9][0-9]{5}$' or not exists(select 1 from public.postal_pincode_localities p join public.localities l on l.id=p.locality_id join public.cities c on c.id=l.city_id where p.pincode=pin and l.id=locality and l.city_id=city and l.is_active and c.is_active) then raise exception 'Invalid PIN/locality';end if;
 if jsonb_typeof(p_payload->'media_ids') is distinct from 'array' then raise exception 'Invalid photos';end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'media_ids');
 if coalesce(cardinality(ids),0) not between 1 and 8 or (select count(distinct x) from unnest(ids) x)<>cardinality(ids) or (select count(*) from public.posting_staged_media where session_id=s.id and state='ready' and id=any(ids))<>cardinality(ids) then raise exception 'Choose 1 to 8 ready photos';end if;
 insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes)
 values(s.listing_id,u,r.category_id,city,locality,pin,trim(p_payload->>'title'),trim(p_payload->>'description'),(p_payload->>'condition')::public.listing_condition_enum,(case when p_payload->>'trade'='giveaway' then 'free' when (p_payload->>'negotiable')::boolean then 'negotiable' else 'fixed' end)::public.listing_price_type_enum,(p_payload->>'price_paise')::integer,'{}');
 insert into public.listing_tablet_contexts(listing_id,category_id,brand_id,model_id,brand_name,model_name,details,review_required)
 select s.listing_id,r.category_id,m.brand_id,m.id,b.name,case when m.other then p_payload->>'other_model' else m.name end,
 (p_payload-array['selection','session_id','brand_id','model_id','other_model','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id'])||jsonb_build_object('family',m.family,'generation',m.generation,'screen_inches',m.screen_inches),
 m.other or p_payload->>'storage'='Not sure' or p_payload->>'connectivity'='unknown' or p_payload->>'screen_touch_status'<>'working' or p_payload->>'battery_charging_status'<>'normal' or p_payload->>'powers_on'<>'yes'
 from public.tablet_models_v1 m join public.tablet_brands_v1 b on b.id=m.brand_id where m.id=(p_payload->>'model_id')::uuid;
 foreach photo_id in array ids loop
  select * into photo from public.posting_staged_media where posting_staged_media.id=photo_id and session_id=s.id and state='ready' for update;
  base:=s.listing_id::text||'/'||photo.id::text||'/';
  if (select count(*) from storage.objects where (bucket_id='listing-originals' and name=base||'original.webp') or (bucket_id='listing-derivatives' and name in (base||'thumb.webp',base||'medium.webp',base||'large.webp')))<>4 then raise exception 'Photo preparation incomplete';end if;
  insert into public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes) values(photo.id,s.listing_id,u,'photo.webp','image/webp',photo.file_size);
  update public.listing_media set original_storage_path=base||'original.webp',thumbnail_storage_path=base||'thumb.webp',medium_storage_path=base||'medium.webp',large_storage_path=base||'large.webp',width=photo.width,height=photo.height,processing_status='ready',display_order=array_position(ids,photo.id)-1 where listing_media.id=photo.id;
 end loop;
 result:=public.seller_submit_listing(s.listing_id);if result->>'success' is distinct from 'true' then raise exception 'Submission was not acknowledged';end if;
 update public.posting_upload_sessions set state='submitted',submitted_at=now() where posting_upload_sessions.id=s.id;
 perform app_security.log_audit_event('listing.tablet_submitted','listings',s.listing_id,jsonb_build_object('contract_version',1));
 return jsonb_build_object('success',true,'listing_id',s.listing_id);
end $$;
create function public.submit_tablet_v1(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select app_security.impl_submit_tablet_v1(payload)$$;
revoke all on function app_security.impl_submit_tablet_v1(jsonb),public.submit_tablet_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_submit_tablet_v1(jsonb),public.submit_tablet_v1(jsonb) to authenticated;

-- Enforce binding for every listing insertion path and retained typed data on edits.
create function app_security.tablet_listing_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare ctx public.listing_tablet_contexts;cat uuid;begin
 select category_id into cat from public.tablet_release_v1;
 if exists(select 1 from public.tablet_session_bindings_v1 b join public.posting_upload_sessions s on s.id=b.session_id where s.listing_id=new.id and b.category_id<>new.category_id) then raise exception 'Cross-category session';end if;
 if tg_op='UPDATE' and old.category_id is distinct from new.category_id and (old.category_id=cat or new.category_id=cat) then raise exception 'Tablet category change requires a new posting';end if;
 if new.category_id=cat then
  perform app_security.tablet_content_guard_v1(concat_ws(' ',new.title,new.description));
  if new.price_paise is null or new.price_paise>100000000 or new.price_type='free' and new.price_paise<>0 or new.price_type<>'free' and new.price_paise<1 then raise exception 'Invalid tablet price';end if;
  if new.status in ('pending_review','active','reserved','paused') then
   select * into ctx from public.listing_tablet_contexts where listing_id=new.id and category_id=cat;
   if ctx.listing_id is null or ctx.details->>'transfer_lock_status'<>'clear' or ctx.details->>'condition' is distinct from new.condition::text then raise exception 'Valid tablet context required';end if;
   if new.status='active' and ctx.review_required and (tg_op='INSERT' or old.status is distinct from new.status) and not app_security.is_active_staff_aal2('moderator') then raise exception 'Tablet requires staff review';end if;
  end if;
 end if;return new;
end $$;
revoke all on function app_security.tablet_listing_guard_v1() from public,anon,authenticated,service_role;
create trigger zz_tablet_listing_guard_v1 before insert or update on public.listings for each row execute function app_security.tablet_listing_guard_v1();
-- Preserve the implementation OID and the installed public wrapper/dependencies.
-- A divergent hosted body must be reviewed; never silently overwrite it.
do $tablet_phone$
declare definition text; delegate_owner name;begin
 if not exists(select 1 from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('app_security.impl_submit_mobile_v2(jsonb)') and md5(prosrc) in ('0fdb04c63a19dc4207fdcfe054c021ae','622323dbcdee479763e58c8cfda56e64') and prosecdef and proconfig @> array['search_path=""'])
 or not exists(select 1 from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('public.submit_mobile_v2(jsonb)') and md5(prosrc)='a5fed26d37c6fa3d9886cae11131f979' and not prosecdef and prorettype='jsonb'::pg_catalog.regtype)
 or pg_catalog.to_regprocedure('app_security.impl_submit_mobile_v2_before_tablets(jsonb)') is not null then
  raise exception 'TABLETS_PHONE_IMPLEMENTATION_DRIFT: capture and review installed phone definitions before release';
 end if;
 select pg_catalog.pg_get_userbyid(proowner) into delegate_owner from pg_catalog.pg_proc where oid='app_security.impl_submit_mobile_v2(jsonb)'::pg_catalog.regprocedure;
 definition:=pg_catalog.pg_get_functiondef('app_security.impl_submit_mobile_v2(jsonb)'::pg_catalog.regprocedure);
 definition:=pg_catalog.regexp_replace(definition,'^CREATE OR REPLACE FUNCTION app_security[.]impl_submit_mobile_v2[(]','CREATE FUNCTION app_security.impl_submit_mobile_v2_before_tablets(');
 execute definition;
 execute pg_catalog.format('alter function app_security.impl_submit_mobile_v2_before_tablets(jsonb) owner to %I',delegate_owner);
end $tablet_phone$;
revoke all on function app_security.impl_submit_mobile_v2_before_tablets(jsonb) from public,anon,authenticated,service_role;
create or replace function app_security.impl_submit_mobile_v2(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform app_security.posting_v2_actor();
 if exists(select 1 from public.tablet_session_bindings_v1 where session_id=(p_payload->>'session_id')::uuid) then raise exception 'Cross-category session';end if;
 return app_security.impl_submit_mobile_v2_before_tablets(p_payload);
end $$;
revoke all on function app_security.impl_submit_mobile_v2(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_submit_mobile_v2(jsonb) to authenticated;
commit;
