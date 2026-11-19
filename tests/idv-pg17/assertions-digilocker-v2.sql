-- DigiLocker OIDC v2 badge provenance (20261119200000) PG17 assertions.
-- Runs after assertions-digilocker.sql, so legacy (unsigned) V1 bindings already exist (user a0a0... linked to '1'x64;
-- fingerprint '2'x64 fraud-blocked and orphaned). No raw id, token or claim exists anywhere in this suite: only synthetic fingerprints.
select public.dl_as(null);

-- Links an account through the real start/consume/complete_v2 path.
create or replace function public.dl_link_v2(p_user uuid, p_state text, p_fp text, p_evidence text default 'oidc_v2_signed_id_token')
returns jsonb language plpgsql as $$
declare r jsonb; a uuid;
begin
  insert into auth.users (id, email) values (p_user, p_user::text || '@fairswap.test') on conflict do nothing;
  insert into public.user_accounts (user_id, account_status) values (p_user, 'active') on conflict do nothing;
  r := app_security.impl_idv_dl_start_attempt(p_user, p_state, 600, 'p', true, 'dl-v1.0');
  if not coalesce((r->>'success')::boolean, false) or r ? 'already_verified' then return r; end if;
  a := (r->>'attempt_id')::uuid;
  perform app_security.impl_idv_dl_consume_state(p_user, p_state);
  return app_security.impl_idv_dl_complete_v2(a, p_user, p_fp, 'v1', '{}'::text[], p_evidence);
end; $$;

create or replace function public.dl_badges(p_ids uuid[]) returns uuid[] language sql as $$
  select coalesce(array_agg(x order by x), '{}'::uuid[]) from public.get_digilocker_badges(p_ids) x;
$$;

-- ---------- Structure, provenance column and privileges ----------
select public.idv_assert((select count(*) = 0 from app_security.idv_digilocker_bindings where evidence_method <> 'legacy_account_link'),
  'V2 existing bindings labelled legacy');
select public.idv_assert((select setting_value from public.app_system_settings where setting_key = 'identity_verification_required') = 'false',
  'V2 identity gate stays OFF');
select public.idv_assert((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']::text[]) from pg_proc p where p.oid in (
  'app_security.has_digilocker_badge(uuid)'::regprocedure, 'app_security.impl_idv_dl_start_attempt(uuid,text,integer,text,boolean,text)'::regprocedure,
  'app_security.impl_idv_dl_complete(uuid,uuid,text,text,text[])'::regprocedure,
  'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure,
  'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure,
  'public.get_digilocker_badges(uuid[])'::regprocedure, 'public.get_my_marketplace_access()'::regprocedure)),
  'V2 every new/replaced function is SECURITY DEFINER with empty search_path');
do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    perform public.idv_assert(not has_function_privilege(role_name, 'app_security.has_digilocker_badge(uuid)', 'execute'), 'V2 badge predicate not callable by ' || role_name);
    perform public.idv_assert(not has_function_privilege(role_name, 'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute'), 'V2 impl complete not callable by ' || role_name);
    perform public.idv_assert(not has_function_privilege(role_name, 'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute'), 'V2 server complete not callable by ' || role_name);
    perform public.idv_assert(not has_function_privilege(role_name, 'public.server_idv_dl_complete(uuid,uuid,text,text,text[])', 'execute'), 'V2 legacy complete still not callable by ' || role_name);
    perform public.idv_assert(has_function_privilege(role_name, 'public.get_digilocker_badges(uuid[])', 'execute'), 'V2 badge projection callable by ' || role_name);
    perform public.idv_assert(not has_table_privilege(role_name, 'app_security.idv_digilocker_bindings', 'select'), 'V2 bindings not readable by ' || role_name);
    perform public.idv_assert(not has_column_privilege(role_name, 'app_security.idv_digilocker_bindings', 'id_fingerprint', 'select'), 'V2 fingerprints not readable by ' || role_name);
    perform public.idv_assert(not has_column_privilege(role_name, 'app_security.idv_digilocker_bindings', 'evidence_method', 'select'), 'V2 provenance not readable by ' || role_name);
  end loop;
