import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSha256, verifyBaseline } from "./verify-baseline.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const pins = readJson(path.join(repositoryRoot, "scripts/ci/toolchain.json")).database;
const accepted = readJson(path.join(repositoryRoot, "docs/extraction/evidence/stage2b/r6/result.json")).security;
export const requiredSuites = Object.freeze({
  "admin_medium_operation.test.sql": 6,
  "admin_reviewed_contract.test.sql": 10,
  "listings_insert_category_eligibility.test.sql": 28,
  "moderation_vault_dispatch_auth.test.sql": 11,
  "pending_review_media_invalidation.test.sql": 31,
  "schema_listings.test.sql": 28,
  "schema_post_ad_category_metadata.test.sql": 59,
  "schema_security.test.sql": 22,
  "seller_listing_category_context.test.sql": 75,
});
export const isolationKeys = Object.freeze([
  "internalNetwork", "loopbackOnly", "nativeNamespace", "hostSql", "runnerSql",
  "ipv4Denied", "ipv6Denied", "probesExecuted", "noExtraNetworks",
]);
export const cleanupKeys = Object.freeze([
  "containersRemoved", "volumesRemoved", "networkRemoved", "portClosed", "baselineResourcesPreserved",
]);
function requireCondition(condition) {
  if (!condition) throw new Error("Database CI evidence does not satisfy the approved contract");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function requireAllTrue(object, keys) {
  requireCondition(object && same(Object.keys(object), keys) && keys.every(key => object[key] === true));
}
export function expectedMigrationVersions() {
  return readFileSync(path.join(repositoryRoot, "docs/extraction/MIGRATION_MANIFEST.sha256"), "utf8")
    .trimEnd().split("\n").map(line => path.posix.basename(line.slice(66)).slice(0, 14)).sort();
}
export function parseSuiteLog(file, log, exitCode) {
  requireCondition(Object.hasOwn(requiredSuites, file) && exitCode === 0 && typeof log === "string");
  requireCondition(log.includes(`/supabase/tests/${file}`) || log.includes(`\\supabase\\tests\\${file}`));
  requireCondition(!/(?:^|\n)\s*(?:not ok\b|Bail out!|Dubious|Failed\b|Parse errors:)|\bERROR:|Result:\s*FAIL/i.test(log));
  const counts = [...log.matchAll(/^Files=(\d+), Tests=(\d+),[^\r\n]*$/gm)];
  requireCondition(counts.length === 1 && counts[0][1] === "1" && Number(counts[0][2]) === requiredSuites[file]);
  requireCondition((log.match(/^Result: PASS\r?$/gm) ?? []).length === 1);
  requireCondition((log.match(/^All tests successful\.\r?$/gm) ?? []).length === 1);
  return { file, assertions: requiredSuites[file], failedAssertions: 0, exitCode: 0, result: "PASS" };
}
export function verifySecurity(snapshot) {
  requireCondition(snapshot?.postgresVersion === "15.8" && snapshot.version_num === 150008);
  requireCondition(same(snapshot.migration_versions, expectedMigrationVersions()) && snapshot.migration_versions.length === 58);
  requireCondition(snapshot.vault_count === 0 && snapshot.moderation_automation_enabled === "false"
    && snapshot.httpRequests === 0 && snapshot.httpResponses === 0);
  for (const key of ["buckets", "rls", "extensions", "sensitive_rpcs", "cron_jobs"]) {
    requireCondition(same(snapshot.checks?.[key], accepted.checks[key]));
  }
  const settings = accepted.checks.runtime_settings.filter(row => ["cron.database_name", "cron.host", "cron.launch_active_jobs"].includes(row.name));
  requireCondition(same(snapshot.checks.runtime_settings, settings));
  requireCondition(same(snapshot.triggerAclContext, accepted.triggerAclContext));
}
export function verifyDbResults(report) {
  requireCondition(report?.schemaVersion === 1 && report.success === true && report.executionExit === 0);
  requireCondition(report.manifestSha256 === manifestSha256 && report.manifestVerifiedBeforeAndAfter === true);
  requireCondition(report.tools?.cliVersion === pins.cliVersion && report.tools.nodeVersion === "24.15.0"
    && report.tools.os === "linux" && report.tools.arch === "amd64"
    && /^\d+\.\d+\.\d+$/.test(report.tools.dockerVersion)
    && Number(report.tools.dockerVersion.split(".")[0]) >= pins.dockerMinimumMajor);
  requireCondition(same(Object.keys(report.images ?? {}), Object.keys(pins.images)));
  for (const [key, pin] of Object.entries(pins.images)) {
    const image = report.images[key];
    requireCondition(image?.tag === pin.tag && image.digest === pin.digest && image.platform === "linux/amd64"
      && /^sha256:[a-f0-9]{64}$/.test(image.imageId));
  }
  requireAllTrue(report.isolationBefore, isolationKeys);
  requireAllTrue(report.isolationAfter, isolationKeys);
  requireAllTrue(report.cleanup, cleanupKeys);
  requireCondition(Array.isArray(report.suites) && report.suites.length === 9);
  const seen = new Set();
  for (const suite of report.suites) {
    requireCondition(Object.hasOwn(requiredSuites, suite.file) && !seen.has(suite.file));
    seen.add(suite.file);
    requireCondition(suite.assertions === requiredSuites[suite.file] && suite.failedAssertions === 0
      && suite.exitCode === 0 && suite.result === "PASS");
  }
  requireCondition(report.suites.reduce((sum, suite) => sum + suite.assertions, 0) === 270);
  verifySecurity(report.securityBefore);
  verifySecurity(report.securityAfter);
  requireCondition(same(report.securityBefore.migration_versions, report.securityAfter.migration_versions));
  return true;
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function verifyEvidence(directory) {
  verifyBaseline();
  requireCondition(same(readdirSync(directory), ["result.json", "suite-results.json", "SHA256SUMS"]));
  requireCondition(readdirSync(directory).every(file => lstatSync(path.join(directory, file)).isFile()
    && !lstatSync(path.join(directory, file)).isSymbolicLink()));
  const expected = ["result.json", "suite-results.json"];
  const lines = readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trimEnd().split("\n");
  requireCondition(lines.length === 2);
  for (let index = 0; index < expected.length; index++) {
    requireCondition(lstatSync(path.join(directory, expected[index])).isFile()
      && !lstatSync(path.join(directory, expected[index])).isSymbolicLink());
    requireCondition(lines[index] === `${sha256(readFileSync(path.join(directory, expected[index])))}  ${expected[index]}`);
  }
  const report = readJson(path.join(directory, "result.json"));
  verifyDbResults(report);
  requireCondition(same(readJson(path.join(directory, "suite-results.json")), report.suites));
  return true;
}
export function collectEvidence(rawDirectory, directory) {
  let report = { schemaVersion: 1, success: false, reason: "Database CI incomplete or failed; raw output withheld" };
  let suites = [];
  let passed = false;
  try {
    verifyBaseline();
    const execution = readJson(path.join(rawDirectory, "execution.json"));
    const manifest = readJson(path.join(rawDirectory, "manifest.json"));
    suites = Object.keys(requiredSuites).map(file => {
      const exit = readFileSync(path.join(rawDirectory, `${file}.exit`), "utf8").trim();
      requireCondition(exit === "0");
      return parseSuiteLog(file, readFileSync(path.join(rawDirectory, `${file}.log`), "utf8"), Number(exit));
    });
    const candidate = {
      schemaVersion: 1, success: true, executionExit: execution.exitCode,
      manifestSha256: manifest.sha256, manifestVerifiedBeforeAndAfter: manifest.before === true && manifest.after === true,
      tools: readJson(path.join(rawDirectory, "tools.json")), images: readJson(path.join(rawDirectory, "images.json")),
      isolationBefore: readJson(path.join(rawDirectory, "isolation-before.json")),
      isolationAfter: readJson(path.join(rawDirectory, "isolation-after.json")),
      securityBefore: readJson(path.join(rawDirectory, "security-before.json")),
      securityAfter: readJson(path.join(rawDirectory, "security-after.json")),
      cleanup: readJson(path.join(rawDirectory, "cleanup.json")), suites,
    };
    verifyDbResults(candidate);
    // Build an allowlist projection; never copy arbitrary log text or unknown input fields.
    const fixed = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
    const security = () => ({
      postgresVersion: "15.8", version_num: 150008, migration_versions: expectedMigrationVersions(),
      vault_count: 0, moderation_automation_enabled: "false", httpRequests: 0, httpResponses: 0,
      checks: { ...accepted.checks, runtime_settings: accepted.checks.runtime_settings.filter(row => ["cron.database_name", "cron.host", "cron.launch_active_jobs"].includes(row.name)) },
      triggerAclContext: accepted.triggerAclContext,
    });
    report = { ...candidate,
      tools: fixed(candidate.tools, ["cliVersion", "nodeVersion", "os", "arch", "dockerVersion"]),
      images: Object.fromEntries(Object.entries(pins.images).map(([key, pin]) => [key, { ...pin, platform: "linux/amd64", imageId: candidate.images[key].imageId }])),
      isolationBefore: fixed(candidate.isolationBefore, isolationKeys), isolationAfter: fixed(candidate.isolationAfter, isolationKeys),
      cleanup: fixed(candidate.cleanup, cleanupKeys), securityBefore: security(), securityAfter: security(),
    };
    passed = true;
  } catch {
    // No assertion messages, URLs, absolute paths, credentials or raw error text escape.
    suites = [];
    try {
      const cleanup = readJson(path.join(rawDirectory, "cleanup.json"));
      requireAllTrue(cleanup, cleanupKeys);
      report.cleanup = Object.fromEntries(cleanupKeys.map(key => [key, true]));
    } catch { report.cleanup = "UNVERIFIED"; }
  }
  mkdirSync(directory, { recursive: true });
  requireCondition(readdirSync(directory).every(file => ["result.json", "suite-results.json", "SHA256SUMS"].includes(file)));
  requireCondition(readdirSync(directory).every(file => lstatSync(path.join(directory, file)).isFile()
    && !lstatSync(path.join(directory, file)).isSymbolicLink()));
  writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(directory, "suite-results.json"), `${JSON.stringify(suites, null, 2)}\n`);
  writeFileSync(path.join(directory, "SHA256SUMS"), ["result.json", "suite-results.json"]
    .map(file => `${sha256(readFileSync(path.join(directory, file)))}  ${file}\n`).join(""));
  if (passed) verifyEvidence(directory);
  return passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, first, second, ...extra] = process.argv.slice(2);
    requireCondition(extra.length === 0);
    if (mode === "--collect" && first && second) requireCondition(collectEvidence(first, second));
    else if (mode === "--verify" && first && !second) verifyEvidence(first);
    else throw new Error("Unsupported arguments");
    console.log("PASS: database CI contract, cleanup and sanitized evidence checksums");
  } catch {
    console.error("FAIL: database CI evidence missing, unsafe, incomplete or outside the approved contract");
    process.exitCode = 1;
  }
}
