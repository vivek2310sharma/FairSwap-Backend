import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { manifestSha256 } from "./verify-baseline.mjs";
import { verifyForwardSources } from "./verify-v2-forward.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migration = "20261101000000_moderation_v2_synthetic.sql";
const suite = "moderation_v2_synthetic.test.sql";
const digest = value => createHash("sha256").update(value).digest("hex");
function withFixture(callback) {
  const dir = mkdtempSync(path.join(tmpdir(), "fairswap-v2-forward-test-"));
  const mkdir = relative => mkdirSync(path.join(dir, relative), { recursive: true });
  mkdir("docs/extraction");
  mkdir("docs/moderation");
  mkdir("supabase/forward-migrations/moderation-v2");
  mkdir("supabase/tests");
  const history = readFileSync(path.join(root, "docs/extraction/MIGRATION_MANIFEST.sha256"));
  assert.equal(digest(history), manifestSha256);
  writeFileSync(path.join(dir, "docs/extraction/MIGRATION_MANIFEST.sha256"), history);
  const sql = "-- synthetic only, never hosted\nSELECT 1;\n";
  const pgTap = "BEGIN; SELECT plan(1); SELECT ok(true, 'synthetic'); SELECT * FROM finish(); ROLLBACK;\n";
  writeFileSync(path.join(dir, "supabase/forward-migrations/moderation-v2", migration), sql);
  writeFileSync(path.join(dir, "supabase/tests", suite), pgTap);
  const manifest = {
    schemaVersion: 1, baselineSha256: manifestSha256,
    migrations: [{ file: migration, sha256: digest(sql) }],
    tests: [{ file: suite, sha256: digest(pgTap), assertions: 1 }],
  };
  const manifestFile = path.join(dir, "docs/moderation/V2_FORWARD_MANIFEST.json");
  const save = () => writeFileSync(manifestFile, JSON.stringify(manifest) + "\n");
  save();
  try { callback({ dir, manifest, save, manifestFile }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("accepts sealed migration and pgTAP inventories", () => withFixture(({ dir }) => {
  const r = verifyForwardSources(dir);
  assert.deepEqual(r.migrations, [migration]);
  assert.deepEqual(r.tests, [{ file: suite, assertions: 1 }]);
}));

test("rejects absent migration, even with a test suite", () => withFixture(({ dir, manifest, save }) => {
  manifest.migrations = [];
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects absent test suite, even with a migration", () => withFixture(({ dir, manifest, save }) => {
  manifest.tests = [];
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects historical migration names", () => withFixture(({ dir, manifest, save }) => {
  manifest.migrations[0].file = "20261011000038_old.sql";
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects a changed forward SQL byte", () => withFixture(({ dir }) => {
  writeFileSync(path.join(dir, "supabase/forward-migrations/moderation-v2", migration), "SELECT 2;\n");
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects an unlisted SQL file", () => withFixture(({ dir }) => {
  writeFileSync(path.join(dir, "supabase/forward-migrations/moderation-v2/20991231235959_extra.sql"), "SELECT 1;\n");
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects an unlisted pgTAP suite", () => withFixture(({ dir }) => {
  writeFileSync(path.join(dir, "supabase/tests/moderation_v2_extra.test.sql"), "SELECT 1;\n");
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects modified assertion suite bytes", () => withFixture(({ dir }) => {
  writeFileSync(path.join(dir, "supabase/tests", suite), "SELECT 1;\n");
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects forged historical baseline pin", () => withFixture(({ dir, manifest, save }) => {
  manifest.baselineSha256 = "0".repeat(64);
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects unknown manifest properties", () => withFixture(({ dir, manifest, save }) => {
  manifest.allowNetwork = true;
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects duplicate forward versions", () => withFixture(({ dir, manifest, save }) => {
  manifest.migrations.push({ ...manifest.migrations[0] });
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects path traversal in test filename", () => withFixture(({ dir, manifest, save }) => {
  manifest.tests[0].file = "../file.sql";
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects symlinked extra forward SQL", () => withFixture(({ dir }) => {
  symlinkSync(path.join(dir, "supabase/forward-migrations/moderation-v2", migration),
    path.join(dir, "supabase/forward-migrations/moderation-v2/20991231235959_fake.sql"));
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects incorrect assertion totals", () => withFixture(({ dir, manifest, save }) => {
  manifest.tests[0].assertions = 0;
  save();
  assert.throws(() => verifyForwardSources(dir));
}));

test("rejects missing or non-JSON manifest", () => withFixture(({ dir, manifestFile }) => {
  writeFileSync(manifestFile, '{"error":"DO_NOT_LOG"');
  assert.throws(() => verifyForwardSources(dir));
}));

test("does not mutate source SQL or historical manifest", () => withFixture(({ dir }) => {
  const a = readFileSync(path.join(dir, "supabase/forward-migrations/moderation-v2", migration));
  const b = readFileSync(path.join(dir, "docs/extraction/MIGRATION_MANIFEST.sha256"));
  verifyForwardSources(dir);
  assert.deepEqual(readFileSync(path.join(dir, "supabase/forward-migrations/moderation-v2", migration)), a);
  assert.deepEqual(readFileSync(path.join(dir, "docs/extraction/MIGRATION_MANIFEST.sha256")), b);
}));

import { verifyForwardDb, verifyForwardSuite } from "./verify-v2-forward-results.mjs";

test("checks exact forward ledger while retaining all 58 V1 migration versions", () => {
  const existing = Array.from({ length: 58 }, (_, i) => String(20260901000000 + i));
  const before = { migration_versions: existing, moderation_automation_enabled: "false",
    vault_count: 0, httpRequests: 0, httpResponses: 0,
    checks: { authRoles: "unchanged", v1Rls: true }, triggerAclContext: [] };
  const version = "20261101000000";
  const after = { ...structuredClone(before), migration_versions: [...existing, version].sort() };
  const evidence = verifyForwardDb(before, after, [version + "_moderation_v2_synthetic.sql"]);
  assert.equal(evidence.v1StateUnchanged, true);
  assert.equal(evidence.forwardMigrations, 1);
  assert.throws(() => verifyForwardDb(before, { ...after, vault_count: 1 }, [version + "_moderation_v2_synthetic.sql"]));
  assert.throws(() => verifyForwardDb(before, { ...after, moderation_automation_enabled: "true" },
    [version + "_moderation_v2_synthetic.sql"]));
  assert.throws(() => verifyForwardDb(before, { ...after, checks: { v1Rls: false } },
    [version + "_moderation_v2_synthetic.sql"]));
  assert.throws(() => verifyForwardDb(before, { ...after, migration_versions: existing },
    [version + "_moderation_v2_synthetic.sql"]));
});

test("requires exactly one clean pg_prove completion with approved assertion count", () => {
  const log = "Running /task/supabase/tests/moderation_v2_synthetic.test.sql\n"
    + "All tests successful.\nFiles=1, Tests=2, 0 wallclock secs\nResult: PASS\n";
  assert.equal(verifyForwardSuite("moderation_v2_synthetic.test.sql", 2, log).success, true);
  assert.throws(() => verifyForwardSuite("moderation_v2_synthetic.test.sql", 1, log));
  assert.throws(() => verifyForwardSuite("moderation_v2_other.test.sql", 2, log));
  assert.throws(() => verifyForwardSuite("moderation_v2_synthetic.test.sql", 2,
    log.replace("Result: PASS", "Result: FAIL")));
  assert.throws(() => verifyForwardSuite("moderation_v2_synthetic.test.sql", 2, log + "not ok 2\n"));
});

test("opt-in runner cannot bypass baseline, isolation or exact migration inventory", () => {
  const runner = readFileSync(path.join(root, "scripts/ci/run-local-db.sh"), "utf8");
  const baseline = runner.indexOf("failure_stage=security-after");
  const forward = runner.indexOf("if [[ $v2_forward_mode == 1 ]]; then");
  const isolation = runner.indexOf('check_isolation "$raw/isolation-after.json"');
  assert.ok(baseline >= 0 && forward > baseline && isolation > forward);
  assert.match(runner, /FAIRSWAP_DB_V2_FORWARD="\$v2_forward_mode"/);
  assert.match(runner, /verify-v2-forward\.mjs" --check/);
  assert.match(runner, /verify-v2-forward-results\.mjs" --check-db/);
  assert.match(runner, /cli_local migration up --local/);
  assert.match(runner, /v2-forward-security/);
  assert.match(runner, /rm -- "\$project\/supabase\/migrations\/\$file"/);
  assert.match(runner, /node "\$root\/scripts\/ci\/verify-baseline\.mjs"/);
});