end $$;
select public.idv_assert(has_function_privilege('service_role', 'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute'), 'V2 server complete callable by service_role');
select public.idv_assert(not has_function_privilege('anon', 'public.get_my_marketplace_access()', 'execute'), 'V2 access summary not anon');
select public.idv_assert(has_function_privilege('authenticated', 'public.get_my_marketplace_access()', 'execute'), 'V2 access summary authenticated');
select public.idv_assert(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
  where p.oid in ('app_security.has_digilocker_badge(uuid)'::regprocedure, 'public.get_digilocker_badges(uuid[])'::regprocedure,
                  'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure,
                  'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure)
    and a.grantee = 0), 'V2 no PUBLIC EXECUTE on new functions');
select public.idv_assert(not has_table_privilege('service_role', 'app_security.idv_digilocker_bindings', 'update'), 'V2 bindings: still no direct DML for service_role');

-- ---------- Legacy unsigned linking can no longer bind or badge ----------
select public.idv_assert(app_security.is_identity_verified('a0a0a0a0-a0a0-4000-8000-0000000000a0'), 'V2 legacy user keeps generic projection');
select public.idv_assert(not app_security.has_digilocker_badge('a0a0a0a0-a0a0-4000-8000-0000000000a0'), 'V2 legacy link projects no DigiLocker badge');
select public.idv_assert(public.dl_badges(array['a0a0a0a0-a0a0-4000-8000-0000000000a0']::uuid[]) = '{}'::uuid[], 'V2 legacy link hidden from public projection');
select public.idv_assert((public.dl_link('d3d3d3d3-d3d3-4000-8000-0000000000d3', repeat('3d', 32), repeat('f', 64)))->>'error' = 'LEGACY_LINK_DISABLED',
  'V2 legacy complete refused');
select public.idv_assert(not exists (select 1 from app_security.idv_digilocker_bindings where id_fingerprint = repeat('f', 64)), 'V2 legacy complete created no binding');
select public.idv_assert((select status = 'failed' and failure_code = 'LEGACY_LINK_DISABLED' from app_security.idv_digilocker_attempts where state_hash = repeat('3d', 32)),
  'V2 legacy attempt recorded as failed');
select public.idv_assert(not app_security.is_identity_verified('d3d3d3d3-d3d3-4000-8000-0000000000d3'), 'V2 legacy complete issued nothing');

-- ---------- Successful signed verification ----------
select public.idv_assert((public.dl_link_v2('d1d1d1d1-d1d1-4000-8000-0000000000d1', repeat('1d', 32), repeat('e', 64), 'legacy_account_link'))->>'error' = 'INVALID_IDENTITY_EVIDENCE',
  'V2 non-OIDC evidence label rejected');
select public.idv_assert((public.dl_link_v2('d1d1d1d1-d1d1-4000-8000-0000000000d1', repeat('1e', 32), repeat('e', 64)))->>'success' = 'true', 'V2 signed link succeeds');
select public.idv_assert((select evidence_method = 'oidc_v2_signed_id_token' and evidence_verified_at is not null and identity_status = 'linked'
  from app_security.idv_digilocker_bindings where user_id = 'd1d1d1d1-d1d1-4000-8000-0000000000d1'), 'V2 binding stores signed provenance');
select public.idv_assert(app_security.has_digilocker_badge('d1d1d1d1-d1d1-4000-8000-0000000000d1'), 'V2 badge issued');
select public.idv_assert((select valid_until is null and badge_issued and verification_status = 'verified' from public.user_identity_verifications
  where user_id = 'd1d1d1d1-d1d1-4000-8000-0000000000d1'), 'V2 projection verified, no expiry');

-- ---------- Same-account retry ----------
select public.idv_assert((public.dl_link_v2('d1d1d1d1-d1d1-4000-8000-0000000000d1', repeat('1f', 32), repeat('e', 64)))->>'already_verified' = 'true',
  'V2 same-account retry short-circuits');
select public.idv_assert((select count(*) = 0 from app_security.idv_digilocker_attempts where state_hash = repeat('1f', 32)), 'V2 retry creates no attempt');
select public.idv_assert((select count(*) = 1 from app_security.idv_digilocker_bindings where id_fingerprint = repeat('e', 64)), 'V2 retry keeps one binding');

