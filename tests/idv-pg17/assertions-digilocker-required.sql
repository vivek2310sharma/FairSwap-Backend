-- Mandatory DigiLocker gate (20261122100000) PG17 assertions. Runs after assertions-digilocker-v2.sql, reusing its
-- helpers (public.idv_assert, public.dl_as, public.dl_denied, public.dl_link_v2, public.dl_definer_system_write) and state:
--   a0a0... signed-OIDC upgraded then fraud-blocked (account suspended); d1d1... signed then admin-revoked;
--   55555... active, never verified; 99999... administrator.
-- Every binding below is synthetic and exists only in this disposable database. No raw id, token or claim is used.
select public.dl_as(null);

-- Returns 'OK' or '<SQLSTATE>:<message>' so the exact gate error contract is asserted, not just any 42501.
create or replace function public.dlr_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ':' || v_msg;
end; $$;
create or replace function public.dlr_gated(p_sql text) returns boolean language sql as $$
  select public.dlr_err(p_sql) = '42501:IDENTITY_VERIFICATION_REQUIRED';
$$;
create or replace function public.dlr_ok(p_sql text) returns boolean language sql as $$
  select public.dlr_err(p_sql) = 'OK';
$$;

-- ---------- Structure: only the gate helper changed; switch untouched; privileges preserved ----------
select public.idv_assert((select setting_value from public.app_system_settings where setting_key = 'identity_verification_required') = 'false',
  'REQ migration leaves identity gate OFF');
select public.idv_assert((select count(*) = 1 from public.app_system_settings where setting_key = 'identity_verification_required'),
  'REQ single operational switch row');
select public.idv_assert((select p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""']::text[]
  from pg_proc p where p.oid = 'app_security.enforce_verified_actor(uuid,boolean)'::regprocedure),
  'REQ gate helper SECURITY DEFINER, STABLE, empty search_path');
select public.idv_assert((select d like '%app_security.has_digilocker_badge(p_actor)%' and d not like '%is_identity_verified%'
    and d like '%IDENTITY_VERIFICATION_REQUIRED%' and d like '%42501%'
  from pg_get_functiondef('app_security.enforce_verified_actor(uuid,boolean)'::regprocedure) d),
  'REQ gate helper uses strict signed predicate only, same error contract');
do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    perform public.idv_assert(not has_function_privilege(role_name, 'app_security.enforce_verified_actor(uuid,boolean)', 'execute'), 'REQ gate helper not callable by ' || role_name);
    perform public.idv_assert(not has_function_privilege(role_name, 'app_security.has_digilocker_badge(uuid)', 'execute'), 'REQ badge predicate not callable by ' || role_name);
  end loop;
end $$;
select public.idv_assert(has_function_privilege('service_role', 'app_security.enforce_verified_actor(uuid,boolean)', 'execute'), 'REQ gate helper service_role EXECUTE preserved');
select public.idv_assert(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
  where p.oid = 'app_security.enforce_verified_actor(uuid,boolean)'::regprocedure and a.grantee = 0), 'REQ gate helper no PUBLIC EXECUTE');
select public.idv_assert(has_function_privilege('authenticated', 'app_security.is_identity_verified(uuid)', 'execute')
  and not has_function_privilege('anon', 'app_security.is_identity_verified(uuid)', 'execute'), 'REQ generic predicate grants unchanged');
select public.idv_assert((select count(*) = 4 from pg_trigger t where not t.tgisinternal and t.tgname = 'trg_identity_gate' and t.tgenabled = 'O'
  and (t.tgrelid, t.tgfoid) in (('public.listings'::regclass, 'app_security.trg_identity_gate_listings()'::regprocedure),
                                ('public.listing_media'::regclass, 'app_security.trg_identity_gate_by_listing()'::regprocedure),
                                ('public.conversations'::regclass, 'app_security.trg_identity_gate_conversations()'::regprocedure),
                                ('public.messages'::regclass, 'app_security.trg_identity_gate_messages()'::regprocedure))),
  'REQ four gate triggers intact and enabled');

