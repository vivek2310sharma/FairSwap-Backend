// Reusable Supabase candidate registry and validation
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

export const MOBILE_CATALOGUE_CANDIDATE = 'mobile-catalogue-india-v1';

export const CANDIDATES = Object.freeze({
  [MOBILE_CATALOGUE_CANDIDATE]: Object.freeze({
    id: MOBILE_CATALOGUE_CANDIDATE,
    version: '20261105213015',
    filename: '20261105213015_posting_v2_mobile_catalogue_india.sql',
    path: 'supabase/forward-migrations/posting-v2/supabase/migrations/20261105213015_posting_v2_mobile_catalogue_india.sql',
    sha256: '4bb663e766876f34136620651308c41293cce1e9411c7247bd87801a7cd9f360',
    description: 'Posting V2 India Mobile Catalogue V1',
    autoPromote: true
  }),
  'moderation-analytics-v1': Object.freeze({
    id: 'moderation-analytics-v1',
    version: '20261102000000',
    filename: '20261102000000_admin_moderation_analytics_v1.sql',
    path: 'supabase/forward-migrations/moderation-analytics-v1/20261102000000_admin_moderation_analytics_v1.sql',
    sha256: '8c046431a4f37369626cafee75dd8eb27bca25db96dab9d70c2125f1a2bc46f8',
    description: 'Admin moderation analytics V1 authoritative RPC',
    autoPromote: true
  }),
  'moderation-azure-v1': Object.freeze({
    id: 'moderation-azure-v1',
    version: '20261104113705',
    filename: '20261104113705_azure_moderation_finalizer.sql',
    path: 'supabase/forward-migrations/moderation-azure-v1/20261104113705_azure_moderation_finalizer.sql',
    sha256: '8a87ad04f7516737d8248eb4cbd4dcf644428300e67d5dd1190b74ec25090fa8',
    description: 'Azure Moderation V1 Authoritative Publication Gate and Receipt Registry',
    autoPromote: true
  }),
  'moderation-switching-v1': Object.freeze({
    id: 'moderation-switching-v1',
    version: '20261104223000',
    filename: '20261104223000_moderation_provider_switching.sql',
    path: 'supabase/forward-migrations/moderation-switching-v1/20261104223000_moderation_provider_switching.sql',
    sha256: '1e75154d50333e94aa80894f0c59a507d0ab3ebad34e99f2e909506d64b94a7d',
    description: 'FairSwap Provider-Switchable Moderation Architecture V1',
    autoPromote: true
  }),
  'accessories-v1-foundation': Object.freeze({
    id: 'accessories-v1-foundation',
    version: '20261102164135',
    filename: '20261102164135_accessories_v1.sql',
    path: 'supabase/forward-migrations/accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql',
    sha256: '790f6e2e06fb049d84903b42fad9bf8efd359a248ac0ecfcdd69f1e897142e9a',
    description: 'Accessories V1 foundation (category installed disabled)',
    strict: true,
    stage: 'foundation',
    autoPromote: false,
    requiredLedgerVersions: Object.freeze([]),
    // Activation must follow, and Tablets (wraps impl_submit_mobile_v2) must come after this foundation.
    incompatibleLedgerVersions: Object.freeze(['20261102164137', '20261102165946'])
  }),
  'accessories-v1-activation': Object.freeze({
    id: 'accessories-v1-activation',
    version: '20261102164137',
    filename: '20261102164137_activate_accessories_v1.sql',
    path: 'supabase/forward-migrations/accessories-v1/activation/supabase/migrations/20261102164137_activate_accessories_v1.sql',
    sha256: '3fe0647b33ad914efca86b5a9aa91590be1d2d42ac20eb42cdc5d38ee3baabcd',
    description: 'Accessories V1 activation (enables typed category)',
    strict: true,
    stage: 'activation',
    autoPromote: false,
    requiredLedgerVersions: Object.freeze(['20261102164135']),
    incompatibleLedgerVersions: Object.freeze(['20261102165946'])
  }),
  'tablets-v1-foundation': Object.freeze({
    id: 'tablets-v1-foundation',
    version: '20261102165946',
    filename: '20261102165946_posting_v2_tablets.sql',
    path: 'supabase/forward-migrations/tablets-v1/supabase/migrations/20261102165946_posting_v2_tablets.sql',
    sha256: 'bf081edd9f89d1244de5a8735b1c1f25f71aa75d6a34df8e1b83115c2ea7860a',
    description: 'Tablets V1 foundation (category installed disabled)',
    strict: true,
    stage: 'foundation',
    autoPromote: false,
    // Accessories activation must also precede Tablets because its existing release gate
    // rejects the Tablet phone wrapper and its migration version sorts before Tablets.
    requiredLedgerVersions: Object.freeze(['20261102164135', '20261102164137']),
    incompatibleLedgerVersions: Object.freeze(['20261102170611'])
  }),
  'tablets-v1-activation': Object.freeze({
    id: 'tablets-v1-activation',
    version: '20261102170611',
    filename: '20261102170611_activate_tablets_v1.sql',
    path: 'supabase/forward-migrations/tablets-v1/activation/supabase/migrations/20261102170611_activate_tablets_v1.sql',
    sha256: '08b4c4e27e2df8782c4879b184d4bb57e7ed28d884cdc15999d36f296ed149b4',
    description: 'Tablets V1 activation',
    strict: true,
    stage: 'activation',
    autoPromote: false,
    requiredLedgerVersions: Object.freeze(['20261102164135', '20261102164137', '20261102165946']),
    incompatibleLedgerVersions: Object.freeze([])
  }),
  'tablets-v2-catalogue': Object.freeze({
    id: 'tablets-v2-catalogue',
    version: '20261104215253',
    filename: '20261104215253_tablets_v2_india_catalogue.sql',
    path: 'supabase/forward-migrations/tablets-v2/supabase/migrations/20261104215253_tablets_v2_india_catalogue.sql',
    sha256: '42bcab058e68e5cb4352a92212f4bbe836cf2ae28626950cf54574c57508ed95',
    description: 'Tablets V2 India catalogue and seller-declared specifications',
    strict: true,
    stage: 'catalogue',
    autoPromote: false,
    requiredLedgerVersions: Object.freeze(['20261102164135', '20261102164137', '20261102165946', '20261102170611']),
    incompatibleLedgerVersions: Object.freeze([])
  }),
  'wearables-v11-catalogue': Object.freeze({
    id: 'wearables-v11-catalogue', version: '20261111195641',
    filename: '20261111195641_wearables_v11_catalogue.sql',
    path: 'supabase/forward-migrations/wearables-v11/supabase/migrations/20261111195641_wearables_v11_catalogue.sql',
    sha256: 'de4a8581988ec53e51c34b28836e24228df49b83dade94ef09d025be19900cf3',
    description: 'Verified India wearables catalogue V1.1; preserves V1 IDs',
    strict: true, stage: 'catalogue', autoPromote: false,
    requiredLedgerVersions: Object.freeze(['20261104120000', '20261104230000']),
    incompatibleLedgerVersions: Object.freeze([])
  }),
  // Wearables V1: separate foundation (installed disabled) and activation. Only the Accessories foundation is a
  // fixed ledger prerequisite; the Mobile Phones history uses environment-specific hosted versions and is reconciled
  // by wearables-v1-release.mjs (MOBILE_PHONES_HISTORY). Tablets is a coexistence target in either order.
  'wearables-v1-foundation': Object.freeze({
    id: 'wearables-v1-foundation',
    version: '20261104120000',
    filename: '20261104120000_posting_v2_wearables.sql',
    path: 'supabase/forward-migrations/wearables-v1/supabase/migrations/20261104120000_posting_v2_wearables.sql',
    sha256: '41122396afe11952126eaf474d272e88e81444863e97d0b2e646ee4cbac48b06',
    description: 'Wearables V1 foundation (category installed disabled)',
    strict: true,
    stage: 'foundation',
    autoPromote: false,
    requiredLedgerVersions: Object.freeze(['20261102164135']),
    incompatibleLedgerVersions: Object.freeze(['20261104230000'])
  }),
  'wearables-v1-activation': Object.freeze({
    id: 'wearables-v1-activation',
    version: '20261104230000',
    filename: '20261104230000_activate_wearables_v1.sql',
    path: 'supabase/forward-migrations/wearables-v1/activation/supabase/migrations/20261104230000_activate_wearables_v1.sql',
    sha256: 'ec102db34e4414a713aed950b756ea617888209515031c5a615306d30e08ac54',
    description: 'Wearables V1 activation (enables typed category)',
    strict: true,
    stage: 'activation',
    autoPromote: false,
    // Provider-switching moderation 20261104223000 (which supersedes Azure 20261104113705) must be installed: activation wraps
    // its finalizer (W-AZ-1) and accepts only its body. Strict order: Azure -> Wearables foundation -> switching -> Wearables
    // activation. The switching row's exact name and hosted statements digest are pinned in wearables-v1-release.mjs.
    requiredLedgerVersions: Object.freeze(['20261102164135', '20261104113705', '20261104120000', '20261104223000']),
    incompatibleLedgerVersions: Object.freeze([])
  })
});

