-- Fresh disposable PostgreSQL only. Auth/account/lifecycle helpers are substitutes;
-- RLS, taxonomy migration, specialist source migrations and SQL tests are real.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema app_security;
create schema storage;
grant usage on schema public,auth,app_security,storage to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.user',true),'')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
create type public.staff_role_enum as enum('administrator','moderator','content_editor','support_agent');
create function app_security.get_account_status(uuid) returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.account',true),''),'active')
$$;
create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('request.policy',true),''),'true')='true'
$$;
create function app_security.is_active_staff_aal2(public.staff_role_enum) returns boolean language sql stable as $$select false$$;
create function app_security.is_listing_publicly_visible(uuid) returns boolean language sql stable as $$select false$$;
create function app_security.submission_family(uuid,uuid) returns text language sql stable as $$select null::text$$;
create function app_security.log_audit_event(text,text,uuid,jsonb) returns void language plpgsql as $$begin end$$;
create table auth.users(id uuid primary key);
create table public.categories (
 id uuid primary key default gen_random_uuid(),slug text unique not null,name text not null,description text,icon text,
 sort_order integer not null default 0,is_active boolean not null default true,
 macro_category text,new_listing_enabled boolean not null default false
);
create table public.category_attributes (
 id uuid primary key default gen_random_uuid(),category_id uuid references public.categories,name text,label text,
 value_type text,is_required boolean default false,options jsonb,validation_rules jsonb,sort_order integer default 0
);
create table public.cities(id uuid primary key,is_active boolean,name text,state text);
create table public.localities(id uuid primary key,city_id uuid references public.cities,is_active boolean,name text);
create table public.postal_pincode_localities(pincode text,locality_id uuid references public.localities);
create type public.listing_status_enum as enum('draft','pending_review','active','reserved','sold','rejected','paused','expired','removed');
create type public.listing_price_type_enum as enum('fixed','negotiable','free');
create type public.listing_condition_enum as enum('new','like_new','good','fair','poor');
create type public.media_processing_status_enum as enum('uploading','processing','ready','failed');
create table public.listings (
 id uuid primary key default gen_random_uuid(),seller_id uuid references auth.users,category_id uuid not null references public.categories,
 city_id uuid references public.cities,locality_id uuid references public.localities,pin_code text,title text,description text,
 condition public.listing_condition_enum,price_type public.listing_price_type_enum,
 price_paise integer check(price_paise between 0 and 100000000),category_attributes jsonb default '{}',
 status public.listing_status_enum not null default 'draft',revision integer not null default 1,cover_photo_id uuid,
 rejection_reason text,submitted_at timestamptz,updated_at timestamptz,created_at timestamptz default now(),
 published_at timestamptz,expires_at timestamptz,slug text,search_vector tsvector
);
create table public.listing_media (
 id uuid primary key,listing_id uuid references public.listings,uploader_id uuid,original_filename text,content_type text,
 file_size_bytes integer,original_storage_path text,thumbnail_storage_path text,medium_storage_path text,large_storage_path text,
 width integer,height integer,processing_status public.media_processing_status_enum,display_order integer default 0,created_at timestamptz default now()
);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
-- Submission is stubbed: this suite proves unchanged contracts, not publication.
create function public.seller_submit_listing(uuid) returns jsonb language sql as $$select '{}'::jsonb$$;
alter table public.categories enable row level security;
create policy categories_select_policy on public.categories for select using(is_active);
grant select on public.categories to anon,authenticated;
alter table public.listings enable row level security;
create policy fixture_owner_select on public.listings for select using(seller_id=auth.uid());
create policy listings_insert_policy on public.listings for insert with check (
 seller_id=auth.uid() and app_security.get_account_status(auth.uid())='active'
 and app_security.has_current_policy_acceptance(auth.uid())
);
create policy fixture_owner_update on public.listings for update using(seller_id=auth.uid()) with check(seller_id=auth.uid());
grant select,insert,update on public.listings to authenticated;
