import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function verifyForwardDb(before, after, migrations) {
  assert.ok(Array.isArray(migrations) && migrations.length >= 1, "No approved forward migrations");
  const versions = migrations.map(name => {
    const match = /^([0-9]{14})_[a-z0-9_]+\.sql$/.exec(name);
    assert.ok(match, "Invalid forward filename");
    return match[1];
  });
  assert.equal(before.migration_versions.length, 58, "Not the frozen baseline");
  assert.deepEqual(after.migration_versions, [...before.migration_versions, ...versions].sort());
  for (const property of Object.keys(before).filter(name => name !== "migration_versions")) {
    assert.deepEqual(after[property], before[property]);
  }
  assert.equal(after.moderation_automation_enabled, "false", "V1 automation gate changed");
  assert.equal(after.vault_count, 0, "Unexpected Vault material");
  assert.equal(after.httpRequests, 0, "Unexpected outbound DB HTTP");
  assert.equal(after.httpResponses, 0, "Unexpected outbound DB HTTP response");
  return { baselineMigrations: 58, forwardMigrations: versions.length, v1StateUnchanged: true };
}
export function verifyForwardSuite(file, assertions, log) {
  assert.ok(/^moderation_v2_[a-z0-9_]+\.test\.sql$/.test(file), "Unexpected suite");
  assert.ok(Number.isSafeInteger(assertions) && assertions > 0, "Invalid assertion count");
  assert.ok(typeof log === "string" &&
    (log.includes("/supabase/tests/" + file) || log.includes("\\supabase\\tests\\" + file)),
    "SQL suite path not evidenced");
  assert.ok(!/(?:^|\n)\s*(?:not ok\b|Bail out!|Dubious|Failed\b|Parse errors:)|\bERROR:|Result:\s*FAIL/i.test(log),
    "SQL suite did not pass cleanly");
  const counts = [...log.matchAll(/^Files=(\d+), Tests=(\d+),[^\r\n]*$/gm)];
  assert.equal(counts.length, 1, "Expected single pg_prove result line");
  assert.equal(counts[0][1], "1", "Unexpected file count");
  assert.equal(Number(counts[0][2]), assertions, "SQL assertion count drifted");
  assert.equal((log.match(/^Result: PASS\r?$/gm) ?? []).length, 1, "Missing clean pass result");
  assert.equal((log.match(/^All tests successful\.\r?$/gm) ?? []).length, 1, "Missing complete suite pass");
  return { assertions, success: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === "--check-db" && process.argv.length === 6) {
      const before = JSON.parse(readFileSync(process.argv[3], "utf8"));
      const after = JSON.parse(readFileSync(process.argv[4], "utf8"));
      const migrations = readFileSync(process.argv[5], "utf8").trimEnd().split("\n");
      verifyForwardDb(before, after, migrations);
      console.log("PASS: V1 catalog/privileges unchanged after V2 forward migration");
    } else if (mode === "--check-suite" && process.argv.length === 6) {
      verifyForwardSuite(process.argv[3], Number(process.argv[4]), readFileSync(process.argv[5], "utf8"));
      console.log("PASS: exact V2 SQL suite count and results");
    } else {
      throw new Error("Bad command");
    }
  } catch {
    console.error("FAIL: V2 forward database or SQL test contract mismatch");
    process.exitCode = 1;
  }
}