export const PROJECT_REFS = Object.freeze({
  FairSwapTest: 'wpppxlnbzqynvhpeuavd',
  FairSwapProd: 'kriuhwppxgxsyyrbjsau'
});

// Web commits each release family is pinned to (verified GitHub baselines). Tablets reuses the Accessories pins.
export const ACCESSORIES_WEB = Object.freeze({
  stagingSha: '1039873c2fa62845f19627d298cb9f3ba185d819',
  productionBaselineSha: 'd3e183dc204dcefc536494e73cf412a80e9836f0',
  repository: 'vivek2310sharma/FairSwap-Web',
  productionEnvironment: 'Production'
});

// The normal Wearables path requires tested staging ancestry. The one-release waiver pins a selective Web tree.
export const WEARABLES_WEB = Object.freeze({
  stagingSha: 'e37e28df1d387a02bcbea19487dfe0f82d198f74',
  productionBaselineSha: null,
  // Full SHA of the reviewed, deployed Web commit that contains the Wearables E2E runner. It must descend from
  // stagingSha with exactly the reviewed runner, CI and Tablets V2 changes (see WEARABLES_E2E.runnerPaths).
  // The pin alone does not satisfy the independent Test E2E evidence gate.
  e2eRunnerSha: 'c0f2d7fcdb9614a5d762df46b8121ce596267594',
  repository: ACCESSORIES_WEB.repository,
  productionEnvironment: ACCESSORIES_WEB.productionEnvironment
});

