-- Posting V2: same additive artifact for isolated Test and Production workspaces.
-- Never apply from the immutable historical migrations directory.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
 if to_regprocedure('public.seller_submit_listing(uuid)') is null or to_regclass('public.postal_pincode_localities') is null or to_regclass('public.listing_media') is null or to_regprocedure('app_security.is_active_staff_aal2(public.staff_role_enum)') is null then raise exception 'Posting V2 prerequisites are missing; use the reviewed environment-specific baseline'; end if;
end $$;

create table public.posting_category_definitions (
  category_key text not null, subcategory_key text not null, version integer not null check(version=2),
  listing_category_id uuid not null references public.categories(id),
  enabled boolean not null default false,
  primary key(category_key,subcategory_key,version), unique(listing_category_id)
);
create table public.phone_brands (
  id uuid primary key default gen_random_uuid(), name text not null unique check(length(trim(name)) between 1 and 100),
  aliases text[] not null default '{}', enabled boolean not null default true,
  sort_order integer not null default 0 check(sort_order between 0 and 100000), updated_at timestamptz not null default now(),
  check(cardinality(aliases)<=20)
);
create table public.phone_models (
  id uuid primary key default gen_random_uuid(), brand_id uuid not null references public.phone_brands(id),
  name text not null check(length(trim(name)) between 1 and 100), aliases text[] not null default '{}',
  enabled boolean not null default true, older_group boolean not null default false, other boolean not null default false,
  sort_order integer not null default 0 check(sort_order between 0 and 100000), updated_at timestamptz not null default now(),
  unique(brand_id,name), unique(id,brand_id), check(cardinality(aliases)<=20), check(not (older_group and other))
);
create index phone_models_brand_order on public.phone_models(brand_id,sort_order,id);
create unique index phone_brands_name_folded on public.phone_brands(lower(name));
create unique index phone_models_name_folded on public.phone_models(brand_id,lower(name));
create table public.posting_upload_sessions (
  -- Retain an expiring cleanup tombstone after account deletion so objects can
  -- still be removed. The cleanup acknowledgement deletes the tombstone.
  id uuid primary key, owner_id uuid not null,
  listing_id uuid not null unique default gen_random_uuid(),
  state text not null default 'open' check(state in ('open','finalizing','submitted','expired','cleaned')),
  created_at timestamptz not null default now(), expires_at timestamptz not null default (now()+interval '24 hours'),
  cleanup_after timestamptz not null default (now()+interval '24 hours'),
  submitted_at timestamptz
);
create index posting_upload_expiry on public.posting_upload_sessions(cleanup_after,id) where state<>'cleaned';
create index posting_upload_owner on public.posting_upload_sessions(owner_id,created_at);
create table public.posting_staged_media (
  id uuid primary key, session_id uuid not null references public.posting_upload_sessions(id) on delete cascade,
  state text not null default 'uploading' check(state in ('uploading','ready','removed')),
  attempt uuid not null default gen_random_uuid(), lease_until timestamptz not null default (now()+interval '2 minutes'),
  file_size integer check(file_size between 1 and 5242880), width integer check(width between 1 and 1600), height integer check(height between 1 and 1600),
  created_at timestamptz not null default now(), unique(session_id,id)
);
create index posting_staged_session on public.posting_staged_media(session_id,state);
create table public.listing_mobile_contexts (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  contract_version integer not null default 2 check(contract_version=2),
  category_id uuid not null references public.categories(id),
  brand_id uuid not null references public.phone_brands(id), model_id uuid not null,
  brand_name text not null, model_name text not null,
  other_model text check(length(other_model)<=100),
  storage text not null check(storage in ('8 GB','16 GB','32 GB','64 GB','128 GB','256 GB','512 GB','1 TB','2 TB','Other','Not applicable')),
  ram text check(ram in ('2 GB','3 GB','4 GB','6 GB','8 GB','12 GB','16 GB')),
  included text[] not null default '{}' check(included<@array['Original box','Bill/invoice','Charger','Under warranty']::text[] and cardinality(included)<=4),
  warranty_until date, fulfillment text not null default 'pickup' check(fulfillment='pickup'),
  plan_id text not null default 'free-v1' check(plan_id='free-v1'),
  foreign key(model_id,brand_id) references public.phone_models(id,brand_id),
  check(('Under warranty'=any(included))=(warranty_until is not null))
);
create index mobile_context_brand on public.listing_mobile_contexts(brand_id,model_id);
create table public.listing_phone_risk_flags (
  listing_id uuid not null references public.listings(id) on delete cascade,
  signal text not null check(signal in ('other_model','older_model_group','giveaway','advance_or_courier_request')),
  primary key(listing_id,signal)
);