-- ---------- Synthetic identities (disposable DB only) ----------
-- E1 current signed binding; E2 generic projection only (e.g. other provider); E3 legacy unsigned binding + projection;
-- E4 signed then expired projection; E5 signed then account suspended.
select public.idv_assert((public.dl_link_v2('e1e1e1e1-e1e1-4000-8000-0000000000e1', repeat('01', 32), repeat('b1', 32)))->>'success' = 'true', 'REQ E1 signed link');
select public.idv_assert((public.dl_link_v2('e4e4e4e4-e4e4-4000-8000-0000000000e4', repeat('04', 32), repeat('b4', 32)))->>'success' = 'true', 'REQ E4 signed link');
select public.idv_assert((public.dl_link_v2('e5e5e5e5-e5e5-4000-8000-0000000000e5', repeat('05', 32), repeat('b5', 32)))->>'success' = 'true', 'REQ E5 signed link');
insert into auth.users (id, email) values
  ('e2e2e2e2-e2e2-4000-8000-0000000000e2', 'e2@fairswap.test'),
  ('e3e3e3e3-e3e3-4000-8000-0000000000e3', 'e3@fairswap.test');
insert into public.user_accounts (user_id, account_status) values
  ('e2e2e2e2-e2e2-4000-8000-0000000000e2', 'active'),
  ('e3e3e3e3-e3e3-4000-8000-0000000000e3', 'active');
insert into public.user_identity_verifications (user_id, verification_status, badge_issued, verified_at) values
  ('e2e2e2e2-e2e2-4000-8000-0000000000e2', 'verified', true, clock_timestamp()),
  ('e3e3e3e3-e3e3-4000-8000-0000000000e3', 'verified', true, clock_timestamp());
insert into app_security.idv_digilocker_bindings (user_id, id_fingerprint, consent_timestamp, consent_purpose, consent_policy_version)
values ('e3e3e3e3-e3e3-4000-8000-0000000000e3', repeat('b3', 32), clock_timestamp(), 'p', 'dl-v1.0'); -- legacy_account_link by default
update public.user_identity_verifications set valid_until = clock_timestamp() - interval '1 second'
where user_id = 'e4e4e4e4-e4e4-4000-8000-0000000000e4';
update public.user_accounts set account_status = 'suspended' where user_id = 'e5e5e5e5-e5e5-4000-8000-0000000000e5';
-- Fraud-blocked a0a0...: reactivate the account so only the identity block is under test.
update public.user_accounts set account_status = 'active' where user_id = 'a0a0a0a0-a0a0-4000-8000-0000000000a0';

select public.idv_assert(app_security.has_digilocker_badge('e1e1e1e1-e1e1-4000-8000-0000000000e1'), 'REQ E1 holds signed badge');
select public.idv_assert(app_security.is_identity_verified('e2e2e2e2-e2e2-4000-8000-0000000000e2')
  and not app_security.has_digilocker_badge('e2e2e2e2-e2e2-4000-8000-0000000000e2'), 'REQ E2 generic-verified without badge');
select public.idv_assert(app_security.is_identity_verified('e3e3e3e3-e3e3-4000-8000-0000000000e3')
  and not app_security.has_digilocker_badge('e3e3e3e3-e3e3-4000-8000-0000000000e3'), 'REQ E3 legacy-verified without badge');
select public.idv_assert(not app_security.has_digilocker_badge('e4e4e4e4-e4e4-4000-8000-0000000000e4'), 'REQ E4 expired: no badge');
select public.idv_assert(not app_security.has_digilocker_badge('e5e5e5e5-e5e5-4000-8000-0000000000e5'), 'REQ E5 suspended: no badge');
select public.idv_assert(not app_security.has_digilocker_badge('a0a0a0a0-a0a0-4000-8000-0000000000a0'), 'REQ fraud-blocked: no badge');
select public.idv_assert(not app_security.has_digilocker_badge('d1d1d1d1-d1d1-4000-8000-0000000000d1'), 'REQ admin-revoked: no badge');