// Exact integration package for the owner's one-release exception. It is bound to the two
// registered migration candidates and the selective Web port from the approved staging source.
export const WEARABLES_E2E_WAIVER = Object.freeze({
  input: 'OWNER_APPROVED_WEARABLES_V1_E2E_WAIVER',
  owner: 'vivek2310sharma',
  ownerId: '59019804',
  webStagingSource: 'c0f2d7fcdb9614a5d762df46b8121ce596267594',
  webBaseSha: '9d70e6bcdf7be9d2dc85efe67a6f061dfb7387d8',
  webTreeSha: 'c1b447cc75fd2e4069af2870eaae543701fa68ac'
});

export const WEB_PINS = Object.freeze({
  'accessories-v1': ACCESSORIES_WEB,
  'tablets-v1': ACCESSORIES_WEB,
  // V2 staging SHA is supplied by the dispatch and verified against successful staging CI and deployment.
  'tablets-v2': Object.freeze({...ACCESSORIES_WEB, stagingSha: null}),
  'wearables-v11': Object.freeze({...ACCESSORIES_WEB, stagingSha: null}),
  'wearables-v1': WEARABLES_WEB
});

// Release family of a strict candidate, e.g. 'wearables-v1'.
export function candidateFamily(candidate) {
  return candidate.id.slice(0, -candidate.stage.length - 1);
}

