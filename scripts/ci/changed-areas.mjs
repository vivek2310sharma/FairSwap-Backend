#!/usr/bin/env node
// Relevant-change filter for the heavy PG15 Docker jobs. Fail-open: every flag is "true" unless a pull
// request's complete changed-file list was read from the GitHub API and proves the job irrelevant.
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

async function changedFiles(env) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  const number = Number(env.PR_NUMBER);
  if (!owner || !repo || !Number.isSafeInteger(number) || number < 1 || !env.GITHUB_TOKEN) return null;
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) return null;
    const batch = await response.json();
    if (!Array.isArray(batch)) return null;
    for (const entry of batch) {
      files.push(entry.filename);
      if (entry.previous_filename) files.push(entry.previous_filename);
    }
    if (batch.length < 100) return files;
  }
  return null; // GitHub caps the listing at 3000 files; treat anything larger as everything.
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
