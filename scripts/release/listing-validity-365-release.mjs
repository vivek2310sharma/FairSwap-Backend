// Read-only release verification. Listing IDs/fingerprints stay in process memory;
// neither snapshots nor raw SQL output may be logged, persisted or put in receipts.
import assert from 'node:assert/strict';
import {getCandidate, PROJECT_REFS} from './reusable-candidates.mjs';
export const VALIDITY_SCOPE = 'listing-validity-365-integrity';
const fail = code => {throw new Error(`REUSABLE_RELEASE_LISTING_VALIDITY_${code}`);};
export const snapshotSql = `BEGIN READ ONLY;
SET LOCAL statement_timeout='30s'; SET LOCAL timezone='UTC';
SELECT jsonb_build_object(
 'capturedAt',clock_timestamp(),
 'functions',(SELECT jsonb_object_agg(n.nspname||'.'||p.proname,
   replace(pg_get_functiondef(p.oid),E'\\r\\n',E'\\n'))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE (n.nspname='app_security' AND p.proname IN
   ('impl_moderate_listing','impl_finalize_moderation_result_azure_v1','impl_seller_transition_listing','is_listing_publicly_visible'))
   OR (n.nspname='public' AND p.proname='trg_fn_listing_transition_notification')),
 'security',jsonb_build_object(
   'tables',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_security') AND c.relkind IN ('r','p')),
   'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.schemaname,p.tablename,p.policyname) FROM pg_policies p WHERE p.schemaname IN ('public','app_security')),
   'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proowner,p.proacl::text,p.prosecdef,p.proconfig) ORDER BY p.oid)
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_security'))),
 'rows',coalesce((SELECT jsonb_object_agg(l.id,jsonb_build_object(
   'fingerprint',md5((to_jsonb(l)-'expires_at'-'updated_at')::text),
   'expiry',l.expires_at::text,'desired',(l.published_at+interval '365 days')::text,
   'eligible',coalesce(l.id<>'f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8' AND l.status IN ('active','reserved','paused')
     AND l.published_at IS NOT NULL AND l.sold_at IS NULL AND l.expires_at>clock_timestamp()
     AND l.expires_at<l.published_at+interval '365 days'
     AND app_security.get_account_status(l.seller_id)='active'
     AND app_security.has_current_policy_acceptance(l.seller_id)
     AND EXISTS(SELECT 1 FROM public.categories c WHERE c.id=l.category_id AND c.is_active),false)))
   FROM public.listings l),'{}'::jsonb));
COMMIT;`;
export function readValiditySnapshot(query) {
  let value;
  try {value=JSON.parse(String(query(snapshotSql)).trim());} catch {fail('SNAPSHOT_INVALID');}
  if(!value || !value.functions || !value.security || !value.rows || !Number.isFinite(Date.parse(value.capturedAt))) fail('SNAPSHOT_INVALID');
  const names=['app_security.impl_moderate_listing','app_security.impl_finalize_moderation_result_azure_v1',
    'app_security.impl_seller_transition_listing','app_security.is_listing_publicly_visible','public.trg_fn_listing_transition_notification'];
  if(names.some(n=>typeof value.functions[n]!=='string')) fail('FUNCTIONS_REQUIRED');
  return value;
}
export function expectedValidityFunctions(functions) {
  const output={...functions};
  const patch=(name,oldText,newText)=>{
    if(output[name]?.split(oldText).length!==2) fail('FUNCTION_PATCH_INVALID');
    output[name]=output[name].replace(oldText,newText);
  };
  patch('app_security.impl_moderate_listing',"expires_at = pg_catalog.clock_timestamp() + INTERVAL '30 days'","expires_at = pg_catalog.statement_timestamp() + INTERVAL '365 days'");
  patch('app_security.impl_moderate_listing','published_at = pg_catalog.clock_timestamp(),','published_at = pg_catalog.statement_timestamp(),');
  patch('app_security.impl_finalize_moderation_result_azure_v1',"expires_at = v_now + INTERVAL '30 days'","expires_at = v_now + INTERVAL '365 days'");
  patch('public.trg_fn_listing_transition_notification','has been approved and is now live.',
    'has been approved and is now live. Listing validity is 365 days from publication, unless sold or removed sooner.');
  return output;
}
export function verifyValidityPostflight(before,after) {
  if(!before || !after) fail('BASELINE_REQUIRED');
  try {
    assert.deepEqual(after.functions,expectedValidityFunctions(before.functions));
    assert.deepEqual(after.security,before.security);
    assert.deepEqual(Object.keys(after.rows).sort(),Object.keys(before.rows).sort());
    for(const [id,old] of Object.entries(before.rows)) {
      const row=after.rows[id];
      assert.equal(row.fingerprint,old.fingerprint);
      if(old.eligible && old.expiry!==null) {
        // A row can cross its old expiry while the CLI is preparing its apply.
        // It must then stay unchanged; an expiry still in the future must extend.
        if(Date.parse(old.expiry)<=Date.parse(after.capturedAt)) assert([old.expiry,old.desired].includes(row.expiry));
        else assert.equal(row.expiry,old.desired);
      } else assert.equal(row.expiry,old.expiry);
    }
  } catch {fail('POSTFLIGHT_FAILED');}
  return {status:'PASS',scope:VALIDITY_SCOPE};
}
export function verifyValidityTestReceipt(receipt,context) {
  const c=getCandidate('listing-validity-365');
  if(!/^[a-f0-9]{40}$/.test(context.GITHUB_SHA??'') || !/^[1-9]\d*$/.test(context.GITHUB_RUN_ID??'') ||
    !/^[1-9]\d*$/.test(context.GITHUB_RUN_ATTEMPT??'') ||
    receipt?.environment!=='FairSwapTest' || receipt.projectRef!==PROJECT_REFS.FairSwapTest ||
    receipt.candidateId!==c.id || receipt.migrationVersion!==c.version || receipt.migrationFile!==c.filename ||
    receipt.migrationSha256!==c.sha256 || receipt.reviewedCommit!==context.GITHUB_SHA ||
    receipt.releaseWorkflowRun!==context.GITHUB_RUN_ID || receipt.releaseWorkflowAttempt!==context.GITHUB_RUN_ATTEMPT ||
    receipt.status!=='APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' || receipt.postflightVerified!==true ||
    receipt.postflightScope!==VALIDITY_SCOPE || !Array.isArray(receipt.dryRunPending) ||
    receipt.dryRunPending.length!==1 || receipt.dryRunPending[0]!==c.filename ||
    !/^[a-f0-9]{64}$/.test(receipt.ledgerStatementsSha256??'')) fail('TEST_RECEIPT_INVALID');
  return receipt.ledgerStatementsSha256;
}