-- No client writes, including service-mediated session state transitions: only RPCs.
do $$ declare t text; begin
  foreach t in array array['posting_category_definitions','phone_brands','phone_models','posting_upload_sessions','posting_staged_media','listing_mobile_contexts','listing_phone_risk_flags'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;
grant select on public.posting_category_definitions,public.phone_brands,public.phone_models to authenticated;
create policy posting_definitions_read on public.posting_category_definitions for select to authenticated using(true);
create policy phone_brands_read on public.phone_brands for select to authenticated using(enabled or app_security.is_active_staff_aal2('content_editor'));
create policy phone_models_read on public.phone_models for select to authenticated using(enabled or app_security.is_active_staff_aal2('content_editor'));
grant select on public.posting_upload_sessions,public.posting_staged_media to authenticated;
create policy posting_session_owner on public.posting_upload_sessions for select to authenticated using(owner_id=(select auth.uid()));
create policy posting_media_owner on public.posting_staged_media for select to authenticated using(exists(select 1 from public.posting_upload_sessions s where s.id=session_id and s.owner_id=(select auth.uid())));
grant select on public.listing_mobile_contexts to anon,authenticated;
create policy mobile_context_read on public.listing_mobile_contexts for select to anon,authenticated using(
  app_security.is_listing_publicly_visible(listing_id) or exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid())) or app_security.is_active_staff_aal2('moderator')
);
grant select on public.listing_phone_risk_flags to authenticated;
create policy phone_risks_staff on public.listing_phone_risk_flags for select to authenticated using(app_security.is_active_staff_aal2('moderator'));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('posting-staged','posting-staged',false,5242880,array['image/webp']) on conflict(id) do nothing;
-- Deliberately no storage.objects policy for posting-staged: trusted server only.

-- Versioned DB mapping. Existing Electronics data is untouched. Dedicated category
-- is hidden from generic assignment until release; the typed RPC owns creation.
insert into public.categories(slug,name,description,sort_order,is_active,macro_category,new_listing_enabled)
values('mobile-phones','Mobile Phones','Mobile phones: seller-declared details, pickup only',20,true,'goods',false)
on conflict(slug) do nothing;
do $$ begin
 if not exists(select 1 from public.categories where slug='mobile-phones' and macro_category='goods')
 or exists(select 1 from public.category_attributes a join public.categories c on c.id=a.category_id where c.slug='mobile-phones' and a.is_required) then raise exception 'Existing Mobile Phones category conflicts with Posting V2; review its contract before migration'; end if;
end $$;
insert into public.posting_category_definitions(category_key,subcategory_key,version,listing_category_id)
select 'mobiles','mobile-phones',2,id from public.categories where slug='mobile-phones';

