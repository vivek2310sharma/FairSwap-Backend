-- HDR-03 Production-only forward release; approved operator installation required.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Exact observed Production history; names and versions must both agree.
do $hdr03_preflight$
begin
  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'HDR03 STOP: PostgreSQL 17 or newer required';
  end if;
  if (select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name) order by version),'[]'::jsonb)
      from supabase_migrations.schema_migrations)
     <> '[{"version":"20260914000001","name":"create_accounts_and_profiles"},{"version":"20260914000002","name":"create_staff_and_security"},{"version":"20260914000003","name":"create_audit_and_privacy"},{"version":"20260914000004","name":"create_categories_and_locations"},{"version":"20260914000005","name":"create_listings"},{"version":"20260914000006","name":"create_listing_media"},{"version":"20260914000007","name":"create_storage_buckets_and_policies"},{"version":"20260914000008","name":"create_listing_rpcs"},{"version":"20260914000009","name":"create_discovery_and_favourites"},{"version":"20260914000010","name":"create_notifications"},{"version":"20260914000011","name":"create_communication"},{"version":"20260914000012","name":"create_abuse_controls_and_reports"},{"version":"20260914000013","name":"create_support_and_appeals"},{"version":"20260914000014","name":"create_privacy_fulfillment_and_fk_safety"},{"version":"20260914000015","name":"correct_report_notification_and_permissions"},{"version":"20260914000016","name":"staff_user_moderation_and_hardening"},{"version":"20260914000017","name":"fix_report_target_visibility"},{"version":"20260916000018","name":"performance_and_reliability_indexes"},{"version":"20260916000019","name":"fix_public_rls_staff_helper_execution"},{"version":"20260918000020","name":"legal_acceptance_and_age_audit"},{"version":"20260918000021","name":"policy_reacceptance_records"},{"version":"20260926000022","name":"listing_email_notifications"},{"version":"20260926000023","name":"email_outbox_dispatch_runtime"},{"version":"20260926000024","name":"email_outbox_runtime_extensions"},{"version":"20260929000025","name":"india_postal_location_schema"},{"version":"20260930000026","name":"fix_india_location_admin_and_lookup"},{"version":"20260930000027","name":"support_multi_district_pincodes"},{"version":"20260930000028","name":"harden_official_postal_snapshot"},{"version":"20261001000029","name":"fix_listing_landmark_column_permissions"},{"version":"20261001000030","name":"require_explicit_postal_source"},{"version":"20261001000031","name":"harden_public_listing_location_privacy"},{"version":"20261001000032","name":"add_staff_private_listing_location_access"},{"version":"20261002000033","name":"seller_media_management"},{"version":"20261007153735","name":"admin_pending_medium_download"},{"version":"20261007153744","name":"atomic_reviewed_moderation"},{"version":"20261007161425","name":"admin_pending_medium_download_info"},{"version":"20261008210921","name":"post_ad_category_metadata"},{"version":"20261009163210","name":"seller_listing_category_context"},{"version":"20261010071050","name":"invalidate_pending_review_on_media_mutation"},{"version":"20261010080000","name":"remediate_legacy_moderate_listing"},{"version":"20261010090000","name":"invalidate_resubmission_review_token"},{"version":"20261011000038","name":"create_moderation_queue_and_results"},{"version":"20261011000039","name":"moderation_dispatch_and_killswitch"},{"version":"20261013192336","name":"post_ad_listing_insert_category_guard"},{"version":"20261013235311","name":"moderation_vault_dispatch_auth"},{"version":"20261017205755","name":"category_foundation_01_two_wheeler_draft_v1"},{"version":"20261017205757","name":"category_foundation_02_two_wheeler_catalogue_lookup"},{"version":"20261017205759","name":"category_foundation_03_two_wheeler_unresolved_mapping_correction"},{"version":"20261017205801","name":"category_foundation_04_two_wheeler_reference_errors"},{"version":"20261017205803","name":"category_foundation_05_car_draft_v1"},{"version":"20261017205805","name":"category_foundation_06_property_rental_draft_v1"},{"version":"20261017205807","name":"category_foundation_07_property_scoped_draft_lock"},{"version":"20261018172250","name":"moderation_v2_private_foundation"},{"version":"20261018182448","name":"moderation_v2_input_validation"},{"version":"20261019102255","name":"moderation_v2_input_lease"},{"version":"20261022073602","name":"moderation_v1_openai_text_image_publication_gate"},{"version":"20261022110410","name":"production_family_submission_and_human_review_default_off_v1"}]'::jsonb then
    raise exception 'HDR03 STOP: Production 57-version ledger differs; re-review required';
  end if;
  if to_regprocedure('public.get_unread_counts()') is not null
     or to_regclass('public.unread_count_signals') is not null then
    raise exception 'HDR03 STOP: contract already present or partial installation';
  end if;
  if to_regprocedure('public.mark_conversation_read(uuid,uuid)') is null
     or to_regprocedure('app_security.get_account_status(uuid)') is null
     or to_regclass('public.messages') is null
     or to_regclass('public.conversations') is null
     or to_regclass('public.conversation_read_states') is null
     or to_regclass('public.notifications') is null then
    raise exception 'HDR03 STOP: communication prerequisites missing';
  end if;
  if exists (select 1 from pg_class where oid in
      ('public.messages'::regclass,'public.conversations'::regclass,
       'public.conversation_read_states'::regclass,'public.notifications'::regclass)
      and not relrowsecurity) then
    raise exception 'HDR03 STOP: source RLS disabled';
  end if;
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
    raise exception 'HDR03 STOP: Realtime publication missing';
  end if;
