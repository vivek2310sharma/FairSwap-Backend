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
    description: 'Admin moderation analytics V1 authoritative RPC'
  })
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