-- ---------- Gate OFF: no behaviour change for anyone (rollout safety) ----------
select public.dl_as('55555555-5555-4000-8000-000000000005');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values ('55555555-5555-4000-8000-000000000005')$q$), 'REQ OFF unverified can still create');
select public.dl_as('e2e2e2e2-e2e2-4000-8000-0000000000e2');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values ('e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ OFF generic-verified can still create');
select public.dl_as(null, 'aal1', 'service_role');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values (null)$q$), 'REQ OFF ownerless service_role insert unchanged');
select public.dl_as(null);
-- Seed rows (direct database session, gate OFF) for the management/messaging paths below.
insert into public.listings (id, seller_id, status) values
  ('e2000000-0000-4000-8000-000000000002', 'e2e2e2e2-e2e2-4000-8000-0000000000e2', 'active'),
  ('e2000000-0000-4000-8000-000000000003', 'e2e2e2e2-e2e2-4000-8000-0000000000e2', 'draft'),
  ('e2000000-0000-4000-8000-000000000004', 'e2e2e2e2-e2e2-4000-8000-0000000000e2', 'draft'),
  ('e2000000-0000-4000-8000-000000000005', 'e2e2e2e2-e2e2-4000-8000-0000000000e2', 'draft'),
  ('e1000000-0000-4000-8000-000000000009', null, 'draft');
insert into public.conversations (id, listing_id, buyer_id, seller_id) values
  ('c1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'e2e2e2e2-e2e2-4000-8000-0000000000e2', '55555555-5555-4000-8000-000000000005'),
  ('c1000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'e1e1e1e1-e1e1-4000-8000-0000000000e1', 'e2e2e2e2-e2e2-4000-8000-0000000000e2');

update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required';

-- ---------- Gate ON: everyone without a current signed badge is refused on every gated INSERT ----------
do $$
declare
  u uuid; label text;
  cases text[][] := array[
    array['55555555-5555-4000-8000-000000000005', 'never verified'],
    array['e2e2e2e2-e2e2-4000-8000-0000000000e2', 'generic-verified (no DigiLocker)'],
    array['e3e3e3e3-e3e3-4000-8000-0000000000e3', 'legacy unsigned DigiLocker link'],
    array['e4e4e4e4-e4e4-4000-8000-0000000000e4', 'expired signed verification'],
    array['e5e5e5e5-e5e5-4000-8000-0000000000e5', 'suspended account with signed binding'],
    array['a0a0a0a0-a0a0-4000-8000-0000000000a0', 'fraud-blocked identity'],
    array['d1d1d1d1-d1d1-4000-8000-0000000000d1', 'admin-revoked signed verification']];
  i int;
begin
  for i in 1 .. array_length(cases, 1) loop
    u := cases[i][1]::uuid; label := cases[i][2];
    perform public.dl_as(u::text);
    perform public.idv_assert(public.dlr_gated(format('insert into public.listings (seller_id) values (%L)', u)), 'REQ ON listing draft create denied: ' || label);
    perform public.idv_assert(public.dlr_gated(format('insert into public.listings (seller_id, status) values (%L, ''pending_review'')', u)), 'REQ ON listing direct submit denied: ' || label);
    perform public.idv_assert(public.dlr_gated(format(
      'insert into public.conversations (listing_id, buyer_id, seller_id) values (''aaaaaaaa-0000-4000-8000-000000000001'', %L, ''55555555-5555-4000-8000-000000000005'')', u)),
      'REQ ON conversation start denied: ' || label);
    perform public.idv_assert(public.dlr_gated(format(
      'insert into public.messages (conversation_id, sender_id) values (''c1000000-0000-4000-8000-000000000001'', %L)', u)), 'REQ ON message send denied: ' || label);
  end loop;
  perform public.dl_as(null);
end $$;
-- Media: listing owner must hold the badge (generic-verified owner refused, even on an existing draft).
select public.dl_as('e2e2e2e2-e2e2-4000-8000-0000000000e2');
select public.idv_assert(public.dlr_gated($q$insert into public.listing_media (listing_id) values ('e2000000-0000-4000-8000-000000000003')$q$), 'REQ ON media denied for generic-verified owner');
-- Draft edits and (re)submission/publication by a non-badge owner.
select public.idv_assert(public.dlr_gated($q$update public.listings set title = 'x' where id = 'e2000000-0000-4000-8000-000000000003'$q$), 'REQ ON draft edit denied');
select public.idv_assert(public.dlr_gated($q$update public.listings set status = 'pending_review' where id = 'e2000000-0000-4000-8000-000000000003'$q$), 'REQ ON draft submit denied');
-- Seller replying inside an existing conversation is a message send too.
select public.idv_assert(public.dlr_gated($q$insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000002', 'e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ ON generic-verified seller reply denied');
-- Intentionally open: managing own existing ads (pause, sold, remove, remove a draft).
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'paused' where id = 'e2000000-0000-4000-8000-000000000002'$q$), 'REQ ON owner can pause own ad');
select public.idv_assert(public.dlr_gated($q$update public.listings set status = 'active' where id = 'e2000000-0000-4000-8000-000000000002'$q$), 'REQ ON owner cannot republish paused ad');
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'sold' where id = 'e2000000-0000-4000-8000-000000000002'$q$), 'REQ ON owner can mark sold');
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'removed' where id = 'e2000000-0000-4000-8000-000000000002'$q$), 'REQ ON owner can remove own ad');
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'removed' where id = 'e2000000-0000-4000-8000-000000000005'$q$), 'REQ ON owner can remove own draft');
-- Browsing stays open.
select public.idv_assert((select count(*) from public.listings where status = 'active') >= 1, 'REQ ON browse unaffected');
select public.dl_as(null);