end;
$hdr03_preflight$;


-- Invoker execution is intentional: all source-table RLS and SELECT privileges
-- remain effective. No identity parameter, elevated aggregate or private helper.
create function public.get_unread_counts()
returns table (unread_messages bigint, unread_notifications bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(app_security.get_account_status(v_uid)::text, '') not in ('active', 'suspended') then
    raise exception using errcode = '42501', message = 'Authentication or account access required';
  end if;

  -- Count messages, not conversations; never count the caller's own messages.
  -- last_read_at is when a read was recorded, NOT the message ordering cursor.
  select count(*) into unread_messages
  from public.conversations c
  join public.messages m on m.conversation_id = c.id
  left join public.conversation_read_states r on r.conversation_id = c.id and r.user_id = v_uid
  left join public.messages marker on marker.conversation_id = r.conversation_id and marker.id = r.last_read_message_id
  where (c.buyer_id = v_uid or c.seller_id = v_uid)
    and m.sender_id is distinct from v_uid
    and (marker.id is null or (m.created_at, m.id) > (marker.created_at, marker.id));

  select count(*) into unread_notifications
  from public.notifications n where n.user_id = v_uid and n.read_at is null;

  -- count(*) is non-negative bigint; reject values JS cannot represent exactly.
  if unread_messages > 9007199254740991 or unread_notifications > 9007199254740991 then
    raise exception using errcode = '22003', message = 'Unread count out of range';
  end if;
  return next;
end;
$$;
revoke all on function public.get_unread_counts() from public, anon, authenticated;
grant execute on function public.get_unread_counts() to authenticated;

-- Minimal invalidation signal: never publish message bodies or read-marker IDs.
create table public.unread_count_signals (
  -- DELETE tombstones must never expose the owner ID as a replica key.
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0)
);
alter table public.unread_count_signals enable row level security;
alter table public.unread_count_signals force row level security;
revoke all on public.unread_count_signals from public, anon, authenticated;
grant select on public.unread_count_signals to authenticated;
create policy unread_count_signals_owner_select on public.unread_count_signals
for select to authenticated using (
  user_id = (select auth.uid())
  and app_security.get_account_status((select auth.uid())) in ('active', 'suspended')
);

-- Only trigger owners can execute these helpers. Client DML stays revoked.
create function app_security.hdr03_signal_message()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.unread_count_signals as s (user_id)
  select participant from public.conversations c
  cross join lateral (values (c.buyer_id), (c.seller_id)) p(participant)
  where c.id = new.conversation_id and participant is not null
    and participant is distinct from new.sender_id
  order by participant
  on conflict (user_id) do update set revision = s.revision + 1;
  return new;
end;
$$;
revoke all on function app_security.hdr03_signal_message() from public, anon, authenticated;

create function app_security.hdr03_signal_read_state()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.unread_count_signals as s (user_id) values (new.user_id)
  on conflict (user_id) do update set revision = s.revision + 1;
  return new;
end;
$$;
revoke all on function app_security.hdr03_signal_read_state() from public, anon, authenticated;

create trigger hdr03_message_arrival after insert on public.messages
for each row execute function app_security.hdr03_signal_message();
create trigger hdr03_read_state_insert after insert on public.conversation_read_states
for each row execute function app_security.hdr03_signal_read_state();
create trigger hdr03_read_state_update after update of last_read_message_id on public.conversation_read_states
for each row when (old.last_read_message_id is distinct from new.last_read_message_id)
execute function app_security.hdr03_signal_read_state();

-- Existing Supabase publication must exist; missing prerequisites fail atomically.
alter publication supabase_realtime add table public.unread_count_signals;
notify pgrst, 'reload schema';
comment on function public.get_unread_counts() is
  'HDR-03: caller-only unread inbound message count after (created_at,id) read cursor, plus unread notification count; existing RLS applies.';
commit;
