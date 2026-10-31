-- Reduced synthetic prerequisites for an in-memory PostgreSQL engine ONLY.
-- Not a full migration replay or a Supabase Auth/PostgREST service.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema app_security;
grant usage on schema app_security to anon, authenticated, service_role;
create type public.listing_condition_enum as enum ('new','like_new','good','fair','poor');
create table public.user_accounts(user_id uuid primary key, account_status text);
create table public.categories(id uuid primary key, slug text unique, name text, icon text, is_active boolean);
create table public.cities(id uuid primary key, name text, state text);
create table public.localities(id uuid primary key, name text);
create table public.listing_media(id uuid primary key, thumbnail_storage_path text, medium_storage_path text, width integer, height integer);
create table public.listings(
 id uuid primary key, seller_id uuid, slug text, title text, description text,
 condition public.listing_condition_enum, price_type text, price_paise integer,
 category_attributes jsonb default '{}', status text, created_at timestamptz,
 published_at timestamptz, expires_at timestamptz, category_id uuid, city_id uuid,
 locality_id uuid, cover_photo_id uuid,
 search_vector tsvector generated always as (
 setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
 setweight(to_tsvector('english', coalesce(description, '')), 'B')) stored
);
alter table public.listings enable row level security;
alter table public.user_accounts enable row level security;
revoke all on public.listings, public.user_accounts from public, anon, authenticated;
insert into public.user_accounts values
('00000000-0000-0000-0000-000000000001','active'),
('00000000-0000-0000-0000-000000000002','suspended');
insert into public.categories values
('00000000-0000-0000-0000-000000000001','goods','Goods',null,true),
('00000000-0000-0000-0000-000000000002','hidden','Hidden',null,false);
insert into public.cities values ('00000000-0000-0000-0000-000000000001','Synthetic','Fixture');
insert into public.listings(id,seller_id,slug,title,description,condition,price_type,price_paise,status,created_at,category_id,city_id)
select md5(i::text)::uuid, '00000000-0000-0000-0000-000000000001', 'fixture-'||i,
 case when i=1 then 'साइकिल bicycle' else 'Laptop fixture '||i end,
 'Synthetic English हिन्दी search fixture', 'good','fixed',i*100,'active','2026-01-01Z'::timestamptz,
 '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
from generate_series(1,120) i;
insert into public.listings(id,seller_id,slug,title,status,expires_at,category_id,city_id)
select md5(('hidden'||i)::text)::uuid,
 case when i=10 then '00000000-0000-0000-0000-000000000002'::uuid else '00000000-0000-0000-0000-000000000001'::uuid end,
 'hidden-'||i, 'Laptop hidden',
 case when i>=9 then 'active' else (array['draft','pending_review','reserved','sold','rejected','paused','expired','removed'])[i] end,
 case when i=9 then '2000-01-01Z'::timestamptz end,
 '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
from generate_series(1,10) i;
