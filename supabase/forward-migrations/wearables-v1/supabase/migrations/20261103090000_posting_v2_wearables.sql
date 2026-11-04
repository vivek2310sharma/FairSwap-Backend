-- Wearables V1 foundation (default OFF). Forward-only; never part of the immutable supabase/migrations set.
-- Requires, INSTALLED (not necessarily enabled): Posting V2 foundation, V2.1.2 session recovery, Accessories V1
-- (whose impl_posting_v2_session body is the exact baseline moved into the session core below).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ declare def text;begin
 if to_regclass('public.wearable_release_v1') is not null then raise exception 'WEARABLES_ALREADY_INSTALLED';end if;
 if to_regprocedure('public.submit_mobile_v2(jsonb)') is null or to_regprocedure('app_security.phone_content_guard(text)') is null or to_regprocedure('app_security.posting_v2_actor()') is null or to_regprocedure('public.posting_v2_media_ready(uuid,uuid,uuid,integer,integer,integer)') is null or to_regprocedure('public.seller_submit_listing(uuid)') is null then raise exception 'WEARABLES_PREREQUISITE_MISSING: Posting V2';end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='posting_upload_sessions' and column_name='draft_protected') then raise exception 'WEARABLES_PREREQUISITE_MISSING: V2.1.2 session recovery';end if;
 if to_regclass('public.accessory_release_v1') is null then raise exception 'WEARABLES_PREREQUISITE_MISSING: Accessories V1';end if;
 select pg_catalog.pg_get_functiondef('app_security.impl_posting_v2_session(uuid,text,uuid)'::regprocedure) into def;
 if def not like '%accessory_release_v1%' or def not like '%list_recovery%' or def like '%wearable%' then raise exception 'WEARABLES_BASELINE_DRIFT: installed impl_posting_v2_session is not the Accessories V1 baseline';end if;
end $$;

-- Deterministic matching keys. Must equal scripts/wearables/name-key.mjs in FairSwap-Web.
create function app_security.wearable_name_key(p text) returns text language sql immutable set search_path='' as $$
 select pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.lower(p),'\+',' plus ','g'),'[^a-z0-9]+',' ','g'))
$$;
create function app_security.wearable_base_key(p text) returns text language sql immutable set search_path='' as $$
 select coalesce(pg_catalog.array_to_string(array(select w from pg_catalog.unnest(pg_catalog.string_to_array(app_security.wearable_name_key(p),' ')) w where w<>'' and w<>all(array['gold','silver','matte','grey','gray','black','white','titanium','ceramic','rose','space','raw','bionic'])),' '),'')
$$;
revoke all on function app_security.wearable_name_key(text),app_security.wearable_base_key(text) from public,anon,authenticated,service_role;
grant execute on function app_security.wearable_name_key(text),app_security.wearable_base_key(text) to authenticated;

do $$ begin
 if exists(select 1 from public.categories where lower(name)=lower('Smartwatches & Wearables') and slug<>'wearables') then raise exception 'WEARABLES_CATEGORY_CONFLICT: a differently-slugged category with this name exists';end if;
 if exists(select 1 from public.listings l join public.categories c on c.id=l.category_id where c.slug='wearables') then raise exception 'WEARABLES_CATEGORY_CONFLICT: existing wearables listings require a reviewed backfill';end if;
 if exists(select 1 from public.categories c where c.slug='wearables' and (c.new_listing_enabled or exists(select 1 from public.category_attributes a where a.category_id=c.id and a.is_required))) then raise exception 'WEARABLES_CATEGORY_CONFLICT: existing wearables category is not in the expected closed state';end if;
end $$;
insert into public.categories(slug,name,description,sort_order,is_active,macro_category,new_listing_enabled)
 values('wearables','Smartwatches & Wearables','Smartwatches, fitness bands, sports GPS watches and smart rings; seller-reported details',23,false,'goods',false) on conflict(slug) do nothing;

create table public.wearable_release_v1(singleton boolean primary key default true check(singleton),category_id uuid not null unique references public.categories,enabled boolean not null default false);
create table public.wearable_catalogue_revision_v1(singleton boolean primary key default true check(singleton),revision text not null check(revision~'^[0-9a-f]{16}$'),csv_sha256 text not null,corrections_sha256 text not null,rows_total integer not null,rows_approved integer not null);
create table public.wearable_brands_v1(id text primary key check(id~'^wb_[a-z0-9-]+$'),name text unique not null,sort_order integer not null);
create table public.wearable_models_v1(
 id text primary key check(id~'^wm_[0-9a-f]{12}$'),brand_id text not null references public.wearable_brands_v1,
 device_type text not null check(device_type in ('smartwatch','fitness_band','sports_gps_watch','smart_ring')),
 series text not null,name text not null,
 name_key text generated always as (app_security.wearable_name_key(name)) stored,
 base_key text generated always as (app_security.wearable_base_key(name)) stored,
 status text not null check(status in ('approved','quarantined','excluded')),
 reason text check((status='approved')=(reason is null)),
 source_row integer not null unique,sort_order integer not null,
 unique(name_key)
);
create index wearable_models_brand_v1 on public.wearable_models_v1(brand_id,device_type) where status='approved';
create index wearable_models_base_key_v1 on public.wearable_models_v1(base_key);
create table public.wearable_session_bindings_v1(session_id uuid primary key references public.posting_upload_sessions on delete cascade,category_id uuid not null references public.categories);
create table public.listing_wearable_contexts_v1(
 listing_id uuid primary key references public.listings on delete cascade,
 contract_version integer not null default 1 check(contract_version=1),
 category_id uuid not null references public.categories,
 device_type text not null check(device_type in ('smartwatch','fitness_band','sports_gps_watch','smart_ring')),
 brand_id text references public.wearable_brands_v1,model_id text references public.wearable_models_v1,
 brand_name text not null,model_name text not null,other_model boolean not null,
 catalogue_revision text not null,
 pairing_status text not null check(pairing_status in ('reset_ready','signed_out','still_paired','unknown')),
 transfer_ready boolean not null,
 details jsonb not null check(jsonb_typeof(details)='object'),
 check(other_model=(model_id is null)),
 check(transfer_ready=(pairing_status in ('reset_ready','signed_out')))
);
create index wearable_context_filter_v1 on public.listing_wearable_contexts_v1(device_type,brand_id,model_id,pairing_status);
create table public.listing_wearable_risk_flags_v1(listing_id uuid not null references public.listings on delete cascade,signal text not null check(signal in ('other_model','other_brand','still_paired','unknown_pairing')),created_at timestamptz not null default now(),primary key(listing_id,signal));
do $$ declare t text;begin foreach t in array array['wearable_release_v1','wearable_catalogue_revision_v1','wearable_brands_v1','wearable_models_v1','wearable_session_bindings_v1','listing_wearable_contexts_v1','listing_wearable_risk_flags_v1'] loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
end loop;end $$;
-- Catalogue reference rows are readable by signed-in users (names only; quarantine reasons stay internal via column grants).
grant select on public.wearable_release_v1,public.wearable_catalogue_revision_v1 to authenticated;
create policy wearable_release_read on public.wearable_release_v1 for select to authenticated using(true);
create policy wearable_revision_read on public.wearable_catalogue_revision_v1 for select to authenticated using(true);
grant select(id,name,sort_order) on public.wearable_brands_v1 to authenticated;
create policy wearable_brands_read on public.wearable_brands_v1 for select to authenticated using(true);
grant select(id,brand_id,device_type,series,name,sort_order) on public.wearable_models_v1 to authenticated;
create policy wearable_models_read on public.wearable_models_v1 for select to authenticated using(status='approved' or app_security.is_active_staff_aal2('content_editor'));
grant select(listing_id,category_id,device_type,brand_id,model_id,brand_name,model_name,other_model,catalogue_revision,pairing_status,transfer_ready,details) on public.listing_wearable_contexts_v1 to anon,authenticated;
create policy wearable_context_read on public.listing_wearable_contexts_v1 for select to anon,authenticated using(
 app_security.is_listing_publicly_visible(listing_id) or exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid())) or app_security.is_active_staff_aal2('moderator'));
grant select on public.listing_wearable_risk_flags_v1 to authenticated;
create policy wearable_flags_staff on public.listing_wearable_risk_flags_v1 for select to authenticated using(app_security.is_active_staff_aal2('moderator'));
-- No session-binding policy: only definer functions read or write bindings.

