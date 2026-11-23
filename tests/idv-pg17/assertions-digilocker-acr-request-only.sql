-- Owner-authorized request-only ACR verification: signed DigiLocker identity is still required by Edge.
-- SQL cannot attest the provider's enforcement of the acr=aadhaar authorization request.
-- Synthetic fingerprints only; no Aadhaar numbers, tokens, names or claims.
select public.dl_as(null);

-- Historical strong signed-ACR bindings remain valid. Legacy signed-ID-only never qualifies automatically.
select public.idv_assert(app_security.has_digilocker_badge('f2f2f2f2-f2f2-4000-8000-0000000000f2'),
  'Request-only migration preserves historical signed-ACR badge');
select public.idv_assert(app_security.has_digilocker_badge('e1e1e1e1-e1e1-4000-8000-0000000000e1'),
  'Request-only migration preserves prior signed-ACR re-verification');
select public.idv_assert(not app_security.has_digilocker_badge('e3e3e3e3-e3e3-4000-8000-0000000000e3'),
  'Legacy binding remains ineligible');

select public.idv_assert(
  position('oidc_v2_signed_id_requested_aadhaar' in
    (select pg_get_constraintdef(oid) from pg_constraint
     where conrelid='app_security.idv_digilocker_bindings'::regclass and conname='chk_idv_dl_evidence_method')) > 0,
  'Evidence constraint recognizes new request-only provenance');

select public.idv_assert(
  (public.dl_link_v2('f4f4f4f4-f4f4-4000-8000-0000000000f4', repeat('71',32),repeat('c4',32),
    'oidc_v2_signed_aadhaar_acr'))->>'error' = 'INVALID_IDENTITY_EVIDENCE',
  'Old Edge function cannot issue new signed-ACR-labelled badges');
select public.idv_assert(
  (public.dl_link_v2('f4f4f4f4-f4f4-4000-8000-0000000000f4', repeat('72',32),repeat('c4',32),
    'oidc_v2_signed_id_token'))->>'error' = 'INVALID_IDENTITY_EVIDENCE',
  'Old signed-ID-only evidence remains rejected');

-- New provenance is accepted through the service-role-only atomic binder.
select public.idv_assert(
  (public.dl_link_v2('f1f1f1f1-f1f1-4000-8000-0000000000f1', repeat('73',32), repeat('c5',32),
    'oidc_v2_signed_id_requested_aadhaar'))->>'success' = 'true',
  'Signed DigiLocker ID with requested ACR may be bound');
select public.idv_assert(
  (select evidence_method='oidc_v2_signed_id_requested_aadhaar' and evidence_verified_at is not null
   from app_security.idv_digilocker_bindings where user_id='f1f1f1f1-f1f1-4000-8000-0000000000f1'),
  'New evidence is correctly labelled, timestamped');
select public.idv_assert(app_security.has_digilocker_badge('f1f1f1f1-f1f1-4000-8000-0000000000f1'),
  'New request-ACR binding satisfies badge predicate');
select public.idv_assert(
  (public.dl_link_v2('f3f3f3f3-f3f3-4000-8000-0000000000f3', repeat('74',32),repeat('c5',32),
    'oidc_v2_signed_id_requested_aadhaar'))->>'error' = 'IDENTITY_ALREADY_LINKED',
  'Duplicate identity still blocked');
select public.idv_assert(not app_security.has_digilocker_badge('f3f3f3f3-f3f3-4000-8000-0000000000f3'),
  'Duplicate account has no badge');

select public.idv_assert(
  public.dlr_err($q$update app_security.idv_digilocker_bindings
     set evidence_method = 'oidc_v2_signed_id_requested_aadhaar', evidence_verified_at = null
     where user_id='f1f1f1f1-f1f1-4000-8000-0000000000f1'$q$) like '23514:%',
  'Request-ACR evidence requires timestamp');
select public.idv_assert(
  (select setting_value from public.app_system_settings
   where setting_key='identity_verification_required')='false',
  'Migration never changes mandatory verification setting');
select public.idv_assert(not has_function_privilege('anon',
  'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute')
  and not has_function_privilege('authenticated',
  'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)', 'execute'),
  'Only service-role may invoke the binder');