insert into public.phone_brands(name,sort_order)
select name,ord::integer from unnest(array['Apple','Samsung','Xiaomi','Redmi','Vivo','Oppo','Realme','OnePlus','Motorola','iQOO','Poco','Nothing','Google','Infinix','Tecno','Lava','Nokia','Honor','itel','Jio','Other brand']) with ordinality as b(name,ord);
insert into public.phone_models(brand_id,name,sort_order)
select b.id,m.name,m.ord from public.phone_brands b join (values
 ('Apple','iPhone 15',1),('Apple','iPhone 15 Plus',2),('Apple','iPhone 15 Pro',3),('Apple','iPhone 15 Pro Max',4),('Apple','iPhone 16',5),('Apple','iPhone 16 Plus',6),('Apple','iPhone 16 Pro',7),('Apple','iPhone 16 Pro Max',8),('Apple','iPhone 14',9),('Apple','iPhone 13',10),
 ('Samsung','Galaxy S24',1),('Samsung','Galaxy S24+',2),('Samsung','Galaxy S24 Ultra',3),('Samsung','Galaxy A55 5G',4),('Samsung','Galaxy M35 5G',5),
 ('Xiaomi','Xiaomi 14',1),('Xiaomi','Xiaomi 14 Civi',2),('Redmi','Redmi Note 13 5G',1),('Redmi','Redmi Note 13 Pro 5G',2),('Redmi','Redmi Note 13 Pro+ 5G',3),
 ('Vivo','V30',1),('Vivo','V30 Pro',2),('Oppo','Reno11 5G',1),('Oppo','Reno11 Pro 5G',2),('Realme','realme 12 Pro 5G',1),('Realme','realme 12 Pro+ 5G',2),
 ('OnePlus','OnePlus 12',1),('OnePlus','OnePlus 12R',2),('OnePlus','OnePlus Nord CE4',3),('Motorola','motorola edge 50 pro',1),('Motorola','moto g64 5G',2),
 ('iQOO','iQOO 12',1),('iQOO','iQOO Neo9 Pro',2),('Poco','POCO X6 5G',1),('Poco','POCO X6 Pro 5G',2),('Poco','POCO F6',3),
 ('Nothing','Phone (2)',1),('Nothing','Phone (2a)',2),('Google','Pixel 8',1),('Google','Pixel 8 Pro',2),('Google','Pixel 8a',3),
 ('Infinix','NOTE 40 Pro 5G',1),('Tecno','CAMON 30 5G',1),('Lava','Blaze 5G',1),('Lava','Agni 2 5G',2),('Lava','A1',3),
 ('Nokia','105 (2023)',1),('Nokia','110 4G (2023)',2),('Honor','HONOR 90',1),('itel','A70',1),('itel','it2163',2),('Jio','JioBharat B1',1),('Jio','JioPhone Prima 4G',2)
) m(brand,name,ord) on m.brand=b.name;
-- Current India Apple names checked against apple.com/in/shop/buy-iphone on
-- 25 October 2026. No reference price or inferred model specification is seeded.
insert into public.phone_models(brand_id,name,sort_order)
select b.id,m.name,m.ord from public.phone_brands b cross join (values
 ('iPhone 17',11),('iPhone 17e',12),('iPhone Air',13),('iPhone 18 Pro',14),('iPhone 18 Pro Max',15),('iPhone Duo',16)
) m(name,ord) where b.name='Apple';
insert into public.phone_models(brand_id,name,older_group,sort_order)
select id,'Older '||name||' phones',true,900 from public.phone_brands where name<>'Other brand';
insert into public.phone_models(brand_id,name,other,sort_order) select id,'Other model',true,999 from public.phone_brands;
update public.phone_brands set aliases=case name when 'Apple' then array['iPhone'] when 'Redmi' then array['red mi'] when 'Poco' then array['POCO'] when 'iQOO' then array['iqoo'] when 'Jio' then array['JioBharat','JioPhone'] else '{}'::text[] end;

create function app_security.posting_v2_actor() returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); begin
 if u is null or app_security.get_account_status(u)::text is distinct from 'active' or not app_security.has_current_policy_acceptance(u) then raise exception using errcode='42501',message='Eligible account and current policies required'; end if;
 return u;
end $$;
revoke all on function app_security.posting_v2_actor() from public,anon,authenticated,service_role;

