import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/backend-prune-merged-branches-once.yml", import.meta.url),
  "utf8",
);

test("Branch pruning cannot run on PR code, other repos or unconfirmed manual runs", () => {
  assert.match(workflow, /^on:\s*\n  push:\s*\n    branches: \[main\]/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+(?:pull_request|schedule):/);
  assert.match(workflow, /github\.repository == 'vivek2310sharma\/FairSwap-Backend'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.actor == 'vivek2310sharma'/);
  assert.match(workflow, /inputs\.confirm == 'PRUNE_REVIEWED_MERGED_BRANCHES'/);
  assert.match(workflow, /backend-prune-merged-branches-once\.yml/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /secrets\.GITHUB_TOKEN/);
  // Repo root must NOT append a trailing slash: GitHub REST returns 404.
  assert.match(workflow, /const root = 'https:\/\/api\.github\.com\/repos\/' \+ repo;/);
  assert.match(workflow, /fetch\(root \+ \(path \? '\/' \+ path : ''\)/);
  assert.match(workflow, /housekeepingBranches\.some/);
  assert.doesNotMatch(workflow, /SUPABASE_|OPENAI_|FAIRSWAP_PROD_/);
});

test("Pruning requires merged PR SHA, protects active PR heads+bases and rechecks branch before deletion", () => {
  assert.match(workflow, /const pins = \[\{"pr":39,/);
  assert.match(workflow, /"pr":38/);
  assert.match(workflow, /"pr":37/);
  assert.match(workflow, /head\?\.sha !== t\.sha/);
  assert.match(workflow, /!pr\.merged_at/);
  assert.match(workflow, /pr\.base\?\.ref !== 'main'/);
  assert.match(workflow, /opened\.flatMap\(p=>\[p\.head\?\.ref,p\.base\?\.ref\]\)/);
  assert.match(workflow, /reserved\.has\(t\.branch\)/);
  assert.match(workflow, /live\.protected \|\| live\.commit\?\.sha !== t\.sha/);
  assert.match(workflow, /'branches\/'.*encodeURIComponent/);
  assert.match(workflow, /await api\(ref, 'DELETE'\)/);
  assert.doesNotMatch(workflow, /'git\/refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /\bforce:\s*true/);
});

test("Cleanup includes only the 17 audited merged PRs, not active V2 work", () => {
  const ids = [...workflow.matchAll(/"pr":(\d+),"branch":/g)].map(m=>Number(m[1]));
  assert.deepEqual(ids, [39,38,37,36,35,34,33,31,19,18,17,13,12,11,10,6,4]);
  for (const protectedRef of [
    "feat/moderation-v2-point3-recovered",
    "feat/moderation-v2-input-lease",
    "chore/backend-extraction-baseline",
    "candidate/modv2-b2-guarded-storage-20261021",
    "main",
  ]) {
    assert.ok(!workflow.includes(',"branch":"' + protectedRef + '"'),
      "Protected open-PR branch must not be a cleanup candidate: " + protectedRef);
  }
});