export function webPin(candidate) {
  const pin = WEB_PINS[candidateFamily(candidate)];
  if (!pin) throw new Error(`REUSABLE_RELEASE_NO_WEB_PIN: ${candidate.id}`);
  return pin;
}

// Installations that already exist in a hosted environment but have no release-workflow receipt (they predate the
// pipeline). Adoption is a read-only attestation of the CURRENT, observed state: the ledger rows, their statement counts
// and JSON-statements digests (sha256 of to_jsonb(statements)::text, as read by readTabletsLedger), and the strict
// installed-state postflight. It never claims the workflow installed anything.
//
// Provenance of each row is independently verified:
//  * foundation: 58 stored statements; the JSON-statements digest equals the digest derived from the reviewed SQL (Supabase CLI split).
//  * activation: the hosted ledger stores ONE statement (not the 7 a CLI split of the file would yield). Its exact stored SQL text
//    (sha256 of statements[1], UTF-8) is pinned in storedSqlSha256 and, at run time, must equal both the pin AND the sha256 of the
//    reviewed source file. matchesReviewedSource in the receipt is computed from that run-time comparison, never a constant.
export const EXISTING_INSTALLATIONS = Object.freeze({
  'accessories-v1-foundation|FairSwapProd': Object.freeze({
    candidateId: 'accessories-v1-foundation',
    environment: 'FairSwapProd',
    observedState: 'activated',
    entries: Object.freeze([
      Object.freeze({
        role: 'foundation', candidateId: 'accessories-v1-foundation', ledgerVersion: '20261102164135', ledgerName: 'accessories_v1',
        statementCount: 58,
        statementsSha256: '70f752d5484a4e5a85680e4b2fd8ef5c257fef2f74979bd803fa4db1bf43f772',
        storedSqlSha256: null,
        reviewedSourceStatementsSha256: '70f752d5484a4e5a85680e4b2fd8ef5c257fef2f74979bd803fa4db1bf43f772'
      }),
      Object.freeze({
        role: 'activation', candidateId: 'accessories-v1-activation', ledgerVersion: '20261102164137', ledgerName: 'activate_accessories_v1',
        // Read-only comparison of both hosted databases: one stored statement, 533 characters, byte-identical to the reviewed source.
        statementCount: 1,
        statementsSha256: '389d6ee5fcfb047057c9243570661cf4b5096030a2ebb1cbcabb2e26ad11b3bd',
        storedSqlSha256: '3fe0647b33ad914efca86b5a9aa91590be1d2d42ac20eb42cdc5d38ee3baabcd',
        reviewedSourceStatementsSha256: null
      })
    ]),
    // Later chain stages must be absent: Wearables must never be recorded.
    forbiddenLedgerVersions: Object.freeze(['20261104120000', '20261104230000']),
    // Tablets foundation + activation may be recorded ONLY as a complete, verified pair (the known post-Tablets state). Either
    // one alone is rejected. In that state the obsolete Accessories wrapper assertions are exempt (see postTabletsExemptKeys).
    postTabletsLedger: Object.freeze([
      Object.freeze({candidateId: 'tablets-v1-foundation', ledgerVersion: '20261102165946', ledgerName: 'posting_v2_tablets'}),
      Object.freeze({candidateId: 'tablets-v1-activation', ledgerVersion: '20261102170611', ledgerName: 'activate_tablets_v1'})
    ]),
    postTabletsExemptKeys: Object.freeze(['mobile_wrappers_extended', 'tablets_not_wrapped'])
  })
});

export function getAdoption(candidateId, environment) {
  const adoption = EXISTING_INSTALLATIONS[`${candidateId}|${environment}`];
  if (!adoption) throw new Error(`REUSABLE_RELEASE_ADOPTION_NOT_REGISTERED: ${candidateId}|${environment}`);
  return adoption;
}

