-- Package 1 only: no canonical seed, catalogue imports or route activation.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
  if not exists(select 1 from pg_catalog.pg_class where oid='public.listings'::regclass and relrowsecurity)
    or not exists(select 1 from pg_catalog.pg_class where oid='public.categories'::regclass and relrowsecurity)
    or pg_catalog.to_regprocedure('app_security.get_account_status(uuid)') is null
    or pg_catalog.to_regprocedure('app_security.has_current_policy_acceptance(uuid)') is null then
    raise exception 'TAXONOMY_V2_SECURITY_BASELINE_MISSING';
  end if;
end $$;

-- NULL status is an explicit pre-V2 compatibility state, NOT a canonical root.
-- Existing identities, legacy flags and listing references are never backfilled.
alter table public.categories
  add column parent_id uuid,
  add column status text check (status in ('live','coming_soon','hidden','blocked')),
  add column posting_flow text check (posting_flow in (
    'generic','accessory','adoption_rehoming','property','specialist:phone',
    'specialist:tablet','specialist:wearable','specialist:car','specialist:two_wheeler')),
  add column catalogue_mode text check (catalogue_mode in ('none','brand_only','brand_model')),
  -- Composite self-FK enforces depth under concurrent writes, without recursive
  -- trigger reads or lock-order assumptions. These two columns are internal.
  add column taxonomy_is_root boolean generated always as (status is not null and parent_id is null) stored,
  add column taxonomy_parent_is_root boolean generated always as
    (case when parent_id is not null then true else null end) stored,
  add constraint categories_taxonomy_root_key unique (id,taxonomy_is_root),
  add constraint categories_taxonomy_parent_fk foreign key (parent_id,taxonomy_parent_is_root)
    references public.categories(id,taxonomy_is_root),
  add constraint categories_taxonomy_shape check (
    (status is null and parent_id is null and posting_flow is null and catalogue_mode is null)
    or (status is not null and (
      (parent_id is null and posting_flow is null and catalogue_mode is null and not new_listing_enabled)
      or (parent_id is not null and posting_flow is not null and catalogue_mode is not null)
    ))),
  add constraint categories_taxonomy_visibility check (status is null or (
    (status = 'live' or not new_listing_enabled)
    and (status not in ('hidden','blocked') or not is_active)));
create index categories_taxonomy_parent_idx on public.categories(parent_id) where parent_id is not null;
comment on column public.categories.status is
  'NULL = unmigrated legacy reference. V2 status is explicit; no implicit live backfill.';

-- Preserve every old RLS predicate. V2 validation is additional and also covers
-- SECURITY DEFINER specialist submission, staff and service writes. AFTER sees
-- final state after lifecycle BEFORE triggers. Existing saved drafts can be edited.
create function app_security.impl_taxonomy_v2_listing_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c public.categories; r public.categories; assignment boolean;
begin
  assignment := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    assignment := new.category_id is distinct from old.category_id;
    if not assignment and new.status is not distinct from old.status then return new; end if;
  end if;
  select * into c from public.categories where id = new.category_id for share;
  if c.status is null then return new; end if;
  -- Every canonical root is non-postable, even through privileged inserts.
  if c.parent_id is null then
    raise exception using errcode='23514', message='TAXONOMY_V2_ROOT_NOT_POSTABLE';
  end if;
  select * into r from public.categories where id = c.parent_id for share;
  if assignment or new.status in ('pending_review','active','reserved') then
    if c.status <> 'live' or not c.is_active or not c.new_listing_enabled
      or r.status <> 'live' or not r.is_active then
      raise exception using errcode='23514', message='TAXONOMY_V2_CATEGORY_UNAVAILABLE';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app_security.impl_taxonomy_v2_listing_guard() from public,anon,authenticated,service_role;
create trigger taxonomy_v2_listing_guard after insert or update on public.listings
  for each row execute function app_security.impl_taxonomy_v2_listing_guard();

