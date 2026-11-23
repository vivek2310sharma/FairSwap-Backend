-- Final parity migration is installed on top of the full Test migration chain.
-- The same SQL also supports Production with only the signed OIDC V2 installed.
SELECT public.idv_assert(app_security.identity_gate_enabled(),
  'Final parity migration enables mandatory DigiLocker for Test');
SELECT public.idv_assert(app_security.v3_seller_identity_enforced(),
  'Seller identity prerequisite also enforced');
SELECT public.idv_assert(position('app_security.has_digilocker_badge(p_actor)' in
  pg_get_functiondef('app_security.enforce_verified_actor(uuid,boolean)'::regprocedure)) > 0,
  'All guarded writes require strict DigiLocker badge');
SELECT public.idv_assert(position('oidc_v2_signed_id_requested_aadhaar' in
  pg_get_functiondef('app_security.has_digilocker_badge(uuid)'::regprocedure)) > 0,
  'Requested Aadhaar context with signed identity is accepted');
SELECT public.idv_assert(position('oidc_v2_signed_id_requested_aadhaar' in
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid='app_security.idv_digilocker_bindings'::regclass
     AND conname='chk_idv_dl_evidence_method')) > 0,
  'New evidence constraint persists');
SELECT public.idv_assert(not has_function_privilege('anon',
  'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)','EXECUTE')
  and not has_function_privilege('authenticated',
  'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)','EXECUTE'),
  'No end user can invoke the privileged binding function directly');
