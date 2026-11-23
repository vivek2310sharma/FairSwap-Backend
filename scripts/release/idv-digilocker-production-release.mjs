// Protected, read-only DigiLocker parity postflight. Uses the existing Supabase CLI runner.
export const IDV_PROD_CANDIDATE = 'idv-digilocker-prod-parity';
export const IDV_PROD_SCOPE = 'digilocker-production-parity-signed-id-gate-on';
const REQUIRED_KEYS = ['gate_on', 'seller_gate_on','strict_enforce','badge_provenance','completion_provenance',
 'evidence_constraint','service_completion_only','service_gate_only','private_tables_rls'];
export function readIdvProdState(exec) {
  const sql = `BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'gate_on', app_security.identity_gate_enabled(),
  'seller_gate_on', app_security.v3_seller_identity_enforced(),
  'strict_enforce', position('app_security.has_digilocker_badge(p_actor)' in pg_get_functiondef('app_security.enforce_verified_actor(uuid,boolean)'::regprocedure)) > 0
      AND position('app_security.is_identity_verified(p_actor)' in pg_get_functiondef('app_security.enforce_verified_actor(uuid,boolean)'::regprocedure)) = 0,
  'badge_provenance', position('oidc_v2_signed_id_requested_aadhaar' in pg_get_functiondef('app_security.has_digilocker_badge(uuid)'::regprocedure)) > 0
      AND position('v.revoked_at IS NULL' in pg_get_functiondef('app_security.has_digilocker_badge(uuid)'::regprocedure)) > 0
      AND position('v.badge_issued = true' in pg_get_functiondef('app_security.has_digilocker_badge(uuid)'::regprocedure)) > 0,
  'completion_provenance', position('p_evidence_method IS DISTINCT FROM ''oidc_v2_signed_id_requested_aadhaar''' in
       pg_get_functiondef('app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure)) > 0
       AND position('IDENTITY_ALREADY_LINKED' in pg_get_functiondef('app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure)) > 0
       AND position('ACCOUNT_LINKED_TO_OTHER_IDENTITY' in pg_get_functiondef('app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'::regprocedure)) > 0,
  'evidence_constraint', EXISTS(
    SELECT 1 FROM pg_constraint WHERE conrelid='app_security.idv_digilocker_bindings'::regclass
      AND conname='chk_idv_dl_evidence_method'
      AND position('oidc_v2_signed_id_requested_aadhaar' in pg_get_constraintdef(oid)) > 0
  ),
  'service_completion_only',
    has_function_privilege('service_role','app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)','EXECUTE')
    AND NOT has_function_privilege('authenticated','app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)','EXECUTE')
    AND NOT has_function_privilege('anon','app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)','EXECUTE'),
  'service_gate_only',
    has_function_privilege('service_role','app_security.enforce_verified_actor(uuid,boolean)','EXECUTE')
    AND NOT has_function_privilege('authenticated','app_security.enforce_verified_actor(uuid,boolean)','EXECUTE')
    AND NOT has_function_privilege('anon','app_security.enforce_verified_actor(uuid,boolean)','EXECUTE'),
  'private_tables_rls', (
      SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
      FROM pg_class c
      WHERE c.oid = ANY (ARRAY['app_security.idv_digilocker_attempts'::regclass,
                            'app_security.idv_digilocker_bindings'::regclass])
  )
)::text;
COMMIT;`;
  const raw=exec(sql);
  let v;
  try {v=JSON.parse(raw.trim());}catch {throw new Error('IDV_PROD_PARITY_INVALID_SNAPSHOT');}
  if(!v || typeof v!=='object' || Array.isArray(v) || REQUIRED_KEYS.some(k=>typeof v[k]!=='boolean'))
    throw new Error('IDV_PROD_PARITY_INVALID_STATE');
  return v;
}
export function runIdvProdPreflight(exec, environment) {
  const state=readIdvProdState(exec);
  if (state.gate_on !== (environment === 'FairSwapTest') ||
      state.seller_gate_on !== (environment === 'FairSwapTest'))
    throw new Error('IDV_PROD_PARITY_UNEXPECTED_INITIAL_GATE');
  if (environment === 'FairSwapProd' && (state.strict_enforce || state.badge_provenance || state.completion_provenance || state.evidence_constraint))
    throw new Error('IDV_PROD_PARITY_PRODUCTION_ALREADY_EVOLVED');
  if (environment === 'FairSwapTest' && (!state.strict_enforce || !state.badge_provenance || !state.completion_provenance || !state.evidence_constraint))
    throw new Error('IDV_PROD_PARITY_TEST_NOT_READY');
  if (!state.private_tables_rls || !state.service_completion_only || !state.service_gate_only)
    throw new Error('IDV_PROD_PARITY_PRIVILEGE_DRIFT');
  return state;
}
export function runIdvProdPostflight(exec) {
  const state=readIdvProdState(exec);
  if (REQUIRED_KEYS.some(k=>state[k]!==true)) throw new Error('IDV_PROD_PARITY_POSTFLIGHT_FAILED');
  return {status:'PASS',scope:IDV_PROD_SCOPE};
}
export function verifyIdvProdTestReceipt(r,e) {
  const expected={environment:'FairSwapTest',projectRef:'wpppxlnbzqynvhpeuavd',
    candidateId:IDV_PROD_CANDIDATE,migrationVersion:'20261123180000',
    migrationFile:'20261123180000_idv_digilocker_production_parity.sql',
    migrationSha256:'9bdb4ef6ea71aee98b5009e4405f9566e60ef52fa3cb259dc0f152fb2bb7d941',
    postflightScope:IDV_PROD_SCOPE,reviewedCommit:e.GITHUB_SHA,releaseWorkflowRun:e.GITHUB_RUN_ID};
  for(const [k,v] of Object.entries(expected))if(r?.[k]!==v)throw new Error('IDV_PROD_PARITY_RECEIPT_INVALID_'+k);
  if(r.postflightVerified!==true || r.status!=='APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED'
    ||!Array.isArray(r.dryRunPending)||r.dryRunPending.length!==1||r.dryRunPending[0]!==expected.migrationFile
    ||!/^[0-9a-f]{64}$/.test(r.ledgerStatementsSha256??''))throw new Error('IDV_PROD_PARITY_TEST_UNVERIFIED');
  return r.ledgerStatementsSha256;
}
