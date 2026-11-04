-- Accessories V1 foundation. Apply only through ledger-matched environment release workspace.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
 if not exists(select 1 from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('app_security.impl_submit_mobile_v2(jsonb)') and md5(prosrc)='0fdb04c63a19dc4207fdcfe054c021ae' and prosecdef and proconfig @> array['search_path=""']) then raise exception 'ACCESSORIES_PHONE_IMPLEMENTATION_DRIFT: review installed phone function before release';end if;
 if to_regprocedure('public.submit_mobile_v2(jsonb)') is null or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='posting_upload_sessions' and column_name='draft_protected') then raise exception 'Posting V2.1.2 prerequisite missing'; end if;
end $$;
create table public.accessory_release_v1 (singleton boolean primary key default true check(singleton), category_id uuid not null unique references public.categories,enabled boolean not null default false);
create table public.accessory_types_v1 (id text primary key,definition jsonb not null);
create table public.listing_accessory_contexts (
 listing_id uuid primary key references public.listings on delete cascade,
 contract_version integer not null default 1 check(contract_version=1),category_id uuid not null references public.categories,
 accessory_type text not null references public.accessory_types_v1,brand text not null,device_brand text not null,device_model text not null,condition text not null,
 details jsonb not null check(jsonb_typeof(details)='object')
);
create index accessory_filter_v1 on public.listing_accessory_contexts(accessory_type,brand,device_brand,device_model,condition);
do $$ declare t text;begin foreach t in array array['accessory_release_v1','accessory_types_v1','listing_accessory_contexts'] loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
end loop;end $$;
grant select on public.accessory_release_v1,public.accessory_types_v1 to anon,authenticated;
create policy accessory_release_read on public.accessory_release_v1 for select to anon,authenticated using(true);
create policy accessory_types_read on public.accessory_types_v1 for select to anon,authenticated using(true);
grant select on public.listing_accessory_contexts to anon,authenticated;
create policy accessory_context_read on public.listing_accessory_contexts for select to anon,authenticated using(app_security.is_listing_publicly_visible(listing_id) or exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid())) or app_security.is_active_staff_aal2('moderator'));
insert into public.categories(slug,name,description,sort_order,is_active,macro_category,new_listing_enabled)
 values('mobile-accessories','Mobile & Tablet Accessories','Phone, tablet and wearable accessories; seller-declared compatibility',21,false,'goods',false) on conflict(slug) do nothing;
do $$ begin
 if not exists(select 1 from public.categories where slug='mobile-accessories' and macro_category='goods' and not new_listing_enabled) or exists(select 1 from public.category_attributes a join public.categories c on c.id=a.category_id where c.slug='mobile-accessories' and a.is_required) or exists(select 1 from public.posting_category_definitions d join public.categories c on c.id=d.listing_category_id where c.slug='mobile-accessories') then raise exception 'Existing Accessories category conflicts with typed contract';end if;
 if exists(select 1 from public.listings l join public.categories c on c.id=l.category_id where c.slug='mobile-accessories') then raise exception 'Existing Accessories listings require a reviewed backfill before this foundation';end if;