-- ---------- Duplicate identity on another account ----------
do $$
declare r jsonb;
begin
  r := public.dl_link_v2('d2d2d2d2-d2d2-4000-8000-0000000000d2', repeat('2d', 32), repeat('e', 64));
  perform public.idv_assert(r->>'error' = 'IDENTITY_ALREADY_LINKED' and (r->>'recovery')::boolean, 'V2 duplicate identity rejected with recovery');
  perform public.idv_assert(not app_security.has_digilocker_badge('d2d2d2d2-d2d2-4000-8000-0000000000d2'), 'V2 duplicate account gets no badge');
  perform public.idv_assert((select count(*) = 1 from app_security.idv_digilocker_bindings where id_fingerprint = repeat('e', 64)), 'V2 duplicate created no second binding');
  -- Legacy-bound identity cannot be claimed by another account through v2 either.
  r := public.dl_link_v2('d5d5d5d5-d5d5-4000-8000-0000000000d5', repeat('5d', 32), repeat('1', 64));
  perform public.idv_assert(r->>'error' = 'IDENTITY_ALREADY_LINKED', 'V2 legacy-bound identity not claimable by another account');
  -- A second identity cannot be attached to an account already bound to one.
  r := public.dl_link_v2('a0a0a0a0-a0a0-4000-8000-0000000000a0', repeat('4d', 32), repeat('9', 64));
  perform public.idv_assert(r->>'error' = 'ACCOUNT_LINKED_TO_OTHER_IDENTITY', 'V2 account bound to another identity rejected');
end $$;

-- ---------- Legacy account upgraded by signed verification of the same identity ----------
select public.idv_assert((public.dl_link_v2('a0a0a0a0-a0a0-4000-8000-0000000000a0', repeat('4e', 32), repeat('1', 64)))->>'success' = 'true',
  'V2 legacy link upgraded with same identity');
select public.idv_assert((select evidence_method = 'oidc_v2_signed_id_token' from app_security.idv_digilocker_bindings
  where user_id = 'a0a0a0a0-a0a0-4000-8000-0000000000a0'), 'V2 upgraded binding provenance');
select public.idv_assert(app_security.has_digilocker_badge('a0a0a0a0-a0a0-4000-8000-0000000000a0'), 'V2 upgraded account holds badge');

-- ---------- Fraud-blocked identity ----------
select public.idv_assert((public.dl_link_v2('d4d4d4d4-d4d4-4000-8000-0000000000d4', repeat('6d', 32), repeat('2', 64)))->>'error' = 'VERIFICATION_UNAVAILABLE',
  'V2 fraud-blocked identity cannot verify');
select public.idv_assert(not app_security.has_digilocker_badge('d4d4d4d4-d4d4-4000-8000-0000000000d4'), 'V2 fraud-blocked identity no badge');

-- ---------- Public projection ----------
select public.idv_assert(public.dl_badges(array['d1d1d1d1-d1d1-4000-8000-0000000000d1', 'd2d2d2d2-d2d2-4000-8000-0000000000d2',
  'a0a0a0a0-a0a0-4000-8000-0000000000a0', 'd1d1d1d1-d1d1-4000-8000-0000000000d1', null]::uuid[])
  = array['a0a0a0a0-a0a0-4000-8000-0000000000a0', 'd1d1d1d1-d1d1-4000-8000-0000000000d1']::uuid[], 'V2 projection returns only badge holders, deduplicated');
select public.idv_assert(public.dl_badges(null) = '{}'::uuid[] and public.dl_badges('{}'::uuid[]) = '{}'::uuid[], 'V2 projection empty input');
do $$
begin
  perform public.get_digilocker_badges((select array_agg(gen_random_uuid()) from generate_series(1, 101)));
  raise exception 'V2 projection accepted more than 100 ids';