insert into public.wearable_release_v1(category_id) select id from public.categories where slug='wearables';
-- BEGIN GENERATED CATALOGUE revision=8dd5783ac9b7e12e
insert into public.wearable_catalogue_revision_v1(singleton,revision,csv_sha256,corrections_sha256,rows_total,rows_approved) values(true,'8dd5783ac9b7e12e','6f7da5dd8aeae2a0914369b2bfeebe1604bd2f9c5c5eb42a3275fe050d86f6ce','cb515cbf2868ece388d08f24d970e2fdadf9dad6646b5eb1764b7185af71c9c3',607,587) on conflict(singleton) do nothing;
insert into public.wearable_brands_v1(id,name,sort_order) values
('wb_amazfit','Amazfit',1),
('wb_apple','Apple',2),
('wb_boat','boAt',3),
('wb_boult','Boult',4),
('wb_casio','Casio',5),
('wb_coros','COROS',6),
('wb_fastrack','Fastrack',7),
('wb_fire-boltt','Fire-Boltt',8),
('wb_fitbit','Fitbit',9),
('wb_fossil','Fossil',10),
('wb_garmin','Garmin',11),
('wb_google','Google',12),
('wb_haylou','Haylou',13),
('wb_honor','Honor',14),
('wb_huawei','Huawei',15),
('wb_michael-kors','Michael Kors',16),
('wb_mobvoi','Mobvoi',17),
('wb_motorola','Motorola',18),
('wb_noise','Noise',19),
('wb_nothing','Nothing',20),
('wb_oneplus','OnePlus',21),
('wb_oppo','Oppo',22),
('wb_oura','Oura',23),
('wb_pebble','Pebble',24),
('wb_polar','Polar',25),
('wb_realme','Realme',26),
('wb_ringconn','RingConn',27),
('wb_samsung','Samsung',28),
('wb_skagen','Skagen',29),
('wb_suunto','Suunto',30),
('wb_titan','Titan',31),
('wb_ultrahuman','Ultrahuman',32),
('wb_vivo','Vivo',33),
('wb_whoop','Whoop',34),
('wb_xiaomi','Xiaomi',35) on conflict(id) do nothing;
insert into public.wearable_models_v1(id,brand_id,device_type,series,name,status,reason,source_row,sort_order) values
('wm_d4f0eb37040a','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Active','approved',null,35,1),
('wm_57139a4722a4','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Active 2','approved',null,36,2),
('wm_8370c1c4fc51','wb_amazfit','fitness_band','Amazfit Band','Amazfit Active Edge','approved',null,2,3),
('wm_92cba4a820f5','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Balance','approved',null,37,4),
('wm_f231615a19b2','wb_amazfit','fitness_band','Amazfit Band','Amazfit Band 5','approved',null,3,5),
('wm_e45cc9f914d9','wb_amazfit','fitness_band','Amazfit Band','Amazfit Band 7','approved',null,4,6),
('wm_0795aecf2f1d','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip','approved',null,11,7),
('wm_a299ecf1f9d7','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip 3','approved',null,12,8),
('wm_613b888ec5d5','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip 3 Pro','approved',null,13,9),
('wm_466315387435','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip 5','approved',null,14,10),
('wm_f500eab427aa','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip 5 Unity','approved',null,15,11),
('wm_2e5bc41ed8d5','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip 6','approved',null,16,12),
('wm_2450ffc5f7f3','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip S','approved',null,17,13),
('wm_3df274f22af1','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip U','approved',null,18,14),
('wm_2690f00b32cb','wb_amazfit','smartwatch','Amazfit Bip','Amazfit Bip U Pro','approved',null,19,15),
('wm_f901c3ddf46e','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Cheetah','approved',null,38,16),
('wm_4097543db469','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Cheetah Pro','approved',null,39,17),
('wm_ffc089e07d4f','wb_amazfit','fitness_band','Amazfit Band','Amazfit Cor','approved',null,5,18),
('wm_38e85be7cd72','wb_amazfit','fitness_band','Amazfit Band','Amazfit Cor 2','approved',null,6,19),
('wm_b3a2d265b916','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Falcon','approved',null,40,20),
('wm_3e3dc974dab3','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Falcon Pro','approved',null,41,21),
('wm_7e89b2e43179','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR','approved',null,20,22),
('wm_e83d090b8921','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR 2','approved',null,21,23),
('wm_74a5b3ccee53','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR 2e','approved',null,22,24),
('wm_ee598e6aacad','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR 3','approved',null,23,25),
('wm_c39082b6d789','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR 3 Pro','approved',null,24,26),
('wm_c87d1069aa24','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR 4','approved',null,25,27),
('wm_33dc99fd36c7','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR 47mm','approved',null,26,28),
('wm_0bb448f4dbe9','wb_amazfit','smartwatch','Amazfit GTR','Amazfit GTR Lite','approved',null,27,29),
('wm_a73e3234d034','wb_amazfit','smartwatch','Amazfit GTS','Amazfit GTS','approved',null,28,30),
('wm_af7639ab0092','wb_amazfit','smartwatch','Amazfit GTS','Amazfit GTS 2','approved',null,29,31),
('wm_f54aa827bcee','wb_amazfit','smartwatch','Amazfit GTS','Amazfit GTS 2 Mini','approved',null,30,32),
('wm_878cceeda9d0','wb_amazfit','smartwatch','Amazfit GTS','Amazfit GTS 2e','approved',null,31,33),
('wm_f406afe52c09','wb_amazfit','smartwatch','Amazfit GTS','Amazfit GTS 3','approved',null,32,34),
('wm_0954fe36d840','wb_amazfit','smartwatch','Amazfit GTS','Amazfit GTS 4','approved',null,33,35),
('wm_334d4dab37e5','wb_amazfit','smartwatch','Amazfit GTS','Amazfit GTS 4 Mini','approved',null,34,36),
('wm_d5a01ba64c20','wb_amazfit','fitness_band','Amazfit Band','Amazfit Health Band 1S','approved',null,7,37),
('wm_f3d3fc39018e','wb_amazfit','smart_ring','Amazfit Helio','Amazfit Helio Ring','approved',null,9,38),
('wm_d6a19b9c34cc','wb_amazfit','smart_ring','Amazfit Helio','Amazfit Helio Strap','quarantined','type_mismatch',10,39),
('wm_4c9ec8348c6e','wb_amazfit','fitness_band','Amazfit Band','Amazfit Neo','approved',null,8,40),
('wm_a3eff417c612','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Pace','approved',null,42,41),
('wm_e081eb1bf47c','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Stratos','approved',null,43,42),
('wm_f1aedbf3fa3b','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Stratos 3','approved',null,44,43),
('wm_2fc1a6c2d7a8','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit T-Rex','approved',null,45,44),
('wm_474cad1332f5','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit T-Rex 2','approved',null,46,45),
('wm_9a385548b041','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit T-Rex 3','approved',null,47,46),
('wm_017fda973d0f','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit T-Rex Pro','approved',null,48,47),
('wm_6c48d58c3ec4','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Verge','approved',null,49,48),
('wm_f7d975743ad5','wb_amazfit','sports_gps_watch','Amazfit T-Rex / Balance / Active','Amazfit Verge Lite','approved',null,50,49),
('wm_1a5b41a3fe2f','wb_apple','smartwatch','Apple Watch','Apple Watch (1st generation)','approved',null,51,50),
('wm_7a6fb97438ad','wb_apple','smartwatch','Apple Watch SE','Apple Watch SE (1st generation)','approved',null,63,51),
('wm_637e2907ce26','wb_apple','smartwatch','Apple Watch SE','Apple Watch SE (2nd generation)','approved',null,64,52),
('wm_b93ca56acc77','wb_apple','smartwatch','Apple Watch SE','Apple Watch SE 3','approved',null,65,53),
('wm_4aae61849a75','wb_apple','smartwatch','Apple Watch','Apple Watch Series 1','approved',null,52,54),
('wm_cec79e122f47','wb_apple','smartwatch','Apple Watch','Apple Watch Series 10','approved',null,53,55),
('wm_5c1ffc9cfc15','wb_apple','smartwatch','Apple Watch (2025)','Apple Watch Series 11','approved',null,62,56),
('wm_c0f0f96470a9','wb_apple','smartwatch','Apple Watch','Apple Watch Series 2','approved',null,54,57),
('wm_8577f97ead7e','wb_apple','smartwatch','Apple Watch','Apple Watch Series 3','approved',null,55,58),
('wm_bc8f3603eec2','wb_apple','smartwatch','Apple Watch','Apple Watch Series 4','approved',null,56,59),
('wm_a83b5432e10b','wb_apple','smartwatch','Apple Watch','Apple Watch Series 5','approved',null,57,60),
('wm_df353128b1a9','wb_apple','smartwatch','Apple Watch','Apple Watch Series 6','approved',null,58,61),
('wm_907d0d90bb77','wb_apple','smartwatch','Apple Watch','Apple Watch Series 7','approved',null,59,62),
('wm_24e733c7a54a','wb_apple','smartwatch','Apple Watch','Apple Watch Series 8','approved',null,60,63),
('wm_b003ffae0dbb','wb_apple','smartwatch','Apple Watch','Apple Watch Series 9','approved',null,61,64),
('wm_eb3d19ce148d','wb_apple','sports_gps_watch','Apple Watch Ultra','Apple Watch Ultra','approved',null,66,65),
('wm_6c1260d0837e','wb_apple','sports_gps_watch','Apple Watch Ultra','Apple Watch Ultra 2','approved',null,67,66),
('wm_aab583795775','wb_apple','sports_gps_watch','Apple Watch Ultra','Apple Watch Ultra 3','approved',null,68,67),
('wm_714ccad958f3','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Cosmos','approved',null,69,68),
('wm_3205407858ff','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Enigma','approved',null,70,69),
('wm_4bd25a70f9d1','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Lunar Call','approved',null,71,70),
('wm_9df49e227a07','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Lunar Connect','approved',null,72,71),
('wm_3387c5ed4211','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Lunar Discovery','approved',null,73,72),
('wm_8e00d6ac5d9a','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Storm Call','approved',null,74,73),
('wm_63195f467156','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Storm Call 2','approved',null,75,74),
('wm_062aa7577717','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Ultima Call','approved',null,76,75),
('wm_4263caae734f','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Ultima Chronos','approved',null,77,76),
('wm_a240a9ce9232','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Ultima Regal','approved',null,78,77),
('wm_49c0817abe2f','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Beat','approved',null,79,78),
('wm_1b6498d26f8c','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Call','approved',null,80,79),
('wm_e2a53843ca84','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Call 2','approved',null,81,80),
('wm_1bf3163d4307','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Call 3','approved',null,82,81),
('wm_c0ddf5e5e52c','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Elevate','approved',null,83,82),
('wm_ca94ef1cf8d1','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Flex','approved',null,84,83),
('wm_541d0987bf66','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Genesis','approved',null,85,84),
('wm_2cb62d40a0fa','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Lite','approved',null,86,85),
('wm_193803c98088','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Neo','approved',null,87,86),
('wm_cdfa37e447d7','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Prime','approved',null,88,87),
('wm_145287740983','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Sigma','approved',null,89,88),
('wm_c4d361e27731','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Wave Style','approved',null,90,89),
('wm_87390b6f9c61','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Xtend','approved',null,91,90),
('wm_e46560ac13e7','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Xtend Plus','approved',null,92,91),
('wm_e6b037fe7951','wb_boat','smartwatch','boAt Wave / Storm / Xtend','boAt Xtend Sport','approved',null,93,92),
('wm_6ef5094a7fbb','wb_boult','smartwatch','Boult','Boult Crown','approved',null,94,93),
('wm_9fc4527cee44','wb_boult','smartwatch','Boult','Boult Crown R','approved',null,95,94),
('wm_ecc3398c9271','wb_boult','smartwatch','Boult','Boult Dive','approved',null,96,95),
('wm_924a849f4f35','wb_boult','smartwatch','Boult','Boult Dive Plus','approved',null,97,96),
('wm_3662582a02c5','wb_boult','smartwatch','Boult','Boult Drift','approved',null,98,97),
('wm_423aa64f1864','wb_boult','smartwatch','Boult','Boult Maverick','approved',null,99,98),
('wm_a683ca78539c','wb_boult','smartwatch','Boult','Boult Rover','approved',null,100,99),
('wm_d60629608c2a','wb_boult','smartwatch','Boult','Boult Soho','approved',null,101,100),
('wm_dfe17af690f7','wb_boult','smartwatch','Boult','Boult Trail','approved',null,102,101),
('wm_1ac2cacb18aa','wb_casio','smartwatch','Casio','Casio G-Shock GBD-200','approved',null,103,102),
('wm_e8c7313be9ff','wb_casio','smartwatch','Casio','Casio G-Shock GBD-H1000','approved',null,104,103),
('wm_b9508e107b93','wb_casio','smartwatch','Casio','Casio G-Shock GBD-H2000','approved',null,105,104),
('wm_38feed3ea733','wb_casio','smartwatch','Casio','Casio Pro Trek WSD-F10','approved',null,106,105),
('wm_f77718b000a1','wb_casio','smartwatch','Casio','Casio Pro Trek WSD-F20','approved',null,107,106),
('wm_096c9b93ec8f','wb_coros','sports_gps_watch','COROS','COROS Apex','approved',null,108,107),
('wm_df92cca50d73','wb_coros','sports_gps_watch','COROS','COROS Apex 2','approved',null,109,108),
('wm_4cb336ab1119','wb_coros','sports_gps_watch','COROS','COROS Apex 2 Pro','approved',null,110,109),
('wm_0b130a8208fa','wb_coros','sports_gps_watch','COROS','COROS Dura','approved',null,111,110),
('wm_c5103116ba57','wb_coros','sports_gps_watch','COROS','COROS Pace 2','approved',null,112,111),
('wm_1b899c9d77c8','wb_coros','sports_gps_watch','COROS','COROS Pace 3','approved',null,113,112),
('wm_dfa02c7fcb6c','wb_coros','sports_gps_watch','COROS','COROS Pace 4','approved',null,114,113),
('wm_cafea576385a','wb_coros','sports_gps_watch','COROS','COROS Vertix','approved',null,115,114),
('wm_6d5afc408744','wb_coros','sports_gps_watch','COROS','COROS Vertix 2','approved',null,116,115),
('wm_cc2cf9ae9755','wb_coros','sports_gps_watch','COROS','COROS Vertix 2S','approved',null,117,116),
('wm_319c6eb145f5','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Limitless FS1','approved',null,118,117),
('wm_6f26b07112e4','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Limitless FS2','approved',null,119,118),
('wm_b56a5ab30621','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Limitless Glide','approved',null,120,119),
('wm_e26bf678c314','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Limitless X2','approved',null,121,120),
('wm_a677546ac9ff','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex 3.0','approved',null,122,121),
('wm_05827c32656a','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex Beat','approved',null,123,122),
('wm_505caefa7b76','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex Charge','approved',null,124,123),
('wm_c46e27a7e221','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex Hello','approved',null,125,124),
('wm_60a4a883768e','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex Play','approved',null,126,125),
('wm_93386212f64d','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex Tag','approved',null,127,126),
('wm_ef56677a6011','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex Vox','approved',null,128,127),
('wm_754887030522','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Reflex Wave','approved',null,129,128),
('wm_162316d3b6d0','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Revoltt FR1 Pro','approved',null,130,129),
('wm_74f75fde7afd','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Revoltt FS1','approved',null,131,130),
('wm_8179aaff231c','wb_fastrack','smartwatch','Fastrack Reflex / Revoltt / Limitless','Fastrack Revoltt FS1 Pro','approved',null,132,131),
('wm_15fd43636751','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Apollo','approved',null,133,132),
('wm_ba17f57057bb','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Blizzard','approved',null,134,133),
('wm_27d10332d069','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Cobra','approved',null,135,134),
('wm_214666e24c94','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Dazzle','approved',null,136,135),
('wm_c4c7449959c2','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Gladiator','approved',null,137,136),
('wm_d2d147a6c92c','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Hurricane','approved',null,138,137),
('wm_01dd85a6bc68','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Invincible','approved',null,139,138),
('wm_96ea6258b60d','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Legend','approved',null,140,139),
('wm_83ae06d83339','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Ninja Call Pro','approved',null,141,140),
('wm_6829d204f490','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Ninja Call Pro Plus','approved',null,142,141),
('wm_8fd2dabbcf54','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Ninja Fit','approved',null,143,142),
('wm_cab1a8c75714','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Phoenix','approved',null,144,143),
('wm_f534c90e47e7','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Phoenix Pro','approved',null,145,144),
('wm_39bc8b270aa1','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Phoenix Ultra','approved',null,146,145),
('wm_48fd5139d8cb','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Rage','approved',null,147,146),
('wm_b62f3463baff','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Talk','approved',null,148,147),
('wm_9a7f50e897c3','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Talk 2','approved',null,149,148),
('wm_c73a82babc08','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Terminator','approved',null,150,149),
('wm_e4e96924b986','wb_fire-boltt','smartwatch','Fire-Boltt','Fire-Boltt Visionary','approved',null,151,150),
('wm_f88909b32407','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Ace 3','excluded','kids_tracker',152,151),
('wm_5cf152b6e854','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Alta HR','approved',null,153,152),
('wm_1bf5909ace35','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Charge 2','approved',null,154,153),
('wm_1817fabf2e05','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Charge 3','approved',null,155,154),
('wm_1fac0bb7d5b7','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Charge 4','approved',null,156,155),
('wm_dbb97f7b30ac','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Charge 5','approved',null,157,156),
('wm_9b1b994b237a','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Charge 6','approved',null,158,157),
('wm_2f15fb1543b7','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Flex 2','approved',null,159,158),
('wm_7670f156a285','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Inspire','approved',null,160,159),
('wm_5b31c5bcd605','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Inspire 2','approved',null,161,160),
('wm_db32261e7dea','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Inspire 3','approved',null,162,161),
('wm_efe83d807dc9','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Inspire HR','approved',null,163,162),
('wm_40aa3f5ede2d','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Ionic','approved',null,165,163),
('wm_1c7a58e570ef','wb_fitbit','fitness_band','Fitbit tracker','Fitbit Luxe','approved',null,164,164),
('wm_d8b72af47915','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Sense','approved',null,166,165),
('wm_d9fc338a7dde','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Sense 2','approved',null,167,166),
('wm_4b5da1ec0866','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Versa','approved',null,168,167),
('wm_4f04fc45b7d7','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Versa 2','approved',null,169,168),
('wm_bf7ed482ccb5','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Versa 3','approved',null,170,169),
('wm_a572d48e2294','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Versa 4','approved',null,171,170),
('wm_ce66736f8fbe','wb_fitbit','smartwatch','Fitbit smartwatch','Fitbit Versa Lite','approved',null,172,171),
('wm_5202236ab678','wb_fossil','smartwatch','Fossil Gen','Fossil Gen 4','approved',null,173,172),
('wm_8da41b23d49e','wb_fossil','smartwatch','Fossil Gen','Fossil Gen 5','approved',null,174,173),
('wm_de52fe5322f5','wb_fossil','smartwatch','Fossil Gen','Fossil Gen 5 LTE','approved',null,175,174),
('wm_c32c6e576dc3','wb_fossil','smartwatch','Fossil Gen','Fossil Gen 6','approved',null,176,175),
('wm_19ad50e0eb09','wb_fossil','smartwatch','Fossil Gen','Fossil Gen 6 Wellness','approved',null,177,176),
('wm_7874452f9987','wb_fossil','smartwatch','Fossil Gen','Fossil Hybrid HR','quarantined','classification_unverified',178,177),
('wm_0709e09005c5','wb_fossil','smartwatch','Fossil Gen','Fossil Hybrid Smartwatch','quarantined','classification_unverified',179,178),
('wm_9bf806a87856','wb_fossil','smartwatch','Fossil Gen','Fossil Q Accomplice','approved',null,180,179),
('wm_b146220d3e45','wb_fossil','smartwatch','Fossil Gen','Fossil Q Commuter','approved',null,181,180),
('wm_c0edf0c20498','wb_fossil','smartwatch','Fossil Gen','Fossil Q Control','approved',null,182,181),
('wm_bbabddf4911b','wb_fossil','smartwatch','Fossil Gen','Fossil Q Crewmaster','approved',null,183,182),
('wm_fde1fb845878','wb_fossil','smartwatch','Fossil Gen','Fossil Q Explorist','approved',null,184,183),
('wm_ce7e047c06e8','wb_fossil','smartwatch','Fossil Gen','Fossil Q Founder','approved',null,185,184),
('wm_6e54538cbf62','wb_fossil','smartwatch','Fossil Gen','Fossil Q Gazer','approved',null,186,185),
('wm_875515732020','wb_fossil','smartwatch','Fossil Gen','Fossil Q Grant','approved',null,187,186),
('wm_35f5bc2bc5e0','wb_fossil','smartwatch','Fossil Gen','Fossil Q Marshal','approved',null,188,187),
('wm_5206e1b17741','wb_fossil','smartwatch','Fossil Gen','Fossil Q Nate','approved',null,189,188),
('wm_1e4a14655010','wb_fossil','smartwatch','Fossil Gen','Fossil Q Tailor','approved',null,190,189),
('wm_16f98eb75bf0','wb_fossil','smartwatch','Fossil Gen','Fossil Q Venture','approved',null,191,190),
('wm_5c660e70109e','wb_fossil','smartwatch','Fossil Gen','Fossil Q Wander','approved',null,192,191),
('wm_1fd76f47d50e','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Approach S12','approved',null,282,192),
('wm_63bf90aa0fb1','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Approach S42','approved',null,283,193),
('wm_1cd65c16f742','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Approach S62','approved',null,284,194),
('wm_5f62e5a90917','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Approach S70','approved',null,285,195),
('wm_5608a0fc6a03','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Bounce','approved',null,286,196),
('wm_6c63812544ce','wb_garmin','sports_gps_watch','Descent','Descent Mk2','approved',null,222,197),
('wm_7d5c3a333be1','wb_garmin','sports_gps_watch','Descent','Descent Mk2i','approved',null,223,198),
('wm_192047268829','wb_garmin','sports_gps_watch','Descent','Descent Mk3','approved',null,224,199),
('wm_8be5510a8076','wb_garmin','sports_gps_watch','Enduro','Enduro','approved',null,225,200),
('wm_f4af4324c905','wb_garmin','sports_gps_watch','Enduro','Enduro 2','approved',null,226,201),
('wm_1457a392b3bd','wb_garmin','sports_gps_watch','Enduro','Enduro 3','approved',null,227,202),
('wm_93168de49f20','wb_garmin','sports_gps_watch','Epix','Epix (Gen 2)','approved',null,228,203),
('wm_3c3232e26c18','wb_garmin','sports_gps_watch','Epix','Epix Pro (Gen 2)','approved',null,229,204),
('wm_d6c1117660ba','wb_garmin','sports_gps_watch','Fenix','Fenix 3','approved',null,230,205),
('wm_8d83073dbf2b','wb_garmin','sports_gps_watch','Fenix','Fenix 3 HR','approved',null,231,206),
('wm_1dd381bc3eaa','wb_garmin','sports_gps_watch','Fenix','Fenix 5','approved',null,232,207),
('wm_81af5951c2dc','wb_garmin','sports_gps_watch','Fenix','Fenix 5 Plus','approved',null,233,208),
('wm_296be0be4eb5','wb_garmin','sports_gps_watch','Fenix','Fenix 5S','approved',null,234,209),
('wm_73e4ce08052f','wb_garmin','sports_gps_watch','Fenix','Fenix 5X','approved',null,235,210),
('wm_0a3e1ec53a2e','wb_garmin','sports_gps_watch','Fenix','Fenix 6','approved',null,236,211),
('wm_232799552838','wb_garmin','sports_gps_watch','Fenix','Fenix 6 Pro','approved',null,237,212),
('wm_622cc85ae424','wb_garmin','sports_gps_watch','Fenix','Fenix 6S','approved',null,238,213),
('wm_d0c2c1b1c2aa','wb_garmin','sports_gps_watch','Fenix','Fenix 6X Pro','approved',null,239,214),
('wm_884fc54732da','wb_garmin','sports_gps_watch','Fenix','Fenix 7','approved',null,240,215),
('wm_f1510f5fcb62','wb_garmin','sports_gps_watch','Fenix','Fenix 7 Pro','approved',null,241,216),
('wm_5f8380cd8637','wb_garmin','sports_gps_watch','Fenix','Fenix 7S','approved',null,242,217),
('wm_dcdc042fceeb','wb_garmin','sports_gps_watch','Fenix','Fenix 7X','approved',null,243,218),
('wm_45f6b321380e','wb_garmin','sports_gps_watch','Fenix','Fenix 8','approved',null,244,219),
('wm_59eaae0a5c70','wb_garmin','sports_gps_watch','Fenix','Fenix 8 Pro','approved',null,245,220),
('wm_8feaa72cd135','wb_garmin','sports_gps_watch','Forerunner','Forerunner 10','approved',null,246,221),
('wm_127b36419ba1','wb_garmin','sports_gps_watch','Forerunner','Forerunner 15','approved',null,247,222),
('wm_2de85bf4ad79','wb_garmin','sports_gps_watch','Forerunner','Forerunner 165','approved',null,248,223),
('wm_f0458a9ce617','wb_garmin','sports_gps_watch','Forerunner','Forerunner 165 Music','approved',null,249,224),
('wm_8007981b941f','wb_garmin','sports_gps_watch','Forerunner','Forerunner 230','approved',null,250,225),
('wm_7b3e21226546','wb_garmin','sports_gps_watch','Forerunner','Forerunner 235','approved',null,251,226),
('wm_2d8b7fb53f4b','wb_garmin','sports_gps_watch','Forerunner','Forerunner 245','approved',null,252,227),
('wm_b0b1b5c03710','wb_garmin','sports_gps_watch','Forerunner','Forerunner 245 Music','approved',null,253,228),
('wm_b61332953ce9','wb_garmin','sports_gps_watch','Forerunner','Forerunner 25','approved',null,254,229),
('wm_7ce96b4afda5','wb_garmin','sports_gps_watch','Forerunner','Forerunner 255','approved',null,255,230),
('wm_f0d837ab39d2','wb_garmin','sports_gps_watch','Forerunner','Forerunner 255 Music','approved',null,256,231),
('wm_435f23b1257f','wb_garmin','sports_gps_watch','Forerunner','Forerunner 255S','approved',null,257,232),
('wm_b647ca475625','wb_garmin','sports_gps_watch','Forerunner','Forerunner 265','approved',null,258,233),
('wm_87302ca46ff6','wb_garmin','sports_gps_watch','Forerunner','Forerunner 265S','approved',null,259,234),
('wm_6b96c5950c42','wb_garmin','sports_gps_watch','Forerunner','Forerunner 35','approved',null,260,235),
('wm_f1cb66ea1ea6','wb_garmin','sports_gps_watch','Forerunner','Forerunner 45','approved',null,261,236),
('wm_f62dea3989e8','wb_garmin','sports_gps_watch','Forerunner','Forerunner 45S','approved',null,262,237),
('wm_f4bb101dd21f','wb_garmin','sports_gps_watch','Forerunner','Forerunner 55','approved',null,263,238),
('wm_181ffdf7095c','wb_garmin','sports_gps_watch','Forerunner','Forerunner 570','approved',null,264,239),
('wm_a91d173e1244','wb_garmin','sports_gps_watch','Forerunner','Forerunner 630','approved',null,265,240),
('wm_1a61fdcb10c9','wb_garmin','sports_gps_watch','Forerunner','Forerunner 645','approved',null,266,241),
('wm_548ca95913c3','wb_garmin','sports_gps_watch','Forerunner','Forerunner 645 Music','approved',null,267,242),
('wm_80b9c243e39c','wb_garmin','sports_gps_watch','Forerunner','Forerunner 735XT','approved',null,268,243),
('wm_0908b4a20ee4','wb_garmin','sports_gps_watch','Forerunner','Forerunner 920XT','approved',null,269,244),
('wm_c5572dc106fb','wb_garmin','sports_gps_watch','Forerunner','Forerunner 935','approved',null,270,245),
('wm_321df001af4b','wb_garmin','sports_gps_watch','Forerunner','Forerunner 945','approved',null,271,246),
('wm_369d5a9920d5','wb_garmin','sports_gps_watch','Forerunner','Forerunner 970','approved',null,272,247),
('wm_af4379997496','wb_garmin','sports_gps_watch','Instinct','Instinct','approved',null,273,248),
('wm_e8dccce5f289','wb_garmin','sports_gps_watch','Instinct','Instinct 2','approved',null,274,249),
('wm_34db03e6d8d0','wb_garmin','sports_gps_watch','Instinct','Instinct 2 Solar','approved',null,275,250),
('wm_5ebc5526fea3','wb_garmin','sports_gps_watch','Instinct','Instinct 2S','approved',null,276,251),
('wm_a77869a5dfcc','wb_garmin','sports_gps_watch','Instinct','Instinct 2X Solar','approved',null,277,252),
('wm_92cc7726783e','wb_garmin','sports_gps_watch','Instinct','Instinct 3','approved',null,278,253),
('wm_4fe1998670a1','wb_garmin','sports_gps_watch','Instinct','Instinct Crossover','approved',null,279,254),
('wm_82ff822027c8','wb_garmin','sports_gps_watch','Instinct','Instinct E','approved',null,280,255),
('wm_d13f7a12c100','wb_garmin','sports_gps_watch','Instinct','Instinct Solar','approved',null,281,256),
('wm_305009f886bf','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Lily','approved',null,287,257),
('wm_99fde08b11a2','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Lily 2','approved',null,288,258),
('wm_eff5908ae2d1','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Lily 2 Active','approved',null,289,259),
('wm_8bd11edc551c','wb_garmin','sports_gps_watch','Swim / Approach / Lily','Swim 2','approved',null,290,260),
('wm_bb00865474e4','wb_garmin','sports_gps_watch','Tactix','Tactix 7','approved',null,291,261),
('wm_8b71516d91a2','wb_garmin','sports_gps_watch','Tactix','Tactix 7 Pro','approved',null,292,262),
('wm_ca4864f0f4db','wb_garmin','sports_gps_watch','Tactix','Tactix Delta','approved',null,293,263),
('wm_3cd0d97ca00e','wb_garmin','smartwatch','Venu','Venu','approved',null,206,264),
('wm_2a884fc2c67c','wb_garmin','smartwatch','Venu','Venu 2','approved',null,207,265),
('wm_6c08a1511d97','wb_garmin','smartwatch','Venu','Venu 2 Plus','approved',null,208,266),
('wm_1b36aa019e0f','wb_garmin','smartwatch','Venu','Venu 2S','approved',null,209,267),
('wm_6d5018294419','wb_garmin','smartwatch','Venu','Venu 3','approved',null,210,268),
('wm_f0e47a0eef6f','wb_garmin','smartwatch','Venu','Venu 3S','approved',null,211,269),
('wm_50b5bc02021d','wb_garmin','smartwatch','Venu','Venu 4','approved',null,212,270),
('wm_fd219c5289ef','wb_garmin','smartwatch','Venu','Venu Sq','approved',null,213,271),
('wm_b075749b204c','wb_garmin','smartwatch','Venu','Venu Sq 2','approved',null,214,272),
('wm_272c1759a6b4','wb_garmin','smartwatch','Venu','Venu X1','approved',null,215,273),
('wm_ad33cc74f716','wb_garmin','smartwatch','Vivoactive','Vivoactive 3','approved',null,216,274),
('wm_a2a97205136d','wb_garmin','smartwatch','Vivoactive','Vivoactive 3 Music','approved',null,217,275),
('wm_8e84f4352868','wb_garmin','smartwatch','Vivoactive','Vivoactive 4','approved',null,218,276),
('wm_ba181a28951f','wb_garmin','smartwatch','Vivoactive','Vivoactive 4S','approved',null,219,277),
('wm_b1912612c386','wb_garmin','smartwatch','Vivoactive','Vivoactive 5','approved',null,220,278),
('wm_bf7a46c5e407','wb_garmin','smartwatch','Vivoactive','Vivoactive 6','approved',null,221,279),
('wm_0e614fca573e','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivofit 3','approved',null,193,280),
('wm_67b5292b07ef','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivofit 4','approved',null,194,281),
('wm_32d30b58d2a9','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivofit Jr 3','approved',null,195,282),
('wm_ab42132fa24d','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivomove 3','approved',null,196,283),
('wm_177da02aa5cb','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivomove HR','approved',null,197,284),
('wm_8465966d130e','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivomove Sport','approved',null,198,285),
('wm_1291488ef50b','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivomove Style','approved',null,199,286),
('wm_3d3b02e7062a','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivomove Trend','approved',null,200,287),
('wm_ee737676967b','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivosmart 3','approved',null,201,288),
('wm_ca4d136d4bcf','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivosmart 4','approved',null,202,289),
('wm_e79fad41e27b','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivosmart 5','approved',null,203,290),
('wm_44271da99f38','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivosmart HR','approved',null,204,291),
('wm_510d1d3cc6a7','wb_garmin','fitness_band','Vivosmart / Vivofit','Vivosport','approved',null,205,292),
('wm_bc546e169425','wb_google','smartwatch','Pixel Watch','Pixel Watch','approved',null,294,293),
('wm_84ce30fe7c90','wb_google','smartwatch','Pixel Watch','Pixel Watch 2','approved',null,295,294),
('wm_b9d652ccbe80','wb_google','smartwatch','Pixel Watch','Pixel Watch 3','approved',null,296,295),
('wm_d5345e4908f3','wb_google','smartwatch','Pixel Watch','Pixel Watch 4','approved',null,297,296),
('wm_29f3f0486912','wb_haylou','smartwatch','Haylou','Haylou GST','approved',null,298,297),
('wm_00a249ff02d9','wb_haylou','smartwatch','Haylou','Haylou LS02','approved',null,299,298),
('wm_3a019a9223f4','wb_haylou','smartwatch','Haylou','Haylou RS4','approved',null,300,299),
('wm_943a898808ca','wb_haylou','smartwatch','Haylou','Haylou Solar','approved',null,301,300),
('wm_f294d36d0003','wb_haylou','smartwatch','Haylou','Haylou Solar LS05','approved',null,302,301),
('wm_e13e19d07a9a','wb_honor','fitness_band','Honor Band','Honor Band 10','approved',null,303,302),
('wm_3fafbb16d1c6','wb_honor','fitness_band','Honor Band','Honor Band 5','approved',null,304,303),
('wm_4b79202b0ed6','wb_honor','fitness_band','Honor Band','Honor Band 5i','approved',null,305,304),
('wm_e911f7e53383','wb_honor','fitness_band','Honor Band','Honor Band 6','approved',null,306,305),
('wm_4e3dcc86248c','wb_honor','fitness_band','Honor Band','Honor Band 7','approved',null,307,306),
('wm_b63235887e9b','wb_honor','fitness_band','Honor Band','Honor Band 9','approved',null,308,307),
('wm_f4ee5b56dcd1','wb_honor','smartwatch','Honor Watch','Honor Watch 4','approved',null,309,308),
('wm_2e5e4db54210','wb_honor','smartwatch','Honor Watch','Honor Watch 5','approved',null,310,309),
('wm_414df26b846c','wb_honor','smartwatch','Honor Watch','Honor Watch ES','approved',null,311,310),
('wm_88e4c12d04a9','wb_honor','smartwatch','Honor Watch','Honor Watch GS 3','approved',null,312,311),
('wm_142c1f0a6597','wb_honor','smartwatch','Honor Watch','Honor Watch GS 4','approved',null,313,312),
('wm_e551f9efc5ab','wb_honor','smartwatch','Honor Watch','Honor Watch GS Pro','approved',null,314,313),
('wm_2760c529af6f','wb_honor','smartwatch','Honor Watch','Honor Watch Magic 2','approved',null,315,314),
('wm_e3285e557986','wb_huawei','fitness_band','Huawei Band','Huawei Band 10','approved',null,316,315),
('wm_998f38d8b60f','wb_huawei','fitness_band','Huawei Band','Huawei Band 3 Pro','approved',null,317,316),
('wm_f064b820125b','wb_huawei','fitness_band','Huawei Band','Huawei Band 4','approved',null,318,317),
('wm_9e314c20f5ea','wb_huawei','fitness_band','Huawei Band','Huawei Band 4 Pro','approved',null,319,318),
('wm_0088d7a7383a','wb_huawei','fitness_band','Huawei Band','Huawei Band 4e','approved',null,320,319),
('wm_4ad89d07be0c','wb_huawei','fitness_band','Huawei Band','Huawei Band 6','approved',null,321,320),
('wm_536c8f7033be','wb_huawei','fitness_band','Huawei Band','Huawei Band 7','approved',null,322,321),
('wm_27302789b080','wb_huawei','fitness_band','Huawei Band','Huawei Band 8','approved',null,323,322),
('wm_195177aea106','wb_huawei','fitness_band','Huawei Band','Huawei Band 9','approved',null,324,323),
('wm_0ad382fca758','wb_huawei','smartwatch','Huawei Watch','Huawei Watch 2','approved',null,325,324),
('wm_67c71af7a546','wb_huawei','smartwatch','Huawei Watch','Huawei Watch 2 Pro','approved',null,326,325),
('wm_5f79e945c238','wb_huawei','smartwatch','Huawei Watch','Huawei Watch 3','approved',null,327,326),
('wm_4468bdbad867','wb_huawei','smartwatch','Huawei Watch','Huawei Watch 3 Pro','approved',null,328,327),
('wm_3efd9b968cf2','wb_huawei','smartwatch','Huawei Watch','Huawei Watch 4','approved',null,329,328),
('wm_672ec309507a','wb_huawei','smartwatch','Huawei Watch','Huawei Watch 4 Pro','approved',null,330,329),
('wm_89eb3e711534','wb_huawei','smartwatch','Huawei Watch','Huawei Watch 5','approved',null,331,330),
('wm_e0e19729ccdf','wb_huawei','smartwatch','Huawei Watch','Huawei Watch D','approved',null,332,331),
('wm_9cfd43cb7c08','wb_huawei','smartwatch','Huawei Watch','Huawei Watch D2','approved',null,333,332),
('wm_478730064bb9','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Fit','approved',null,334,333),
('wm_d36a8914a269','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Fit 2','approved',null,335,334),
('wm_29e8b69cfb37','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Fit 3','approved',null,336,335),
('wm_0b3775b38f6b','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Fit 4','approved',null,337,336),
('wm_f6d7673d925e','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Fit 4 Pro','approved',null,338,337),
('wm_a50540181864','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Fit Special Edition','approved',null,339,338),
('wm_6f728e7977cd','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT','approved',null,340,339),
('wm_b910cf8ea7fe','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 2','approved',null,341,340),
('wm_e2d3f4593b98','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 2 Pro','approved',null,342,341),
('wm_d76b50885df2','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 2e','approved',null,343,342),
('wm_3519e95564ce','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 3','approved',null,344,343),
('wm_f1202a6223d7','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 3 Pro','approved',null,345,344),
('wm_1aa59eb5796f','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 4','approved',null,346,345),
('wm_5977023eeb83','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 5','approved',null,347,346),
('wm_f011d4161e81','wb_huawei','smartwatch','Huawei Watch','Huawei Watch GT 5 Pro','approved',null,348,347),
('wm_dc647f895966','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Magic','approved',null,349,348),
('wm_d9f4e47e12cf','wb_huawei','smartwatch','Huawei Watch','Huawei Watch Ultimate','approved',null,350,349),
('wm_779c201b15b5','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Bradshaw','approved',null,351,350),
('wm_702746d7779f','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Bradshaw 2','approved',null,352,351),
('wm_4eb6356ec943','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Gen 5E MKGO','approved',null,353,352),
('wm_f19fa47d96ed','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Grayson','approved',null,354,353),
('wm_5bafc908cc2b','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Lexington','approved',null,355,354),
('wm_764e47c8157f','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Lexington 2','approved',null,356,355),
('wm_683fa6f125e5','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Runway','approved',null,357,356),
('wm_ec12ca328b53','wb_michael-kors','smartwatch','MK Access','Michael Kors Access Sofie','approved',null,358,357),
('wm_f33764232445','wb_mobvoi','smartwatch','TicWatch','TicWatch C2','approved',null,359,358),
('wm_e0f1aac12724','wb_mobvoi','smartwatch','TicWatch','TicWatch C2+','approved',null,360,359),
('wm_1f90f829ba3e','wb_mobvoi','smartwatch','TicWatch','TicWatch E','approved',null,361,360),
('wm_231f644dc82a','wb_mobvoi','smartwatch','TicWatch','TicWatch E2','approved',null,362,361),
('wm_c228538d4f77','wb_mobvoi','smartwatch','TicWatch','TicWatch E3','approved',null,363,362),
('wm_b1108a32465f','wb_mobvoi','smartwatch','TicWatch','TicWatch Escape','approved',null,364,363),
('wm_2807c8cedd82','wb_mobvoi','smartwatch','TicWatch','TicWatch Express','approved',null,365,364),
('wm_14e60280deab','wb_mobvoi','smartwatch','TicWatch','TicWatch GTH','approved',null,366,365),
('wm_0ebb5392e4af','wb_mobvoi','smartwatch','TicWatch','TicWatch GTH Pro','approved',null,367,366),
('wm_d277d7016cf0','wb_mobvoi','smartwatch','TicWatch','TicWatch GTX','approved',null,368,367),
('wm_f69e6dcbf4b0','wb_mobvoi','smartwatch','TicWatch','TicWatch Move','approved',null,369,368),
('wm_c873dd08f434','wb_mobvoi','smartwatch','TicWatch','TicWatch Move Speed','approved',null,370,369),
('wm_6878f9fd6425','wb_mobvoi','smartwatch','TicWatch','TicWatch Pro','approved',null,371,370),
('wm_80882a2fabc9','wb_mobvoi','smartwatch','TicWatch','TicWatch Pro 3','approved',null,372,371),
('wm_a2b065bcf636','wb_mobvoi','smartwatch','TicWatch','TicWatch Pro 3 LTE','approved',null,373,372),
('wm_721d17f75f71','wb_mobvoi','smartwatch','TicWatch','TicWatch Pro 3 Ultra','approved',null,374,373),
('wm_4a78f7c22fcd','wb_mobvoi','smartwatch','TicWatch','TicWatch Pro 5','approved',null,375,374),
('wm_546108b7adb4','wb_mobvoi','smartwatch','TicWatch','TicWatch Pro 5 Enduro','approved',null,376,375),
('wm_e172b6e6f073','wb_mobvoi','smartwatch','TicWatch','TicWatch Pro X','approved',null,377,376),
('wm_95ead4167ab0','wb_mobvoi','smartwatch','TicWatch','TicWatch S','approved',null,378,377),
('wm_617b7a9a7ed3','wb_mobvoi','smartwatch','TicWatch','TicWatch S2','approved',null,379,378),
('wm_75270f905954','wb_mobvoi','smartwatch','TicWatch','TicWatch Sport','approved',null,380,379),
('wm_648376f9b80c','wb_mobvoi','smartwatch','TicWatch','TicWatch Zephyr','approved',null,381,380),
('wm_5680fd11fe95','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto 360 (1st Gen)','approved',null,382,381),
('wm_2a663caedec6','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto 360 (2nd Gen)','approved',null,383,382),
('wm_aef36c3bd22b','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto 360 (3rd Gen)','approved',null,384,383),
('wm_45d15da2cadd','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto 360 Sport','approved',null,385,384),
('wm_c94f699c1b7b','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto Watch 100','approved',null,386,385),
('wm_200a7729692b','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto Watch 120','approved',null,387,386),
('wm_423eb3ebca3d','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto Watch 70','approved',null,388,387),
('wm_68be70d2ef1d','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto Watch Fit','approved',null,389,388),
('wm_b07f5b65f7f5','wb_motorola','smartwatch','Moto 360 / Moto Watch','Moto Watch Fit 2','approved',null,390,389),
('wm_4ec78e19e725','wb_noise','fitness_band','Noise Band','Noise Band','approved',null,391,390),
('wm_1620b15b0162','wb_noise','fitness_band','Noise Band','Noise Band 2','approved',null,392,391),
('wm_03719198bc9e','wb_noise','fitness_band','Noise Band','Noise Band 3','approved',null,393,392),
('wm_4925ad80db25','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Caliber','approved',null,399,393),
('wm_243f832a2acb','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Icon 2','approved',null,400,394),
('wm_968b8e5f23ad','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Icon 3','approved',null,401,395),
('wm_0a7739f6fea5','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Pro 2','approved',null,402,396),
('wm_9f3014c3ebc3','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Pro 3','approved',null,403,397),
('wm_940182eeb63d','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Pro 4','approved',null,404,398),
('wm_2fc8521dd87e','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Pro 5','approved',null,405,399),
('wm_e7267b1bf0da','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Pulse 2','approved',null,406,400),
('wm_2e6d496cdcc0','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Pulse 3','approved',null,407,401),
('wm_0e94fc76bb19','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Pulse Grand','approved',null,408,402),
('wm_bebbd7d6361a','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Ultra','approved',null,409,403),
('wm_97d8b4313c4f','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Ultra 2','approved',null,410,404),
('wm_038f6ad8d85d','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Ultra 3','approved',null,411,405),
('wm_b2d9d4de4299','wb_noise','smartwatch','ColorFit / NoiseFit','Noise ColorFit Vision 2','approved',null,412,406),
('wm_9f505b6fcdee','wb_noise','smart_ring','Noise Luna','Noise Luna Ring','approved',null,396,407),
('wm_2fb8eac1c8a2','wb_noise','smart_ring','Noise Luna','Noise Luna Ring Gold','quarantined','possible_variant',397,408),
('wm_af9c7ed4ebb9','wb_noise','smart_ring','Noise Luna','Noise Luna Ring Matte','quarantined','possible_variant',398,409),
('wm_603709a8cd05','wb_noise','smartwatch','ColorFit / NoiseFit','Noise Pro 6','approved',null,413,410),
('wm_dbb759ed584c','wb_noise','fitness_band','Noise Band','Noise Pure Band','approved',null,394,411),
('wm_97a849a2f747','wb_noise','fitness_band','Noise Band','Noise Smart Band','approved',null,395,412),
('wm_d44c9cb11f91','wb_noise','smartwatch','ColorFit / NoiseFit','Noise Twist','approved',null,414,413),
('wm_2d30f36e5584','wb_noise','smartwatch','ColorFit / NoiseFit','NoiseFit Active','approved',null,415,414),
('wm_58ffb725ad6c','wb_noise','smartwatch','ColorFit / NoiseFit','NoiseFit Evolve 2','approved',null,416,415),
('wm_4b7953d1b93b','wb_noise','smartwatch','ColorFit / NoiseFit','NoiseFit Halo','approved',null,417,416),
('wm_6a42d94415a9','wb_nothing','fitness_band','CMF Watch','CMF Band','approved',null,418,417),
('wm_6f868fb46c68','wb_nothing','fitness_band','CMF Watch','CMF Band Pro','approved',null,419,418),
('wm_a61dd9af5e15','wb_nothing','smartwatch','CMF Watch','CMF Watch 2','approved',null,420,419),
('wm_d8b27031e5e4','wb_nothing','smartwatch','CMF Watch','CMF Watch 2 Pro','approved',null,421,420),
('wm_0f248694a2fa','wb_nothing','smartwatch','CMF Watch','CMF Watch 3 Pro','approved',null,422,421),
('wm_b69d58832eae','wb_nothing','smartwatch','CMF Watch','CMF Watch Lite','approved',null,423,422),
('wm_f5f9c133bdf4','wb_nothing','smartwatch','CMF Watch','CMF Watch Pro','approved',null,424,423),
('wm_f42be73c3fc9','wb_nothing','smartwatch','CMF Watch','CMF Watch Pro 2','approved',null,425,424),
('wm_aa63455111d0','wb_oneplus','fitness_band','OnePlus Band','OnePlus Band','approved',null,426,425),
('wm_bbed3486a128','wb_oneplus','smartwatch','OnePlus Watch','OnePlus Watch','approved',null,427,426),
('wm_b27c2ec2134f','wb_oneplus','smartwatch','OnePlus Watch','OnePlus Watch 2','approved',null,428,427),
('wm_337c946350b3','wb_oneplus','smartwatch','OnePlus Watch','OnePlus Watch 2R','approved',null,429,428),
('wm_86c22fcc8041','wb_oneplus','smartwatch','OnePlus Watch','OnePlus Watch 3','approved',null,430,429),
('wm_12ee7f2a3ebd','wb_oneplus','smartwatch','OnePlus Watch','OnePlus Watch 3 43mm','approved',null,431,430),
('wm_0521abb475d7','wb_oneplus','smartwatch','OnePlus Watch','OnePlus Watch Cushion','approved',null,432,431),
('wm_64196e2f00ac','wb_oppo','fitness_band','Oppo Band','Oppo Band','approved',null,433,432),
('wm_42ec0c062a42','wb_oppo','fitness_band','Oppo Band','Oppo Band 2','approved',null,434,433),
('wm_946c0b8c989b','wb_oppo','fitness_band','Oppo Band','Oppo Band 3','approved',null,435,434),
('wm_c32eddb5f32f','wb_oppo','fitness_band','Oppo Band','Oppo Band Sport','approved',null,436,435),
('wm_89220a173240','wb_oppo','smartwatch','Oppo Watch','Oppo Watch','approved',null,437,436),
('wm_a2acedd09ef3','wb_oppo','smartwatch','Oppo Watch','Oppo Watch 2','approved',null,438,437),
('wm_4b866dac682d','wb_oppo','smartwatch','Oppo Watch','Oppo Watch 3','approved',null,439,438),
('wm_76294c88bc77','wb_oppo','smartwatch','Oppo Watch','Oppo Watch 3 Pro','approved',null,440,439),
('wm_5328adb129b1','wb_oppo','smartwatch','Oppo Watch','Oppo Watch Free','approved',null,441,440),
('wm_906f03778a10','wb_oppo','smartwatch','Oppo Watch','Oppo Watch X','approved',null,442,441),
('wm_61e08936c623','wb_oppo','smartwatch','Oppo Watch','Oppo Watch X2','approved',null,443,442),
('wm_2a9b8cd45553','wb_oura','smart_ring','Oura Ring','Oura Ring 4','approved',null,444,443),
('wm_92cf0a6b14fe','wb_oura','smart_ring','Oura Ring','Oura Ring Ceramic','quarantined','possible_variant',445,444),
('wm_56ef5ca4ae37','wb_oura','smart_ring','Oura Ring','Oura Ring Gen2','approved',null,446,445),
('wm_619ccc4f63f3','wb_oura','smart_ring','Oura Ring','Oura Ring Gen3','approved',null,447,446),
('wm_42448db8089b','wb_oura','smart_ring','Oura Ring','Oura Ring Heritage','quarantined','possible_variant',448,447),
('wm_e079ced4f996','wb_oura','smart_ring','Oura Ring','Oura Ring Horizon','quarantined','possible_variant',449,448),
('wm_2a5ea5ecdda0','wb_pebble','smartwatch','Pebble Time / Steel (original)','Pebble 2','approved',null,454,449),
('wm_1d086428ad79','wb_pebble','smartwatch','Pebble Cosmos','Pebble Cosmos Engage','approved',null,450,450),
('wm_96956b41490e','wb_pebble','smartwatch','Pebble Cosmos','Pebble Cosmos Luxe','approved',null,451,451),
('wm_9237c011b7e6','wb_pebble','smartwatch','Pebble Cosmos','Pebble Cosmos Pro','approved',null,452,452),
('wm_9ec70f818a02','wb_pebble','smartwatch','Pebble Cosmos','Pebble Cosmos Vault','approved',null,453,453),
('wm_131967ea40d7','wb_pebble','smartwatch','Pebble Time / Steel (original)','Pebble Steel','approved',null,455,454),
('wm_5bdb26078ef4','wb_pebble','smartwatch','Pebble Time / Steel (original)','Pebble Time','approved',null,456,455),
('wm_cd3fef5c9309','wb_pebble','smartwatch','Pebble Time / Steel (original)','Pebble Time Round','approved',null,457,456),
('wm_20a55a2be96d','wb_pebble','smartwatch','Pebble Time / Steel (original)','Pebble Time Steel','approved',null,458,457),
('wm_278b37248bc4','wb_polar','sports_gps_watch','Polar watches','Polar A370','approved',null,459,458),
('wm_e1e228c9b98b','wb_polar','sports_gps_watch','Polar watches','Polar Grit X','approved',null,460,459),
('wm_64c9dad52b2d','wb_polar','sports_gps_watch','Polar watches','Polar Grit X Pro','approved',null,461,460),
('wm_3b7ebb5a48f1','wb_polar','sports_gps_watch','Polar watches','Polar Ignite','approved',null,462,461),
('wm_04ee672d81e6','wb_polar','sports_gps_watch','Polar watches','Polar Ignite 2','approved',null,463,462),
('wm_105c2311e5b4','wb_polar','sports_gps_watch','Polar watches','Polar Ignite 3','approved',null,464,463),
('wm_91a5a8271f8d','wb_polar','sports_gps_watch','Polar watches','Polar Loop','approved',null,465,464),
('wm_4f7230086a5a','wb_polar','sports_gps_watch','Polar watches','Polar M200','approved',null,466,465),
('wm_e2fd6a865227','wb_polar','sports_gps_watch','Polar watches','Polar M430','approved',null,467,466),
('wm_05b397ebcb4b','wb_polar','sports_gps_watch','Polar watches','Polar Pacer','approved',null,468,467),
('wm_8b0e45696a65','wb_polar','sports_gps_watch','Polar watches','Polar Pacer Pro','approved',null,469,468),
('wm_f1da599a2a15','wb_polar','sports_gps_watch','Polar watches','Polar Unite','approved',null,470,469),
('wm_c4bc92c7c432','wb_polar','sports_gps_watch','Polar watches','Polar Vantage M','approved',null,471,470),
('wm_850d0985aa3b','wb_polar','sports_gps_watch','Polar watches','Polar Vantage M2','approved',null,472,471),
('wm_fba218b8d225','wb_polar','sports_gps_watch','Polar watches','Polar Vantage V','approved',null,473,472),
('wm_ad5ec3f05fe1','wb_polar','sports_gps_watch','Polar watches','Polar Vantage V2','approved',null,474,473),
('wm_76ed73ada583','wb_polar','sports_gps_watch','Polar watches','Polar Vantage V3','approved',null,475,474),
('wm_adaf9860fdab','wb_realme','fitness_band','Realme Band','Realme Band','approved',null,476,475),
('wm_522d5cd05027','wb_realme','fitness_band','Realme Band','Realme Band 2','approved',null,477,476),
('wm_4cc5fd6ebd92','wb_realme','fitness_band','Realme TechLife','Realme TechLife Band','approved',null,478,477),
('wm_3954ebe68507','wb_realme','fitness_band','Realme TechLife','Realme TechLife Smart Band','approved',null,479,478),
('wm_3750acadb731','wb_realme','smartwatch','Realme Watch','Realme TechLife Watch R100','approved',null,483,479),
('wm_46c40e4308ec','wb_realme','smartwatch','Realme TechLife','Realme TechLife Watch R150','approved',null,480,480),
('wm_368d94e2ff4a','wb_realme','smartwatch','Realme TechLife','Realme TechLife Watch R200','approved',null,481,481),
('wm_75214782ec2f','wb_realme','smartwatch','Realme TechLife','Realme TechLife Watch S100','approved',null,482,482),
('wm_ef7f27cefa74','wb_realme','smartwatch','Realme Watch','Realme TechLife Watch SZ100','approved',null,484,483),
('wm_0e2433221c00','wb_realme','smartwatch','Realme Watch','Realme Watch','approved',null,485,484),
('wm_fed9e5f23a09','wb_realme','smartwatch','Realme Watch','Realme Watch 2','approved',null,486,485),
('wm_6206e8996987','wb_realme','smartwatch','Realme Watch','Realme Watch 2 Pro','approved',null,487,486),
('wm_178aa99167d0','wb_realme','smartwatch','Realme Watch','Realme Watch 3','approved',null,488,487),
('wm_48fa3b24248e','wb_realme','smartwatch','Realme Watch','Realme Watch 3 Pro','approved',null,489,488),
('wm_b9b1aa902f06','wb_realme','smartwatch','Realme Watch','Realme Watch 5','approved',null,490,489),
('wm_533706df07b2','wb_realme','smartwatch','Realme Watch','Realme Watch S','approved',null,491,490),
('wm_e77737e87fff','wb_realme','smartwatch','Realme Watch','Realme Watch S Pro','approved',null,492,491),
('wm_b525b97e73b3','wb_ringconn','smart_ring','RingConn','RingConn Gen 1','approved',null,493,492),
('wm_efa8a8454b52','wb_ringconn','smart_ring','RingConn','RingConn Gen 2','approved',null,494,493),
('wm_c973f1b814e3','wb_ringconn','smart_ring','RingConn','RingConn Gen 2 Air','approved',null,495,494),
('wm_18f9dabf3c68','wb_ringconn','smart_ring','RingConn','RingConn Gen 2 Pro','approved',null,496,495),
('wm_0f80d657300a','wb_ringconn','smart_ring','RingConn','RingConn Smart Ring','approved',null,497,496),
('wm_2ec04dea0b8b','wb_samsung','fitness_band','Galaxy Fit','Galaxy Fit','approved',null,498,497),
('wm_8c1049ec06e8','wb_samsung','fitness_band','Galaxy Fit','Galaxy Fit e','approved',null,499,498),
('wm_9a4b4dd7ca0a','wb_samsung','fitness_band','Galaxy Fit','Galaxy Fit2','approved',null,500,499),
('wm_f6ad477ca9db','wb_samsung','fitness_band','Galaxy Fit','Galaxy Fit3','approved',null,501,500),
('wm_19251c7a06b3','wb_samsung','fitness_band','Galaxy Fit','Galaxy Gear Fit2 Pro','approved',null,502,501),
('wm_8c408c7e78d6','wb_samsung','smartwatch','Galaxy Watch','Galaxy Gear S2','approved',null,504,502),
('wm_53303a0f567f','wb_samsung','smartwatch','Galaxy Watch','Galaxy Gear S3','approved',null,505,503),
('wm_9324035a0cd9','wb_samsung','smartwatch','Galaxy Watch','Galaxy Gear Sport','approved',null,506,504),
('wm_549d1a076a0e','wb_samsung','smart_ring','Galaxy Ring','Galaxy Ring','approved',null,503,505),
('wm_f9712c72416f','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch (42mm)','approved',null,507,506),
('wm_dff030a53a65','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch (46mm)','approved',null,508,507),
('wm_da1d3a955e3c','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch Active','approved',null,509,508),
('wm_9878b3596d3d','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch Active2','approved',null,510,509),
('wm_4b8aa7d3cbc6','wb_samsung','smartwatch','Galaxy Watch FE','Galaxy Watch FE','approved',null,521,510),
('wm_732fa7b70d30','wb_samsung','sports_gps_watch','Galaxy Watch Ultra','Galaxy Watch Ultra (2024)','approved',null,522,511),
('wm_52755860b53c','wb_samsung','sports_gps_watch','Galaxy Watch Ultra','Galaxy Watch Ultra (2025)','approved',null,523,512),
('wm_3b4e13f6cfca','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch3','approved',null,511,513),
('wm_9d9fa2ef9f96','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch4','approved',null,512,514),
('wm_6e6fc7b1456f','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch4 Classic','approved',null,513,515),
('wm_696f5ddc9af6','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch5','approved',null,514,516),
('wm_0421afe523be','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch5 Pro','approved',null,515,517),
('wm_ea9c657a3dd1','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch6','approved',null,516,518),
('wm_de1e495abcf6','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch6 Classic','approved',null,517,519),
('wm_91f4a74b5432','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch7','approved',null,518,520),
('wm_f0a7d1a843b1','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch8','approved',null,519,521),
('wm_062011cef4a0','wb_samsung','smartwatch','Galaxy Watch','Galaxy Watch8 Classic','approved',null,520,522),
('wm_6d2287472d50','wb_skagen','smartwatch','Skagen Falster','Skagen Falster','approved',null,524,523),
('wm_490bb99097ea','wb_skagen','smartwatch','Skagen Falster','Skagen Falster 2','approved',null,525,524),
('wm_32c0f5536fd3','wb_skagen','smartwatch','Skagen Falster','Skagen Falster 3','approved',null,526,525),
('wm_347e49a1b243','wb_skagen','smartwatch','Skagen Falster','Skagen Jorn','approved',null,527,526),
('wm_9368bacf4d04','wb_skagen','smartwatch','Skagen Falster','Skagen Jorn HR','approved',null,528,527),
('wm_195da4e925eb','wb_suunto','sports_gps_watch','Suunto watches','Suunto 5','approved',null,529,528),
('wm_f990040ed56c','wb_suunto','sports_gps_watch','Suunto watches','Suunto 5 Peak','approved',null,530,529),
('wm_8d7f11d72593','wb_suunto','sports_gps_watch','Suunto watches','Suunto 7','approved',null,531,530),
('wm_4223d600a364','wb_suunto','sports_gps_watch','Suunto watches','Suunto 9','approved',null,532,531),
('wm_1a0be9134726','wb_suunto','sports_gps_watch','Suunto watches','Suunto 9 Peak','approved',null,533,532),
('wm_12ba8970c7af','wb_suunto','sports_gps_watch','Suunto watches','Suunto 9 Peak Pro','approved',null,534,533),
('wm_17d19e5aaa79','wb_suunto','sports_gps_watch','Suunto watches','Suunto Ambit3 Peak','approved',null,535,534),
('wm_790cae82e3cb','wb_suunto','sports_gps_watch','Suunto watches','Suunto Core','approved',null,536,535),
('wm_52d4644a82f8','wb_suunto','sports_gps_watch','Suunto watches','Suunto Race','approved',null,537,536),
('wm_7650e7ff1972','wb_suunto','sports_gps_watch','Suunto watches','Suunto Race S','approved',null,538,537),
('wm_47bb61d434c6','wb_suunto','sports_gps_watch','Suunto watches','Suunto Spartan Sport','approved',null,539,538),
('wm_c6aca59714ea','wb_suunto','sports_gps_watch','Suunto watches','Suunto Vertical','approved',null,540,539),
('wm_c50860548536','wb_titan','smartwatch','Titan Smart / Raga','Titan Celestor','approved',null,541,540),
('wm_7e1895ebabe4','wb_titan','smartwatch','Titan Smart / Raga','Titan Connected X','approved',null,542,541),
('wm_ed9f21d16548','wb_titan','smartwatch','Titan Smart / Raga','Titan Crest','approved',null,543,542),
('wm_8341317851ff','wb_titan','smartwatch','Titan Smart / Raga','Titan Evoke','approved',null,544,543),
('wm_cde1ad2e93e6','wb_titan','smartwatch','Titan Smart / Raga','Titan Fit Pro','approved',null,545,544),
('wm_eb26ca8ec1a5','wb_titan','smartwatch','Titan Smart / Raga','Titan Raga Viva','approved',null,546,545),
('wm_4ff6a7bad450','wb_titan','smartwatch','Titan Smart / Raga','Titan Smart','approved',null,547,546),
('wm_1b168e468160','wb_titan','smartwatch','Titan Smart / Raga','Titan Smart Pro','approved',null,548,547),
('wm_1ecc96ba7376','wb_titan','smartwatch','Titan Smart / Raga','Titan Talk','approved',null,549,548),
('wm_af9d1bfc40fe','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Home','excluded','not_a_wearable',550,549),
('wm_671e1f5a285b','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Rare','quarantined','possible_variant',551,550),
('wm_0fcc5581b15d','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Ring AIR','approved',null,552,551),
('wm_6df3468d8781','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Ring AIR Bionic Gold','quarantined','possible_variant',553,552),
('wm_66c0bb85eab5','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Ring AIR Matte Grey','quarantined','possible_variant',554,553),
('wm_e8be83bd06b9','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Ring AIR Raw Titanium','quarantined','possible_variant',555,554),
('wm_8ebbd4cb3020','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Ring AIR Space Silver','quarantined','possible_variant',556,555),
('wm_fe0a66ed878f','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Ring AIR Titanium','quarantined','possible_variant',557,556),
('wm_e6337b01f3fe','wb_ultrahuman','smart_ring','Ultrahuman Ring','Ultrahuman Ring Pro','approved',null,558,557),
('wm_0d9c88b08df1','wb_vivo','smartwatch','Vivo Watch','Vivo Watch','approved',null,559,558),
('wm_29772f0f029e','wb_vivo','smartwatch','Vivo Watch','Vivo Watch 2','approved',null,560,559),
('wm_68cf24b74b6f','wb_vivo','smartwatch','Vivo Watch','Vivo Watch 3','approved',null,561,560),
('wm_1fed6cb5b35b','wb_vivo','smartwatch','Vivo Watch','Vivo Watch GT','approved',null,562,561),
('wm_41cbac4b9533','wb_whoop','fitness_band','Whoop','Whoop 3.0','excluded','subscription_only',563,562),
('wm_b6d8e1c2328e','wb_whoop','fitness_band','Whoop','Whoop 4.0','excluded','subscription_only',564,563),
('wm_d9483420182f','wb_whoop','fitness_band','Whoop','Whoop 5.0','excluded','subscription_only',565,564),
('wm_a55107e391a3','wb_whoop','fitness_band','Whoop','Whoop MG','excluded','subscription_only',566,565),
('wm_6e54306a3a25','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Band 2','approved',null,567,566),
('wm_b43ce8b8a759','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Band 3','approved',null,568,567),
('wm_54a8f619e7f2','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Band 3i','approved',null,569,568),
('wm_0d57e4d72820','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Band 4','approved',null,570,569),
('wm_a0b4c5d6ff96','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Band 5','approved',null,571,570),
('wm_9aa404485f4e','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Smart Band 6','approved',null,572,571),
('wm_ed4ef673798b','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Smart Band 7','approved',null,573,572),
('wm_ae65784d87bc','wb_xiaomi','fitness_band','Mi Band / Smart Band','Mi Smart Band 7 Pro','approved',null,574,573),
('wm_35cd21f42873','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Mi Watch','approved',null,588,574),
('wm_2b345704652d','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Mi Watch Lite','approved',null,589,575),
('wm_b780922689bf','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Mi Watch Revolve','approved',null,590,576),
('wm_39e963e6efe2','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Mi Watch Revolve Active','approved',null,591,577),
('wm_ef5fe711fdaa','wb_xiaomi','fitness_band','Mi Band / Smart Band','Redmi Band 3','approved',null,575,578),
('wm_21a331524bf5','wb_xiaomi','fitness_band','Mi Band / Smart Band','Redmi Band 5','approved',null,576,579),
('wm_923f00682908','wb_xiaomi','fitness_band','Mi Band / Smart Band','Redmi Smart Band','approved',null,577,580),
('wm_5cc185a03127','wb_xiaomi','fitness_band','Mi Band / Smart Band','Redmi Smart Band 2','approved',null,578,581),
('wm_27952888af5e','wb_xiaomi','fitness_band','Mi Band / Smart Band','Redmi Smart Band 5','approved',null,579,582),
('wm_cf7563bf503e','wb_xiaomi','fitness_band','Mi Band / Smart Band','Redmi Smart Band Pro','approved',null,580,583),
('wm_cc7740570d61','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch','approved',null,592,584),
('wm_3ba1856c90fd','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch 2 Lite','approved',null,593,585),
('wm_fdda4dd208c0','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch 3','approved',null,594,586),
('wm_55f369a91dd4','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch 3 Active','approved',null,595,587),
('wm_04cca665fe72','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch 4','approved',null,596,588),
('wm_2b449e44a549','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch 5','approved',null,597,589),
('wm_a11e782536dc','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch 5 Active','approved',null,598,590),
('wm_2aa7a79501dc','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch 5 Lite','approved',null,599,591),
('wm_f7f749d4f89d','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch Active','approved',null,600,592),
('wm_edc4082aeef1','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Redmi Watch Move','approved',null,601,593),
('wm_6ba604de0e57','wb_xiaomi','fitness_band','Mi Band / Smart Band','Xiaomi Smart Band 10','approved',null,581,594),
('wm_94e82b59557b','wb_xiaomi','fitness_band','Mi Band / Smart Band','Xiaomi Smart Band 8','approved',null,582,595),
('wm_a7912fee74aa','wb_xiaomi','fitness_band','Mi Band / Smart Band','Xiaomi Smart Band 8 Active','approved',null,583,596),
('wm_778ae04edf19','wb_xiaomi','fitness_band','Mi Band / Smart Band','Xiaomi Smart Band 8 Pro','approved',null,584,597),
('wm_05dba917870a','wb_xiaomi','fitness_band','Mi Band / Smart Band','Xiaomi Smart Band 9','approved',null,585,598),
('wm_f0af25cb8389','wb_xiaomi','fitness_band','Mi Band / Smart Band','Xiaomi Smart Band 9 Active','approved',null,586,599),
('wm_46cfe33879cb','wb_xiaomi','fitness_band','Mi Band / Smart Band','Xiaomi Smart Band 9 Pro','approved',null,587,600),
('wm_da732fa672ba','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Xiaomi Watch 2','approved',null,602,601),
('wm_62640c27ebff','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Xiaomi Watch 2 Pro','approved',null,603,602),
('wm_2987e67fc537','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Xiaomi Watch S1','approved',null,604,603),
('wm_f283d2127017','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Xiaomi Watch S1 Active','approved',null,605,604),
('wm_260ae31e4cf3','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Xiaomi Watch S1 Pro','approved',null,606,605),
('wm_2af51a253342','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Xiaomi Watch S3','approved',null,607,606),
('wm_d36e3dc38b90','wb_xiaomi','smartwatch','Xiaomi / Redmi Watch','Xiaomi Watch S4','approved',null,608,607) on conflict(id) do nothing;
-- END GENERATED CATALOGUE
do $$ begin
 if (select count(*) from public.wearable_models_v1 where status='approved')<>(select rows_approved from public.wearable_catalogue_revision_v1) or (select count(*) from public.wearable_models_v1)<>(select rows_total from public.wearable_catalogue_revision_v1) then raise exception 'WEARABLES_SEED_INCONSISTENT';end if;
