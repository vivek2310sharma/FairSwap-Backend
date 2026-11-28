#!/usr/bin/env node
// Relevant-change filter for the heavy PG15 Docker jobs. Fail-open: every flag is "true" unless a pull
// request's exact checked-out merge commit was compared with its event base and proves the job irrelevant.
// Only the literal string "false" lets backend-ci-success accept a skipped job (see backend-ci.yml).
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Default-run rule: a path is database-relevant unless it is explicitly known not to be. Only these are known
// irrelevant: application source (unit-tested elsewhere), documentation and root Markdown. Anything under a
// database-dependency root is relevant regardless of extension, including every forward migration, the
// migration checksum manifest, release scripts/candidates, CI scripts, tests, workflows and toolchain pins.
const DATABASE_ROOTS = /^(?:supabase|scripts|releases|tests|\.github|docs\/extraction)\//;
const KNOWN_IRRELEVANT = /^(?:docs\/|src\/)|^[^/]+\.md$/;
const isRelevant = (file) => DATABASE_ROOTS.test(file) || !KNOWN_IRRELEVANT.test(file);

export function classify(files) {
  // Unverified, empty or malformed lists always run the database jobs.
  if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== 'string' || f === '')) {
    return { pg15: 'true', forward: 'true' };
  }
  const relevant = files.some(isRelevant) ? 'true' : 'false';
  // Both Docker jobs depend on the same migrations, manifest and scripts, so they share one rule.
  return { pg15: relevant, forward: relevant };
}

// GitHub's compare API returns at most 300 files. A capped or invalid result cannot justify a skip.
export async function changedFiles(env, fetcher = fetch) {
  const repository = String(env.GITHUB_REPOSITORY ?? '');
  const base = env.PR_BASE_SHA;
  const merge = env.GITHUB_SHA;
  const fullSha = /^[a-f0-9]{40}$/;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !fullSha.test(base ?? '') || !fullSha.test(merge ?? '') || !env.GITHUB_TOKEN) return null;
  const response = await fetcher(`https://api.github.com/repos/${repository}/compare/${base}...${merge}?per_page=1&page=1`, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) return null;
  const result = await response.json();
  if (result?.base_commit?.sha !== base || result?.merge_base_commit?.sha !== base ||
      result?.status !== 'ahead' || !Array.isArray(result.files) || result.files.length >= 300) return null;
  const files = [];
  for (const entry of result.files) {
    if (typeof entry?.filename !== 'string' || !entry.filename ||
        !['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(entry.status)) return null;
    files.push(entry.filename);
    if (entry.status === 'renamed' || entry.status === 'copied') {
      if (typeof entry.previous_filename !== 'string' || !entry.previous_filename) return null;
    }
    if (entry.previous_filename !== undefined) {
      if (typeof entry.previous_filename !== 'string' || !entry.previous_filename) return null;
      files.push(entry.previous_filename);
    }
  }
  return files;
}

async function main(env) {
  let flags = { pg15: 'true', forward: 'true' };
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    try { flags = classify(await changedFiles(env)); } catch { flags = { pg15: 'true', forward: 'true' }; }
  }
  const lines = `pg15=${flags.pg15}\nforward=${flags.forward}\n`;
  process.stdout.write(lines);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.env);