create function app_security.impl_posting_v2_session(p_session_id uuid,p_operation text,p_media_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor(); s public.posting_upload_sessions; m public.posting_staged_media; n integer;
begin
 if p_operation='create' then
  perform pg_advisory_xact_lock(hashtextextended(u::text,2));
  if not exists(select 1 from public.posting_category_definitions where category_key='mobiles' and subcategory_key='mobile-phones' and version=2 and enabled) then raise exception 'Posting unavailable'; end if;
  if (select count(*) from public.posting_upload_sessions where owner_id=u and state in ('open','finalizing') and expires_at>now())>=5 and not exists(select 1 from public.posting_upload_sessions where id=p_session_id and owner_id=u) then raise exception 'Too many upload sessions'; end if;
  insert into public.posting_upload_sessions(id,owner_id) values(p_session_id,u) on conflict(id) do nothing;
 end if;
 select * into s from public.posting_upload_sessions where id=p_session_id and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='Upload session unavailable'; end if;
 if s.state='submitted' then return jsonb_build_object('session',to_jsonb(s),'media','[]'::jsonb); end if;
 if s.expires_at<=now() or s.state in ('expired','cleaned') then raise exception 'Upload session expired'; end if;
 if p_operation in ('reserve','remove') then
  if s.expires_at<now()+interval '5 minutes' then raise exception 'Upload session is expiring; start a new posting'; end if;
  if s.state<>'open' then raise exception 'Submission is being finalized'; end if;
  if p_operation='remove' then
   update public.posting_staged_media set state='removed' where id=p_media_id and session_id=s.id;
  else
   select * into m from public.posting_staged_media where id=p_media_id and session_id=s.id for update;
   if m.state='removed' then raise exception 'Photo removed'; end if;
   if m.id is null then
    select count(*) into n from public.posting_staged_media where session_id=s.id and state<>'removed';
    if n>=8 then raise exception 'Maximum 8 photos'; end if;
    insert into public.posting_staged_media(id,session_id) values(p_media_id,s.id) returning * into m;
   elsif m.state='uploading' then
    if m.lease_until>now() then raise exception using errcode='PT409',message='Upload in progress; retry shortly'; end if;
    update public.posting_staged_media set attempt=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id=m.id returning * into m;
   end if;
  end if;
 elsif p_operation='prepare' then
  if exists(select 1 from public.posting_staged_media where session_id=s.id and state='uploading') then raise exception 'Finish or remove failed uploads first'; end if;
  update public.posting_upload_sessions set state='finalizing',cleanup_after=greatest(cleanup_after,now()+interval '10 minutes') where id=s.id returning * into s;
 elsif p_operation not in ('create','read') then raise exception 'Invalid operation';
 end if;
 return jsonb_build_object('session',to_jsonb(s),'media',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from public.posting_staged_media x where x.session_id=s.id and x.state<>'removed'),'[]'::jsonb));
