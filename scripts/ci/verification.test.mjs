import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyBaseline } from "./verify-baseline.mjs";
import { approvedFileCount, approvedTestCount, approvedFiles, approvedNetworkSetup, verifyConfiguredFiles, verifyUnitIsolation, verifyUnitResults } from "./verify-unit-results.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = readFileSync(path.join(root, "vitest.config.ts"), "utf8").replaceAll("\r\n", "\n");

function passingReport() {
  return {
    success: true,
    numTotalTests: approvedTestCount,
    numPassedTests: approvedTestCount,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 26,
    numPassedTestSuites: 26,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    snapshot: { failure: false },
    testResults: Object.entries(approvedFiles).map(([file, count]) => ({
      name: path.join(root, file).replaceAll("\\", "/"),
      status: "passed",
      message: "",
      assertionResults: Array.from({ length: count }, (_, index) => ({
        fullName: `Synthetic validator fixture ${index}`,
        status: "passed",
        failureMessages: [],
      })),
    })),
  };
}

function withTemporaryDirectory(callback) {
  const parent = realpathSync(tmpdir());
  const temporary = mkdtempSync(path.join(parent, "fairswap-ci-validator-"));
  try {
    return callback(temporary);
  } finally {
    const resolved = realpathSync(temporary);
    // Delete only the freshly created, direct-child task fixture directory.
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("fairswap-ci-validator-"));
    rmSync(resolved, { recursive: true });
  }
}

test("accepts the existing explicit configuration and a complete report", () => {
  verifyConfiguredFiles(config);
  const summary = verifyUnitResults(passingReport());
  assert.equal(summary.totalFiles, approvedFileCount);
  assert.equal(summary.totalPassed, approvedTestCount);
  assert.deepEqual(summary.files.map(f => f.passed), [39, 7, 10, 3, 34, 103, 83, 60, 93]);
  assert.ok(!JSON.stringify(summary).includes(root));
});

test("accepts exact relative and Windows-style absolute filenames", () => {
  const relative = passingReport();
  relative.testResults.forEach((result, index) => { result.name = Object.keys(approvedFiles)[index]; });
  verifyUnitResults(relative);
  const windows = passingReport();
  windows.testResults.forEach(result => { result.name = result.name.replaceAll("/", "\\"); });
  verifyUnitResults(windows);
});

const negativeReports = {
  "unsuccessful run": r => { r.success = false; },
  "missing totals": r => { delete r.numPassedTests; },
  "wrong totals": r => { r.numTotalTests = approvedTestCount - 1; },
  "failed tests": r => { r.numFailedTests = 1; },
  "pending tests": r => { r.numPendingTests = 1; },
  "todo tests": r => { r.numTodoTests = 1; },
  "skipped tests": r => { r.numSkippedTests = 1; },
  "failed suite": r => { r.numFailedTestSuites = 1; },
  "pending suite": r => { r.numPendingTestSuites = 1; },
  "mismatched passed suites": r => { r.numPassedTestSuites = 25; },
  "runtime error": r => { r.numRuntimeErrorTestSuites = 1; },
  "unhandled errors": r => { r.unhandledErrors = ["private fixture value"]; },
  "snapshot failure": r => { r.snapshot.failure = true; },
  "missing file": r => { r.testResults.pop(); },
  "additional file": r => { r.testResults.push(structuredClone(r.testResults[0])); },
  "duplicate filename": r => { r.testResults[1].name = r.testResults[0].name; },
  "unknown filename": r => { r.testResults[0].name = "src/__tests__/unapproved.test.ts"; },
  "same suffix outside repository": r => { r.testResults[0].name = `/other/${Object.keys(approvedFiles)[0]}`; },
  "wrong per-file distribution": r => { r.testResults[1].assertionResults.push(r.testResults[0].assertionResults.pop()); },
  "failed file": r => { r.testResults[0].status = "failed"; },
  "file error message": r => { r.testResults[0].message = "private fixture value"; },
  "file execution error": r => { r.testResults[0].testExecError = {}; },
  "skipped assertion despite passing totals": r => { r.testResults[0].assertionResults[0].status = "skipped"; },
  "pending assertion despite passing totals": r => { r.testResults[0].assertionResults[0].status = "pending"; },
  "failed assertion despite passing totals": r => { r.testResults[0].assertionResults[0].status = "failed"; },
  "duplicate assertion": r => { r.testResults[0].assertionResults[1].fullName = r.testResults[0].assertionResults[0].fullName; },
  "missing assertion identity": r => { delete r.testResults[0].assertionResults[0].fullName; },
  "hidden assertion failure": r => { r.testResults[0].assertionResults[0].failureMessages = ["private fixture value"]; },
  "null assertion": r => { r.testResults[0].assertionResults[0] = null; },
};
for (const [name, mutate] of Object.entries(negativeReports)) {
  test(`rejects ${name}`, () => {
    const report = passingReport();
    mutate(report);
    assert.throws(() => verifyUnitResults(report));
  });
}

