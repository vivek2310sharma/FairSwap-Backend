-- Aadhaar ACR evidence (20261123120000) PG17 assertions. Runs after assertions-digilocker-required.sql, reusing its helpers
-- (public.idv_assert, public.dl_as, public.dl_denied, public.dl_link_v2, public.dlr_gated/dlr_ok, public.dl_badges).
-- Synthetic fingerprints only; no raw id, token, claim or Aadhaar exists in this suite.
select public.dl_as(null);

-- Pre-existing signed-id-only binding (E1 from the required-gate suite) was NOT upgraded and no longer holds the badge.
select public.idv_assert((select evidence_method = 'oidc_v2_signed_id_token' from app_security.idv_digilocker_bindings
  where user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1'), 'ACR old signed-id binding kept as history, not rewritten');
select public.idv_assert(not app_security.has_digilocker_badge('e1e1e1e1-e1e1-4000-8000-0000000000e1'), 'ACR old signed-id binding is not a badge');
select public.idv_assert(not app_security.has_digilocker_badge('e3e3e3e3-e3e3-4000-8000-0000000000e3'), 'ACR legacy binding is not a badge');
select public.idv_assert(public.dl_badges(array['e1e1e1e1-e1e1-4000-8000-0000000000e1']::uuid[]) = '{}'::uuid[], 'ACR public projection hides old binding');
select public.idv_assert((select (b.digilocker_verified) = false from (select app_security.has_digilocker_badge('e1e1e1e1-e1e1-4000-8000-0000000000e1') as digilocker_verified) b),
  'ACR owner summary predicate false for old binding');
select public.idv_assert(
  (select v.badge_issued and v.verification_status = 'verified' from public.user_identity_verifications v where v.user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1'),
  'ACR generic projection untouched (history preserved) yet not authoritative');

-- Constraint: unknown evidence rejected; signed values require evidence_verified_at; legacy forbids it.
select public.idv_assert((public.dlr_err($q$update app_security.idv_digilocker_bindings set evidence_method = 'other'
  where user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1'$q$) like '23514:%'), 'ACR unknown evidence value refused');
select public.idv_assert((public.dlr_err($q$update app_security.idv_digilocker_bindings set evidence_verified_at = null
  where user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1'$q$) like '23514:%'), 'ACR signed evidence needs timestamp');
select public.idv_assert((public.dlr_err($q$update app_security.idv_digilocker_bindings set evidence_method = 'oidc_v2_signed_aadhaar_acr', evidence_verified_at = null
  where user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1'$q$) like '23514:%'), 'ACR new evidence needs timestamp');

-- Completion rejects every label except the Aadhaar-assured one (old Edge fails closed).
create or replace function public.dl_link_acr(p_user uuid, p_state text, p_fp text, p_evidence text default 'oidc_v2_signed_aadhaar_acr')
returns jsonb language sql as $$ select public.dl_link_v2(p_user, p_state, p_fp, p_evidence); $$;
select public.idv_assert((public.dl_link_acr('f1f1f1f1-f1f1-4000-8000-0000000000f1', repeat('11', 32), repeat('c1', 32), 'oidc_v2_signed_id_token'))->>'error' = 'INVALID_IDENTITY_EVIDENCE',
  'ACR complete_v2 rejects previous signed-id label');
select public.idv_assert((public.dl_link_acr('f1f1f1f1-f1f1-4000-8000-0000000000f1', repeat('12', 32), repeat('c1', 32), 'legacy_account_link'))->>'error' = 'INVALID_IDENTITY_EVIDENCE',
  'ACR complete_v2 rejects legacy label');
select public.idv_assert(not exists (select 1 from app_security.idv_digilocker_bindings where id_fingerprint = repeat('c1', 32))
  and not exists (select 1 from public.user_identity_verifications where user_id = 'f1f1f1f1-f1f1-4000-8000-0000000000f1' and badge_issued),
  'ACR rejected labels leave no binding and no badge');

-- Genuine Aadhaar-assured link issues the badge and the gate passes.
select public.idv_assert((public.dl_link_acr('f2f2f2f2-f2f2-4000-8000-0000000000f2', repeat('21', 32), repeat('c2', 32)))->>'success' = 'true', 'ACR assured link succeeds');
select public.idv_assert(app_security.has_digilocker_badge('f2f2f2f2-f2f2-4000-8000-0000000000f2'), 'ACR assured link holds badge');
select public.idv_assert((select evidence_method = 'oidc_v2_signed_aadhaar_acr' and evidence_verified_at is not null and identity_status = 'linked'
  from app_security.idv_digilocker_bindings where user_id = 'f2f2f2f2-f2f2-4000-8000-0000000000f2'), 'ACR binding stores only the method label');
select public.idv_assert(public.dl_badges(array['f2f2f2f2-f2f2-4000-8000-0000000000f2','e1e1e1e1-e1e1-4000-8000-0000000000e1']::uuid[])
  = array['f2f2f2f2-f2f2-4000-8000-0000000000f2']::uuid[], 'ACR public projection lists only assured users');
select public.idv_assert((select count(*) = 0 from information_schema.columns where table_schema = 'app_security'
  and table_name = 'idv_digilocker_bindings' and column_name ~* 'acr|aadhaar|name|dob|claim|token'), 'ACR no claim/PII columns on bindings');

-- Genuine re-verification of the SAME identity by the old-binding user upgrades it in place (same fingerprint chain).
select public.idv_assert(
  (select (app_security.impl_idv_dl_start_attempt('e1e1e1e1-e1e1-4000-8000-0000000000e1', repeat('31', 32), 600, 'p', true, 'dl-v1.0'))->>'success' = 'true'),
  'ACR old-binding user may start re-verification (not already verified)');
do $$
declare a uuid; r jsonb;
begin
  select id into a from app_security.idv_digilocker_attempts where user_id = 'e1e1e1e1-e1e1-4000-8000-0000000000e1' and state_hash = repeat('31', 32);
  perform app_security.impl_idv_dl_consume_state('e1e1e1e1-e1e1-4000-8000-0000000000e1', repeat('31', 32));
  r := app_security.impl_idv_dl_complete_v2(a, 'e1e1e1e1-e1e1-4000-8000-0000000000e1', repeat('b1', 32), 'v1', '{}'::text[], 'oidc_v2_signed_aadhaar_acr');
  perform public.idv_assert(r->>'success' = 'true', 'ACR re-verification of same identity succeeds');
end $$;
select public.idv_assert(app_security.has_digilocker_badge('e1e1e1e1-e1e1-4000-8000-0000000000e1'), 'ACR re-verified user now holds badge');

-- Duplicate identity on another account is still refused; fraud-blocked identity still refused.
select public.idv_assert((public.dl_link_acr('f3f3f3f3-f3f3-4000-8000-0000000000f3', repeat('41', 32), repeat('c2', 32)))->>'error' = 'IDENTITY_ALREADY_LINKED',
  'ACR duplicate identity still rejected');
select public.idv_assert(not app_security.has_digilocker_badge('f3f3f3f3-f3f3-4000-8000-0000000000f3'), 'ACR duplicate account gets no badge');
select public.idv_assert((public.dl_link_acr('f4f4f4f4-f4f4-4000-8000-0000000000f4', repeat('51', 32), repeat('22', 32)))->>'error' = 'VERIFICATION_UNAVAILABLE',
  'ACR fraud-blocked identity still refused');

-- The gate helper is asserted (required suite) to call has_digilocker_badge, so the assertions above are the gate verdicts.
select public.idv_assert((select setting_value from public.app_system_settings where setting_key = 'identity_verification_required') = 'false', 'ACR migration leaves identity gate OFF');

-- Privileges of replaced functions.
do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    perform public.idv_assert(not has_function_privilege(role_name, 'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute'), 'ACR impl complete_v2 not callable by ' || role_name);
    perform public.idv_assert(not has_function_privilege(role_name, 'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute'), 'ACR server complete_v2 not callable by ' || role_name);
    perform public.idv_assert(not has_function_privilege(role_name, 'app_security.has_digilocker_badge(uuid)', 'execute'), 'ACR badge predicate not callable by ' || role_name);
  end loop;
end $$;
select public.idv_assert(has_function_privilege('service_role', 'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute')
  and has_function_privilege('service_role', 'app_security.has_digilocker_badge(uuid)', 'execute'), 'ACR service_role EXECUTE preserved');
select public.idv_assert(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where a.grantee = 0 and p.oid in (
  'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure,
  'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure, 'app_security.has_digilocker_badge(uuid)'::regprocedure)),
  'ACR no PUBLIC EXECUTE on replaced functions');
select public.idv_assert((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']::text[]) from pg_proc p where p.oid in (
  'app_security.has_digilocker_badge(uuid)'::regprocedure, 'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure,
  'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure)), 'ACR replaced functions SECURITY DEFINER, empty search_path');