-- Keep category editing safe in both directions. The composite FK prevents a
-- listing with saved identity from changing category until its draft identity is
-- explicitly removed; no silent retargeting or snapshot deletion.
alter table public.listings add constraint listings_taxonomy_identity_key unique(id,category_id);
create table public.generic_product_brands (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories(id),
  name text not null check (length(btrim(name)) between 1 and 100),
  normalized_name text generated always as (lower(btrim(name))) stored,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(category_id,normalized_name), unique(id,category_id)
);
create table public.generic_product_models (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null,
  brand_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 150),
  normalized_name text generated always as (lower(btrim(name))) stored,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(brand_id,category_id) references public.generic_product_brands(id,category_id),
  unique(category_id,brand_id,normalized_name), unique(id,brand_id,category_id)
);
create table public.listing_generic_product_identity (
  listing_id uuid primary key,
  category_id uuid not null,
  brand_id uuid,
  model_id uuid,
  brand_name_snapshot text check (brand_name_snapshot is null or length(btrim(brand_name_snapshot)) between 1 and 100),
  model_name_snapshot text check (model_name_snapshot is null or length(btrim(model_name_snapshot)) between 1 and 150),
  selection_source text not null default 'manual' check (selection_source in ('manual','catalogue')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(listing_id,category_id) references public.listings(id,category_id) on delete cascade,
  foreign key(brand_id,category_id) references public.generic_product_brands(id,category_id),
  foreign key(model_id,brand_id,category_id) references public.generic_product_models(id,brand_id,category_id),
  check (model_id is null or brand_id is not null),
  check ((selection_source='manual' and brand_id is null and model_id is null)
    or (selection_source='catalogue' and brand_id is not null))
);
create index listing_generic_identity_brand_idx on public.listing_generic_product_identity(brand_id,category_id);
create index listing_generic_identity_model_idx on public.listing_generic_product_identity(model_id,brand_id,category_id);

-- Validation includes imports by privileged roles. Live/route activation is NOT
-- needed to stage lookup rows, but only generic capable leaves can own them.
create function app_security.impl_taxonomy_v2_catalogue_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c public.categories;
begin
  select * into c from public.categories where id=new.category_id for share;
  if c.parent_id is null or c.posting_flow not in ('generic','accessory')
    or c.catalogue_mode not in ('brand_only','brand_model') then
    raise exception using errcode='23514', message='TAXONOMY_V2_GENERIC_CATEGORY_REQUIRED';
  end if;
  if tg_table_name='generic_product_models' and c.catalogue_mode <> 'brand_model' then
    raise exception using errcode='23514', message='TAXONOMY_V2_MODELS_UNSUPPORTED';
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
revoke all on function app_security.impl_taxonomy_v2_catalogue_guard() from public,anon,authenticated,service_role;
create trigger generic_brands_guard before insert or update on public.generic_product_brands
  for each row execute function app_security.impl_taxonomy_v2_catalogue_guard();
create trigger generic_models_guard before insert or update on public.generic_product_models
  for each row execute function app_security.impl_taxonomy_v2_catalogue_guard();

-- Don't allow metadata edits to invalidate already imported brands/models.
create function app_security.impl_taxonomy_v2_category_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is not null and new.parent_id is null
    and exists(select 1 from public.listings where category_id=new.id) then
    raise exception using errcode='23514', message='TAXONOMY_V2_ROOT_HAS_LISTINGS';
  end if;
  if new.catalogue_mode='brand_only' and exists(
    select 1 from public.listing_generic_product_identity where category_id=new.id
      and (model_id is not null or model_name_snapshot is not null)) then
    raise exception using errcode='23514', message='TAXONOMY_V2_CATEGORY_HAS_MODEL_IDENTITY';
  end if;
  if exists(select 1 from public.generic_product_brands where category_id=new.id)
    and (new.parent_id is null or new.posting_flow not in ('generic','accessory')
      or new.catalogue_mode not in ('brand_only','brand_model')) then
    raise exception using errcode='23514', message='TAXONOMY_V2_CATEGORY_HAS_CATALOGUE';
  end if;
  if new.catalogue_mode is distinct from 'brand_model'
    and exists(select 1 from public.generic_product_models where category_id=new.id) then
    raise exception using errcode='23514', message='TAXONOMY_V2_CATEGORY_HAS_MODELS';
  end if;
  if exists(select 1 from public.listing_generic_product_identity where category_id=new.id)
    and (new.parent_id is null or new.posting_flow not in ('generic','accessory')
      or new.catalogue_mode not in ('brand_only','brand_model')) then
    raise exception using errcode='23514', message='TAXONOMY_V2_CATEGORY_HAS_IDENTITY';
  end if;
  return new;
end;
$$;
revoke all on function app_security.impl_taxonomy_v2_category_guard() from public,anon,authenticated,service_role;
create trigger taxonomy_v2_category_guard before update of parent_id,status,posting_flow,catalogue_mode on public.categories
  for each row execute function app_security.impl_taxonomy_v2_category_guard();

create function app_security.impl_taxonomy_v2_identity_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare l public.listings; c public.categories; b public.generic_product_brands; m public.generic_product_models;
  lid uuid;
begin
  lid := case when tg_op='DELETE' then old.listing_id else new.listing_id end;
  -- Lock order: listing, then category/catalogue. Serializes against submission.
  select * into l from public.listings where id=lid for update;
  if tg_op='DELETE' and not found then return old; end if; -- parent cascade
  if l.status is distinct from 'draft' then
    raise exception using errcode='23514', message='TAXONOMY_V2_IDENTITY_DRAFT_ONLY';
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_op='UPDATE' and (new.listing_id <> old.listing_id or new.category_id <> old.category_id) then
    raise exception using errcode='23514', message='TAXONOMY_V2_IDENTITY_IMMUTABLE_KEY';
  end if;
  select * into c from public.categories where id=new.category_id for share;
  if l.category_id is distinct from new.category_id or c.parent_id is null
    or c.posting_flow not in ('generic','accessory') or c.catalogue_mode not in ('brand_only','brand_model') then
    raise exception using errcode='23514', message='TAXONOMY_V2_GENERIC_CATEGORY_REQUIRED';
  end if;
  if c.catalogue_mode='brand_only' and (new.model_id is not null or new.model_name_snapshot is not null) then
    raise exception using errcode='23514', message='TAXONOMY_V2_MODELS_UNSUPPORTED';
  end if;
  if tg_op='INSERT' or new.brand_id is distinct from old.brand_id
    or new.model_id is distinct from old.model_id or new.selection_source is distinct from old.selection_source then
    if new.selection_source='catalogue' then
      select * into b from public.generic_product_brands
        where id=new.brand_id and category_id=new.category_id and enabled for share;
      if not found then raise exception using errcode='23514', message='TAXONOMY_V2_BRAND_UNAVAILABLE'; end if;
      new.brand_name_snapshot := b.name;
      new.model_name_snapshot := null;
      if new.model_id is not null then
        select * into m from public.generic_product_models
          where id=new.model_id and brand_id=new.brand_id and category_id=new.category_id and enabled for share;
        if not found then raise exception using errcode='23514', message='TAXONOMY_V2_MODEL_UNAVAILABLE'; end if;
        new.model_name_snapshot := m.name;
      end if;
    end if;
  elsif new.selection_source='catalogue' then
    -- Rename/disable never silently rewrites saved names, nor can clients forge them.
    new.brand_name_snapshot := old.brand_name_snapshot;
    new.model_name_snapshot := old.model_name_snapshot;
  end if;
  if tg_op='UPDATE' then new.created_at := old.created_at; end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
revoke all on function app_security.impl_taxonomy_v2_identity_guard() from public,anon,authenticated,service_role;
create trigger generic_identity_guard before insert or update or delete on public.listing_generic_product_identity
  for each row execute function app_security.impl_taxonomy_v2_identity_guard();

alter table public.generic_product_brands enable row level security;
alter table public.generic_product_brands force row level security;
alter table public.generic_product_models enable row level security;
alter table public.generic_product_models force row level security;
alter table public.listing_generic_product_identity enable row level security;
alter table public.listing_generic_product_identity force row level security;
revoke all on public.generic_product_brands,public.generic_product_models,public.listing_generic_product_identity
  from public,anon,authenticated;
grant select on public.generic_product_brands,public.generic_product_models to anon,authenticated;
grant select,delete on public.listing_generic_product_identity to authenticated;
grant insert(listing_id,category_id,brand_id,model_id,brand_name_snapshot,model_name_snapshot,selection_source),
  update(brand_id,model_id,brand_name_snapshot,model_name_snapshot,selection_source)
  on public.listing_generic_product_identity to authenticated;

create policy generic_brands_read on public.generic_product_brands for select to anon,authenticated using (
  enabled and exists(select 1 from public.categories c join public.categories r on r.id=c.parent_id
    where c.id=category_id and c.status='live' and c.is_active and c.new_listing_enabled
      and c.posting_flow in ('generic','accessory') and c.catalogue_mode in ('brand_only','brand_model')
      and r.status='live' and r.is_active));
create policy generic_models_read on public.generic_product_models for select to anon,authenticated using (
  enabled and exists(select 1 from public.generic_product_brands b where b.id=brand_id and b.category_id=generic_product_models.category_id));
create policy generic_identity_read on public.listing_generic_product_identity for select to authenticated using (
  exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid())));
