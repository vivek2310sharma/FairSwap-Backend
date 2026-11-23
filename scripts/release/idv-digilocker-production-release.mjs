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

const SHA40 = /^[0-9a-f]{40}$/;
const PROD_REF = 'kriuhwppxgxsyyrbjsau';
const WEB_REPO = 'vivek2310sharma/FairSwap-Web';
async function readGitHub(url, token, fetcher) {
  const response = await fetcher(url,{headers:{Authorization:`Bearer ${token}`,
    Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
  if (!response.ok) throw new Error('IDV_PROD_WEB_EVIDENCE_NOT_AVAILABLE');
  return response.json();
}
export async function verifyIdvProductionWeb(env, fetcher=fetch) {
  const sha=env.WEB_PRODUCTION_SHA;
  const token=env.WEB_EVIDENCE_TOKEN;
  if (!SHA40.test(sha??'') || !token)throw new Error('IDV_PROD_WEB_SOURCE_EVIDENCE_MISSING');
  const main=await readGitHub(`https://api.github.com/repos/${WEB_REPO}/branches/main`,token,fetcher);
  if (main.commit?.sha !== sha)throw new Error('IDV_PROD_WEB_SHA_NOT_MAIN');
  const dep=await readGitHub(`https://api.github.com/repos/${WEB_REPO}/deployments?sha=${sha}&environment=Production&per_page=30`,token,fetcher);
  if (!Array.isArray(dep) || !dep.some(x=>x.sha===sha && x.environment==='Production'))
    throw new Error('IDV_PROD_WEB_DEPLOYMENT_MISSING');
  let ready=false;
  for(const d of dep.filter(x=>x.sha===sha && x.environment==='Production')){
    const states=await readGitHub(`https://api.github.com/repos/${WEB_REPO}/deployments/${d.id}/statuses?per_page=1`,token,fetcher);
    if (Array.isArray(states) && states[0]?.state==='success'){ready=true;break;}
  }
  if (!ready)throw new Error('IDV_PROD_WEB_NOT_READY');
  // Unauthenticated same-origin POST must be 401 when the production DigiLocker feature is ON.
  // 503 means Web flag OFF. A 404/redirect means the verified route was not deployed.
  const response=await fetcher('https://fairswap.in/api/idv/digilocker/start',{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
    headers:{Origin:'https://fairswap.in','Content-Type':'application/json'},
    body:JSON.stringify({consentAcknowledged:true})});
  if (response.status!==401)throw new Error('IDV_PROD_WEB_FEATURE_NOT_LIVE');
  return {status:'PASS',sha};
}
export function verifyIdvProviderSecretNames(rows) {
  if (!Array.isArray(rows) || rows.some(r=>!r || typeof r.name!=='string'))
    throw new Error('IDV_PROD_SECRET_NAMES_INVALID');
  const names=new Set(rows.map(r=>r.name));
  const required=['FAIRSWAP_DIGILOCKER_ENABLED','DIGILOCKER_AUTH_MODE','DIGILOCKER_CLIENT_ID',
    'DIGILOCKER_CLIENT_SECRET','DIGILOCKER_REDIRECT_URI','IDV_DIGILOCKER_STATE_KEY',
    'IDV_DIGILOCKER_FP_KEY_CURRENT','IDV_DIGILOCKER_FP_KEY_V1'];
  if(required.some(k=>!names.has(k)))throw new Error('IDV_PROD_PROVIDER_CONFIG_MISSING');
  return {status:'PASS',projectRef:PROD_REF};
}
export function verifyIdvDeployedFunctions(rows) {
  if(!Array.isArray(rows))throw new Error('IDV_PROD_EDGE_LIST_INVALID');
  for(const slug of ['idv-digilocker-start','idv-digilocker-complete']){
    const fn=rows.find(x=>x.slug===slug);
    if(!fn || fn.status!=='ACTIVE' || fn.verify_jwt!==true)
      throw new Error('IDV_PROD_EDGE_UNVERIFIED_'+slug);
  }
  return {status:'PASS',projectRef:PROD_REF};
}
