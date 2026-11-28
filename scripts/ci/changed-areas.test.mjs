import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './changed-areas.mjs';

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