-- ---------- Gate ON: current signed badge passes every gated path ----------
select public.dl_as('e1e1e1e1-e1e1-4000-8000-0000000000e1');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (id, seller_id) values ('e1000000-0000-4000-8000-000000000001', 'e1e1e1e1-e1e1-4000-8000-0000000000e1')$q$), 'REQ ON signed draft create');
select public.idv_assert(public.dlr_ok($q$update public.listings set title = 'Cycle' where id = 'e1000000-0000-4000-8000-000000000001'$q$), 'REQ ON signed draft edit');
select public.idv_assert(public.dlr_ok($q$insert into public.listing_media (listing_id) values ('e1000000-0000-4000-8000-000000000001')$q$), 'REQ ON signed media add');
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'pending_review' where id = 'e1000000-0000-4000-8000-000000000001'$q$), 'REQ ON signed submit');
select public.idv_assert(public.dlr_ok($q$insert into public.conversations (id, listing_id, buyer_id, seller_id) values ('c1000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'e1e1e1e1-e1e1-4000-8000-0000000000e1', '55555555-5555-4000-8000-000000000005')$q$), 'REQ ON signed conversation start');
select public.idv_assert(public.dlr_ok($q$insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000003', 'e1e1e1e1-e1e1-4000-8000-0000000000e1')$q$), 'REQ ON signed message send');
select public.dl_as(null);

-- Badge state is re-evaluated on every write: suspension removes, reactivation restores.
update public.user_accounts set account_status = 'suspended' where user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1';
select public.dl_as('e1e1e1e1-e1e1-4000-8000-0000000000e1');
select public.idv_assert(public.dlr_gated($q$insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000003', 'e1e1e1e1-e1e1-4000-8000-0000000000e1')$q$), 'REQ ON suspended signed user refused');
select public.dl_as(null);
update public.user_accounts set account_status = 'active' where user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1';

-- ---------- Failure leaves no partial writes; the session stays usable ----------
create or replace function public.dlr_two_step() returns void language plpgsql as $f$
begin
  insert into public.listings (id, seller_id, title) values ('e1000000-0000-4000-8000-000000000002', 'e1e1e1e1-e1e1-4000-8000-0000000000e1', 'two-step');
  insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000001', 'e2e2e2e2-e2e2-4000-8000-0000000000e2');
end; $f$;
select public.dl_as('e1e1e1e1-e1e1-4000-8000-0000000000e1');
select public.idv_assert(public.dlr_gated('select public.dlr_two_step()'), 'REQ ON mixed write refused');
select public.idv_assert(not exists (select 1 from public.listings where id = 'e1000000-0000-4000-8000-000000000002'), 'REQ ON refused write rolled back the earlier allowed insert');
select public.idv_assert(public.dlr_ok($q$insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000003', 'e1e1e1e1-e1e1-4000-8000-0000000000e1')$q$), 'REQ ON session usable after refusal');
select public.dl_as(null);

-- ---------- No privileged or anonymous bypass ----------
-- service_role API request acting on a user's behalf: only a current badge holder's row is accepted.
select public.dl_as(null, 'aal1', 'service_role');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values ('e1e1e1e1-e1e1-4000-8000-0000000000e1')$q$), 'REQ ON service_role on-behalf insert for badge holder');
select public.idv_assert(public.dlr_gated($q$insert into public.listings (seller_id) values ('e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ ON service_role on-behalf insert for generic-verified denied');
select public.idv_assert(public.dlr_gated($q$insert into public.listings (seller_id) values ('e3e3e3e3-e3e3-4000-8000-0000000000e3')$q$), 'REQ ON service_role on-behalf insert for legacy-linked denied');
select public.idv_assert(public.dlr_gated($q$insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000001', 'e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ ON service_role on-behalf message denied');
select public.idv_assert(public.dlr_gated($q$insert into public.listings (seller_id) values (null)$q$), 'REQ ON service_role ownerless insert denied');
select public.idv_assert(public.dlr_gated($q$select public.dl_definer_insert_for('e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ ON SECURITY DEFINER on-behalf insert denied');
select public.idv_assert(public.dlr_ok('select public.dl_definer_system_write()'), 'REQ ON explicit system-write marker preserved');
-- Reviewed non-owner exceptions: worker/system status change and AAL2 moderation of a non-badge owner's listing.
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'pending_review' where id = 'e2000000-0000-4000-8000-000000000004'$q$), 'REQ ON service_role status update preserved');
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'active' where id = 'e2000000-0000-4000-8000-000000000004'$q$), 'REQ ON AAL2 moderator approval preserved');
select public.idv_assert(public.dlr_ok($q$update public.listings set status = 'pending_review' where id = 'e1000000-0000-4000-8000-000000000009'$q$), 'REQ ON AAL2 staff update of ownerless row preserved');
-- End user cannot publish an ownerless row.
select public.dl_as('e1e1e1e1-e1e1-4000-8000-0000000000e1');
select public.idv_assert(public.dlr_gated($q$update public.listings set status = 'active' where id = 'e1000000-0000-4000-8000-000000000009'$q$), 'REQ ON end-user publish of ownerless row denied');
-- Direct database session (migration / pg_cron / owner): owner must still hold the badge; ownerless allowed as before.
select public.dl_as(null);
select public.idv_assert(public.dlr_gated($q$insert into public.listings (seller_id) values ('e3e3e3e3-e3e3-4000-8000-0000000000e3')$q$), 'REQ ON direct session insert for legacy-linked owner denied');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values (null)$q$), 'REQ ON direct session ownerless insert preserved');
-- Anonymous API requests (JWT role anon, no uid) are refused by the gate itself...
select public.dl_as(null, 'aal1', 'anon');
select public.idv_assert(public.dlr_gated($q$insert into public.listings (seller_id) values ('e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ ON anon insert for generic-verified owner denied');
select public.idv_assert(public.dlr_gated($q$insert into public.listings (seller_id) values (null)$q$), 'REQ ON anon ownerless insert denied');
select public.idv_assert(public.dlr_gated($q$insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000001', null)$q$), 'REQ ON anon ownerless message denied');
-- ...and under the real anon/authenticated roles neither gate internal can be called to probe or spoof.
set role anon;
select public.idv_assert(public.dl_denied($q$select app_security.enforce_verified_actor('e1e1e1e1-e1e1-4000-8000-0000000000e1', true)$q$), 'REQ anon cannot call gate helper');
select public.idv_assert(public.dl_denied($q$select app_security.has_digilocker_badge('e1e1e1e1-e1e1-4000-8000-0000000000e1')$q$), 'REQ anon cannot call badge predicate');
select public.idv_assert(public.dl_denied($q$insert into public.listings (seller_id) values ('e1e1e1e1-e1e1-4000-8000-0000000000e1')$q$), 'REQ anon has no direct listings write');
reset role;
select public.dl_as('e2e2e2e2-e2e2-4000-8000-0000000000e2');
set role authenticated;
select public.idv_assert(public.dl_denied($q$select app_security.enforce_verified_actor('e2e2e2e2-e2e2-4000-8000-0000000000e2', true)$q$), 'REQ authenticated cannot call gate helper');
select public.idv_assert(public.dl_denied($q$update public.user_identity_verifications set badge_issued = true where user_id = 'e2e2e2e2-e2e2-4000-8000-0000000000e2'$q$), 'REQ authenticated cannot write projection');
select public.idv_assert(public.dl_denied($q$update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required'$q$), 'REQ authenticated cannot flip gate switch');
-- Access summary: generic flag stays true but the strict flag the Web guard must use is false.
select public.idv_assert((select a->>'verification_required' = 'true' and a->>'identity_verified' = 'true' and a->>'digilocker_verified' = 'false'
  from (select public.get_my_marketplace_access() a) x), 'REQ access summary: generic true, digilocker false');
reset role;
select public.dl_as(null);

-- ---------- Verification flow stays available while the gate is ON ----------
select public.idv_assert((public.dl_link_v2('e6e6e6e6-e6e6-4000-8000-0000000000e6', repeat('06', 32), repeat('b6', 32)))->>'success' = 'true', 'REQ ON new user can complete signed verification');
select public.dl_as('e6e6e6e6-e6e6-4000-8000-0000000000e6');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values ('e6e6e6e6-e6e6-4000-8000-0000000000e6')$q$), 'REQ ON freshly verified user can post');
set role authenticated;
select public.idv_assert((public.get_my_marketplace_access())->>'digilocker_verified' = 'true', 'REQ ON access summary reflects new badge');
reset role;
select public.dl_as(null);
-- A legacy-linked account upgrades by signing in again with the same DigiLocker identity, then passes.
select public.idv_assert((public.dl_link_v2('e3e3e3e3-e3e3-4000-8000-0000000000e3', repeat('03', 32), repeat('b3', 32)))->>'success' = 'true', 'REQ ON legacy account upgrade via signed OIDC');
select public.dl_as('e3e3e3e3-e3e3-4000-8000-0000000000e3');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values ('e3e3e3e3-e3e3-4000-8000-0000000000e3')$q$), 'REQ ON upgraded account can post');
select public.dl_as(null);
-- Fraud-blocked identity still cannot (re)verify.
select public.idv_assert((public.dl_link_v2('e7e7e7e7-e7e7-4000-8000-0000000000e7', repeat('07', 32), repeat('2', 64)))->>'error' = 'VERIFICATION_UNAVAILABLE', 'REQ ON fraud-blocked identity cannot verify');

-- ---------- Gate OFF again: everything reverts to the pre-gate behaviour ----------
update public.app_system_settings set setting_value = 'false' where setting_key = 'identity_verification_required';
select public.dl_as('e2e2e2e2-e2e2-4000-8000-0000000000e2');
select public.idv_assert(public.dlr_ok($q$insert into public.listings (seller_id) values ('e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ OFF rollback restores unverified posting');
select public.idv_assert(public.dlr_ok($q$insert into public.messages (conversation_id, sender_id) values ('c1000000-0000-4000-8000-000000000001', 'e2e2e2e2-e2e2-4000-8000-0000000000e2')$q$), 'REQ OFF rollback restores unverified messaging');
select public.dl_as(null);
update public.user_accounts set account_status = 'suspended' where user_id = 'a0a0a0a0-a0a0-4000-8000-0000000000a0';
select public.idv_assert((select setting_value from public.app_system_settings where setting_key = 'identity_verification_required') = 'false',
  'REQ identity gate OFF at end');