// The exact adoption block a receipt must carry. Shared by the writer and the Wearables validator so they cannot diverge.
// `observed` maps ledgerVersion -> sha256 of the stored SQL text read from the hosted ledger at run time (writer only); the
// validator passes nothing and so expects the pinned value. A receipt is therefore valid only if observed === pinned, and
// matchesReviewedSource is derived from comparing the observed text digest with the reviewed source file digest.
export function adoptionAttestation(adoption, observed = {}) {
  return {
    kind: 'existing-installation',
    installedByThisWorkflow: false,
    originalReleaseRun: null,
    observedState: adoption.observedState,
    entries: adoption.entries.map(entry => {
      const sourceSha256 = getCandidate(entry.candidateId).sha256;
      const storedSqlSha256 = entry.storedSqlSha256 === null ? null : (observed[entry.ledgerVersion] ?? entry.storedSqlSha256);
      return {
        role: entry.role,
        candidateId: entry.candidateId,
        ledgerVersion: entry.ledgerVersion,
        ledgerName: entry.ledgerName,
        statementCount: entry.statementCount,
        ledgerStatementsSha256: entry.statementsSha256,
        storedSqlSha256,
        sourceSha256,
        reviewedSourceStatementsSha256: entry.reviewedSourceStatementsSha256,
        matchesReviewedSource: storedSqlSha256 === null
          ? entry.statementsSha256 === entry.reviewedSourceStatementsSha256
          : storedSqlSha256 === sourceSha256
      };
    }),
    historyPreserved: true
  };
}

export function getCandidate(candidateId) {
  const candidate = CANDIDATES[candidateId];
  if (!candidate) {
    throw new Error(`REUSABLE_RELEASE_UNKNOWN_CANDIDATE: ${candidateId}`);
  }
  return candidate;
}

export function verifyCandidateSha(candidateId, repoRoot = process.cwd()) {
  const candidate = getCandidate(candidateId);
  const fullPath = resolve(repoRoot, candidate.path);
  const content = readFileSync(fullPath);
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== candidate.sha256) {
    throw new Error(`REUSABLE_RELEASE_CANDIDATE_HASH_MISMATCH: expected ${candidate.sha256}, got ${digest}`);
  }
  return {candidate, fullPath, sha256: digest};
}

const RUN_ID = /^[1-9][0-9]{0,15}$/;
const SHA40 = /^[0-9a-f]{40}$/;

function need(ok, code) {
  if (!ok) throw new Error(`REUSABLE_RELEASE_${code}`);
}

