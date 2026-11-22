-- FairSwapProd shape at the moment DigiLocker V1 is released: tables the V3 production identity prerequisite triggers attach to,
-- plus one optional category-context table that V1 (not V3) gates. Disposable PostgreSQL only.
create table public.posting_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade
);
create table public.posting_staged_media (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.posting_upload_sessions(id) on delete cascade
);
create table public.listing_vehicle_contexts (
  listing_id uuid primary key references public.listings(id) on delete cascade
);