end $$;
create function public.posting_v2_session(session_id uuid,operation text,media_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$ select app_security.impl_posting_v2_session(session_id,operation,media_id) $$;
revoke all on function app_security.impl_posting_v2_session(uuid,text,uuid),public.posting_v2_session(uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_posting_v2_session(uuid,text,uuid),public.posting_v2_session(uuid,text,uuid) to authenticated;

-- Trusted media server reports only already-sanitized objects; clients cannot call.
create function app_security.impl_posting_v2_media_ready(session_id uuid,media_id uuid,attempt_id uuid,file_size integer,width integer,height integer) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.posting_upload_sessions; m public.posting_staged_media; begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception using errcode='42501',message='Media service required'; end if;
 select * into s from public.posting_upload_sessions where id=session_id for update;
 if s.state is distinct from 'open' or s.expires_at<=now() then return false; end if;
 if exists(select 1 from public.posting_staged_media x where x.session_id=s.id and x.id=media_id and x.attempt=attempt_id and x.state='ready' and x.file_size=impl_posting_v2_media_ready.file_size and x.width=impl_posting_v2_media_ready.width and x.height=impl_posting_v2_media_ready.height) then return true; end if;
 update public.posting_staged_media x set state='ready',file_size=impl_posting_v2_media_ready.file_size,width=impl_posting_v2_media_ready.width,height=impl_posting_v2_media_ready.height
 where x.id=media_id and x.session_id=s.id and x.attempt=attempt_id and x.state='uploading' returning * into m;
 return m.id is not null;
end $$;
create function public.posting_v2_media_ready(session_id uuid,media_id uuid,attempt_id uuid,file_size integer,width integer,height integer) returns boolean language sql security invoker set search_path='' as $$select app_security.impl_posting_v2_media_ready(session_id,media_id,attempt_id,file_size,width,height)$$;
revoke all on function app_security.impl_posting_v2_media_ready(uuid,uuid,uuid,integer,integer,integer),public.posting_v2_media_ready(uuid,uuid,uuid,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_posting_v2_media_ready(uuid,uuid,uuid,integer,integer,integer),public.posting_v2_media_ready(uuid,uuid,uuid,integer,integer,integer) to service_role;

create function public.posting_v2_catalogue() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('version',2,'revision',coalesce((select max(updated_at)::text from (select updated_at from public.phone_brands union all select updated_at from public.phone_models) r),'seed-v2'),
 'selection',jsonb_build_object('category','mobiles','subcategory','mobile-phones','version',2),
 'listing_category_id',(select listing_category_id from public.posting_category_definitions where category_key='mobiles' and subcategory_key='mobile-phones' and version=2),
 'enabled',coalesce((select d.enabled and c.is_active from public.posting_category_definitions d join public.categories c on c.id=d.listing_category_id where category_key='mobiles' and subcategory_key='mobile-phones' and version=2),false),
 'brands',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'aliases',aliases,'sort_order',sort_order) order by sort_order,id) from public.phone_brands where enabled),'[]'::jsonb),
 'models',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'brand_id',m.brand_id,'name',m.name,'aliases',m.aliases,'older_group',m.older_group,'other',m.other,'sort_order',m.sort_order) order by m.sort_order,m.id) from public.phone_models m join public.phone_brands b on b.id=m.brand_id where m.enabled and b.enabled),'[]'::jsonb))
$$;
revoke all on function public.posting_v2_catalogue() from public,anon;
grant execute on function public.posting_v2_catalogue() to authenticated;

-- Fixed signal identifiers only; never persist contact/payment text in flags.
create function app_security.phone_content_guard(p_text text) returns void language plpgsql set search_path='' as $$ begin
 if p_text ~* '(\+?91[ .-]?)?[6-9]([ .-]?[0-9]){9}([^0-9]|$)|wa\.me/|t\.me/|upi://|[[:alnum:]._-]{2,}@[[:alpha:]][[:alnum:].]{1,}|(paytm\.me|rzp\.io|pay\.google\.com)/' then raise exception using errcode='22023',message='Remove contact numbers, payment IDs and payment links; use FairSwap chat'; end if;
 if p_text ~* '(courier|shipping|delivery|कूरियर|डिलीवरी).{0,40}(fee|charge|advance|pay|शुल्क|पैसे)|(advance|पहले).{0,30}(upi|pay|payment|भुगतान)' then raise exception using errcode='22023',message='Pickup only: remove courier fees and advance payment requests'; end if;
end $$;
revoke all on function app_security.phone_content_guard(text) from public,anon,authenticated,service_role;

