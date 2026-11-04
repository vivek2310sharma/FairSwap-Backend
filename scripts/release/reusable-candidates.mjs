// Reusable Supabase candidate registry and validation
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

export const CANDIDATES = Object.freeze({
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
  })
});

export const PROJECT_REFS = Object.freeze({
  FairSwapTest: 'wpppxlnbzqynvhpeuavd',
  FairSwapProd: 'kriuhwppxgxsyyrbjsau'
});

// Web commits the Accessories release is pinned to (verified GitHub baselines).
export const ACCESSORIES_WEB = Object.freeze({
  stagingSha: '1039873c2fa62845f19627d298cb9f3ba185d819',
  productionBaselineSha: 'd3e183dc204dcefc536494e73cf412a80e9836f0',
  repository: 'vivek2310sharma/FairSwap-Web',
  productionEnvironment: 'Production'
});

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
export function planDispatch({candidateId, target = 'test', inputs = {}}) {
  const candidate = getCandidate(candidateId);
  need(target === 'test' || target === 'production', 'INVALID_TARGET');
  if (!candidate.strict) {
    need(target === 'test', 'TARGET_NOT_SUPPORTED');
    return {candidate, target, priorRuns: [], webStagingSha: null, webProductionSha: null};
  }
  const run = (key, candidateOfRun, environment) => {
    const id = String(inputs[key] ?? '');
    need(RUN_ID.test(id), `EVIDENCE_RUN_REQUIRED_${key.toUpperCase()}`);
    return {key, runId: id, candidateId: candidateOfRun, environment};
  };
  const stagingWeb = () => {
    const sha = String(inputs.web_staging_sha ?? '');
    need(sha === ACCESSORIES_WEB.stagingSha, 'WEB_STAGING_VERIFICATION_REQUIRED');
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
    need(SHA40.test(webProductionSha) && webProductionSha !== ACCESSORIES_WEB.productionBaselineSha, 'WEB_PRODUCTION_VERIFICATION_REQUIRED');
  }
  return {candidate, target, priorRuns, webStagingSha, webProductionSha};
}