test("rejects non-object JSON and missing assertion arrays", () => {
  for (const value of [null, [], "report", 1, {}]) assert.throws(() => verifyUnitResults(value));
  const report = passingReport();
  delete report.testResults[0].assertionResults;
  assert.throws(() => verifyUnitResults(report));
});

test("rejects discovery changes, duplicates and dynamic or malformed configuration", () => {
  const file = Object.keys(approvedFiles)[0];
  assert.throws(() => verifyConfiguredFiles(config.replace(file, "unapproved.test.ts")));
  assert.throws(() => verifyConfiguredFiles(config.replace(Object.keys(approvedFiles)[1], file)));
  assert.throws(() => verifyConfiguredFiles(config.replace(`"${file}"`, "...otherFiles")));
  assert.throws(() => verifyConfiguredFiles("export default defineConfig({ test: { include: ["));
});

const isolationChanges = {
  "removed setupFiles": source => source.replace('    setupFiles: ["./tests/setup/no-network.ts"],\n', ""),
  "empty setupFiles": source => source.replace('["./tests/setup/no-network.ts"]', "[]"),
  "different setup file": source => source.replace('./tests/setup/no-network.ts', './tests/setup/other.ts'),
  "additional setup file": source => source.replace('["./tests/setup/no-network.ts"]', '["./tests/setup/no-network.ts", "./other.ts"]'),
  "dynamic setup list": source => source.replace('["./tests/setup/no-network.ts"]', "setupFiles"),
  "browser environment": source => source.replace('environment: "node"', 'environment: "jsdom"'),
  "missing environment": source => source.replace('    environment: "node",\n', ""),
  "dynamic environment": source => source.replace('environment: "node"', 'environment: process.env.TEST_ENV'),
  "enabled env loading": source => source.replace('envDir: false', 'envDir: "."'),
  "missing envDir": source => source.replace('  envDir: false,\n', ""),
  "string false envDir": source => source.replace('envDir: false', 'envDir: "false"'),
  "zero-test success": source => source.replace('passWithNoTests: false', 'passWithNoTests: true'),
  "dynamic zero-test setting": source => source.replace('passWithNoTests: false', 'passWithNoTests: process.env.ALLOW_EMPTY'),
  "missing zero-test setting": source => source.replace('    passWithNoTests: false,\n', ""),
  "duplicate zero-test override": source => source.replace('passWithNoTests: false,', 'passWithNoTests: false, passWithNoTests: true,'),
  "computed zero-test override": source => source.replace('passWithNoTests: false,', 'passWithNoTests: false, ["passWithNoTests"]: true,'),
  "spread override": source => source.replace('passWithNoTests: false,', 'passWithNoTests: false, ...overrides,'),
  "per-project overrides": source => source.replace('passWithNoTests: false,', 'passWithNoTests: false, projects: [{ test: { environment: "jsdom" } }],'),
  "per-file environment overrides": source => source.replace('environment: "node",', 'environment: "node", environmentMatchGlobs: [["**", "jsdom"]],'),
  "root plugins": source => source.replace('  envDir: false,', '  envDir: false, plugins: [overridePlugin()],'),
  "nested zero-test override": source => source.replace('alias: {', 'passWithNoTests: true, alias: {'),
};
for (const [name, mutate] of Object.entries(isolationChanges)) {
  test(`isolation rejects ${name}`, () => {
    const changed = mutate(config);
    assert.notEqual(changed, config, "Fixture mutation must change the existing configuration");
    assert.throws(() => verifyConfiguredFiles(changed));
  });
}

test("isolation pins the existing raw setup bytes and rejects weakened, missing or repinned setup", () => {
  verifyUnitIsolation();
  withTemporaryDirectory(temporary => {
    mkdirSync(path.join(temporary, "tests/setup"), { recursive: true });
    mkdirSync(path.join(temporary, "scripts/ci"), { recursive: true });
    const configPath = path.join(temporary, "vitest.config.ts");
    const setupPath = path.join(temporary, approvedNetworkSetup.file);
    const pinPath = path.join(temporary, "scripts/ci/toolchain.json");
    const setup = readFileSync(path.join(root, approvedNetworkSetup.file));
    const pins = readFileSync(path.join(root, "scripts/ci/toolchain.json"));
    writeFileSync(configPath, config);
    writeFileSync(setupPath, setup);
    writeFileSync(pinPath, pins);
    verifyUnitIsolation(temporary);
    writeFileSync(setupPath, "// network blocking silently removed\n");
    assert.throws(() => verifyUnitIsolation(temporary), /setup raw SHA-256 mismatch/);
    writeFileSync(setupPath, Buffer.concat([setup, Buffer.from("\n")]));
    assert.throws(() => verifyUnitIsolation(temporary), /setup raw SHA-256 mismatch/);
    rmSync(setupPath);
    assert.throws(() => verifyUnitIsolation(temporary), /ENOENT/);
    writeFileSync(setupPath, setup);
    writeFileSync(configPath, isolationChanges["removed setupFiles"](config));
    assert.throws(() => verifyUnitIsolation(temporary), /setupFiles/);
    writeFileSync(configPath, config);
    const changedPins = JSON.parse(pins);
    changedPins.unitIsolation.sha256 = "0".repeat(64);
    writeFileSync(pinPath, JSON.stringify(changedPins));
    assert.throws(() => verifyUnitIsolation(temporary), /pin differs/);
  });
});