end $$;

-- Session core: the Accessories V1 baseline impl_posting_v2_session body, moved with exactly four additions
-- (wearable binding filter on list_recovery, binding-aware create gate, atomic binding on creation, binding equality check).
create function app_security.impl_posting_session_core_v1(p_session_id uuid,p_operation text,p_media_id uuid,p_binding uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor(); s public.posting_upload_sessions; m public.posting_staged_media; n integer; candidate_id uuid; request_id uuid; empty_allocation boolean:=false; new_id uuid;
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
     and (select b.category_id from public.wearable_session_bindings_v1 b where b.session_id=candidate.id) is not distinct from p_binding
    order by candidate.created_at,candidate.id limit 5
   ) q),'[]'::jsonb));
 end if;
 -- Same seller lock as creation: capacity release and allocation serialize.
 if p_operation in ('create','create_empty','claim_draft','read','abandon_empty') then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,2));
 end if;
 if p_operation in ('create','create_empty') then
  if p_binding is null then
   if not exists(select 1 from public.posting_category_definitions where category_key='mobiles' and subcategory_key='mobile-phones' and version=2 and enabled) and not exists(select 1 from public.accessory_release_v1 r join public.categories c on c.id=r.category_id where r.enabled and c.is_active) then raise exception 'Posting unavailable'; end if;
  elsif not exists(select 1 from public.wearable_release_v1 r join public.categories c on c.id=r.category_id where r.category_id=p_binding and r.enabled and c.is_active) then raise exception 'Posting unavailable'; end if;
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
   values(p_session_id,u,not empty_allocation,case when empty_allocation then request_id else null end) on conflict(id) do nothing returning id into new_id;
  if new_id is not null and p_binding is not null then insert into public.wearable_session_bindings_v1(session_id,category_id) values(new_id,p_binding); end if;
 end if;
 select * into s from public.posting_upload_sessions where id=p_session_id and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
 if (select b.category_id from public.wearable_session_bindings_v1 b where b.session_id=s.id) is distinct from p_binding then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
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