create function app_security.impl_submit_mobile_v2(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor(); s public.posting_upload_sessions; d public.posting_category_definitions; model public.phone_models; photo public.posting_staged_media; item jsonb; ids uuid[]; base text; result jsonb; price integer; included text[]; warranty date; locality uuid; city uuid; pin text; category uuid; begin
 if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->'selection' is distinct from jsonb_build_object('category','mobiles','subcategory','mobile-phones','version',2) or p_payload->>'plan_id' is distinct from 'free-v1' then raise exception 'Invalid posting contract'; end if;
 select * into s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='Upload session unavailable'; end if;
 if s.state='submitted' then return jsonb_build_object('success',true,'listing_id',s.listing_id); end if;
 if s.state<>'finalizing' or s.expires_at<=now() then raise exception 'Upload session unavailable'; end if;
 select * into d from public.posting_category_definitions where category_key='mobiles' and subcategory_key='mobile-phones' and version=2 and enabled for share;
 if d.listing_category_id is null then raise exception 'Category unavailable'; end if;
 perform 1 from public.categories where id=d.listing_category_id and is_active for share;
 if not found then raise exception 'Category unavailable'; end if;
 select m.* into model from public.phone_models m join public.phone_brands b on b.id=m.brand_id where m.id=(p_payload->>'model_id')::uuid and m.brand_id=(p_payload->>'brand_id')::uuid and m.enabled and b.enabled;
 if model.id is null or (model.other and length(trim(coalesce(p_payload->>'other_model',''))) not between 2 and 100) or (not model.other and coalesce(p_payload->>'other_model','')<>'') then raise exception 'Select a valid Brand and Model'; end if;
 perform app_security.phone_content_guard(concat_ws(' ',p_payload->>'title',p_payload->>'description',p_payload->>'other_model'));
 if length(trim(p_payload->>'title')) not between 3 and 150 or length(trim(p_payload->>'description')) not between 10 and 5000 then raise exception 'Complete Title and Description'; end if;
 price:=(p_payload->>'price_paise')::integer;
 if p_payload->>'trade' is null or p_payload->>'trade' not in ('sell','giveaway') or price is null or price<0 or price>100000000 or (p_payload->>'trade'='sell' and price<1) or (p_payload->>'trade'='giveaway' and (price<>0 or (p_payload->>'negotiable')::boolean is distinct from false)) then raise exception 'Check Price and trade type'; end if;
 pin:=p_payload->>'pin_code';city:=(p_payload->>'city_id')::uuid;locality:=(p_payload->>'locality_id')::uuid;
 if pin is null or pin!~'^[1-9][0-9]{5}$' or locality is null or city is null or not exists(select 1 from public.postal_pincode_localities p join public.localities l on l.id=p.locality_id join public.cities c on c.id=l.city_id where p.pincode=pin and l.id=locality and l.city_id=city and l.is_active and c.is_active) then raise exception 'Select a valid PIN and locality'; end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'media_ids');
 if coalesce(cardinality(ids),0) not between 1 and 8 or (select count(distinct x) from unnest(ids) x)<>cardinality(ids) or (select count(*) from public.posting_staged_media where session_id=s.id and state='ready' and id=any(ids))<>cardinality(ids) then raise exception 'Choose 1 to 8 ready photos'; end if;
 select coalesce(array_agg(value),'{}') into included from jsonb_array_elements_text(p_payload->'included');
 warranty:=case when coalesce(p_payload->>'warranty_until','')='' then null else ((p_payload->>'warranty_until')||'-01')::date end;
 if warranty is not null and (warranty<date_trunc('month',current_date)::date or warranty>(current_date+interval '10 years')::date) then raise exception 'Check warranty expiry month'; end if;
 insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes)
 values(s.listing_id,u,d.listing_category_id,city,locality,pin,trim(p_payload->>'title'),trim(p_payload->>'description'),(p_payload->>'condition')::public.listing_condition_enum,
 (case when p_payload->>'trade'='giveaway' then 'free' when (p_payload->>'negotiable')::boolean then 'negotiable' else 'fixed' end)::public.listing_price_type_enum,price,'{}');
 insert into public.listing_mobile_contexts(listing_id,category_id,brand_id,model_id,brand_name,model_name,other_model,storage,ram,included,warranty_until)
 values(s.listing_id,d.listing_category_id,model.brand_id,model.id,(select name from public.phone_brands where id=model.brand_id),case when model.other then trim(p_payload->>'other_model') else model.name end,nullif(p_payload->>'other_model',''),p_payload->>'storage',nullif(p_payload->>'ram',''),included,warranty);
 if model.other then insert into public.listing_phone_risk_flags values(s.listing_id,'other_model'); end if;
 if model.older_group then insert into public.listing_phone_risk_flags values(s.listing_id,'older_model_group'); end if;
 if p_payload->>'trade'='giveaway' then insert into public.listing_phone_risk_flags values(s.listing_id,'giveaway'); end if;
 foreach category in array ids loop
  select * into photo from public.posting_staged_media where id=category and session_id=s.id and state='ready' for update;
  base:=s.listing_id::text||'/'||photo.id::text||'/';
  -- Storage preparation is verified by the server before this transaction.
  if (select count(*) from storage.objects where (bucket_id='listing-originals' and name=base||'original.webp') or (bucket_id='listing-derivatives' and name in (base||'thumb.webp',base||'medium.webp',base||'large.webp')))<>4 then raise exception 'Photo preparation incomplete'; end if;
  insert into public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes)
  values(photo.id,s.listing_id,u,'photo.webp','image/webp',photo.file_size);
  update public.listing_media set original_storage_path=base||'original.webp',thumbnail_storage_path=base||'thumb.webp',medium_storage_path=base||'medium.webp',large_storage_path=base||'large.webp',width=photo.width,height=photo.height,processing_status='ready' where id=photo.id;
 end loop;
 -- Keep the installed environment's Goods submission/queue/finalizer behavior.
 result:=public.seller_submit_listing(s.listing_id);
 if result->>'success' is distinct from 'true' then raise exception 'Submission was not acknowledged'; end if;
 update public.posting_upload_sessions set state='submitted',submitted_at=now() where id=s.id;
 perform app_security.log_audit_event('listing.mobile_submitted','listings',s.listing_id,jsonb_build_object('contract_version',2,'plan_id','free-v1'));
 return jsonb_build_object('success',true,'listing_id',s.listing_id);