test("workflow checks isolation immediately before unit execution with failure propagation", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/backend-ci.yml"), "utf8");
  const unitStep = workflow.slice(workflow.indexOf("      - name: Run approved unit files"),
    workflow.indexOf("      - name: Verify exact results"));
  assert.match(unitStep, /run: \|\r?\n\s+node scripts\/ci\/verify-unit-results\.mjs --check-isolation\r?\n\s+env -i/);
  assert.match(unitStep, /corepack pnpm test:unit/);
  assert.doesNotMatch(unitStep, /continue-on-error|if:|\|\|\s*true/);
  assert.match(workflow, /shell: bash --noprofile --norc -euo pipefail \{0\}/);
  const guard = spawnSync(process.execPath, [path.join(root, "scripts/ci/verify-unit-results.mjs"), "--check-isolation"],
    { encoding: "utf8" });
  assert.equal(guard.status, 0);
  assert.match(guard.stdout, /PASS: approved Node unit isolation/);
});

test("CLI fails closed for missing/malformed reports and writes only sanitized summaries", () => {
  withTemporaryDirectory(temporary => {
    const reportPath = path.join(temporary, "report.json");
    const summaryPath = path.join(temporary, "summary.json");
    const script = path.join(root, "scripts/ci/verify-unit-results.mjs");
    for (const content of [undefined, '{"private":"DO_NOT_DISCLOSE",', JSON.stringify({ success: false, private: "DO_NOT_DISCLOSE" })]) {
      if (content !== undefined) writeFileSync(reportPath, content);
      const run = spawnSync(process.execPath, [script, reportPath, "--summary", summaryPath], { encoding: "utf8" });
      assert.equal(run.status, 1);
      const summary = readFileSync(summaryPath, "utf8");
      assert.equal(JSON.parse(summary).success, false);
      assert.ok(!`${run.stdout}${run.stderr}${summary}`.includes("DO_NOT_DISCLOSE"));
      assert.ok(!`${run.stdout}${run.stderr}${summary}`.includes(temporary));
    }
    writeFileSync(reportPath, JSON.stringify(passingReport()));
    const run = spawnSync(process.execPath, [script, reportPath, "--summary", summaryPath], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.equal(JSON.parse(readFileSync(summaryPath, "utf8")).totalPassed, approvedTestCount);
    const before = readFileSync(reportPath);
    const overwrite = spawnSync(process.execPath, [script, reportPath, "--summary", reportPath]);
    assert.equal(overwrite.status, 1);
    assert.deepEqual(readFileSync(reportPath), before);
    assert.equal(spawnSync(process.execPath, [script]).status, 1);
  });
});

test("baseline accepts canonical bytes and rejects changed manifest, altered/missing/extra SQL", () => {
  assert.equal(verifyBaseline(), 58);
  withTemporaryDirectory(temporary => {
    const manifestPath = "docs/extraction/MIGRATION_MANIFEST.sha256";
    mkdirSync(path.join(temporary, "docs/extraction"), { recursive: true });
    mkdirSync(path.join(temporary, "supabase/migrations"), { recursive: true });
    const manifest = readFileSync(path.join(root, manifestPath));
    writeFileSync(path.join(temporary, manifestPath), manifest);
    const files = manifest.toString("utf8").trimEnd().split("\n").map(line => line.slice(66));
    for (const file of files) copyFileSync(path.join(root, file), path.join(temporary, file));
    assert.equal(verifyBaseline(temporary), 58);
    writeFileSync(path.join(temporary, manifestPath), Buffer.concat([manifest, Buffer.from("\n")]));
    assert.throws(() => verifyBaseline(temporary), /manifest raw SHA-256 mismatch/);
    writeFileSync(path.join(temporary, manifestPath), manifest);
    const first = path.join(temporary, files[0]);
    writeFileSync(first, "-- altered fixture bytes\n");
    assert.throws(() => verifyBaseline(temporary), /Migration SHA-256 mismatch/);
    rmSync(first);
    assert.throws(() => verifyBaseline(temporary), /missing or additional migration/);
    copyFileSync(path.join(root, files[0]), first);
    writeFileSync(path.join(temporary, "supabase/migrations/20990101000000_extra.sql"), "-- fixture only\n");
    assert.throws(() => verifyBaseline(temporary), /missing or additional migration/);
  });
});