end $$;
insert into public.accessory_release_v1(category_id) select id from public.categories where slug='mobile-accessories';
insert into public.accessory_types_v1 values('phone-case',$taxonomy${"id":"phone-case","name":"Phone case, cover or skin","group":0,"exact":true,"electronic":false,"safety":false,"guide":"Front, rear, edges and model marking.","specs":[{"key":"variant","label":"Exact size / variant","kind":"text"},{"key":"material","label":"Material","kind":"text"},{"key":"colour","label":"Colour","kind":"text"},{"key":"magnetic","label":"Magnetic charging support","kind":"select","options":["Yes","No","Not sure"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('tablet-case',$taxonomy${"id":"tablet-case","name":"Tablet cover or case","group":0,"exact":true,"electronic":false,"safety":false,"guide":"Front, rear, corners and tablet size marking.","specs":[{"key":"variant","label":"Exact size / variant","kind":"text"},{"key":"material","label":"Material","kind":"text"},{"key":"colour","label":"Colour","kind":"text"},{"key":"magnetic","label":"Magnetic charging support","kind":"select","options":["Yes","No","Not sure"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('watch-strap',$taxonomy${"id":"watch-strap","name":"Watch strap or band","group":0,"exact":true,"electronic":false,"safety":false,"guide":"Both connectors, clasp and any wear.","specs":[{"key":"connector","label":"Connector system","kind":"text"},{"key":"size","label":"Connector / strap size","kind":"text"},{"key":"material","label":"Strap material","kind":"text"},{"key":"wrist","label":"Wrist size / length","kind":"text"},{"key":"clasp","label":"Clasp condition","kind":"select","options":["Unused","Good","Worn","Damaged"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('watch-case',$taxonomy${"id":"watch-case","name":"Watch case or screen protector","group":1,"exact":true,"electronic":false,"safety":false,"guide":"Front, edges and exact size marking.","specs":[{"key":"variant","label":"Exact size / variant","kind":"text"},{"key":"material","label":"Material","kind":"text"},{"key":"colour","label":"Colour","kind":"text"},{"key":"magnetic","label":"Magnetic charging support","kind":"select","options":["Yes","No","Not sure"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('phone-protector',$taxonomy${"id":"phone-protector","name":"Phone screen protector","group":1,"exact":true,"electronic":false,"safety":false,"guide":"Packaging, edges and model marking.","specs":[{"key":"material","label":"Material","kind":"text"},{"key":"variant","label":"Exact size / variant","kind":"text"}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('tablet-protector',$taxonomy${"id":"tablet-protector","name":"Tablet screen protector","group":1,"exact":true,"electronic":false,"safety":false,"guide":"Packaging, edges and generation marking.","specs":[{"key":"material","label":"Material","kind":"text"},{"key":"variant","label":"Exact size / variant","kind":"text"}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('charger',$taxonomy${"id":"charger","name":"Charger or charging adapter","group":2,"exact":false,"electronic":true,"safety":true,"guide":"Front, back, output specifications and connector.","specs":[{"key":"port","label":"Port type","kind":"select","options":["USB-C","USB-A","Lightning","Micro-USB","Proprietary","Other"]},{"key":"watts","label":"Output power (W)","kind":"number","min":1,"max":500},{"key":"protocol","label":"Charging protocol","kind":"select","options":["USB PD","USB PD + PPS","Qi","Qi2","Proprietary","Other","Not sure"]},{"key":"ports","label":"Number of ports","kind":"number","min":1,"max":16,"integer":true},{"key":"plug","label":"Plug type","kind":"select","options":["India two-pin","India three-pin","USB powered","Other"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('wireless-charger',$taxonomy${"id":"wireless-charger","name":"Wireless charger","group":2,"exact":false,"electronic":true,"safety":true,"guide":"Charging surface, underside specifications and power input.","specs":[{"key":"port","label":"Port type","kind":"select","options":["USB-C","USB-A","Lightning","Micro-USB","Proprietary","Other"]},{"key":"watts","label":"Output power (W)","kind":"number","min":1,"max":500},{"key":"protocol","label":"Charging protocol","kind":"select","options":["USB PD","USB PD + PPS","Qi","Qi2","Proprietary","Other","Not sure"]},{"key":"ports","label":"Number of ports","kind":"number","min":1,"max":16,"integer":true},{"key":"plug","label":"Plug type","kind":"select","options":["India two-pin","India three-pin","USB powered","Other"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('watch-charger',$taxonomy${"id":"watch-charger","name":"Watch charger or charging dock","group":2,"exact":true,"electronic":true,"safety":true,"guide":"Charging connector, dock and model marking.","specs":[{"key":"port","label":"Port type","kind":"select","options":["USB-C","USB-A","Lightning","Micro-USB","Proprietary","Other"]},{"key":"watts","label":"Output power (W)","kind":"number","min":1,"max":500},{"key":"protocol","label":"Charging protocol","kind":"select","options":["USB PD","USB PD + PPS","Qi","Qi2","Proprietary","Other","Not sure"]},{"key":"ports","label":"Number of ports","kind":"number","min":1,"max":16,"integer":true},{"key":"plug","label":"Plug type","kind":"select","options":["India two-pin","India three-pin","USB powered","Other"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('tablet-charging',$taxonomy${"id":"tablet-charging","name":"Tablet charging accessory","group":2,"exact":false,"electronic":true,"safety":true,"guide":"Connectors and output specifications.","specs":[{"key":"port","label":"Port type","kind":"select","options":["USB-C","USB-A","Lightning","Micro-USB","Proprietary","Other"]},{"key":"watts","label":"Output power (W)","kind":"number","min":1,"max":500},{"key":"protocol","label":"Charging protocol","kind":"select","options":["USB PD","USB PD + PPS","Qi","Qi2","Proprietary","Other","Not sure"]},{"key":"ports","label":"Number of ports","kind":"number","min":1,"max":16,"integer":true},{"key":"plug","label":"Plug type","kind":"select","options":["India two-pin","India three-pin","USB powered","Other"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('cable',$taxonomy${"id":"cable","name":"Charging or data cable","group":3,"exact":false,"electronic":true,"safety":true,"guide":"Both connectors, length and any fraying.","specs":[{"key":"end_a","label":"Connector at first end","kind":"select","options":["USB-C","USB-A","Lightning","Micro-USB","Proprietary","Other"]},{"key":"end_b","label":"Connector at second end","kind":"select","options":["USB-C","USB-A","Lightning","Micro-USB","Proprietary","Other"]},{"key":"length_m","label":"Length (metres)","kind":"number","min":0.1,"max":20},{"key":"watts","label":"Charging capability (W)","kind":"number","min":1,"max":500},{"key":"data","label":"Data-transfer support","kind":"select","options":["Charging only","USB 2","USB 3","USB 4","Thunderbolt","Not sure"]},{"key":"cable_condition","label":"Cable condition","kind":"select","options":["No fraying or exposed wires","Damaged / exposed wires"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('hub',$taxonomy${"id":"hub","name":"USB-C hub or dock","group":3,"exact":false,"electronic":true,"safety":false,"guide":"All ports, input connector and specification label.","specs":[{"key":"input","label":"Input connector","kind":"select","options":["USB-C","USB-A","Lightning","Micro-USB","Proprietary","Other"]},{"key":"outputs","label":"Output ports and standards","kind":"text"},{"key":"watts","label":"Pass-through power (W)","kind":"number","min":0,"max":500}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('power-bank',$taxonomy${"id":"power-bank","name":"Power bank","group":4,"exact":false,"electronic":true,"safety":true,"guide":"All sides, capacity label, ports and any damage.","specs":[{"key":"capacity","label":"Capacity (mAh)","kind":"number","min":100,"max":100000,"integer":true},{"key":"watts","label":"Output power (W)","kind":"number","min":1,"max":500},{"key":"ports","label":"Ports","kind":"text"},{"key":"wireless","label":"Wireless charging","kind":"select","options":["Yes","No","Not sure"]},{"key":"age_months","label":"Approximate age (months)","kind":"number","min":0,"max":240,"integer":true},{"key":"battery","label":"Charging / battery performance","kind":"select","options":["Normal","Reduced capacity","Not tested"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('audio',$taxonomy${"id":"audio","name":"Earphones, earbuds or headphones","group":5,"exact":false,"electronic":true,"safety":true,"guide":"Both earpieces, charging case and included accessories.","specs":[{"key":"connection","label":"Connection","kind":"select","options":["Wired","Wireless"]},{"key":"bluetooth","label":"Bluetooth support","kind":"select","options":["4.x","5.x","6.x","Not sure"],"when":{"key":"connection","value":"Wireless"}},{"key":"earpieces","label":"Both earpieces included","kind":"select","options":["Yes","No","Single-ear product"]},{"key":"case","label":"Charging case included","kind":"select","options":["Yes","No","Not applicable"]},{"key":"audio","label":"Microphone / audio condition","kind":"select","options":["Working","Faulty","Not tested"]},{"key":"battery","label":"Battery performance","kind":"select","options":["Normal","Reduced capacity","Not tested","Not applicable"]},{"key":"anc","label":"Active noise cancellation","kind":"select","options":["Yes","No","Not sure"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('keyboard-case',$taxonomy${"id":"keyboard-case","name":"Tablet keyboard case or folio","group":6,"exact":true,"electronic":true,"safety":false,"guide":"Keyboard, connector, keys and generation marking.","specs":[{"key":"layout","label":"Keyboard layout","kind":"text"},{"key":"pairing","label":"Pairing / connector","kind":"select","options":["Bluetooth","USB-C","Smart connector","Other"]},{"key":"trackpad","label":"Trackpad","kind":"select","options":["Yes","No","Not sure"]},{"key":"backlight","label":"Backlight","kind":"select","options":["Yes","No","Not sure"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('stylus',$taxonomy${"id":"stylus","name":"Stylus or digital pen","group":6,"exact":true,"electronic":true,"safety":false,"guide":"Pen body, nib and model / generation marking.","specs":[{"key":"generation","label":"Pen generation","kind":"text"},{"key":"pairing","label":"Pairing / connector","kind":"select","options":["Bluetooth","USB-C","Lightning","Magnetic","Passive / capacitive","Other"]},{"key":"nib","label":"Nib condition","kind":"select","options":["Unused","Good","Worn","Needs replacement"]}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('phone-stand',$taxonomy${"id":"phone-stand","name":"Phone mount, holder or stand","group":6,"exact":false,"electronic":false,"safety":false,"guide":"Mount, joints and attachment points.","specs":[{"key":"mount","label":"Mount / attachment","kind":"text"},{"key":"size","label":"Supported size","kind":"text"},{"key":"material","label":"Material","kind":"text"}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('tablet-stand',$taxonomy${"id":"tablet-stand","name":"Tablet stand or mount","group":6,"exact":false,"electronic":false,"safety":false,"guide":"Mount, joints and supported size marking.","specs":[{"key":"mount","label":"Mount / attachment","kind":"text"},{"key":"size","label":"Supported size","kind":"text"},{"key":"material","label":"Material","kind":"text"}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('strap-adapter',$taxonomy${"id":"strap-adapter","name":"Watch strap connector or adapter","group":0,"exact":true,"electronic":false,"safety":false,"guide":"Both connectors and size marking.","specs":[{"key":"connector","label":"Connector system","kind":"text"},{"key":"size","label":"Size","kind":"text"}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('other-phone',$taxonomy${"id":"other-phone","name":"Other phone accessory","group":6,"exact":false,"electronic":true,"safety":true,"guide":"Whole item, model markings and any faults.","specs":[{"key":"purpose","label":"Accessory purpose","kind":"text"}]}$taxonomy$::jsonb);
insert into public.accessory_types_v1 values('other-wearable',$taxonomy${"id":"other-wearable","name":"Other wearable accessory","group":6,"exact":true,"electronic":true,"safety":true,"guide":"Whole item, connector and model markings. Watches themselves use Smartwatches & Wearables.","specs":[{"key":"purpose","label":"Accessory purpose","kind":"text"}]}$taxonomy$::jsonb);

create function public.accessories_v1_catalogue() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('version',1,'revision','accessories-v1','listing_category_id',r.category_id,'enabled',r.enabled and c.is_active) from public.accessory_release_v1 r join public.categories c on c.id=r.category_id
$$;
revoke all on function public.accessories_v1_catalogue() from public,anon,authenticated,service_role;
grant execute on function public.accessories_v1_catalogue() to authenticated;

create function app_security.validate_accessory_v1(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare t jsonb;spec jsonb;val jsonb;k text;keys text[];begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid accessory contract';end if;
 keys:=array['selection','session_id','type','brand','other_brand','product_model','originality','compatibility','specs','quantity','bundle_contents','condition','working','faults','bill','box','warranty_until','safety','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id'];
 if p-keys<>'{}' or not(p?&keys) or p->'selection' is distinct from '{"category":"mobiles","subcategory":"mobile-accessories","version":1}'::jsonb or p->>'plan_id' is distinct from 'free-v1' then raise exception 'Invalid accessory contract';end if;
 foreach k in array array['session_id','type','brand','other_brand','product_model','originality','bundle_contents','condition','working','faults','warranty_until','safety','title','description','trade','pin_code','city_id','locality_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'Invalid accessory field';end if;
 end loop;
 foreach k in array array['bill','box','negotiable'] loop if jsonb_typeof(p->k) is distinct from 'boolean' then raise exception 'Invalid accessory boolean';end if;end loop;
 if jsonb_typeof(p->'quantity') is distinct from 'number' or (p->>'quantity')!~'^[0-9]+$' or (p->>'quantity')::integer not between 1 and 100 or jsonb_typeof(p->'price_paise') is distinct from 'number' or (p->>'price_paise')!~'^[0-9]+$' or (p->>'price_paise')::bigint>100000000 then raise exception 'Invalid quantity or price';end if;
 select definition into t from public.accessory_types_v1 where id=p->>'type';if t is null then raise exception 'Unknown accessory type';end if;
 if not(p->>'brand'=any(array['Apple','Samsung','Spigen','Anker','Belkin','boAt','Noise','Portronics','Ambrane','Zebronics','Xiaomi','OnePlus','Other','Unbranded']::text[])) or length(trim(p->>'other_brand'))>80 or length(trim(p->>'product_model'))>100 or length(trim(p->>'bundle_contents')) not between 2 and 500 or length(trim(p->>'faults'))>1000 or length(trim(p->>'title')) not between 3 and 150 or length(trim(p->>'description')) not between 10 and 5000 then raise exception 'Invalid accessory details';end if;
 if (p->>'brand'='Other' and length(trim(p->>'other_brand'))<2) or (p->>'brand'<>'Other' and p->>'other_brand'<>'') or p->>'originality' not in ('original','third_party','unbranded','unknown') or (p->>'brand'='Unbranded' and p->>'originality'<>'unbranded') then raise exception 'Invalid manufacturer declaration';end if;
 if p->>'type' in ('stylus','keyboard-case','audio') and length(trim(p->>'product_model'))<2 then raise exception 'Model/name required';end if;
 val:=p->'compatibility';
 if jsonb_typeof(val) is distinct from 'object' or val-array['state','device_brand','device_model','standard']<>'{}' or not(val?&array['state','device_brand','device_model','standard']) or val->>'state' not in ('seller','unknown') or jsonb_typeof(val->'state') is distinct from 'string' then raise exception 'Invalid compatibility declaration';end if;
 foreach k in array array['device_brand','device_model','standard'] loop if jsonb_typeof(val->k) is distinct from 'string' or length(val->>k)>(case k when 'device_brand' then 80 when 'device_model' then 100 else 120 end) then raise exception 'Invalid compatibility field';end if;end loop;
 if (val->>'state'='unknown' and (val->>'device_brand'<>'' or val->>'device_model'<>'' or val->>'standard'<>'')) or (val->>'state'='seller' and ((t->>'exact')::boolean and (trim(val->>'device_brand')='' or trim(val->>'device_model')='') or not(t->>'exact')::boolean and trim(val->>'standard')='' and trim(val->>'device_model')='')) then raise exception 'Declare exact device/generation or supported standard';end if;
 if jsonb_typeof(p->'specs') is distinct from 'object' then raise exception 'Invalid specifications';end if;
 keys:='{}';for spec in select value from jsonb_array_elements(t->'specs') loop
  if spec?'when' and p->'specs'->>(spec->'when'->>'key') is distinct from spec->'when'->>'value' then continue;end if;
  k:=spec->>'key';keys:=array_append(keys,k);val:=p->'specs'->k;
  if spec->>'kind'='number' then
   if jsonb_typeof(val) is distinct from 'number' then raise exception 'Numeric specification required';end if;
   if coalesce((spec->>'integer')::boolean,false) and mod((val#>>'{}')::numeric,1)<>0 then raise exception 'Integer specification required';end if;
   if (val#>>'{}')::numeric<(spec->>'min')::numeric or (val#>>'{}')::numeric>(spec->>'max')::numeric then raise exception 'Invalid specification range';end if;
  else
   if jsonb_typeof(val) is distinct from 'string' or length(trim(val#>>'{}')) not between 1 and 150 or (spec?'options' and not(spec->'options' @> jsonb_build_array(val))) then raise exception 'Invalid specification value';end if;
  end if;
 end loop;
 if (p->'specs')-keys<>'{}' then raise exception 'Unexpected specification';end if;
 if p->>'condition' not in ('sealed','open_box','like_new','good','fair','parts') or p->>'working' not in ('working','faulty','not_tested','not_applicable') or ((t->>'electronic')::boolean=(p->>'working'='not_applicable')) or (p->>'working'='faulty' or p->>'condition'='parts') and length(trim(p->>'faults'))<3 then raise exception 'Invalid condition/functional declaration';end if;
 if (t->>'safety')::boolean and p->>'safety'<>'safe' or not(t->>'safety')::boolean and p->>'safety'<>'not_applicable' or p->'specs'->>'cable_condition'='Damaged / exposed wires' then raise exception 'Unsafe items cannot be listed';end if;
 if p->>'warranty_until'<>'' and (p->>'warranty_until'!~'^[0-9]{4}-(0[1-9]|1[0-2])$' or (p->>'warranty_until'||'-01')::date<date_trunc('month',current_date)::date or (p->>'warranty_until'||'-01')::date>(current_date+interval '10 years')::date) then raise exception 'Invalid warranty';end if;
 if p->>'trade' not in ('sell','giveaway') or p->>'trade'='sell' and (p->>'price_paise')::integer<1 or p->>'trade'='giveaway' and ((p->>'price_paise')::integer<>0 or (p->>'negotiable')::boolean) then raise exception 'Invalid price/trade';end if;
 -- Scan all seller-authored structured fields as well as title/description.
 perform app_security.phone_content_guard(concat_ws(' ',p->>'title',p->>'description',p->>'other_brand',p->>'product_model',p->>'bundle_contents',p->>'faults',(p->'compatibility')::text,(p->'specs')::text));
end $$;
revoke all on function app_security.validate_accessory_v1(jsonb) from public,anon,authenticated,service_role;

create function app_security.accessory_listing_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare ctx public.listing_accessory_contexts; expected text;begin
 if tg_op='UPDATE' and old.category_id is distinct from new.category_id and (exists(select 1 from public.accessory_release_v1 where category_id=old.category_id) or exists(select 1 from public.accessory_release_v1 where category_id=new.category_id)) then raise exception 'Accessory category reassignment requires a new typed posting';end if;
 if exists(select 1 from public.accessory_release_v1 where category_id=new.category_id) then
  perform app_security.phone_content_guard(concat_ws(' ',new.title,new.description));
  if new.price_paise is null or new.price_paise>100000000 or new.price_type='free' and new.price_paise<>0 or new.price_type<>'free' and new.price_paise<1 then raise exception 'Invalid accessory price';end if;
  if new.status in ('pending_review','active','reserved','paused') then
   select * into ctx from public.listing_accessory_contexts where listing_id=new.id and category_id=new.category_id;
   if ctx.listing_id is null then raise exception 'Accessory context required';end if;
   expected:=case ctx.condition when 'sealed' then 'new' when 'open_box' then 'like_new' when 'parts' then 'poor' else ctx.condition end;
   if new.condition::text is distinct from expected then raise exception 'Accessory condition must match structured context';end if;
  end if;
 end if;return new;
end $$;
revoke all on function app_security.accessory_listing_guard_v1() from public,anon,authenticated,service_role;
create trigger zz_accessory_listing_guard_v1 before insert or update on public.listings for each row execute function app_security.accessory_listing_guard_v1();

create function app_security.impl_submit_accessory_v1(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor();s public.posting_upload_sessions;r public.accessory_release_v1;photo public.posting_staged_media;ids uuid[];photo_id uuid;base text;result jsonb;city uuid;locality uuid;pin text;begin
 perform app_security.validate_accessory_v1(p_payload);
 select * into s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='Upload session unavailable';end if;
 if s.state='submitted' then
  if not exists(select 1 from public.listing_accessory_contexts where listing_id=s.listing_id) then raise exception 'Cross-category session';end if;
  return jsonb_build_object('success',true,'listing_id',s.listing_id);
 end if;
 if s.state<>'finalizing' or s.expires_at<=now() then raise exception 'Upload session unavailable';end if;
 select r1.* into r from public.accessory_release_v1 r1 join public.categories c on c.id=r1.category_id where r1.enabled and c.is_active for share of r1,c;
 if r.category_id is null then raise exception 'Accessory category unavailable';end if;
 city:=(p_payload->>'city_id')::uuid;locality:=(p_payload->>'locality_id')::uuid;pin:=p_payload->>'pin_code';
 if pin!~'^[1-9][0-9]{5}$' or not exists(select 1 from public.postal_pincode_localities p join public.localities l on l.id=p.locality_id join public.cities c on c.id=l.city_id where p.pincode=pin and l.id=locality and l.city_id=city and l.is_active and c.is_active) then raise exception 'Invalid PIN/locality';end if;
 if jsonb_typeof(p_payload->'media_ids') is distinct from 'array' then raise exception 'Invalid photos';end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'media_ids');
 if coalesce(cardinality(ids),0) not between 1 and 8 or (select count(distinct x) from unnest(ids) x)<>cardinality(ids) or (select count(*) from public.posting_staged_media where session_id=s.id and state='ready' and id=any(ids))<>cardinality(ids) then raise exception 'Choose 1 to 8 ready photos';end if;
 insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes)
 values(s.listing_id,u,r.category_id,city,locality,pin,trim(p_payload->>'title'),trim(p_payload->>'description'),(case p_payload->>'condition' when 'sealed' then 'new' when 'open_box' then 'like_new' when 'parts' then 'poor' else p_payload->>'condition' end)::public.listing_condition_enum,(case when p_payload->>'trade'='giveaway' then 'free' when (p_payload->>'negotiable')::boolean then 'negotiable' else 'fixed' end)::public.listing_price_type_enum,(p_payload->>'price_paise')::integer,'{}');
 insert into public.listing_accessory_contexts(listing_id,category_id,accessory_type,brand,device_brand,device_model,condition,details)
 values(s.listing_id,r.category_id,p_payload->>'type',case when p_payload->>'brand'='Other' then p_payload->>'other_brand' else p_payload->>'brand' end,p_payload->'compatibility'->>'device_brand',p_payload->'compatibility'->>'device_model',p_payload->>'condition',p_payload-array['selection','session_id','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id']);
 foreach photo_id in array ids loop
  select * into photo from public.posting_staged_media where posting_staged_media.id=photo_id and session_id=s.id and state='ready' for update;
  base:=s.listing_id::text||'/'||photo.id::text||'/';
  if (select count(*) from storage.objects where (bucket_id='listing-originals' and name=base||'original.webp') or (bucket_id='listing-derivatives' and name in (base||'thumb.webp',base||'medium.webp',base||'large.webp')))<>4 then raise exception 'Photo preparation incomplete';end if;
  insert into public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes) values(photo.id,s.listing_id,u,'photo.webp','image/webp',photo.file_size);
  update public.listing_media set original_storage_path=base||'original.webp',thumbnail_storage_path=base||'thumb.webp',medium_storage_path=base||'medium.webp',large_storage_path=base||'large.webp',width=photo.width,height=photo.height,processing_status='ready' where listing_media.id=photo.id;
 end loop;
 result:=public.seller_submit_listing(s.listing_id);if result->>'success' is distinct from 'true' then raise exception 'Submission was not acknowledged';end if;
 update public.posting_upload_sessions set state='submitted',submitted_at=now() where posting_upload_sessions.id=s.id;
 perform app_security.log_audit_event('listing.accessory_submitted','listings',s.listing_id,jsonb_build_object('contract_version',1));
 return jsonb_build_object('success',true,'listing_id',s.listing_id);
end $$;
create function public.submit_accessory_v1(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select app_security.impl_submit_accessory_v1(payload)$$;
revoke all on function app_security.impl_submit_accessory_v1(jsonb),public.submit_accessory_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_submit_accessory_v1(jsonb),public.submit_accessory_v1(jsonb) to authenticated;
-- Preserve the complete phone implementation; only reject a cross-category submitted retry.
create or replace function app_security.impl_submit_mobile_v2(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor(); s public.posting_upload_sessions; d public.posting_category_definitions; model public.phone_models; photo public.posting_staged_media; item jsonb; ids uuid[]; base text; result jsonb; price integer; included text[]; warranty date; locality uuid; city uuid; pin text; category uuid; begin
 if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->'selection' is distinct from jsonb_build_object('category','mobiles','subcategory','mobile-phones','version',2) or p_payload->>'plan_id' is distinct from 'free-v1' then raise exception 'Invalid posting contract'; end if;
 select * into s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='Upload session unavailable'; end if;
 if s.state='submitted' then if exists(select 1 from public.listing_accessory_contexts where listing_id=s.listing_id) then raise exception 'Cross-category session';end if;return jsonb_build_object('success',true,'listing_id',s.listing_id); end if;
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

-- Shared media sessions are available for either independently enabled typed category.
create or replace function app_security.impl_posting_v2_session(p_session_id uuid,p_operation text,p_media_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor(); s public.posting_upload_sessions; m public.posting_staged_media; n integer; candidate_id uuid; request_id uuid; empty_allocation boolean:=false;
begin
 if p_operation='list_recovery' then
  return pg_catalog.jsonb_build_object('limit',5,'sessions',coalesce((
   select pg_catalog.jsonb_agg(q.item order by q.created_at,q.id) from (
    select candidate.id,candidate.created_at,pg_catalog.jsonb_build_object(
     'id',candidate.id,'state',candidate.state,'created_at',candidate.created_at,'expires_at',candidate.expires_at,
     'draft_protected',candidate.draft_protected,
     'can_rotate',not candidate.draft_protected and candidate.empty_request_id is not null and candidate.state='open' and not exists(select 1 from public.posting_staged_media pm where pm.session_id=candidate.id),
     'can_abandon',candidate.state='open' and not exists(select 1 from public.posting_staged_media pm where pm.session_id=candidate.id)
    ) as item from public.posting_upload_sessions candidate
    where candidate.owner_id=u and candidate.state in ('open','finalizing') and candidate.expires_at>now()
    order by candidate.created_at,candidate.id limit 5
   ) q),'[]'::jsonb));
 end if;
 -- Same seller lock as creation: capacity release and allocation serialize.
 if p_operation in ('create','create_empty','claim_draft','read','abandon_empty') then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,2));
 end if;
 if p_operation in ('create','create_empty') then
  if not exists(select 1 from public.posting_category_definitions where category_key='mobiles' and subcategory_key='mobile-phones' and version=2 and enabled) and not exists(select 1 from public.accessory_release_v1 r join public.categories c on c.id=r.category_id where r.enabled and c.is_active) then raise exception 'Posting unavailable'; end if;
  if p_operation='create_empty' then
   -- A caller-supplied/local draft UUID can NEVER be certified empty. The request
   -- nonce is only an owner-scoped idempotency key; the new session id is server-minted.
   if p_session_id is null then raise exception using errcode='22023',message='Invalid empty allocation request'; end if;
   request_id:=p_session_id;
   select existing.id into candidate_id from public.posting_upload_sessions existing where existing.owner_id=u and existing.empty_request_id=request_id;
   if candidate_id is not null then p_session_id:=candidate_id;
   else p_session_id:=pg_catalog.gen_random_uuid(); empty_allocation:=true; end if;
  end if;
  -- Reject collisions before retirement, including a supplied id owned elsewhere.
  if exists(select 1 from public.posting_upload_sessions existing where existing.id=p_session_id and existing.owner_id<>u) then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
  if not exists(select 1 from public.posting_upload_sessions existing where existing.id=p_session_id and existing.owner_id=u)
   and (select count(*) from public.posting_upload_sessions where owner_id=u and state in ('open','finalizing') and expires_at>now())>=5 then
   -- Draft protection is monotonic. Null/legacy knowledge is protected by default.
   -- Reserve/prepare/claim take the same session row lock and protect before writing.
   select candidate.id into candidate_id from public.posting_upload_sessions candidate
    where candidate.owner_id=u and candidate.state='open' and candidate.expires_at>now()
     and not candidate.draft_protected and candidate.empty_request_id is not null
     and not exists(select 1 from public.posting_staged_media pm where pm.session_id=candidate.id)
    order by candidate.created_at,candidate.id limit 1 for update;
   if candidate_id is null then raise exception using errcode='PT429',message='UPLOAD_SESSION_LIMIT'; end if;
   -- No row or asset is deleted. The unchanged service-only cleanup consumes this tombstone.
   update public.posting_upload_sessions set state='expired',expires_at=now(),cleanup_after=now() where id=candidate_id;
  end if;
  insert into public.posting_upload_sessions(id,owner_id,draft_protected,empty_request_id)
   values(p_session_id,u,not empty_allocation,case when empty_allocation then request_id else null end) on conflict(id) do nothing;
 end if;
 select * into s from public.posting_upload_sessions where id=p_session_id and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
 if p_operation='abandon_empty' then
  -- Even removed/uploading media history protects the session and its objects.
  -- This row lock is also taken by reserve, media-ready, prepare and finalization.
  if exists(select 1 from public.posting_staged_media pm where pm.session_id=s.id)
   or s.state not in ('open','expired') then
   raise exception using errcode='PT409',message='UPLOAD_SESSION_PROTECTED';
  end if;
  if s.state='open' then
   if s.expires_at<=now() then raise exception using errcode='PT410',message='UPLOAD_SESSION_EXPIRED'; end if;
   update public.posting_upload_sessions set state='expired',expires_at=now(),cleanup_after=now() where id=s.id returning * into s;
  end if;
  -- Keep a tombstone for lost-response retries; never delete here.
  return pg_catalog.jsonb_build_object('session',pg_catalog.to_jsonb(s),'media','[]'::jsonb);
 end if;
 if s.state='submitted' then return jsonb_build_object('session',to_jsonb(s),'media','[]'::jsonb); end if;
 if s.expires_at<=now() or s.state in ('expired','cleaned') then raise exception using errcode='PT410',message='UPLOAD_SESSION_EXPIRED'; end if;
 if p_operation in ('create','read','claim_draft','reserve','remove','prepare') then
  update public.posting_upload_sessions set draft_protected=true where id=s.id returning * into s;
 end if;
 if p_operation in ('reserve','remove') then
  if s.expires_at<now()+interval '5 minutes' then raise exception using errcode='PT410',message='UPLOAD_SESSION_EXPIRED'; end if;
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
 elsif p_operation not in ('create','create_empty','read','claim_draft') then raise exception 'Invalid operation';
 end if;
 return jsonb_build_object('session',to_jsonb(s),'media',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from public.posting_staged_media x where x.session_id=s.id and x.state<>'removed'),'[]'::jsonb));
end $$;

-- Preserve the existing public invoker signature, owner RLS and explicit grants.

-- Dedicated structured search; other categories keep the installed search RPC unchanged.
create function app_security.impl_search_accessories_v1(p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
DECLARE
  p_query text:=p_filters->>'q';
  p_city_id uuid:=nullif(p_filters->>'city_id','')::uuid;
  p_locality_id uuid:=nullif(p_filters->>'locality_id','')::uuid;
  p_condition text:=nullif(p_filters->>'condition','');
  p_price_min integer:=(p_filters->>'price_min')::integer;
  p_price_max integer:=(p_filters->>'price_max')::integer;
  p_sort text:=coalesce(p_filters->>'sort','newest');
  p_page integer:=coalesce((p_filters->>'page')::integer,1);
  p_per_page integer:=12;
  filter_key text;
  v_page integer := coalesce(p_page, 1);
  v_per_page integer := coalesce(p_per_page, 20);
  v_offset integer;
  v_total_count integer;
  v_items jsonb;
  v_tsquery tsquery := NULL;
  v_cat_id uuid := (select r.category_id from public.accessory_release_v1 r join public.categories c on c.id=r.category_id where r.enabled and c.is_active);
  v_cond public.listing_condition_enum := NULL;
BEGIN
  if jsonb_typeof(p_filters) is distinct from 'object' or p_filters-array['q','type','brand','device_brand','device_model','accessory_condition','condition','city_id','locality_id','price_min','price_max','sort','page']<>'{}' or length(p_filters::text)>3000 then raise exception 'Invalid accessory filters';end if;
  foreach filter_key in array array['q','type','brand','device_brand','device_model','accessory_condition','condition','city_id','locality_id','sort'] loop
    if p_filters?filter_key and (jsonb_typeof(p_filters->filter_key) is distinct from 'string' or length(p_filters->>filter_key)>150) then raise exception 'Invalid accessory filter value';end if;
  end loop;
  foreach filter_key in array array['price_min','price_max','page'] loop
    if p_filters?filter_key and jsonb_typeof(p_filters->filter_key) not in ('number','null') then raise exception 'Invalid numeric accessory filter';end if;
  end loop;
  if p_condition is not null and p_condition not in ('new','like_new','good','fair','poor') then raise exception 'Invalid condition filter';end if;
  if v_cat_id is null then return jsonb_build_object('items','[]'::jsonb,'total_count',0,'page',v_page,'per_page',12,'total_pages',0);end if;
  if nullif(p_filters->>'type','') is not null and not exists(select 1 from public.accessory_types_v1 where id=p_filters->>'type') or nullif(p_filters->>'accessory_condition','') is not null and p_filters->>'accessory_condition' not in ('sealed','open_box','like_new','good','fair','parts') or p_sort not in ('newest','price_asc','price_desc','relevance') or p_page not between 1 and 1000 or p_price_min<0 or p_price_max<0 or p_price_max<p_price_min then raise exception 'Invalid accessory filters';end if;
  -- Validate pagination bounds
  IF v_page < 1 THEN v_page := 1; END IF;
  IF v_per_page < 1 THEN v_per_page := 20; END IF;
  IF v_per_page > 50 THEN v_per_page := 50; END IF;
  v_offset := (v_page - 1) * v_per_page;

  -- Cast condition if valid
  IF p_condition IS NOT NULL AND p_condition IN ('new', 'like_new', 'good', 'fair', 'poor') THEN
    v_cond := p_condition::public.listing_condition_enum;
  END IF;

  -- Parse search query safely using websearch_to_tsquery
  IF p_query IS NOT NULL AND length(trim(p_query)) > 0 THEN
    v_tsquery := websearch_to_tsquery('english', trim(p_query));
    -- If websearch returns empty (e.g. stop words only or symbols), treat as null
    IF v_tsquery = ''::tsquery THEN
      v_tsquery := NULL;
    END IF;
  END IF;

  -- Count total matching rows
  SELECT count(*)
  INTO v_total_count
  FROM public.listings l
  JOIN public.user_accounts ua ON ua.user_id = l.seller_id
    JOIN public.listing_accessory_contexts a ON a.listing_id=l.id AND a.category_id=l.category_id
  WHERE l.status = 'active'
    AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
    AND ua.account_status = 'active'
      AND app_security.is_listing_publicly_visible(l.id)
      AND (nullif(p_filters->>'type','') is null or a.accessory_type=p_filters->>'type')
      AND (nullif(p_filters->>'brand','') is null or lower(a.brand)=lower(trim(p_filters->>'brand')) or (p_filters->>'brand'='Other' and a.details->>'brand'='Other'))
      AND (nullif(p_filters->>'device_brand','') is null or lower(a.device_brand)=lower(trim(p_filters->>'device_brand')))
      AND (nullif(p_filters->>'device_model','') is null or lower(a.device_model)=lower(trim(p_filters->>'device_model')))
      AND (nullif(p_filters->>'accessory_condition','') is null or a.condition=p_filters->>'accessory_condition')
      
    AND (v_cat_id IS NULL OR l.category_id = v_cat_id)
    AND (p_city_id IS NULL OR l.city_id = p_city_id)
    AND (p_locality_id IS NULL OR l.locality_id = p_locality_id)
    AND (v_cond IS NULL OR l.condition = v_cond)
    AND (p_price_min IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise >= p_price_min))
    AND (p_price_max IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise <= p_price_max))
    AND (v_tsquery IS NULL OR l.search_vector @@ v_tsquery);

  -- Fetch matching items (strictly excluding pin_code and landmark)
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      l.id,
      l.seller_id,
      l.slug,
      l.title,
      l.description,
      l.condition,
      l.price_type,
      l.price_paise,
      l.category_attributes,
      l.status,
      l.created_at,
      l.published_at,
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'slug', c.slug,
        'icon', c.icon
      ) AS category,
      jsonb_build_object(
        'id', ci.id,
        'name', ci.name,
        'state', ci.state
      ) AS city,
      CASE
        WHEN loc.id IS NOT NULL THEN jsonb_build_object('id', loc.id, 'name', loc.name)
        ELSE NULL
      END AS locality,
      CASE
        WHEN m.id IS NOT NULL THEN jsonb_build_object(
          'id', m.id,
          'thumbnail_storage_path', m.thumbnail_storage_path,
          'medium_storage_path', m.medium_storage_path,
          'width', m.width,
          'height', m.height
        )
        ELSE NULL
      END AS cover_photo
    FROM public.listings l
    JOIN public.user_accounts ua ON ua.user_id = l.seller_id
    JOIN public.listing_accessory_contexts a ON a.listing_id=l.id AND a.category_id=l.category_id
    JOIN public.categories c ON c.id = l.category_id
    JOIN public.cities ci ON ci.id = l.city_id
    LEFT JOIN public.localities loc ON loc.id = l.locality_id
    LEFT JOIN public.listing_media m ON m.id = l.cover_photo_id
    WHERE l.status = 'active'
      AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
      AND ua.account_status = 'active'
      AND app_security.is_listing_publicly_visible(l.id)
      AND (nullif(p_filters->>'type','') is null or a.accessory_type=p_filters->>'type')
      AND (nullif(p_filters->>'brand','') is null or lower(a.brand)=lower(trim(p_filters->>'brand')) or (p_filters->>'brand'='Other' and a.details->>'brand'='Other'))
      AND (nullif(p_filters->>'device_brand','') is null or lower(a.device_brand)=lower(trim(p_filters->>'device_brand')))
      AND (nullif(p_filters->>'device_model','') is null or lower(a.device_model)=lower(trim(p_filters->>'device_model')))
      AND (nullif(p_filters->>'accessory_condition','') is null or a.condition=p_filters->>'accessory_condition')
      
      AND (v_cat_id IS NULL OR l.category_id = v_cat_id)
      AND (p_city_id IS NULL OR l.city_id = p_city_id)
      AND (p_locality_id IS NULL OR l.locality_id = p_locality_id)
      AND (v_cond IS NULL OR l.condition = v_cond)
      AND (p_price_min IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise >= p_price_min))
      AND (p_price_max IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise <= p_price_max))
      AND (v_tsquery IS NULL OR l.search_vector @@ v_tsquery)
    ORDER BY
      CASE WHEN p_sort = 'price_asc' THEN l.price_paise END ASC NULLS LAST,
      CASE WHEN p_sort = 'price_desc' THEN l.price_paise END DESC NULLS LAST,
      CASE WHEN p_sort = 'relevance' AND v_tsquery IS NOT NULL THEN ts_rank(l.search_vector, v_tsquery) END DESC NULLS LAST,
      l.created_at DESC,
      l.id DESC
    LIMIT v_per_page
    OFFSET v_offset
  ) item;

  RETURN jsonb_build_object(
    'items', v_items,
    'total_count', v_total_count,
    'page', v_page,
    'per_page', v_per_page,
    'total_pages', CASE WHEN v_total_count > 0 THEN ceil(v_total_count::numeric / v_per_page)::integer ELSE 0 END
  );
END;
$$;
create function public.search_accessories_v1(filters jsonb) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_search_accessories_v1(filters)$$;
revoke all on function app_security.impl_search_accessories_v1(jsonb),public.search_accessories_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_search_accessories_v1(jsonb),public.search_accessories_v1(jsonb) to anon,authenticated;
create index accessory_device_exact_v1 on public.listing_accessory_contexts(lower(device_brand),lower(device_model));

commit;
