import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, changedFiles } from './changed-areas.mjs';

const all = { pg15: 'true', forward: 'true' };
const none = { pg15: 'false', forward: 'false' };

test('missing, empty or malformed file lists fail open to every job', () => {
  for (const input of [null, undefined, [], [''], [1], 'x', [null]]) assert.deepEqual(classify(input), all);
});

test('only documentation, root Markdown and application source skip the database jobs', () => {
  assert.deepEqual(classify(['README.md', 'docs/operations/X.md', 'src/lib/a.ts', 'docs/contracts/a.md']), none);
});

test('every database dependency root is relevant, whatever the extension', () => {
  for (const path of ['supabase/migrations/1.sql', 'supabase/functions/x/index.ts', 'supabase/config.toml', 'supabase/tests/a.sql',
    'supabase/forward-migrations/wearables-v1/a.sql', 'supabase/forward-migrations/idv/README.md',
    'supabase/forward-migrations/moderation-analytics-v1/a.sql', 'supabase/forward-migrations/profile-onboarding/a.sql',
    'docs/extraction/MIGRATION_MANIFEST.sha256', 'docs/extraction/evidence/stage2b/r6/result.json',
    'scripts/verify-migration-manifest.mjs', 'scripts/release/x.mjs', 'scripts/ci/toolchain.json', 'releases/candidates/a/b.json',
    'tests/ratings/run.mjs', '.github/workflows/backend-ci.yml']) {
    assert.deepEqual(classify(['README.md', path]), all, path);
  }
});

test('unknown paths run the database jobs', () => {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'vitest.config.ts', 'tsconfig.json', 'infra/x.bicep', 'newdir/file', 'LICENSE', 'a/b.md']) {
    assert.deepEqual(classify(['src/a.ts', path]), all, path);
  }
});

test('one relevant file among many irrelevant ones is enough', () => {
  assert.deepEqual(classify([...Array(50).fill('docs/a.md'), 'supabase/forward-migrations/x/y.sql']), all);
});

const base = 'a'.repeat(40), merge = 'b'.repeat(40);
const env = { GITHUB_REPOSITORY: 'owner/repo', PR_BASE_SHA: base, GITHUB_SHA: merge, GITHUB_TOKEN: 'synthetic' };
const result = files => ({base_commit: {sha: base}, merge_base_commit: {sha: base}, status: 'ahead', files});
const fetchResult = value => async () => ({ok: true, json: async () => value});

test('compare uses only immutable event base and tested merge SHA, never a live PR number', async () => {
  const files = await changedFiles({...env, PR_NUMBER: '99'}, async url => {
    assert.equal(url, `https://api.github.com/repos/owner/repo/compare/${base}...${merge}?per_page=1&page=1`);
    return {ok: true, json: async () => result([{filename: 'docs/a.md', status: 'modified'}])};
  });
  assert.deepEqual(classify(files), none);
});

test('renaming a database path into documentation still requires both jobs', async () => {
  const files = await changedFiles(env, fetchResult(result([{filename: 'docs/a.md', previous_filename: 'supabase/a.sql', status: 'renamed'}])));
  assert.deepEqual(classify(files), all);
});

test('capped, incomplete, divergent or malformed compare results require both jobs', async () => {
  for (const value of [
    result(Array.from({length: 300}, (_, i) => ({filename: `docs/${i}.md`, status: 'added'}))),
    result([{filename: 'docs/a.md', status: 'renamed'}]), result([{filename: 'docs/a.md'}]),
    {...result([]), merge_base_commit: {sha: merge}}, {...result([]), base_commit: {sha: merge}},
    {...result([]), status: 'diverged'}, {...result([]), files: null}, null
  ]) assert.deepEqual(classify(await changedFiles(env, fetchResult(value))), all);
  assert.deepEqual(classify(await changedFiles(env, async () => ({ok: false}))), all);
  assert.deepEqual(classify(await changedFiles({...env, PR_BASE_SHA: 'main'}, () => assert.fail('invalid SHA must not fetch'))), all);
});