-- ACL: the core is executable only by its two definer callers (the object owner). Clients cannot reach it
-- and cannot choose p_binding; every call is still bound to auth.uid(), the binding row and release tables.
revoke all on function app_security.impl_posting_session_core_v1(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;

-- Phone/accessory/tablet entry point: same signature, ACL preserved by CREATE OR REPLACE; hardcoded unbound selector.
create or replace function app_security.impl_posting_v2_session(p_session_id uuid,p_operation text,p_media_id uuid default null) returns jsonb language sql security definer set search_path='' as $$
 select app_security.impl_posting_session_core_v1(p_session_id,p_operation,p_media_id,null::uuid)
$$;

-- Wearable entry point: the category selector comes from the release table, never from input.
create function app_security.impl_wearable_v1_session(p_session_id uuid,p_operation text,p_media_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor();cat uuid;existing uuid;op text:=p_operation;sid uuid:=p_session_id;
begin
 select r.category_id into cat from public.wearable_release_v1 r join public.categories c on c.id=r.category_id where r.enabled and c.is_active;
 if cat is null then raise exception 'Wearable category unavailable';end if;
 if p_operation not in ('create','create_empty','claim_draft','acquire_draft','read','reserve','remove','prepare','abandon_empty','list_recovery') then raise exception 'Invalid wearable session operation';end if;
 if p_operation='acquire_draft' then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,2));
  select s.id into existing from public.posting_upload_sessions s where s.owner_id=u and s.id=p_session_id;
  if existing is not null then op:='create';
  else
   select s.id into existing from public.posting_upload_sessions s where s.owner_id=u and s.empty_request_id=p_session_id;
   if existing is not null then op:='claim_draft';sid:=existing;else op:='create';end if;
  end if;
 end if;
 return app_security.impl_posting_session_core_v1(sid,op,p_media_id,cat);