create policy generic_identity_insert on public.listing_generic_product_identity for insert to authenticated with check (
  app_security.get_account_status((select auth.uid()))='active'
  and app_security.has_current_policy_acceptance((select auth.uid()))
  and exists(select 1 from public.listings l join public.categories c on c.id=l.category_id
    join public.categories r on r.id=c.parent_id where l.id=listing_id and l.seller_id=(select auth.uid())
    and l.status='draft' and c.status='live' and c.is_active and c.new_listing_enabled and r.status='live' and r.is_active));
create policy generic_identity_update on public.listing_generic_product_identity for update to authenticated using (
  app_security.get_account_status((select auth.uid()))='active'
  and app_security.has_current_policy_acceptance((select auth.uid()))
  and exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid()) and l.status='draft'))
  with check (
  app_security.get_account_status((select auth.uid()))='active'
  and app_security.has_current_policy_acceptance((select auth.uid()))
  and exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid()) and l.status='draft'));
create policy generic_identity_delete on public.listing_generic_product_identity for delete to authenticated using (
  app_security.get_account_status((select auth.uid()))='active'
  and app_security.has_current_policy_acceptance((select auth.uid()))
  and exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=(select auth.uid()) and l.status='draft'));

-- Small versioned projection; no hidden legacy references, attributes or private
-- fields. Revision is content-addressed, so every returned metadata edit invalidates
-- caches without an extra revision table or category update side effects.
create function app_security.impl_get_category_catalogue_v2()
returns jsonb language sql stable security definer set search_path = '' as $$
  with visible as (
    select c.id,c.parent_id,c.slug,c.name,c.status,c.posting_flow,c.catalogue_mode,c.sort_order,
      (c.parent_id is not null and c.status='live' and c.is_active and c.new_listing_enabled
        and r.status='live' and r.is_active) is true as posting_enabled
    from public.categories c left join public.categories r on r.id=c.parent_id
    where c.status in ('live','coming_soon') and c.is_active
      and (c.parent_id is null or (r.status in ('live','coming_soon') and r.is_active))
  ), payload as (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.sort_order,v.id),'[]'::jsonb) nodes from visible v
  ) select pg_catalog.jsonb_build_object('api_version',2,'taxonomy_revision','foundation-1',
      'revision',pg_catalog.md5(nodes::text),'nodes',nodes) from payload;
$$;
create function public.get_category_catalogue_v2()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select app_security.impl_get_category_catalogue_v2();
$$;
revoke all on function app_security.impl_get_category_catalogue_v2(),public.get_category_catalogue_v2()
  from public,anon,authenticated,service_role;
grant execute on function app_security.impl_get_category_catalogue_v2(),public.get_category_catalogue_v2() to anon,authenticated;
-- No INSERTs into either generic lookup table. Future imports need no DDL.
commit;