// Pure, offline plan of what a dispatch must prove before it may touch a hosted database.
// Accessories stages are separate dispatches (target=test | production); evidence of the earlier
// stage is a prior successful run of this workflow. Only Accessories foundation can use ancestor evidence.
export function planDispatch({candidateId, target = 'test', inputs = {}, context = {}}) {
  const candidate = getCandidate(candidateId);
  need(target === 'test' || target === 'production' || target === 'adopt', 'INVALID_TARGET');
  const waiver = WEARABLES_E2E_WAIVER;
  const waiveE2e = inputs.test_e2e_run_id === waiver.input;
  if (waiveE2e) {
    need(target === 'production' && (candidate.id === 'wearables-v1-foundation' || candidate.id === 'wearables-v1-activation'),
      'E2E_WAIVER_SCOPE_INVALID');
    need(context.GITHUB_ACTIONS === 'true' && context.GITHUB_EVENT_NAME === 'workflow_dispatch'
      && context.GITHUB_REPOSITORY === `${waiver.owner}/FairSwap-Backend` && context.GITHUB_REF === 'refs/heads/main'
      && context.GITHUB_WORKFLOW_REF === `${context.GITHUB_REPOSITORY}/.github/workflows/reusable-supabase-release.yml@${context.GITHUB_REF}`
      && context.GITHUB_ACTOR === waiver.owner && context.GITHUB_TRIGGERING_ACTOR === waiver.owner
      && context.GITHUB_ACTOR_ID === waiver.ownerId && context.GITHUB_REPOSITORY_OWNER_ID === waiver.ownerId
      && SHA40.test(context.GITHUB_SHA ?? '') && RUN_ID.test(context.GITHUB_RUN_ID ?? ''), 'E2E_WAIVER_OWNER_DISPATCH_REQUIRED');
  }
  if (target === 'adopt') {
    // Read-only attestation of an existing Production installation; only registered installations qualify.
    need(candidate.strict && EXISTING_INSTALLATIONS[`${candidate.id}|FairSwapProd`], 'ADOPTION_NOT_REGISTERED');
    return {candidate, target, priorRuns: [], webStagingSha: null, webProductionSha: null, adoption: getAdoption(candidate.id, 'FairSwapProd')};
  }
  if (!candidate.strict) {
    need(target === 'test', 'TARGET_NOT_SUPPORTED');
    return {candidate, target, priorRuns: [], webStagingSha: null, webProductionSha: null};
  }
  const run = (key, candidateOfRun, environment) => {
    const id = String(inputs[key] ?? '');
    need(RUN_ID.test(id), `EVIDENCE_RUN_REQUIRED_${key.toUpperCase()}`);
    return {key, runId: id, candidateId: candidateOfRun, environment};
  };
  if (['tablets-v2-catalogue', 'wearables-v11-catalogue'].includes(candidate.id)) {
    const priorRuns = target === 'production' ? [run('test_catalogue_run_id', candidate.id, 'test')] : [];
    const webStagingSha = target === 'production' ? String(inputs.web_staging_sha ?? '') : null;
    need(target !== 'production' || SHA40.test(webStagingSha), 'WEB_STAGING_VERIFICATION_REQUIRED');
    return {candidate, target, priorRuns, webStagingSha, webProductionSha: null};
  }
  const pin = webPin(candidate);
  const stagingWeb = () => {
    const sha = String(inputs.web_staging_sha ?? '');
    need(sha === pin.stagingSha, 'WEB_STAGING_VERIFICATION_REQUIRED');
    return sha;
  };
  const family = candidate.id.slice(0, -candidate.stage.length);
  const foundationId = family + 'foundation';
  const activationId = family + 'activation';
  const priorRuns = [];
  let webStagingSha = null;
  let webProductionSha = null;
  if (candidate.stage === 'foundation' && target === 'production') {
    priorRuns.push(run('test_foundation_run_id', foundationId, 'test'));
    priorRuns.push(run('test_activation_run_id', activationId, 'test'));
    webStagingSha = stagingWeb();
  } else if (candidate.stage === 'activation' && target === 'test') {
    priorRuns.push(run('test_foundation_run_id', foundationId, 'test'));
    webStagingSha = stagingWeb();
  } else if (candidate.stage === 'activation' && target === 'production') {
    priorRuns.push(run('test_activation_run_id', activationId, 'test'));
    priorRuns.push(run('prod_foundation_run_id', foundationId, 'prod'));
    webStagingSha = stagingWeb();
    webProductionSha = String(inputs.web_production_sha ?? '');
    need(SHA40.test(webProductionSha) && webProductionSha !== pin.productionBaselineSha, 'WEB_PRODUCTION_VERIFICATION_REQUIRED');
  }
  // Wearables Production additionally needs (a) the Accessories Production foundation (a prior-commit receipt, verified
  // by wearables-v1-release.mjs) and (b) independent Test E2E evidence. Neither is a same-commit priorRun.
  const extra = {};
  if (candidateFamily(candidate) === 'wearables-v1' && target === 'production') {
    extra.crossCommitRuns = [run('accessories_prod_foundation_run_id', 'accessories-v1-foundation', 'prod')];
    if (waiveE2e) {
      extra.e2eWaiver = {
        status: 'WAIVED_BY_OWNER',
        scope: 'authenticated-wearables-v1-test-e2e',
        testExecuted: false,
        approvedBy: waiver.owner,
        approvedById: waiver.ownerId,
        dispatchRunId: context.GITHUB_RUN_ID,
        approvedWebStagingSource: waiver.webStagingSource,
        reviewedWebProductionBase: waiver.webBaseSha,
        reviewedWebProductionTree: waiver.webTreeSha
      };
    } else {
      extra.e2eRunId = run('test_e2e_run_id', candidate.id, 'test').runId;
    }
  }
  return {candidate, target, priorRuns, webStagingSha, webProductionSha, ...extra};
}