end $$;
create function public.wearable_v1_session(session_id uuid,operation text default 'create',media_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$select app_security.impl_wearable_v1_session(session_id,operation,media_id)$$;
revoke all on function app_security.impl_wearable_v1_session(uuid,text,uuid),public.wearable_v1_session(uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_wearable_v1_session(uuid,text,uuid),public.wearable_v1_session(uuid,text,uuid) to authenticated;

create function public.wearables_v1_catalogue() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('version',1,'revision',v.revision,'listing_category_id',r.category_id,'enabled',r.enabled and c.is_active)
 from public.wearable_release_v1 r join public.categories c on c.id=r.category_id cross join public.wearable_catalogue_revision_v1 v
$$;
revoke all on function public.wearables_v1_catalogue() from public,anon,authenticated,service_role;
grant execute on function public.wearables_v1_catalogue() to authenticated;

create function app_security.validate_wearable_v1(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare dt text:=p->>'device_type';allowed text[];k text;b public.wearable_brands_v1;m public.wearable_models_v1;hit record;n1 text;n2 text;b1 text;b2 text;bn text;mode text:=p->>'battery_mode';ps text:=p->>'pairing_status';cur text:=pg_catalog.to_char(pg_catalog.now(),'YYYY-MM');
begin
 if jsonb_typeof(p) is distinct from 'object' or pg_catalog.length(p::text)>8000 then raise exception 'Invalid wearable payload';end if;
 if dt is null or dt not in ('smartwatch','fitness_band','sports_gps_watch','smart_ring') then raise exception 'Invalid device type';end if;
 allowed:=array['selection','session_id','catalogue_revision','device_type','brand_id','other_brand','model_id','other_model','generation','phone_os','finish','condition','sensors','charging','battery_mode','included','purchase_month','warranty_until','pairing_status','transfer_ack','ownership_confirmed','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id'];
 if dt<>'smart_ring' then allowed:=allowed||array['screen','controls','strap'];end if;
 if dt in ('smartwatch','sports_gps_watch') then allowed:=allowed||array['case_size_mm'];end if;
 if dt='smart_ring' then allowed:=allowed||array['ring_size'];end if;
 if dt='smartwatch' then allowed:=allowed||array['connectivity'];end if;
 if dt='sports_gps_watch' then allowed:=allowed||array['gps_status'];end if;
 if mode='health_percent' then allowed:=allowed||array['battery_health_percent'];elsif mode='runtime_hours' then allowed:=allowed||array['battery_runtime_hours'];end if;
 if exists(select 1 from pg_catalog.jsonb_object_keys(p) x(key) where x.key<>all(allowed)) then raise exception 'Invalid wearable field';end if;
 foreach k in array allowed loop if not p?k then raise exception 'Missing wearable field: %',k;end if;end loop;
 if p->'selection' is distinct from '{"category":"mobiles","subcategory":"wearables","version":1}'::jsonb or p->>'plan_id' is distinct from 'free-v1' then raise exception 'Invalid wearable selection';end if;
 if p->>'catalogue_revision' is distinct from (select v.revision from public.wearable_catalogue_revision_v1 v) then raise exception 'CATALOGUE_REVISION_MISMATCH';end if;
 -- Pairing / ownership: locked and stolen declarations are blocked; still_paired is a separate, disclosed, review-controlled state.
 if ps='locked' then raise exception 'WEARABLE_LOCKED';end if;
 if ps is null or ps not in ('reset_ready','signed_out','still_paired','unknown') then raise exception 'Invalid pairing status';end if;
 if jsonb_typeof(p->'ownership_confirmed') is distinct from 'boolean' or (p->>'ownership_confirmed')::boolean is not true then raise exception 'WEARABLE_OWNERSHIP_UNCONFIRMED';end if;
 if jsonb_typeof(p->'transfer_ack') is distinct from 'boolean' then raise exception 'Invalid transfer acknowledgement';end if;
 if ps='still_paired' and (p->>'transfer_ack')::boolean is not true then raise exception 'WEARABLE_STILL_PAIRED_ACK_REQUIRED';end if;
 if ps<>'still_paired' and (p->>'transfer_ack')::boolean then raise exception 'Invalid transfer acknowledgement';end if;
 -- Brand / model ownership.
 if jsonb_typeof(p->'other_brand') is distinct from 'string' or jsonb_typeof(p->'other_model') is distinct from 'string' then raise exception 'Invalid brand or model text';end if;
 if jsonb_typeof(p->'brand_id')='string' then
  select * into b from public.wearable_brands_v1 where id=p->>'brand_id';
  if b.id is null or p->>'other_brand'<>'' then raise exception 'Invalid brand';end if;
  bn:=b.name;
  if jsonb_typeof(p->'model_id')='string' then
   select * into m from public.wearable_models_v1 where id=p->>'model_id' and status='approved';
   if m.id is null or m.brand_id<>b.id or m.device_type<>dt or p->>'other_model'<>'' then raise exception 'Invalid model';end if;
  elsif jsonb_typeof(p->'model_id') is distinct from 'null' then raise exception 'Invalid model';end if;
 elsif jsonb_typeof(p->'brand_id') is distinct from 'null' or jsonb_typeof(p->'model_id') is distinct from 'null' then raise exception 'Invalid brand';
 else
  bn:=pg_catalog.btrim(p->>'other_brand');
  if pg_catalog.length(bn) not between 2 and 60 then raise exception 'Invalid brand name';end if;
  if exists(select 1 from public.wearable_brands_v1 x where app_security.wearable_name_key(x.name)=app_security.wearable_name_key(bn)) then raise exception 'WEARABLE_BRAND_LISTED';end if;
 end if;
 if m.id is null then
  -- Other model: never a back door for quarantined, excluded or listed entries.
  if pg_catalog.length(pg_catalog.btrim(p->>'other_model')) not between 2 and 80 then raise exception 'Invalid model name';end if;
  n1:=app_security.wearable_name_key(p->>'other_model');n2:=app_security.wearable_name_key(bn||' '||(p->>'other_model'));
  b1:=app_security.wearable_base_key(p->>'other_model');b2:=app_security.wearable_base_key(bn||' '||(p->>'other_model'));
  if b1='' or n1='' then raise exception 'Invalid model name';end if;
  select x.status,x.reason into hit from public.wearable_models_v1 x where x.name_key in (n1,n2) or x.base_key in (b1,b2) order by (x.status='approved') limit 1;
  if hit.status is not null and hit.status<>'approved' then raise exception 'WEARABLE_MODEL_NOT_ACCEPTED:%',hit.reason;end if;
  if hit.status='approved' then raise exception 'WEARABLE_MODEL_LISTED';end if;
 end if;
 -- Type-specific attributes (seller-reported).
 if jsonb_typeof(p->'generation') is distinct from 'string' or pg_catalog.length(p->>'generation')>40 or jsonb_typeof(p->'finish') is distinct from 'string' or pg_catalog.length(p->>'finish')>40 then raise exception 'Invalid text field';end if;
 if p->>'condition' is null or p->>'condition' not in ('new','like_new','good','fair','poor') then raise exception 'Invalid condition';end if;
 if dt<>'smart_ring' then
  if p->>'screen' not in ('perfect','minor_scratches','cracked','not_working') or p->>'controls' not in ('working','issues','not_tested') or p->>'strap' not in ('good','worn','damaged','missing') then raise exception 'Invalid watch condition';end if;
 end if;
 if p->>'sensors' not in ('working','some_issues','not_tested') or p->>'charging' not in ('working','issues','not_tested') then raise exception 'Invalid condition detail';end if;
 if dt in ('smartwatch','sports_gps_watch') and not (jsonb_typeof(p->'case_size_mm')='null' or jsonb_typeof(p->'case_size_mm')='number' and (p->>'case_size_mm')~'^[0-9]{2}$' and (p->>'case_size_mm')::integer between 20 and 60) then raise exception 'Invalid case size';end if;
 if dt='smart_ring' and (jsonb_typeof(p->'ring_size') is distinct from 'string' or pg_catalog.length(pg_catalog.btrim(p->>'ring_size')) not between 1 and 20) then raise exception 'Invalid ring size';end if;
 if dt='smartwatch' and p->>'connectivity' not in ('bluetooth','lte','unknown') then raise exception 'Invalid connectivity';end if;
 if dt='sports_gps_watch' and p->>'gps_status' not in ('working','not_working','not_tested') then raise exception 'Invalid GPS status';end if;
 if mode is null or mode not in ('health_percent','runtime_hours','not_tested') then raise exception 'Invalid battery mode';end if;
 if mode='health_percent' and (dt<>'smartwatch' or jsonb_typeof(p->'battery_health_percent') is distinct from 'number' or (p->>'battery_health_percent')!~'^[0-9]{1,3}$' or (p->>'battery_health_percent')::integer not between 1 and 100) then raise exception 'Invalid battery health';end if;
 if mode='runtime_hours' and (jsonb_typeof(p->'battery_runtime_hours') is distinct from 'number' or (p->>'battery_runtime_hours')!~'^[0-9]{1,4}$' or (p->>'battery_runtime_hours')::integer not between 1 and 1440) then raise exception 'Invalid battery runtime';end if;
 if jsonb_typeof(p->'phone_os') is distinct from 'array' or exists(select 1 from pg_catalog.jsonb_array_elements(p->'phone_os') e where jsonb_typeof(e)<>'string' or e#>>'{}' not in ('android','ios')) or (select count(distinct e#>>'{}') from pg_catalog.jsonb_array_elements(p->'phone_os') e)<>jsonb_array_length(p->'phone_os') then raise exception 'Invalid phone compatibility';end if;
 if jsonb_typeof(p->'included') is distinct from 'array' or exists(select 1 from pg_catalog.jsonb_array_elements(p->'included') e where jsonb_typeof(e)<>'string' or e#>>'{}' <>all(array['charger','box','invoice','warranty_card']||case when dt='smart_ring' then array['charging_case'] else array['extra_strap'] end)) or (select count(distinct e#>>'{}') from pg_catalog.jsonb_array_elements(p->'included') e)<>jsonb_array_length(p->'included') then raise exception 'Invalid included items';end if;
 foreach k in array array['purchase_month','warranty_until'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or not (p->>k='' or p->>k~'^20[0-9]{2}-(0[1-9]|1[0-2])$') then raise exception 'Invalid month';end if;
 end loop;
 if p->>'purchase_month'<>'' and p->>'purchase_month'>cur then raise exception 'Purchase month is in the future';end if;
 if p->>'warranty_until'<>'' and p->>'warranty_until'<cur then raise exception 'Warranty has already ended';end if;
 -- Listing basics.
 if p->>'trade' not in ('sell','giveaway') or jsonb_typeof(p->'negotiable') is distinct from 'boolean' or jsonb_typeof(p->'price_paise') is distinct from 'number' or (p->>'price_paise')!~'^[0-9]{1,9}$' then raise exception 'Invalid price';end if;
 if p->>'trade'='giveaway' and ((p->>'price_paise')::integer<>0 or (p->>'negotiable')::boolean) or p->>'trade'='sell' and (p->>'price_paise')::integer not between 1 and 100000000 then raise exception 'Invalid price';end if;
 if pg_catalog.length(pg_catalog.btrim(p->>'title')) not between 5 and 80 or pg_catalog.length(pg_catalog.btrim(p->>'description')) not between 20 and 1500 then raise exception 'Invalid title or description';end if;
 perform app_security.phone_content_guard(pg_catalog.concat_ws(' ',p->>'title',p->>'description',p->>'other_brand',p->>'other_model',p->>'generation',p->>'finish',p->>'ring_size'));
end $$;
revoke all on function app_security.validate_wearable_v1(jsonb) from public,anon,authenticated,service_role;

create function app_security.wearable_listing_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare cat uuid;ctx public.listing_wearable_contexts_v1;
begin
 select r.category_id into cat from public.wearable_release_v1 r;
 if tg_op='UPDATE' and old.category_id is distinct from new.category_id and (old.category_id=cat or new.category_id=cat) then raise exception 'Wearable category reassignment requires a new typed posting';end if;
 if new.category_id=cat then
  perform app_security.phone_content_guard(concat_ws(' ',new.title,new.description));
  if new.price_paise is null or new.price_paise>100000000 or new.price_type='free' and new.price_paise<>0 or new.price_type<>'free' and new.price_paise<1 then raise exception 'Invalid wearable price';end if;
  if tg_op='INSERT' and not exists(select 1 from public.posting_upload_sessions s join public.wearable_session_bindings_v1 b on b.session_id=s.id where s.listing_id=new.id and s.owner_id=new.seller_id and b.category_id=cat) then raise exception 'Wearable listing requires a wearable session';end if;
  if new.status in ('pending_review','active','reserved','paused') then
   select * into ctx from public.listing_wearable_contexts_v1 where listing_id=new.id and category_id=new.category_id;
   if ctx.listing_id is null then raise exception 'Wearable context required';end if;
   if new.condition::text is distinct from ctx.details->>'condition' then raise exception 'Wearable condition must match structured context';end if;
  end if;
  -- Enforceable review: no non-staff path (seller, system finalizer, service role) may activate a flagged listing.
  if tg_op='UPDATE' and new.status='active' and old.status is distinct from new.status and exists(select 1 from public.listing_wearable_risk_flags_v1 where listing_id=new.id) and not app_security.is_active_staff_aal2('moderator') then raise exception 'Wearable listing requires staff review';end if;
 elsif tg_op='INSERT' and exists(select 1 from public.posting_upload_sessions s join public.wearable_session_bindings_v1 b on b.session_id=s.id where s.listing_id=new.id) then raise exception 'Cross-category session';
 end if;
 return new;
end $$;
revoke all on function app_security.wearable_listing_guard_v1() from public,anon,authenticated,service_role;
create trigger zz_wearable_listing_guard_v1 before insert or update on public.listings for each row execute function app_security.wearable_listing_guard_v1();

create function app_security.impl_submit_wearable_v1(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor();s public.posting_upload_sessions;r public.wearable_release_v1;photo public.posting_staged_media;ids uuid[];photo_id uuid;base text;result jsonb;city uuid;locality uuid;pin text;bn text;mn text;ps text:=p_payload->>'pairing_status';
begin
 perform app_security.validate_wearable_v1(p_payload);
 select * into s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='Upload session unavailable';end if;
 select r1.* into r from public.wearable_release_v1 r1 join public.categories c on c.id=r1.category_id where r1.enabled and c.is_active for share of r1,c;
 if r.category_id is null then raise exception 'Wearable category unavailable';end if;
 if not exists(select 1 from public.wearable_session_bindings_v1 where session_id=s.id and category_id=r.category_id) then raise exception 'Cross-category session';end if;
 if s.state='submitted' then
  if not exists(select 1 from public.listing_wearable_contexts_v1 where listing_id=s.listing_id) then raise exception 'Cross-category session';end if;
  return jsonb_build_object('success',true,'listing_id',s.listing_id);
 end if;
 if s.state<>'finalizing' or s.expires_at<=now() then raise exception 'Upload session unavailable';end if;
 city:=(p_payload->>'city_id')::uuid;locality:=(p_payload->>'locality_id')::uuid;pin:=p_payload->>'pin_code';
 if pin!~'^[1-9][0-9]{5}$' or not exists(select 1 from public.postal_pincode_localities p join public.localities l on l.id=p.locality_id join public.cities c on c.id=l.city_id where p.pincode=pin and l.id=locality and l.city_id=city and l.is_active and c.is_active) then raise exception 'Invalid PIN/locality';end if;
 if jsonb_typeof(p_payload->'media_ids') is distinct from 'array' then raise exception 'Invalid photos';end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'media_ids');
 if coalesce(cardinality(ids),0) not between 1 and 8 or (select count(distinct x) from unnest(ids) x)<>cardinality(ids) or (select count(*) from public.posting_staged_media where session_id=s.id and state='ready' and id=any(ids))<>cardinality(ids) then raise exception 'Choose 1 to 8 ready photos';end if;
 select coalesce((select b.name from public.wearable_brands_v1 b where b.id=p_payload->>'brand_id'),pg_catalog.btrim(p_payload->>'other_brand')) into bn;
 select coalesce((select m.name from public.wearable_models_v1 m where m.id=p_payload->>'model_id'),pg_catalog.btrim(p_payload->>'other_model')) into mn;
 insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes)
 values(s.listing_id,u,r.category_id,city,locality,pin,trim(p_payload->>'title'),trim(p_payload->>'description'),(p_payload->>'condition')::public.listing_condition_enum,(case when p_payload->>'trade'='giveaway' then 'free' when (p_payload->>'negotiable')::boolean then 'negotiable' else 'fixed' end)::public.listing_price_type_enum,(p_payload->>'price_paise')::integer,'{}');
 insert into public.listing_wearable_contexts_v1(listing_id,category_id,device_type,brand_id,model_id,brand_name,model_name,other_model,catalogue_revision,pairing_status,transfer_ready,details)
 values(s.listing_id,r.category_id,p_payload->>'device_type',p_payload->>'brand_id',p_payload->>'model_id',bn,mn,p_payload->>'model_id' is null,p_payload->>'catalogue_revision',ps,ps in ('reset_ready','signed_out'),
  p_payload-array['selection','session_id','catalogue_revision','device_type','brand_id','other_brand','model_id','other_model','pairing_status','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id','ownership_confirmed']);
 -- Enforceable review state: flags are written here, and the listings guard blocks activation by anyone but staff.
 if p_payload->>'model_id' is null then insert into public.listing_wearable_risk_flags_v1(listing_id,signal) values(s.listing_id,'other_model');end if;
 if p_payload->>'brand_id' is null then insert into public.listing_wearable_risk_flags_v1(listing_id,signal) values(s.listing_id,'other_brand');end if;
 if ps='still_paired' then insert into public.listing_wearable_risk_flags_v1(listing_id,signal) values(s.listing_id,'still_paired');end if;
 if ps='unknown' then insert into public.listing_wearable_risk_flags_v1(listing_id,signal) values(s.listing_id,'unknown_pairing');end if;
 foreach photo_id in array ids loop
  select * into photo from public.posting_staged_media where posting_staged_media.id=photo_id and session_id=s.id and state='ready' for update;
  base:=s.listing_id::text||'/'||photo.id::text||'/';
  if (select count(*) from storage.objects where (bucket_id='listing-originals' and name=base||'original.webp') or (bucket_id='listing-derivatives' and name in (base||'thumb.webp',base||'medium.webp',base||'large.webp')))<>4 then raise exception 'Photo preparation incomplete';end if;
  insert into public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes) values(photo.id,s.listing_id,u,'photo.webp','image/webp',photo.file_size);
  update public.listing_media set original_storage_path=base||'original.webp',thumbnail_storage_path=base||'thumb.webp',medium_storage_path=base||'medium.webp',large_storage_path=base||'large.webp',width=photo.width,height=photo.height,processing_status='ready' where listing_media.id=photo.id;
 end loop;
 result:=public.seller_submit_listing(s.listing_id);if result->>'success' is distinct from 'true' then raise exception 'Submission was not acknowledged';end if;
 update public.posting_upload_sessions set state='submitted',submitted_at=now() where posting_upload_sessions.id=s.id;
 perform app_security.log_audit_event('listing.wearable_submitted','listings',s.listing_id,jsonb_build_object('contract_version',1,'device_type',p_payload->>'device_type'));
 return jsonb_build_object('success',true,'listing_id',s.listing_id);
end $$;
create function public.submit_wearable_v1(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select app_security.impl_submit_wearable_v1(payload)$$;
revoke all on function app_security.impl_submit_wearable_v1(jsonb),public.submit_wearable_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_submit_wearable_v1(jsonb),public.submit_wearable_v1(jsonb) to authenticated;

-- Buyer search: only filters backed by validated, stored data (no ring size / charger filter: maker-specific free text / not separately stored).
create function app_security.impl_search_wearables_v1(p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 v_cat uuid:=(select r.category_id from public.wearable_release_v1 r join public.categories c on c.id=r.category_id where r.enabled and c.is_active);
 k text;v_page integer;v_per integer:=12;v_total integer;v_items jsonb;v_tsquery tsquery:=null;v_cond public.listing_condition_enum:=null;
 q text:=nullif(trim(p_filters->>'q'),'');
 sort text:=coalesce(nullif(p_filters->>'sort',''),'newest');
 city uuid;locality uuid;pmin integer;pmax integer;
begin
 if jsonb_typeof(p_filters) is distinct from 'object' or length(p_filters::text)>3000 or p_filters-array['q','type','brand_id','model_id','condition','city_id','locality_id','price_min','price_max','transfer_ready','connectivity','sort','page']<>'{}'::jsonb then raise exception 'Invalid wearable filters';end if;
 foreach k in array array['q','type','brand_id','model_id','condition','city_id','locality_id','transfer_ready','connectivity','sort'] loop
  if p_filters?k and (jsonb_typeof(p_filters->k) is distinct from 'string' or length(p_filters->>k)>150) then raise exception 'Invalid wearable filter value';end if;
 end loop;
 foreach k in array array['price_min','price_max','page'] loop
  if p_filters?k and jsonb_typeof(p_filters->k) not in ('number','null') then raise exception 'Invalid numeric wearable filter';end if;
 end loop;
 if nullif(p_filters->>'type','') is not null and p_filters->>'type' not in ('smartwatch','fitness_band','sports_gps_watch','smart_ring') then raise exception 'Invalid wearable type';end if;
 if nullif(p_filters->>'condition','') is not null and p_filters->>'condition' not in ('new','like_new','good','fair','poor') then raise exception 'Invalid condition filter';end if;
 if nullif(p_filters->>'transfer_ready','') is not null and p_filters->>'transfer_ready'<>'true' then raise exception 'Invalid transfer filter';end if;
 if nullif(p_filters->>'connectivity','') is not null and p_filters->>'connectivity' not in ('bluetooth','lte') then raise exception 'Invalid connectivity filter';end if;
 if sort not in ('newest','price_asc','price_desc','relevance') then raise exception 'Invalid sort';end if;
 city:=nullif(p_filters->>'city_id','')::uuid;locality:=nullif(p_filters->>'locality_id','')::uuid;
 pmin:=(p_filters->>'price_min')::integer;pmax:=(p_filters->>'price_max')::integer;
 if pmin is not null and pmax is not null and pmin>pmax then raise exception 'Invalid price range';end if;
 v_page:=greatest(coalesce((p_filters->>'page')::integer,1),1);
 if nullif(p_filters->>'condition','') is not null then v_cond:=(p_filters->>'condition')::public.listing_condition_enum;end if;
 if q is not null then v_tsquery:=websearch_to_tsquery('english',q);if v_tsquery=''::tsquery then v_tsquery:=null;end if;end if;
 if v_cat is null then return jsonb_build_object('items','[]'::jsonb,'total_count',0,'page',v_page,'per_page',v_per,'total_pages',0);end if;
 select count(*) into v_total from public.listings l
  join public.user_accounts ua on ua.user_id=l.seller_id
  join public.listing_wearable_contexts_v1 w on w.listing_id=l.id and w.category_id=l.category_id
  where l.category_id=v_cat and l.status='active' and (l.expires_at is null or l.expires_at>pg_catalog.clock_timestamp()) and ua.account_status='active' and app_security.is_listing_publicly_visible(l.id)
   and (nullif(p_filters->>'type','') is null or w.device_type=p_filters->>'type')
   and (nullif(p_filters->>'brand_id','') is null or w.brand_id=p_filters->>'brand_id')
   and (nullif(p_filters->>'model_id','') is null or w.model_id=p_filters->>'model_id')
   and (nullif(p_filters->>'transfer_ready','') is null or w.transfer_ready)
   and (nullif(p_filters->>'connectivity','') is null or w.details->>'connectivity'=p_filters->>'connectivity')
   and (city is null or l.city_id=city) and (locality is null or l.locality_id=locality) and (v_cond is null or l.condition=v_cond)
   and (pmin is null or (l.price_paise is not null and l.price_paise>=pmin)) and (pmax is null or (l.price_paise is not null and l.price_paise<=pmax))
   and (v_tsquery is null or l.search_vector @@ v_tsquery);
 select coalesce(jsonb_agg(item),'[]'::jsonb) into v_items from (
  select l.id,l.seller_id,l.slug,l.title,l.description,l.condition,l.price_type,l.price_paise,l.category_attributes,l.status,l.created_at,l.published_at,
   jsonb_build_object('id',c.id,'name',c.name,'slug',c.slug,'icon',c.icon) as category,
   jsonb_build_object('id',ci.id,'name',ci.name,'state',ci.state) as city,
   case when loc.id is not null then jsonb_build_object('id',loc.id,'name',loc.name) else null end as locality,
   case when m.id is not null then jsonb_build_object('id',m.id,'thumbnail_storage_path',m.thumbnail_storage_path,'medium_storage_path',m.medium_storage_path,'width',m.width,'height',m.height) else null end as cover_photo,
   jsonb_build_object('device_type',w.device_type,'brand_name',w.brand_name,'model_name',w.model_name,'other_model',w.other_model,'transfer_ready',w.transfer_ready,'pairing_status',w.pairing_status) as wearable
  from public.listings l
  join public.user_accounts ua on ua.user_id=l.seller_id
  join public.listing_wearable_contexts_v1 w on w.listing_id=l.id and w.category_id=l.category_id
  join public.categories c on c.id=l.category_id join public.cities ci on ci.id=l.city_id
  left join public.localities loc on loc.id=l.locality_id left join public.listing_media m on m.id=l.cover_photo_id
  where l.category_id=v_cat and l.status='active' and (l.expires_at is null or l.expires_at>pg_catalog.clock_timestamp()) and ua.account_status='active' and app_security.is_listing_publicly_visible(l.id)
   and (nullif(p_filters->>'type','') is null or w.device_type=p_filters->>'type')
   and (nullif(p_filters->>'brand_id','') is null or w.brand_id=p_filters->>'brand_id')
   and (nullif(p_filters->>'model_id','') is null or w.model_id=p_filters->>'model_id')
   and (nullif(p_filters->>'transfer_ready','') is null or w.transfer_ready)
   and (nullif(p_filters->>'connectivity','') is null or w.details->>'connectivity'=p_filters->>'connectivity')
   and (city is null or l.city_id=city) and (locality is null or l.locality_id=locality) and (v_cond is null or l.condition=v_cond)
   and (pmin is null or (l.price_paise is not null and l.price_paise>=pmin)) and (pmax is null or (l.price_paise is not null and l.price_paise<=pmax))
   and (v_tsquery is null or l.search_vector @@ v_tsquery)
  order by case when sort='price_asc' then l.price_paise end asc nulls last,case when sort='price_desc' then l.price_paise end desc nulls last,
   case when sort='relevance' and v_tsquery is not null then ts_rank(l.search_vector,v_tsquery) end desc nulls last,l.created_at desc,l.id desc
  limit v_per offset (v_page-1)*v_per) item;
 return jsonb_build_object('items',v_items,'total_count',v_total,'page',v_page,'per_page',v_per,'total_pages',case when v_total>0 then ceil(v_total::numeric/v_per)::integer else 0 end);
end $$;
create function public.search_wearables_v1(filters jsonb) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_search_wearables_v1(filters)$$;
revoke all on function app_security.impl_search_wearables_v1(jsonb),public.search_wearables_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_search_wearables_v1(jsonb),public.search_wearables_v1(jsonb) to anon,authenticated;
commit;
