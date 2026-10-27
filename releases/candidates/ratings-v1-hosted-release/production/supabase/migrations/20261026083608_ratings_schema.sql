begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_security.ratings_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  public_reads boolean not null default false,
  jobs_enabled boolean not null default false,
  staff_enabled boolean not null default false,
  min_reviews integer not null default 3 check (min_reviews >= 3)
);
insert into app_security.ratings_settings default values;

create table public.rating_trades (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid unique references public.listings(id) on delete set null,
  seller_id uuid references auth.users(id) on delete set null,
  buyer_id uuid references auth.users(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  state text not null check (state in ('pending_selection','pending_buyer','confirmed','disputed','unattributed','expired_unconfirmed')),
  sold_at timestamptz not null default statement_timestamp(),
  deadline timestamptz not null default (statement_timestamp() + interval '14 days'),
  buyer_confirmed_at timestamptz,
  closed_at timestamptz,
  voided boolean not null default false,
  risk_excluded boolean not null default false,
  check (seller_id is null or buyer_id is null or seller_id <> buyer_id),
  check (deadline = sold_at + interval '14 days'),
  check (state <> 'confirmed' or buyer_confirmed_at is not null)
);
create index rating_trades_seller on public.rating_trades(seller_id,sold_at desc,id desc);
create index rating_trades_buyer on public.rating_trades(buyer_id,sold_at desc,id desc);
create index rating_trades_due on public.rating_trades(deadline,id) where closed_at is null;

create table app_security.rating_tags (
  code text primary key check (code ~ '^[a-z_]{2,40}$'),
  reviewer_role text not null check (reviewer_role in ('buyer','seller','both')),
  internal_signal boolean not null default false,
  enabled boolean not null default true
);
insert into app_security.rating_tags(code,reviewer_role,internal_signal) values
 ('on_time','both',false),('polite','both',false),('quick_replies','both',false),
 ('paid_as_agreed','seller',false),('easy_pickup','seller',false),
 ('item_as_described','buyer',false),('accurate_photos','buyer',false),('smooth_handover','buyer',false),
 ('did_not_show_up','both',false),('delayed_payment','seller',false),
 ('item_not_as_described','buyer',false),('changed_price','buyer',false),
 ('asked_advance_payment','buyer',true),('sent_payment_link','both',true);

create function app_security.rating_text(p_text text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text;
begin
 if p_text is null then return null; end if;
 v := pg_catalog.btrim(pg_catalog.normalize(p_text,'NFC'));
 if pg_catalog.char_length(v)>500 or v ~ U&'[\0001-\001F\007F-\009F<>\202A-\202E\2066-\2069\FEFF]' then
   raise exception 'RATINGS_INVALID_TEXT' using errcode='22023';
 end if;
 return nullif(v,'');
end $$;

create table public.rating_reviews (
 id uuid primary key default gen_random_uuid(),
 trade_id uuid not null references public.rating_trades(id),
 author_id uuid references auth.users(id) on delete set null,
 recipient_id uuid references auth.users(id) on delete set null,
 reviewer_role text not null check (reviewer_role in ('buyer','seller')),
 communication smallint not null check (communication between 1 and 4),
 payment_item smallint not null check (payment_item between 1 and 4),
 meetup smallint not null check (meetup between 1 and 4),
 score numeric(3,1) generated always as (round(((communication+payment_item+meetup)/3.0-1)/3.0*10,1)) stored,
 body text check (body is not distinct from app_security.rating_text(body)),
 tags text[] not null default '{}' check (cardinality(tags)<=5),
 submitted_at timestamptz not null default clock_timestamp(),
 published_at timestamptz,
 hidden boolean not null default false,
 redacted boolean not null default false,
 unique(trade_id,reviewer_role),
 check (author_id is null or recipient_id is null or author_id <> recipient_id)
);
create index rating_reviews_recipient on public.rating_reviews(recipient_id,submitted_at desc,id desc);
create index rating_reviews_author on public.rating_reviews(author_id,submitted_at desc,id desc);
create table public.rating_replies (
 review_id uuid primary key references public.rating_reviews(id),
 author_id uuid references auth.users(id) on delete set null,
 body text not null check (body = app_security.rating_text(body) and length(body)>0),
 created_at timestamptz not null default clock_timestamp()
);
create table public.profile_rating_stats (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 published_review_count integer not null default 0,
 counted_review_count integer not null default 0,
 completed_trades integer not null default 0,
 score numeric(3,1), communication_average numeric(4,2), payment_item_average numeric(4,2), meetup_average numeric(4,2)
);
insert into public.profile_rating_stats(user_id) select id from public.profiles;

create table public.trade_system_events (
 id uuid primary key default gen_random_uuid(),
 trade_id uuid not null references public.rating_trades(id),
 kind text not null check (kind in ('buyer_selected','pending_buyer','confirmed','rated_buyer','rated_seller','disputed','expired')),
 created_at timestamptz not null default clock_timestamp(),
 unique(trade_id,kind)
);
create index trade_system_events_page on public.trade_system_events(trade_id,created_at desc,id desc);
create table app_security.rating_notification_receipts (
 trade_id uuid not null references public.rating_trades(id),
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null,
 primary key(trade_id,user_id,kind)
);
create table app_security.rating_cases (
 id uuid primary key default gen_random_uuid(),
 trade_id uuid not null references public.rating_trades(id),
 review_id uuid references public.rating_reviews(id),
 reporter_id uuid references auth.users(id) on delete set null,
 support_ticket_id uuid references public.support_tickets(id) on delete set null,
 kind text not null check(kind in ('dispute','review_report')),
 reason text not null,
 created_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz
);
create unique index rating_cases_dedupe on app_security.rating_cases(trade_id,coalesce(review_id,'00000000-0000-0000-0000-000000000000'::uuid),reporter_id,kind);
create table app_security.rating_moderation_audit (
 id uuid primary key default gen_random_uuid(),
 case_id uuid not null references app_security.rating_cases(id),
 actor_id uuid references auth.users(id) on delete set null,
 action text not null, reason text not null,
 created_at timestamptz not null default clock_timestamp()
);

-- No direct table API: all projections below are explicitly selected by RPCs.
alter table app_security.ratings_settings enable row level security;
alter table app_security.rating_tags enable row level security;
alter table app_security.rating_notification_receipts enable row level security;
alter table app_security.rating_cases enable row level security;
alter table app_security.rating_moderation_audit enable row level security;
alter table public.rating_trades enable row level security;
alter table public.rating_reviews enable row level security;
alter table public.rating_replies enable row level security;
alter table public.profile_rating_stats enable row level security;
alter table public.trade_system_events enable row level security;
alter table public.rating_trades force row level security;
alter table public.rating_reviews force row level security;
alter table public.rating_replies force row level security;
alter table public.profile_rating_stats force row level security;
alter table public.trade_system_events force row level security;
revoke all on app_security.ratings_settings,app_security.rating_tags,app_security.rating_notification_receipts,
 app_security.rating_cases,app_security.rating_moderation_audit,
 public.rating_trades,public.rating_reviews,public.rating_replies,public.profile_rating_stats,public.trade_system_events
 from public,anon,authenticated,service_role;
revoke all on function app_security.rating_text(text) from public,anon,authenticated,service_role;

create function app_security.rating_new_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin insert into public.profile_rating_stats(user_id) values(new.id) on conflict do nothing; return new; end $$;
revoke all on function app_security.rating_new_profile() from public,anon,authenticated,service_role;
create trigger ratings_new_profile after insert on public.profiles for each row execute function app_security.rating_new_profile();
commit;