exception when sqlstate '22023' then null;
end $$;
-- Real role switch: anonymous and authenticated callers see the projection but nothing else.
set role anon;
select public.idv_assert((select count(*) = 1 from public.get_digilocker_badges(array['d1d1d1d1-d1d1-4000-8000-0000000000d1']::uuid[])), 'V2 anon reads projection');
select public.idv_assert(public.dl_denied($q$select app_security.has_digilocker_badge('d1d1d1d1-d1d1-4000-8000-0000000000d1')$q$), 'V2 anon cannot call predicate');
select public.idv_assert(public.dl_denied($q$select count(*) from app_security.idv_digilocker_bindings$q$), 'V2 anon cannot read bindings');
select public.idv_assert(public.dl_denied($q$select public.server_idv_dl_complete_v2(gen_random_uuid(), gen_random_uuid(), repeat('e', 64), 'v1', '{}', 'oidc_v2_signed_id_token')$q$), 'V2 anon cannot complete');
select public.idv_assert(public.dl_denied($q$select public.get_my_marketplace_access()$q$), 'V2 anon cannot read access summary');
reset role;
select public.dl_as('d1d1d1d1-d1d1-4000-8000-0000000000d1');
set role authenticated;
select public.idv_assert((select count(*) = 1 from public.get_digilocker_badges(array['d1d1d1d1-d1d1-4000-8000-0000000000d1']::uuid[])), 'V2 authenticated reads projection');
select public.idv_assert((public.get_my_marketplace_access())->>'digilocker_verified' = 'true', 'V2 owner sees digilocker_verified');
select public.idv_assert(public.dl_denied($q$select count(*) from app_security.idv_digilocker_bindings$q$), 'V2 authenticated cannot read bindings');
select public.idv_assert(public.dl_denied($q$select public.server_idv_dl_complete_v2(gen_random_uuid(), gen_random_uuid(), repeat('e', 64), 'v1', '{}', 'oidc_v2_signed_id_token')$q$), 'V2 authenticated cannot complete');
select public.idv_assert(public.dl_denied($q$update public.user_identity_verifications set badge_issued = true where user_id = 'd2d2d2d2-d2d2-4000-8000-0000000000d2'$q$), 'V2 authenticated cannot spoof projection');
reset role;
select public.dl_as('d2d2d2d2-d2d2-4000-8000-0000000000d2');
set role authenticated;
select public.idv_assert((public.get_my_marketplace_access())->>'digilocker_verified' = 'false', 'V2 unverified owner sees false');
reset role;
select public.dl_as(null);

-- ---------- Inactive account hides the badge ----------
update public.user_accounts set account_status = 'suspended' where user_id = 'd1d1d1d1-d1d1-4000-8000-0000000000d1';
select public.idv_assert(public.dl_badges(array['d1d1d1d1-d1d1-4000-8000-0000000000d1']::uuid[]) = '{}'::uuid[], 'V2 suspended account hidden');
update public.user_accounts set account_status = 'active' where user_id = 'd1d1d1d1-d1d1-4000-8000-0000000000d1';

-- ---------- Revoked identity is not re-issued ----------
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.admin_revoke_verification('d1d1d1d1-d1d1-4000-8000-0000000000d1', 'Revoked after confirmed impersonation report');
select public.dl_as(null);
select public.idv_assert(not app_security.has_digilocker_badge('d1d1d1d1-d1d1-4000-8000-0000000000d1'), 'V2 admin revocation removes badge');
select public.idv_assert((public.dl_link_v2('d1d1d1d1-d1d1-4000-8000-0000000000d1', repeat('7d', 32), repeat('e', 64)))->>'error' = 'VERIFICATION_UNAVAILABLE',
  'V2 admin-revoked account cannot self-relink');
select public.idv_assert(public.dl_badges(array['d1d1d1d1-d1d1-4000-8000-0000000000d1']::uuid[]) = '{}'::uuid[], 'V2 revoked account stays hidden');

-- ---------- Fraud block after signed verification ----------
select public.dl_as('99999999-9999-4000-8000-000000000099', 'aal2');
select public.idv_assert((public.admin_digilocker_fraud_block('a0a0a0a0-a0a0-4000-8000-0000000000a0', 'Confirmed fake courier payment-link fraud'))->>'success' = 'true',
  'V2 fraud block of signed account');
select public.dl_as(null);
select public.idv_assert(not app_security.has_digilocker_badge('a0a0a0a0-a0a0-4000-8000-0000000000a0'), 'V2 fraud block removes badge');
select public.idv_assert(public.dl_badges(array['a0a0a0a0-a0a0-4000-8000-0000000000a0']::uuid[]) = '{}'::uuid[], 'V2 fraud-blocked hidden from projection');

select public.idv_assert((select setting_value from public.app_system_settings where setting_key = 'identity_verification_required') = 'false',
  'V2 identity gate still OFF at end');
