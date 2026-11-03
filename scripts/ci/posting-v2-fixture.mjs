// Shared disposable-fixture setup only. Caller must prove its database is fresh/local.
// Supporting auth/storage helpers are substitutes; migrations/functions are real source.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const functionFrom=(file,name)=>{const source=readFileSync(resolve(root,'supabase/migrations',file),'utf8');const start=source.toLowerCase().indexOf(`create or replace function ${name.toLowerCase()}(`);assert(start>=0);const part=source.slice(start);const dollar=part.match(/\$(?:function)?\$/)[0];const first=part.indexOf(dollar);const end=part.indexOf(dollar,first+dollar.length)+dollar.length;return part.slice(0,end)+';';};

export async function installPostingFixture(db) {
 await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema app_security;create schema storage;
 grant usage on schema public,auth,app_security,storage to anon,authenticated,service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.user',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt',true),''),'{}')::jsonb$$;
 create type public.staff_role_enum as enum('administrator','moderator','content_editor','support_agent');
 create function app_security.get_account_status(uuid) returns text language sql stable as $$select coalesce(nullif(current_setting('request.account',true),''),'active')::text$$;
 create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql stable as $$select coalesce(current_setting('request.policy',true),'true')='true'$$;
 create function app_security.is_active_staff_aal2(public.staff_role_enum) returns boolean language sql stable as $$select coalesce(current_setting('request.staff',true),'false')='true'$$;
 create function app_security.is_listing_publicly_visible(uuid) returns boolean language sql stable as $$select false$$;
 create function app_security.submission_family(uuid,uuid) returns text language sql stable as $$select null::text$$;
 create function app_security.log_audit_event(text,text,uuid,jsonb) returns void language plpgsql as $$begin end$$;
 create table auth.users(id uuid primary key);
 create table public.categories(id uuid primary key default gen_random_uuid(),slug text unique,name text,description text,sort_order integer,is_active boolean,macro_category text,new_listing_enabled boolean);
 create table public.category_attributes(category_id uuid,name text,label text,is_required boolean);
 create table public.cities(id uuid primary key,is_active boolean);
 create table public.localities(id uuid primary key,city_id uuid references public.cities,is_active boolean);
 create table public.postal_pincode_localities(pincode text,locality_id uuid references public.localities);
 create type public.listing_status_enum as enum('draft','pending_review','active','reserved','sold','rejected','paused','expired','removed');
 create type public.listing_price_type_enum as enum('fixed','negotiable','free');
 create type public.listing_condition_enum as enum('new','like_new','good','fair','poor');
 create type public.media_processing_status_enum as enum('uploading','processing','ready','failed');
 create table public.listings(id uuid primary key,seller_id uuid references auth.users,category_id uuid references public.categories,city_id uuid references public.cities,locality_id uuid references public.localities,pin_code text,title text,description text,condition public.listing_condition_enum,price_type public.listing_price_type_enum,price_paise integer,category_attributes jsonb,status public.listing_status_enum default 'draft',revision integer default 1,cover_photo_id uuid,rejection_reason text,submitted_at timestamptz,updated_at timestamptz);
 create table public.listing_media(id uuid primary key,listing_id uuid references public.listings,uploader_id uuid,original_filename text,content_type text,file_size_bytes integer,original_storage_path text,thumbnail_storage_path text,medium_storage_path text,large_storage_path text,width integer,height integer,processing_status public.media_processing_status_enum,display_order integer default 0,created_at timestamptz default now());
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
 `);
 await db.exec(functionFrom('20261012120000_post_ad_current_base_compatibility.sql','app_security.impl_seller_submit_listing'));
 await db.exec(functionFrom('20260914000008_create_listing_rpcs.sql','public.seller_submit_listing'));
 await db.exec(readFileSync(resolve(root,'supabase/forward-migrations/posting-v2/supabase/migrations/20261025131116_posting_v2_mobiles.sql'),'utf8'));
}
