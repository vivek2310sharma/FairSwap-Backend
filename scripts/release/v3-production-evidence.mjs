import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PROJECT_REFS, V3_PRODUCTION_SEQUENCE, verifyCandidateSha} from './reusable-candidates.mjs';

const directory = 'supabase/forward-migrations/unified-publishing-v3';
const runs = Object.freeze([
  ['44549355860', '3981313bbffd31588b8f99a786e196600fbac9df'],
  ['44550690764', '3981313bbffd31588b8f99a786e196600fbac9df'],
  ['44554475736', '3981313bbffd31588b8f99a786e196600fbac9df'],
  ...Array.from({length: 4}, () => ['44567714896', 'c4b9c8f0820c3fe172d8024c4ec24929fa87ea38']),
]);

export function verifyV3ProductionEvidence(root, expectedDigest) {
  const candidates = V3_PRODUCTION_SEQUENCE.map(id => verifyCandidateSha(id, root).candidate);
  const manifest = readFileSync(resolve(root, directory, 'MIGRATIONS.sha256'));
  const digest = createHash('sha256').update(manifest).digest('hex');
  if (digest !== expectedDigest || manifest.toString() !== candidates.map(c => `${c.sha256}  ${c.filename}\n`).join('')) {
    throw new Error('V3_PRODUCTION_MANIFEST_MISMATCH');
  }
  const receiptBytes = readFileSync(resolve(root, directory, 'TEST_RECEIPTS.json'));
  if (createHash('sha256').update(receiptBytes).digest('hex') !== '7b2984187ee332fdac69e1bb52031fd20754781b67a8a9fb511c1448b72f4007') {
    throw new Error('V3_TEST_RECEIPT_PIN_MISMATCH');
  }
  const receipts = JSON.parse(receiptBytes);
  if (!Array.isArray(receipts) || receipts.length !== runs.length) throw new Error('V3_TEST_RECEIPT_COUNT');
  return new Map(candidates.slice(1).map((c, index) => {
    const r = receipts[index];
    const [run, commit] = runs[index];
    if (r.environment !== 'FairSwapTest' || r.projectRef !== PROJECT_REFS.FairSwapTest ||
        r.releaseWorkflowRun !== run || r.reviewedCommit !== commit ||
        r.candidateId !== c.id || r.migrationVersion !== c.version || r.migrationFile !== c.filename ||
        r.migrationSha256 !== c.sha256 || r.status !== 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' ||
        r.postflightVerified !== true || JSON.stringify(r.dryRunPending) !== JSON.stringify([c.filename]) ||
        !/^[a-f0-9]{64}$/.test(r.ledgerStatementsSha256 ?? '')) {
      throw new Error(`V3_TEST_RECEIPT_MISMATCH_${c.id}`);
    }
    return [c.id, r.ledgerStatementsSha256];
  }));
}

export function v3ProductionState(exec, {beforePrerequisite = false, beforeProperty = false} = {}) {
  const identity = beforePrerequisite ? `
    to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') is null
    and not exists (select 1 from pg_trigger where tgname='trg_identity_gate' and not tgisinternal)
    and not exists (select 1 from public.app_system_settings
      where setting_key='identity_verification_required' and setting_value is distinct from 'false')
    and to_regclass('app_security.ordinary_goods_contracts_v3') is null` : `
    (select setting_value from public.app_system_settings where setting_key='identity_verification_required')='false'
    and to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') is not null
    and (select count(*) from pg_trigger t
      join (values
        ('public.listings'::regclass, 'app_security.trg_identity_gate_listings()'::regprocedure, 23),
        ('public.listing_media'::regclass, 'app_security.trg_identity_gate_by_listing()'::regprocedure, 7),
        ('public.posting_upload_sessions'::regclass, 'app_security.trg_identity_gate_posting_session()'::regprocedure, 7),
        ('public.posting_staged_media'::regclass, 'app_security.trg_identity_gate_staged_media()'::regprocedure, 23)
      ) expected(rel,fn,type) on t.tgrelid=expected.rel and t.tgfoid=expected.fn and t.tgtype=expected.type
      where t.tgname='trg_identity_gate' and not t.tgisinternal and t.tgenabled='O')=4`;
  // The immutable property migration performs one targeted substitution in the installed
  // seller function. Confirm its exact anchor on Production before the first write.
  const itemTerms = `IF v_listing.condition IS NULL THEN
    RAISE EXCEPTION 'condition is required';
  END IF;

  IF v_listing.price_type IS NULL THEN
    RAISE EXCEPTION 'price type is required';
  END IF;

  IF v_listing.price_type != 'free' AND (v_listing.price_paise IS NULL OR v_listing.price_paise <= 0) THEN
    RAISE EXCEPTION 'price in paise is required for non-free listings';
  END IF;`;
  const result = JSON.parse(exec(`
    begin read only;
    set local statement_timeout='15s';
    with lifecycle as (
      select replace(pg_get_functiondef('app_security.impl_seller_submit_listing(uuid)'::regprocedure),
        E'\\r\\n', E'\\n') as body
    )
    select jsonb_build_object(
      'identity', (${identity}),
      'lifecycle', ${beforeProperty ? `length(body)-length(replace(body,$item$${itemTerms}$item$,''))=length($item$${itemTerms}$item$)` : 'true'},
      'categories', md5((select jsonb_agg(to_jsonb(c) order by c.id)::text from public.categories c)),
      'policies', md5((select jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname)::text
        from pg_policies p where p.schemaname in ('public','storage')))
    )::text from lifecycle;
    commit;
  `).trim());
  if (result.identity !== true || result.lifecycle !== true || !result.categories || !result.policies) {
    throw new Error('V3_PRODUCTION_IDENTITY_OR_LIFECYCLE_MISMATCH');
  }
  return {categories: result.categories, policies: result.policies};
}