end $$;
create function public.submit_mobile_v2(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$ select app_security.impl_submit_mobile_v2(payload) $$;
revoke all on function app_security.impl_submit_mobile_v2(jsonb),public.submit_mobile_v2(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_submit_mobile_v2(jsonb),public.submit_mobile_v2(jsonb) to authenticated;

-- Mandatory typed contract at database boundaries, including legacy API edits.
create function app_security.mobile_listing_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if exists(select 1 from public.posting_category_definitions where listing_category_id=new.category_id) then
  perform app_security.phone_content_guard(concat_ws(' ',new.title,new.description));
  if new.price_type='free' and new.price_paise is distinct from 0 then raise exception 'Give away requires zero price'; end if;
  if new.price_type<>'free' and (new.price_paise is null or new.price_paise<=0) then raise exception 'Sell requires a positive price'; end if;
  if tg_op='UPDATE' and new.category_id is distinct from old.category_id then raise exception 'Mobile category reassignment requires a new typed posting'; end if;
  if tg_op='UPDATE' and new.status in ('pending_review','active','reserved','paused') and not exists(select 1 from public.listing_mobile_contexts where listing_id=new.id and category_id=new.category_id) then raise exception 'Mobile context required'; end if;
  if tg_op='UPDATE' and new.status='active' and old.status is distinct from new.status and exists(select 1 from public.listing_phone_risk_flags where listing_id=new.id and signal in ('other_model','older_model_group')) and not app_security.is_active_staff_aal2('moderator') then raise exception 'Mobile model requires staff review'; end if;
 elsif tg_op='UPDATE' and exists(select 1 from public.listing_mobile_contexts where listing_id=old.id) then raise exception 'Mobile category reassignment requires a new typed posting';
 end if;
 return new;
end $$;
revoke all on function app_security.mobile_listing_guard() from public,anon,authenticated,service_role;
create trigger zz_mobile_listing_guard before insert or update on public.listings for each row execute function app_security.mobile_listing_guard();

-- Staff catalogue mutations never accept security/release metadata.
create function app_security.impl_admin_phone_catalogue(p_kind text,p_entry jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare target uuid:=coalesce((p_entry->>'id')::uuid,gen_random_uuid()); aliases text[]; begin
 if not app_security.is_active_staff_aal2('content_editor') or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Staff MFA and policy acceptance required'; end if;
 if p_kind not in ('brand','model') or p_entry-array['id','name','aliases','enabled','sort_order','brand_id','older_group','other']<>'{}'::jsonb then raise exception 'Invalid catalogue input'; end if;
 select coalesce(array_agg(trim(value)),'{}') into aliases from jsonb_array_elements_text(p_entry->'aliases');
 if exists(select 1 from unnest(aliases) a where length(a) not between 1 and 100) then raise exception 'Invalid alias'; end if;
 if p_kind='brand' then
  insert into public.phone_brands(id,name,aliases,enabled,sort_order) values(target,trim(p_entry->>'name'),aliases,(p_entry->>'enabled')::boolean,(p_entry->>'sort_order')::integer)
  on conflict(id) do update set name=excluded.name,aliases=excluded.aliases,enabled=excluded.enabled,sort_order=excluded.sort_order,updated_at=clock_timestamp();
 else
  insert into public.phone_models(id,brand_id,name,aliases,enabled,sort_order,older_group,other) values(target,(p_entry->>'brand_id')::uuid,trim(p_entry->>'name'),aliases,(p_entry->>'enabled')::boolean,(p_entry->>'sort_order')::integer,(p_entry->>'older_group')::boolean,(p_entry->>'other')::boolean)
  on conflict(id) do update set name=excluded.name,aliases=excluded.aliases,enabled=excluded.enabled,sort_order=excluded.sort_order,older_group=excluded.older_group,other=excluded.other,updated_at=clock_timestamp();
 end if;
 perform app_security.log_audit_event('catalogue.phone_updated','phone_'||p_kind,target,jsonb_build_object('enabled',p_entry->'enabled'));
 return jsonb_build_object('success',true);
end $$;
create function public.admin_phone_catalogue(kind text,entry jsonb) returns jsonb language sql security invoker set search_path='' as $$ select app_security.impl_admin_phone_catalogue(kind,entry) $$;
revoke all on function app_security.impl_admin_phone_catalogue(text,jsonb),public.admin_phone_catalogue(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_admin_phone_catalogue(text,jsonb),public.admin_phone_catalogue(text,jsonb) to authenticated;

-- Service cleanup claims expired sessions under the SAME lock as finalization.
-- Repeated claims include failed attempts; only acknowledged storage deletion marks cleaned.
create function app_security.impl_posting_v2_cleanup(operation text,session_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.posting_upload_sessions; items jsonb:='[]'; begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception using errcode='42501',message='Cleanup service required'; end if;
 if operation='ack' then
  delete from public.posting_upload_sessions where id=session_id and state in ('expired','submitted') and cleanup_after<=now();return '[]';
 elsif operation<>'claim' then raise exception 'Invalid cleanup operation'; end if;
 for s in select * from public.posting_upload_sessions where cleanup_after<=now() and state<>'cleaned' order by cleanup_after,id limit 50 for update skip locked loop
  if s.state<>'submitted' then update public.posting_upload_sessions set state='expired' where id=s.id; end if;
  items:=items||jsonb_build_array(jsonb_build_object('id',s.id,'owner_id',s.owner_id,'listing_id',s.listing_id,'submitted',s.state='submitted',
   'attached',coalesce((select jsonb_agg(id) from public.listing_media where listing_id=s.listing_id),'[]'::jsonb),
   'media',coalesce((select jsonb_agg(jsonb_build_object('id',id,'attempt',attempt)) from public.posting_staged_media where posting_staged_media.session_id=s.id),'[]'::jsonb)));
 end loop;
 return items;
end $$;
create function public.posting_v2_cleanup(operation text,session_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$select app_security.impl_posting_v2_cleanup(operation,session_id)$$;
revoke all on function app_security.impl_posting_v2_cleanup(text,uuid),public.posting_v2_cleanup(text,uuid) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_posting_v2_cleanup(text,uuid),public.posting_v2_cleanup(text,uuid) to service_role;
commit;
