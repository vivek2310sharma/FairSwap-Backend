import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSha256 } from "./verify-baseline.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = "docs/moderation/V2_FORWARD_MANIFEST.json";
const historicPath = "docs/extraction/MIGRATION_MANIFEST.sha256";
const forwardDir = "supabase/forward-migrations/moderation-v2";
const suitesDir = "supabase/tests";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (obj, keys) => obj !== null && typeof obj === "object" && !Array.isArray(obj)
  && Object.keys(obj).sort().join(",") === [...keys].sort().join(",");
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const safeFile = (root, relative) => {
  const file = path.join(root, relative);
  assert.ok(lstatSync(file).isFile(), "Expected ordinary file, no links");
  assert.equal(realpathSync(file), path.resolve(file), "Symlinks are prohibited");
  const bytes = readFileSync(file);
  assert.ok(bytes.length > 0 && !bytes.includes(0), "Empty or binary source is prohibited");
  return bytes;
};
const namesIn = (root, relative, include) => {
  const dir = path.join(root, relative);
  assert.ok(lstatSync(dir).isDirectory(), "Expected directory, no links");
  assert.equal(realpathSync(dir), path.resolve(dir), "Directory links are prohibited");
  return readdirSync(dir, { withFileTypes: true }).filter(entry => {
    assert.ok(entry.isFile(), "Nested folders and symlinks are prohibited in the forward source directory");
    return include(entry.name);
  }).map(entry => entry.name).sort();
};

export function verifyForwardSources(root = repositoryRoot) {
  root = path.resolve(root);
  const history = safeFile(root, historicPath);
  assert.equal(hash(history), manifestSha256, "Historical migration baseline has drifted");
  const old = history.toString("utf8").trimEnd().split("\n");
  assert.equal(old.length, 58, "Expected 58 sealed historical migrations");
  const oldVersions = old.map(line => {
    const match = /^[0-9a-f]{64}  supabase\/migrations\/([0-9]{14})_[a-z0-9_]+\.sql$/.exec(line);
    assert.ok(match, "Unrecognized historical migration manifest");
    return match[1];
  });
  assert.equal(new Set(oldVersions).size, 58, "Duplicate historical version");
  const lastHistoricalVersion = [...oldVersions].sort().at(-1);

  const manifest = JSON.parse(safeFile(root, manifestPath).toString("utf8"));
  assert.ok(exactKeys(manifest, ["schemaVersion", "baselineSha256", "migrations", "tests"]), "Unexpected manifest fields");
  assert.equal(manifest.schemaVersion, 1, "Unknown manifest schema");
  assert.equal(manifest.baselineSha256, manifestSha256, "Wrong baseline anchor");
  assert.ok(Array.isArray(manifest.migrations) && manifest.migrations.length >= 1 && manifest.migrations.length <= 30,
    "At least one reviewed forward migration is required");
  assert.ok(Array.isArray(manifest.tests) && manifest.tests.length >= 1 && manifest.tests.length <= 50,
    "At least one reviewed SQL assertion suite is required");

  const migrations = [];
  const versions = new Set();
  for (const item of manifest.migrations) {
    assert.ok(exactKeys(item, ["file", "sha256"]) && digest(item.sha256), "Invalid forward migration entry");
    const match = /^([0-9]{14})_[a-z0-9_]+\.sql$/.exec(item.file);
    assert.ok(match && match[1] > lastHistoricalVersion, "Invalid, unversioned or historical migration name");
    assert.ok(!versions.has(match[1]), "Duplicate migration version");
    versions.add(match[1]);
    assert.equal(hash(safeFile(root, path.join(forwardDir, item.file))), item.sha256, "Forward migration bytes drifted");
    migrations.push(item.file);
  }
  assert.deepEqual(migrations, [...migrations].sort(), "Migrations must be version-sorted");
  assert.deepEqual(namesIn(root, forwardDir, name => name.endsWith(".sql")), [...migrations].sort(),
    "Unlisted or missing SQL migration");
  // A forward directory may contain only the registered SQL files.
  assert.deepEqual(namesIn(root, forwardDir, () => true), [...migrations].sort(),
    "Unexpected file in forward migration directory");

  const tests = [];
  for (const item of manifest.tests) {
    assert.ok(exactKeys(item, ["file", "sha256", "assertions"]) && digest(item.sha256), "Invalid test entry");
    assert.ok(/^moderation_v2_[a-z0-9_]+\.test\.sql$/.test(item.file), "Unexpected SQL test name");
    assert.ok(Number.isSafeInteger(item.assertions) && item.assertions > 0 && item.assertions <= 500,
      "Invalid SQL assertion count");
    assert.equal(hash(safeFile(root, path.join(suitesDir, item.file))), item.sha256, "SQL test bytes drifted");
    tests.push({ file: item.file, assertions: item.assertions });
  }
  assert.deepEqual(tests.map(t => t.file), [...tests.map(t => t.file)].sort(), "SQL tests must be name-sorted");
  assert.deepEqual(namesIn(root, suitesDir, name => name.startsWith("moderation_v2_") && name.endsWith(".test.sql")),
    tests.map(t => t.file), "Unlisted or missing V2 SQL assertion suite");

  return { migrations, tests, lastHistoricalVersion };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length === 3, "Exactly one command is required");
    const report = verifyForwardSources();
    switch (process.argv[2]) {
      case "--check":
        console.log("PASS: sealed V2 forward sources, " + report.migrations.length + " migrations, "
          + report.tests.length + " SQL test suites");
        break;
      case "--list-migrations":
        for (const file of report.migrations) console.log(file);
        break;
      case "--list-tests":
        for (const suite of report.tests) console.log(suite.file + "\t" + suite.assertions);
        break;
      default:
        throw new Error("Unknown command");
    }
  } catch {
    // Fail closed without echoing user content, SQL bytes, absolute paths or credentials.
    console.error("FAIL: unapproved or invalid V2 forward-source inventory");
    process.exitCode = 1;
  }
}
