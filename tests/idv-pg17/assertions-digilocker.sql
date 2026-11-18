-- DigiLocker-direct (20261117090000) PG17 assertions. Requires fixture-digilocker.sql and the foundation migration.
-- p_role: JWT role of an API request. NULL with NULL uid = direct database session (migration/cron/owner).
create or replace function public.dl_as(p_uid text, p_aal text default 'aal1', p_role text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  perform set_config('request.jwt.claim.aal', p_aal, false);
  perform set_config('request.jwt.claim.role', coalesce(p_role, case when p_uid is not null then 'authenticated' end, ''), false);
  perform set_config('request.jwt.claims', '', false);
end; $$;

-- Links a fresh account to a fingerprint through the real start/consume/complete functions.
create or replace function public.dl_link(p_user uuid, p_state text, p_fp text) returns jsonb language plpgsql as $$
declare r jsonb; a uuid;
begin
  insert into auth.users (id, email) values (p_user, p_user::text || '@fairswap.test') on conflict do nothing;
  insert into public.user_accounts (user_id, account_status) values (p_user, 'active') on conflict do nothing;
  r := app_security.impl_idv_dl_start_attempt(p_user, p_state, 600, 'p', true, 'dl-v1.0');
  if not coalesce((r->>'success')::boolean, false) or r ? 'already_verified' then return r; end if;
  a := (r->>'attempt_id')::uuid;
  perform app_security.impl_idv_dl_consume_state(p_user, p_state);
  return app_security.impl_idv_dl_complete(a, p_user, p_fp, 'v1');
end; $$;

create or replace function public.dl_denied(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when sqlstate '42501' then
  return true;
end; $$;

insert into auth.users (id, email) values
  ('44444444-4444-4000-8000-000000000004', 'dl1@fairswap.test'),
  ('55555555-5555-4000-8000-000000000005', 'dl2@fairswap.test') on conflict (id) do nothing;
insert into public.user_accounts (user_id, account_status) values
  ('44444444-4444-4000-8000-000000000004', 'active'),
  ('55555555-5555-4000-8000-000000000005', 'active') on conflict (user_id) do nothing;

select public.dl_as(null);
select public.idv_assert((select setting_value from public.app_system_settings where setting_key = 'identity_verification_required') = 'false', 'DL gate default OFF');

-- Seed marketplace rows as system (no JWT => not gated)
insert into public.listings (id, seller_id, status) values ('aaaaaaaa-0000-4000-8000-000000000001', '55555555-5555-4000-8000-000000000005', 'active');

-- Gate OFF: unverified user can still insert (rollout safety)
select public.dl_as('44444444-4444-4000-8000-000000000004');
insert into public.listings (seller_id) values ('44444444-4444-4000-8000-000000000004');
select public.dl_as(null);
update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required';

-- Gate ON: unverified user denied on every gated mutation path (direct table writes, as RPCs would)
select public.dl_as('44444444-4444-4000-8000-000000000004');
select public.idv_assert(public.dl_denied($q$insert into public.listings (seller_id) values ('44444444-4444-4000-8000-000000000004')$q$), 'DL unverified cannot create draft');
select public.idv_assert(public.dl_denied($q$update public.listings set title = 'x' where seller_id = '44444444-4444-4000-8000-000000000004' and status = 'draft'$q$), 'DL unverified cannot edit/submit draft');
select public.idv_assert(public.dl_denied($q$insert into public.listing_media (listing_id) select id from public.listings where seller_id = '44444444-4444-4000-8000-000000000004' limit 1$q$), 'DL unverified cannot add media');
select public.idv_assert(public.dl_denied($q$insert into public.conversations (listing_id, buyer_id, seller_id) values ('aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4000-8000-000000000004', '55555555-5555-4000-8000-000000000005')$q$), 'DL unverified cannot start conversation');
select public.idv_assert(public.dl_denied($q$insert into public.messages (conversation_id, sender_id) values (gen_random_uuid(), '44444444-4444-4000-8000-000000000004')$q$), 'DL unverified cannot send message');
-- Browsing/support unaffected: reads work
select public.idv_assert((select count(*) from public.listings where status = 'active') >= 1, 'DL unverified can browse');
-- No bypass through privileged paths: an INSERT for an unverified owner is denied even without a user JWT
-- (service-role / SECURITY DEFINER on-behalf writes).
select public.dl_as(null);
select public.idv_assert(public.dl_denied($q$insert into public.listings (seller_id) values ('44444444-4444-4000-8000-000000000004')$q$), 'DL service-role insert for unverified owner denied');
select public.idv_assert(public.dl_denied($q$insert into public.messages (conversation_id, sender_id) values (gen_random_uuid(), '44444444-4444-4000-8000-000000000004')$q$), 'DL service-role message for unverified sender denied');
-- System/moderation UPDATEs (caller is not the owner) keep working, e.g. a worker moving a draft to review.
update public.listings set status = 'pending_review' where seller_id = '44444444-4444-4000-8000-000000000004' and status = 'draft';
-- Owner managing own ad stays open while unverified (e.g. remove).
select public.dl_as('55555555-5555-4000-8000-000000000005');
update public.listings set status = 'removed' where id = 'aaaaaaaa-0000-4000-8000-000000000001';
select public.dl_as(null);
update public.listings set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- Grants: server-only RPCs and tables are not reachable by clients
select public.idv_assert(not has_function_privilege('authenticated', 'public.server_idv_dl_complete(uuid,uuid,text,text,text[])', 'execute'), 'DL complete not client-callable');
select public.idv_assert(not has_function_privilege('anon', 'public.server_idv_dl_start_attempt(uuid,text,integer,text,boolean,text)', 'execute'), 'DL start not anon-callable');
select public.idv_assert(not has_table_privilege('authenticated', 'app_security.idv_digilocker_bindings', 'select'), 'DL bindings not client-readable');
select public.idv_assert(not has_table_privilege('authenticated', 'app_security.idv_digilocker_attempts', 'select'), 'DL attempts not client-readable');
select public.idv_assert(not has_table_privilege('service_role', 'app_security.idv_digilocker_bindings', 'update'), 'DL bindings: no direct DML even for service_role');
select public.idv_assert(not has_table_privilege('service_role', 'app_security.idv_digilocker_bindings', 'delete'), 'DL bindings: no direct delete even for service_role');
select public.idv_assert(not has_function_privilege('authenticated', 'app_security.impl_idv_dl_complete(uuid,uuid,text,text,text[])', 'execute'), 'DL impl complete not client-callable (RPC bypass)');
select public.idv_assert(not has_function_privilege('authenticated', 'app_security.enforce_verified_actor(uuid,boolean)', 'execute'), 'DL gate helper not client-callable');

-- Flow: start -> consume -> complete
do $$
declare r jsonb; a uuid; h1 text := repeat('a', 64); h2 text := repeat('b', 64); fp text := repeat('c', 64); u1 uuid := '44444444-4444-4000-8000-000000000004'; u2 uuid := '55555555-5555-4000-8000-000000000005';
begin
  r := app_security.impl_idv_dl_start_attempt(u1, h1, 600, 'p', false, 'dl-v1.0');
  perform public.idv_assert(r->>'error' = 'CONSENT_REQUIRED', 'DL consent required');
  r := app_security.impl_idv_dl_start_attempt(u1, h1, 600, 'p', true, 'dl-v1.0');
  perform public.idv_assert((r->>'success')::boolean, 'DL start ok'); a := (r->>'attempt_id')::uuid;
  perform public.idv_assert((app_security.impl_idv_dl_consume_state(u2, h1))->>'error' = 'ATTEMPT_NOT_FOUND', 'DL wrong user state rejected');
  perform public.idv_assert((app_security.impl_idv_dl_consume_state(u1, h1))->>'success' = 'true', 'DL consume ok');
  perform public.idv_assert((app_security.impl_idv_dl_consume_state(u1, h1))->>'error' = 'STATE_ALREADY_USED', 'DL state replay rejected');
  perform public.idv_assert((app_security.impl_idv_dl_complete(a, u1, 'not-a-fingerprint', 'v1'))->>'error' = 'INVALID_IDENTITY_EVIDENCE', 'DL invalid fingerprint rejected');
  perform public.idv_assert((app_security.impl_idv_dl_complete(a, u1, fp, 'v1'))->>'success' = 'true', 'DL complete ok');
  perform public.idv_assert(app_security.is_identity_verified(u1), 'DL user verified');
  perform public.idv_assert((select valid_until is null and badge_issued from public.user_identity_verifications where user_id = u1), 'DL one-time: no expiry');
  perform public.idv_assert((app_security.impl_idv_dl_start_attempt(u1, repeat('d', 64), 600, 'p', true, 'dl-v1.0'))->>'already_verified' = 'true', 'DL already verified no new attempt');
  perform public.idv_assert((select count(*) from app_security.idv_digilocker_attempts where state_hash = repeat('d', 64)) = 0, 'DL no attempt row when already verified');

  -- Duplicate identity on another account
  r := app_security.impl_idv_dl_start_attempt(u2, h2, 600, 'p', true, 'dl-v1.0'); a := (r->>'attempt_id')::uuid;
  perform app_security.impl_idv_dl_consume_state(u2, h2);
  r := app_security.impl_idv_dl_complete(a, u2, fp, 'v1');
  perform public.idv_assert(r->>'error' = 'IDENTITY_ALREADY_LINKED' and (r->>'recovery')::boolean, 'DL duplicate identity rejected with recovery');
  perform public.idv_assert(not app_security.is_identity_verified(u2), 'DL duplicate user not verified');
  perform public.idv_assert((select count(*) from app_security.idv_digilocker_bindings) = 1, 'DL single binding');
  begin
    insert into app_security.idv_digilocker_bindings (user_id, id_fingerprint, consent_timestamp, consent_purpose, consent_policy_version)
    values (u2, fp, now(), 'p', 'v');
    raise exception 'DL unique constraint missing';
  exception when unique_violation then null; end;
end $$;

-- Gate ON: verified user passes all gated paths
select public.dl_as('44444444-4444-4000-8000-000000000004');
insert into public.listings (seller_id) values ('44444444-4444-4000-8000-000000000004');
insert into public.conversations (listing_id, buyer_id, seller_id) values ('aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4000-8000-000000000004', '55555555-5555-4000-8000-000000000005');
insert into public.messages (conversation_id, sender_id) select id, '44444444-4444-4000-8000-000000000004' from public.conversations limit 1;
select public.dl_as(null);

-- Fraud block: admin only, AAL2 required
select public.dl_as('44444444-4444-4000-8000-000000000004');
select public.idv_assert((public.admin_digilocker_fraud_block('55555555-5555-4000-8000-000000000005', 'confirmed fraud ring'))->>'error' = 'FORBIDDEN_ADMIN_AAL2_REQUIRED', 'DL non-admin cannot fraud-block');
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal1');
select public.idv_assert((public.admin_digilocker_fraud_block('44444444-4444-4000-8000-000000000004', 'confirmed fraud ring'))->>'error' = 'FORBIDDEN_ADMIN_AAL2_REQUIRED', 'DL admin needs AAL2');
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.idv_assert((public.admin_digilocker_fraud_block('44444444-4444-4000-8000-000000000004', 'confirmed fraud ring'))->>'success' = 'true', 'DL admin fraud-block ok');
select public.dl_as(null);
select public.idv_assert((select identity_status = 'fraud_blocked' and retention_review_at is not null from app_security.idv_digilocker_bindings), 'DL binding blocked with retention review date');
select public.idv_assert((select account_status = 'suspended' from public.user_accounts where user_id = '44444444-4444-4000-8000-000000000004'), 'DL marketplace access disabled');
select public.idv_assert(not app_security.is_identity_verified('44444444-4444-4000-8000-000000000004'), 'DL blocked user not verified');

-- Blocked identity cannot verify another account
do $$
declare r jsonb; a uuid; u2 uuid := '55555555-5555-4000-8000-000000000005';
begin
  r := app_security.impl_idv_dl_start_attempt(u2, repeat('e', 64), 600, 'p', true, 'dl-v1.0'); a := (r->>'attempt_id')::uuid;
  perform app_security.impl_idv_dl_consume_state(u2, repeat('e', 64));
  perform public.idv_assert((app_security.impl_idv_dl_complete(a, u2, repeat('c', 64), 'v1'))->>'error' = 'VERIFICATION_UNAVAILABLE', 'DL blocked identity cannot verify another account');
  -- After key rotation the same identity arrives as a new current fingerprint plus the legacy one: still blocked.
  r := app_security.impl_idv_dl_start_attempt(u2, repeat('9', 64), 600, 'p', true, 'dl-v1.0'); a := (r->>'attempt_id')::uuid;
  perform app_security.impl_idv_dl_consume_state(u2, repeat('9', 64));
  perform public.idv_assert((app_security.impl_idv_dl_complete(a, u2, repeat('f', 64), 'v2', array[repeat('c', 64)]))->>'error' = 'VERIFICATION_UNAVAILABLE', 'DL fraud block survives key rotation');
  perform public.idv_assert((app_security.impl_idv_dl_complete(a, u2, repeat('f', 64), 'bad', array[]::text[]))->>'error' = 'INVALID_IDENTITY_EVIDENCE', 'DL key version validated');
end $$;

-- Fraud-block cannot be released or deleted outside the admin resolve function
select public.idv_assert(public.dl_denied($q$update app_security.idv_digilocker_bindings set identity_status = 'linked', fraud_blocked_at = null$q$), 'DL fraud block protected from direct release');
select public.idv_assert(public.dl_denied($q$delete from app_security.idv_digilocker_bindings$q$), 'DL fraud block protected from direct delete');

-- Fraud-block survives auth.users deletion (no cascade)
delete from auth.users where id = '44444444-4444-4000-8000-000000000004';
select public.idv_assert((select count(*) = 1 and bool_and(user_id is null and identity_status = 'fraud_blocked') from app_security.idv_digilocker_bindings), 'DL fraud-block survives auth.users delete');

-- Review: only admin AAL2 can release/purge
select public.dl_as('55555555-5555-4000-8000-000000000005');
select public.idv_assert((public.admin_digilocker_fraud_block_resolve((select id from app_security.idv_digilocker_bindings), 'purge', 'retention window elapsed'))->>'error' = 'FORBIDDEN_ADMIN_AAL2_REQUIRED', 'DL non-admin cannot resolve');
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.idv_assert((public.admin_digilocker_fraud_block_resolve((select id from app_security.idv_digilocker_bindings), 'purge', 'retention window elapsed'))->>'success' = 'true', 'DL admin purge ok');
select public.dl_as(null);
select public.idv_assert((select count(*) = 0 from app_security.idv_digilocker_bindings), 'DL binding purged');

-- A non-blocked binding is removed with its account (data minimisation), freeing the identity
insert into auth.users (id, email) values ('66666666-6666-4000-8000-000000000006', 'dl3@fairswap.test');
insert into public.user_accounts (user_id, account_status) values ('66666666-6666-4000-8000-000000000006', 'active');
do $$
declare r jsonb; a uuid; u uuid := '66666666-6666-4000-8000-000000000006';
begin
  r := app_security.impl_idv_dl_start_attempt(u, repeat('7', 64), 600, 'p', true, 'dl-v1.0'); a := (r->>'attempt_id')::uuid;
  perform app_security.impl_idv_dl_consume_state(u, repeat('7', 64));
  perform public.idv_assert((app_security.impl_idv_dl_complete(a, u, repeat('8', 64), 'v1'))->>'success' = 'true', 'DL third user verified');
end $$;
delete from auth.users where id = '66666666-6666-4000-8000-000000000006';
select public.idv_assert((select count(*) = 0 from app_security.idv_digilocker_bindings where id_fingerprint = repeat('8', 64)), 'DL non-blocked binding removed with account');

-- ===================== NULL-owner bypass attempts (gate ON) =====================
select public.dl_as(null);
update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required';
insert into public.listings (id, seller_id, status) values ('bbbbbbbb-0000-4000-8000-000000000002', null, 'draft'); -- historical ownerless row
update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required';

create or replace function public.dl_definer_insert_ownerless() returns void language sql security definer set search_path = '' as $f$
  insert into public.listings (seller_id) values (null);
$f$;
create or replace function public.dl_definer_insert_for(p_owner uuid) returns void language sql security definer set search_path = '' as $f$
  insert into public.listings (seller_id) values (p_owner);
$f$;
create or replace function public.dl_definer_system_write() returns void language plpgsql security definer set search_path = '' as $f$
begin
  perform pg_catalog.set_config('fairswap.identity_gate_system_write', 'on', true);
  insert into public.listings (seller_id) values (null);
  perform pg_catalog.set_config('fairswap.identity_gate_system_write', '', true);
end; $f$;

-- service_role API request: direct table writes with NULL owner
select public.dl_as(null, 'aal1', 'service_role');
select public.idv_assert(public.dl_denied($q$insert into public.listings (seller_id) values (null)$q$), 'NULL owner: service_role listing insert denied');
select public.idv_assert(public.dl_denied($q$insert into public.conversations (listing_id, buyer_id, seller_id) values ('aaaaaaaa-0000-4000-8000-000000000001', null, '55555555-5555-4000-8000-000000000005')$q$), 'NULL owner: service_role conversation insert denied');
select public.idv_assert(public.dl_denied($q$insert into public.messages (conversation_id, sender_id) values (gen_random_uuid(), null)$q$), 'NULL owner: service_role message insert denied');
select public.idv_assert(public.dl_denied($q$select public.dl_definer_insert_ownerless()$q$), 'NULL owner: SECURITY DEFINER via service_role denied');
select public.idv_assert(public.dl_denied($q$select public.dl_definer_insert_for('55555555-5555-4000-8000-000000000005')$q$), 'SECURITY DEFINER on behalf of unverified owner denied');
-- authenticated end user
select public.dl_as('55555555-5555-4000-8000-000000000005');
select public.idv_assert(public.dl_denied($q$insert into public.listings (seller_id) values (null)$q$), 'NULL owner: authenticated listing insert denied');
select public.idv_assert(public.dl_denied($q$insert into public.messages (conversation_id, sender_id) values (gen_random_uuid(), null)$q$), 'NULL owner: authenticated message insert denied');
select public.idv_assert(public.dl_denied($q$select public.dl_definer_insert_ownerless()$q$), 'NULL owner: SECURITY DEFINER via authenticated denied');
-- anon and unparseable claims are API requests too, never "system"
select public.dl_as(null, 'aal1', 'anon');
select public.idv_assert(public.dl_denied($q$insert into public.listings (seller_id) values (null)$q$), 'NULL owner: anon insert denied');
select public.dl_as(null);
select set_config('request.jwt.claims', 'not-json', false);
select public.idv_assert(public.dl_denied($q$insert into public.listings (seller_id) values (null)$q$), 'NULL owner: unparseable claims treated as API');
select public.dl_as(null);
-- legitimate system operations
select public.dl_as(null, 'aal1', 'service_role');
select public.dl_definer_system_write(); -- explicit system-write marker inside a database function
select public.dl_as(null);
insert into public.listings (seller_id) values (null); -- direct database session (migration / pg_cron / owner)
select public.idv_assert((select count(*) from public.listings where seller_id is null) = 3, 'NULL owner: only legitimate system inserts created rows');
-- UPDATE of the historical ownerless row
select public.dl_as('55555555-5555-4000-8000-000000000005');
select public.idv_assert(public.dl_denied($q$update public.listings set status = 'pending_review' where id = 'bbbbbbbb-0000-4000-8000-000000000002'$q$), 'NULL owner: end-user publish of ownerless row denied');
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
update public.listings set status = 'pending_review' where id = 'bbbbbbbb-0000-4000-8000-000000000002'; -- moderation (AAL2 staff) allowed
select public.dl_as(null, 'aal1', 'service_role');
update public.listings set status = 'removed' where id = 'bbbbbbbb-0000-4000-8000-000000000002'; -- system/worker allowed
select public.dl_as(null);
select public.idv_assert((select status = 'removed' from public.listings where id = 'bbbbbbbb-0000-4000-8000-000000000002'), 'NULL owner: historical row preserved and moderatable');
-- Gate OFF: NULL-owner and unverified writes behave exactly as before
update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required';
select public.dl_as(null, 'aal1', 'service_role');
insert into public.listings (seller_id) values (null);
select public.dl_as(null);
update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required';

-- Account deletion orphaning a draft (FK SET NULL in hosted schemas) is never blocked, even in the user's own session
insert into auth.users (id, email) values ('c0c0c0c0-c0c0-4000-8000-0000000000c0', 'dl-c0@fairswap.test');
insert into public.user_accounts (user_id, account_status) values ('c0c0c0c0-c0c0-4000-8000-0000000000c0', 'active');
update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required';
insert into public.listings (seller_id, status) values ('c0c0c0c0-c0c0-4000-8000-0000000000c0', 'draft');
update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required';
select public.dl_as('c0c0c0c0-c0c0-4000-8000-0000000000c0');
update public.listings set seller_id = null where seller_id = 'c0c0c0c0-c0c0-4000-8000-0000000000c0';
select public.dl_as(null);
select public.idv_assert((select count(*) from public.listings where seller_id is null and status = 'draft') >= 1, 'NULL owner: deletion orphaning of an unverified draft allowed');

-- ===================== Fraud-suspension integration (REAL impl_update_user_account_status) =====================
select public.dl_as(null);
select public.idv_assert((public.dl_link('77777777-7777-4000-8000-000000000007', repeat('1a', 32), repeat('1', 64)))->>'success' = 'true', 'FRAUD: normal user linked');
select public.idv_assert((public.dl_link('88888888-8888-4000-8000-000000000008', repeat('2a', 32), repeat('2', 64)))->>'success' = 'true', 'FRAUD: suspect linked');
-- A normal (non-fraud) suspension through the existing Admin workflow
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.admin_update_user_account_status('77777777-7777-4000-8000-000000000007', 'suspended', 'Spam reports under review');
select public.dl_as(null);
select public.idv_assert((select identity_status = 'linked' and fraud_blocked_at is null from app_security.idv_digilocker_bindings where user_id = '77777777-7777-4000-8000-000000000007'), 'FRAUD: normal suspension is not an identity ban');
select public.idv_assert(exists (select 1 from public.test_audit_log where action = 'user_account.status_update' and entity_id = '77777777-7777-4000-8000-000000000007'), 'FRAUD: normal suspension audited by existing workflow');
delete from auth.users where id = '77777777-7777-4000-8000-000000000007';
select public.idv_assert(not exists (select 1 from app_security.idv_digilocker_bindings where id_fingerprint = repeat('1', 64)), 'FRAUD: normally suspended + deleted account leaves no permanent ban');
select public.idv_assert((public.dl_link('a0a0a0a0-a0a0-4000-8000-0000000000a0', repeat('3a', 32), repeat('1', 64)))->>'success' = 'true', 'FRAUD: identity reusable after non-fraud deletion');
-- Investigation suspension first, then confirmed fraud (previously failed: existing impl rejects no-op status change)
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.admin_update_user_account_status('88888888-8888-4000-8000-000000000008', 'suspended', 'Under fraud investigation');
select public.idv_assert((select (r->>'success')::boolean and r->>'previous_status' = 'suspended' from (select public.admin_digilocker_fraud_block('88888888-8888-4000-8000-000000000008', 'Confirmed UPI advance-payment fraud') r) x), 'FRAUD: confirmed fraud on already-suspended account succeeds');
select public.dl_as(null);
select public.idv_assert((select identity_status = 'fraud_blocked' from app_security.idv_digilocker_bindings where id_fingerprint = repeat('2', 64)), 'FRAUD: fingerprint blocked');
select public.idv_assert((select account_status = 'suspended' from public.user_accounts where user_id = '88888888-8888-4000-8000-000000000008'), 'FRAUD: marketplace access disabled');
-- Reinstating the account through the normal workflow does not lift the identity block
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.admin_update_user_account_status('88888888-8888-4000-8000-000000000008', 'active', 'Reinstated after appeal review');
select public.dl_as(null);
select public.idv_assert((select identity_status = 'fraud_blocked' from app_security.idv_digilocker_bindings where id_fingerprint = repeat('2', 64)), 'FRAUD: reinstatement does not release identity block');
delete from auth.users where id = '88888888-8888-4000-8000-000000000008';
select public.idv_assert((select user_id is null and identity_status = 'fraud_blocked' from app_security.idv_digilocker_bindings where id_fingerprint = repeat('2', 64)), 'FRAUD: block survives account deletion');
select public.idv_assert((public.dl_link('b0b0b0b0-b0b0-4000-8000-0000000000b0', repeat('4a', 32), repeat('2', 64)))->>'error' = 'VERIFICATION_UNAVAILABLE', 'FRAUD: blocked identity cannot verify a new account');
-- Moderator (not administrator) cannot confirm fraud or release
update public.staff_roles set role = 'moderator' where user_id = '99999999-9999-4000-8000-000000000099';
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.idv_assert((public.admin_digilocker_fraud_block('a0a0a0a0-a0a0-4000-8000-0000000000a0', 'Confirmed fraud by moderator'))->>'error' = 'FORBIDDEN_ADMIN_AAL2_REQUIRED', 'FRAUD: moderator cannot confirm fraud');
select public.idv_assert((public.admin_digilocker_fraud_block_resolve((select id from app_security.idv_digilocker_bindings where id_fingerprint = repeat('2', 64)), 'release', 'Moderator release attempt'))->>'error' = 'FORBIDDEN_ADMIN_AAL2_REQUIRED', 'FRAUD: moderator cannot release');
select public.dl_as(null);
update public.staff_roles set role = 'administrator' where user_id = '99999999-9999-4000-8000-000000000099';

update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required';
select public.dl_as(null);
