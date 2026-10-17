import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { approvedPlan, approvedPinnedForwardPlan, prepare, stageBaseline, stagePinnedCandidates, checkLedger, verifyPrepared, stageCandidates } from "./production-category-rehearsal.mjs";

test("rehearsal source is exactly the 45 Production versions plus seven pinned candidates", () => {
  const plan = approvedPlan();
  assert.equal(plan.baseline.length, 45);
  assert.equal(plan.candidates.length, 7);
  assert.equal(plan.baseline.at(-1).version, "20261013235311");
  assert.equal(plan.projectRef, "kriuhwppxgxsyyrbjsau");
  const baselineVersions = new Set(plan.baseline.map(item => item.version));
  assert.equal(baselineVersions.size, 45);
  for (const row of plan.candidates) assert.equal(baselineVersions.has(basename(row.path).slice(0, 14)), false);
  const pinned = approvedPinnedForwardPlan();
  assert.equal(pinned.forwardMigrations.length, 7);
  assert.equal(pinned.generationEvidence.githubRunId, 39068727798);
  assert.equal(pinned.forwardMigrations[0].version, "20261017205755");
  assert.equal(pinned.forwardMigrations[6].version, "20261017205807");
});

test("empty project is staged only in a task-scoped isolated working directory", () => {
  const previous = process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY;
  process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY = "1";
  const root = mkdtempSync(join(tmpdir(), "fairswap-category-rehearsal.unit-"));
  const target = join(root, "project");
  try {
    const stage = prepare(target);
    assert.equal(stage.baselineVersions.length, 45);
    assert.equal(stage.candidates.length, 0);
    assert.match(readFileSync(join(target, "supabase/config.toml"), "utf8"), /major_version = 17/);
    assert.equal(readdirSync(join(target, "supabase/migrations")).filter(x => x.endsWith(".sql")).length, 0);
    assert.throws(() => stageBaseline(target), /Missing isolated PG17 pre-SQL receipt/);
    writeFileSync(join(target, "isolation-confirmed"), "pg17.6-cron-off-network-isolated-empty-ledger\n");
    assert.equal(stageBaseline(target), 45);
    assert.throws(() => stageBaseline(target), /Unexpected FairSwap SQL before network isolation/);
    assert.equal(readdirSync(join(target, "supabase/migrations")).filter(x => x.endsWith(".sql")).length, 45);
    assert.throws(() => prepare(target), /exists/);
    assert.throws(() => verifyPrepared(target), /Incomplete candidate/);
    const ledger = stage.baselineVersions.join(",") + "\n";
    assert.equal(checkLedger(ledger, join(target, "rehearsal.json"), 45), true);
    assert.throws(() => checkLedger(stage.baselineVersions.slice(1).join(","), join(target, "rehearsal.json"), 45), /Migration history mismatch/);
    assert.throws(() => checkLedger(ledger, join(target, "rehearsal.json"), 52), /Migration history mismatch/);
    assert.throws(() => stageCandidates(target, "/bin/false"), /baseline-confirmed/);
    writeFileSync(join(target, "baseline-confirmed"), "45\n");
    assert.throws(() => stageCandidates(target, "/bin/false"), /CLI failed/);
    const applied = stagePinnedCandidates(target);
    assert.equal(applied.candidates.length, 7);
    assert.equal(readdirSync(join(target, "supabase/migrations")).filter(x => x.endsWith(".sql")).length, 52);
    assert.equal(verifyPrepared(target), true);
    const finalLedger = [...applied.baselineVersions, ...applied.candidates.map(x => x.version)].sort().join(",") + "\n";
    assert.equal(checkLedger(finalLedger, join(target, "rehearsal.json"), 52), true);
    assert.throws(() => stagePinnedCandidates(target), /Unexpected candidate staging state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY;
    else process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY = previous;
  }
});

test("rehearsal preparation refuses unscoped directories or a hosted connection", () => {
  const previous = process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY;
  process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY = "1";
  try {
    assert.throws(() => prepare("/var/tmp/wrong-target"), /unsafe rehearsal working directory/i);
    const prevUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://not-a-real-database.invalid/";
    try { assert.throws(() => prepare("/tmp/fairswap-category-rehearsal.fake/project"), /Hosted database/); }
    finally {
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
    }
  } finally {
    if (previous === undefined) delete process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY;
    else process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY = previous;
  }
});
