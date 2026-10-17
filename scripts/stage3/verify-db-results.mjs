import {inspectTap,verifyTap} from './parse-compatibility.mjs';
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSha256, verifyBaseline } from "../ci/verify-baseline.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const pins = readJson(path.join(repositoryRoot, "scripts/stage3/toolchain.json")).database;
const accepted = readJson(path.join(repositoryRoot, "docs/extraction/evidence/stage2b/r6/result.json")).security;
// Stage 2B's historical "listings" any-DML boolean recorded whole-table
// privileges, while the new catalog SQL includes column-level grants. Preserve
// that historical artifact and require the real, narrower grant boundaries here.
export const expectedRls = accepted.checks.rls.map(row => row.relname === "listings"
  ? { ...row, authenticated_any_dml: true } : row);
const listingMutableColumns = ["category_attributes","category_id","city_id","condition","description","landmark","locality_id","pin_code","price_paise","price_type","title"];
const emptyColumnDml = relname => ({ relname, anon_insert: [], anon_update: [],
  authenticated_insert: [], authenticated_update: [],
  anon_table_insert: false, anon_table_update: false, anon_table_delete: false,
  authenticated_table_insert: false, authenticated_table_update: false, authenticated_table_delete: false });
export const expectedColumnDml = Object.freeze([
  emptyColumnDml("email_outbox"),
  { ...emptyColumnDml("listing_media"), authenticated_insert: ["content_type", "file_size_bytes", "listing_id", "original_filename"] },
  { ...emptyColumnDml("listings"), authenticated_insert: listingMutableColumns,
    authenticated_update: listingMutableColumns },
]);
export const requiredSuites = Object.freeze({
  "moderation_compatibility.test.sql": 74,
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
  "firewallIsolated", "loopbackOnly", "nativeNamespace", "hostSql", "runnerSql",
  "ipv4Denied", "ipv6Denied", "probesExecuted", "noExtraNetworks",
]);
export const cleanupKeys = Object.freeze([
  "containersRemoved", "volumesRemoved", "networkRemoved", "portClosed", "baselineResourcesPreserved", "firewallRemoved",
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
// Finite diagnostic vocabularies: never publish raw command output or caller text.
export const imageDiagnosticStages = Object.freeze([
  "image-postgres-buildx-check",
  "image-postgres-index-fetch",
  "image-postgres-index-digest",
  "image-postgres-amd64-descriptor",
  "image-postgres-child-fetch",
  "image-postgres-child-digest",
  "image-postgres-child-pull",
  "image-postgres-child-id-inspect",
  "image-pin-list",
  "image-role-validate",
  "image-postgres-child-id-verify",
  "image-tools-evidence",
  "image-postgres-reference-select",
  "image-pgProve-reference-select",
  ...["postgres","pgProve","authBootstrap","storageBootstrap","realtimeBootstrap"].flatMap(role =>
    ["validate","reference-validate","pull","id-inspect","platform-inspect","platform-verify","repo-digests-inspect","repo-digests-verify","tag-probe","tag-existing-id-inspect","tag-existing-id-verify","tag-create","tag-final-id-inspect","tag-final-id-verify","evidence"].map(operation => `image-${role}-${operation}`)),
]);
export const startupDiagnosticStages = Object.freeze([
  "db-start-cli",
  "db-start-version-num-query",
  "db-start-version-num-verify",
  "db-start-version-text-query",
  "db-start-version-text-verify",
  "db-start-cron-alter",
  "db-start-cron-reload",
  "db-start-cron-confirm",
  "db-start-pgtap-extension"
]);
export const diagnosticStages = Object.freeze([
  ...startupDiagnosticStages,
  ...["unclassified","preflight","manifest-before","cli-download","cli-check","images","network-setup","port-probe","db-start","isolation-before","migrations","security-before","pgtap","security-after","isolation-after","manifest-after","complete","port-probe-run","port-probe-inspect","port-probe-binding","port-probe-cleanup","firewall-hooks","firewall-setup","firewall-verify","route-isolation","security-before-sql","security-before-verify","cleanup","artifact-validation"], ...imageDiagnosticStages,
]);
export const diagnosticCategories = Object.freeze([
  "db-start-command-failed",
  "db-start-version-mismatch",
  "db-start-cron-not-disabled",
  "none",
  "unclassified",
  "required-tool-check-failed",
  "manifest-retrieval-failed",
  "digest-check-failed",
  "descriptor-check-failed",
  "image-pull-failed",
  "image-inspect-failed",
  "platform-check-failed",
  "repo-digest-check-failed",
  "child-image-id-check-failed",
  "pin-check-failed",
  "tag-check-failed",
  "tag-create-failed",
  "evidence-write-failed",
  "cleanup-failed",
  "evidence-validation-failed",
  "manifest-not-found",
  "registry-denied",
  "rate-limited",
  "transport-error",
  "storage-error",
  "unsupported-manifest",
  "probe-run-error",
  "probe-port-conflict",
  "probe-network-rule-error",
  "probe-entrypoint-error",
  "probe-image-missing",
  "probe-port-missing",
  "probe-wildcard-binding",
  "probe-other-binding",
  "security-parse",
  "security-version",
  "security-ledger",
  "security-vault",
  "security-setting",
  "security-queues",
  "security-buckets",
  "security-rls",
  "security-column-grants",
  "security-rls-shape",
  "security-extensions",
  "security-extension-approval-pending",
  "security-rpcs",
  "security-cron",
  "security-runtime",
  "security-trigger",
  "security-unclassified",
  "security-rls-email_outbox-present",
  "security-rls-email_outbox-relrowsecurity",
  "security-rls-email_outbox-relforcerowsecurity",
  "security-rls-email_outbox-policies",
  "security-rls-email_outbox-anon_any_dml",
  "security-rls-email_outbox-authenticated_any_dml",
  "security-rls-listing_media-present",
  "security-rls-listing_media-relrowsecurity",
  "security-rls-listing_media-relforcerowsecurity",
  "security-rls-listing_media-policies",
  "security-rls-listing_media-anon_any_dml",
  "security-rls-listing_media-authenticated_any_dml",
  "security-rls-listings-present",
  "security-rls-listings-relrowsecurity",
  "security-rls-listings-relforcerowsecurity",
  "security-rls-listings-policies",
  "security-rls-listings-anon_any_dml",
  "security-rls-listings-authenticated_any_dml"
]);
export function sanitizeDiagnostic(value) {
  const unknown = {stage:"unclassified",category:"unclassified"};
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value,"stage") || !Object.hasOwn(value,"category")
      || typeof value.stage !== "string" || typeof value.category !== "string"
      || !diagnosticStages.includes(value.stage) || !diagnosticCategories.includes(value.category)) return unknown;
  return {stage:value.stage,category:value.category};
}

// Conservative floors retain the previously verified Stage 2B capabilities.
// They are not a security certification or approval of newer PG17 versions.
export const extensionMinimumVersions = Object.freeze({
  pg_cron: "1.6", pg_net: "0.14.0", supabase_vault: "0.3.1",
});
function extensionVersion(version) {
  requireCondition(typeof version === "string" && version.length <= 11 && version === version.trim()
    && /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(?:\.(0|[1-9][0-9]{0,2}))?$/.test(version));
  return version.split(".").map(Number).concat(version.split(".").length === 2 ? [0] : []);
}
export function verifyExtensionInventory(inventory) {
  requireCondition(inventory && typeof inventory === "object" && !Array.isArray(inventory)
    && [Object.prototype, null].includes(Object.getPrototypeOf(inventory))
    && same(Object.keys(inventory), Object.keys(extensionMinimumVersions)));
  const versions = {};
  for (const [name, floor] of Object.entries(extensionMinimumVersions)) {
    const actual = extensionVersion(inventory[name]), minimum = extensionVersion(floor);
    const firstDifference = actual.findIndex((part, index) => part !== minimum[index]);
    requireCondition(firstDifference === -1 || actual[firstDifference] > minimum[firstDifference]);
    versions[name] = inventory[name];
  }
  return {versions, approved: same(versions, accepted.checks.extensions)};
}

export function expectedMigrationVersions() {
  return readFileSync(path.join(repositoryRoot, "docs/extraction/MIGRATION_MANIFEST.sha256"), "utf8")
    .trimEnd().split("\n").map(line => path.posix.basename(line.slice(66)).slice(0, 14)).sort();
}
export function parseSuiteLog(file, log, exitCode) {
  if(file==='moderation_compatibility.test.sql'){
    verifyTap(log,exitCode);
    return {file,assertions:74,failedAssertions:0,exitCode:0,result:'PASS'};
  }
  requireCondition(Object.hasOwn(requiredSuites, file) && exitCode === 0 && typeof log === "string");
  requireCondition(log.includes(`/supabase/tests/${file}`) || log.includes(`\\supabase\\tests\\${file}`));
  requireCondition(!/(?:^|\n)\s*(?:not ok\b|Bail out!|Dubious|Failed\b|Parse errors:)|\bERROR:|Result:\s*FAIL/i.test(log));
  const counts = [...log.matchAll(/^Files=(\d+), Tests=(\d+),[^\r\n]*$/gm)];
  requireCondition(counts.length === 1 && counts[0][1] === "1" && Number(counts[0][2]) === requiredSuites[file]);
  requireCondition((log.match(/^Result: PASS\r?$/gm) ?? []).length === 1);
  requireCondition((log.match(/^All tests successful\.\r?$/gm) ?? []).length === 1);
  return { file, assertions: requiredSuites[file], failedAssertions: 0, exitCode: 0, result: "PASS" };
}
export function verifySecurity(snapshot, {allowUnapprovedExtensions = false} = {}) {
  requireCondition(snapshot?.postgresVersion === "17.6" && snapshot.version_num === 170006);
  requireCondition(same(snapshot.migration_versions, expectedMigrationVersions()) && snapshot.migration_versions.length === 58);
  requireCondition(snapshot.vault_count === 0 && snapshot.moderation_automation_enabled === "false"
    && snapshot.httpRequests === 0 && snapshot.httpResponses === 0);
  const extensions = verifyExtensionInventory(snapshot.checks?.extensions);
  requireCondition(allowUnapprovedExtensions === true || extensions.approved);
  for (const key of ["buckets", "sensitive_rpcs", "cron_jobs"]) {
    requireCondition(same(snapshot.checks?.[key], accepted.checks[key]));
  }
  requireCondition(same(snapshot.checks?.rls, expectedRls));
  // Column ACLs must match the exact approved mutable fields; blanket table
  // UPDATE/INSERT/DELETE and all anon mutations remain explicitly forbidden.
  requireCondition(same(snapshot.checks?.column_dml, expectedColumnDml));
  const settings = accepted.checks.runtime_settings.filter(row => ["cron.database_name", "cron.host", "cron.launch_active_jobs"].includes(row.name))
    .map(row=>row.name==="cron.launch_active_jobs"?{...row,setting:"off"}:row);
  requireCondition(same(snapshot.checks.runtime_settings, settings));
  requireCondition(same(snapshot.triggerAclContext, accepted.triggerAclContext));
}
function verifyExecutionContract(report, allowUnapprovedExtensions = false) {
  requireCondition(report?.schemaVersion === 1 && report.success === true && report.executionExit === 0);
  requireCondition(same(report.diagnostic,{stage:"complete",category:"none"}));
  requireCondition(report.compatibility?.passed === true && report.compatibility.assertionsObserved === 74
    && report.compatibility.failed?.length === 0 && report.compatibility.observations?.length === 4);
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
  requireCondition(Array.isArray(report.suites) && report.suites.length === 10);
  const seen = new Set();
  for (const suite of report.suites) {
    requireCondition(Object.hasOwn(requiredSuites, suite.file) && !seen.has(suite.file));
    seen.add(suite.file);
    requireCondition(suite.assertions === requiredSuites[suite.file] && suite.failedAssertions === 0
      && suite.exitCode === 0 && suite.result === "PASS");
  }
  requireCondition(report.suites.reduce((sum, suite) => sum + suite.assertions, 0) === 344);
  verifySecurity(report.securityBefore, {allowUnapprovedExtensions});
  verifySecurity(report.securityAfter, {allowUnapprovedExtensions});
  requireCondition(same(report.extensionReview, {before:verifyExtensionInventory(report.securityBefore.checks.extensions),
    after:verifyExtensionInventory(report.securityAfter.checks.extensions)}));
  requireCondition(same(report.securityBefore.migration_versions, report.securityAfter.migration_versions));
  return true;
}
// The public acceptance verifier has no provisional/bypass option.
export function verifyDbResults(report) { return verifyExecutionContract(report); }
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
function writeEvidence(directory,report,suites) {
  mkdirSync(directory, { recursive: true });
  requireCondition(readdirSync(directory).every(file => ["result.json", "suite-results.json", "SHA256SUMS"].includes(file)));
  requireCondition(readdirSync(directory).every(file => lstatSync(path.join(directory, file)).isFile()
    && !lstatSync(path.join(directory, file)).isSymbolicLink()));
  writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(directory, "suite-results.json"), `${JSON.stringify(suites, null, 2)}\n`);
  writeFileSync(path.join(directory, "SHA256SUMS"), ["result.json", "suite-results.json"]
    .map(file => `${sha256(readFileSync(path.join(directory, file)))}  ${file}\n`).join(""));
}
export function invalidateCleanupEvidence(directory,diagnostic) {
  writeEvidence(directory,{
    schemaVersion:1,success:false,reason:"Task cleanup failed; raw output withheld",
    diagnostic:sanitizeDiagnostic(diagnostic),cleanup:"FAILED",
  },[]);
  return false;
}
// Retain numeric TAP evidence only; never retain descriptions or raw diagnostics.
export function inspectSuiteEvidence(file, log, exitCode) {
  requireCondition(Object.hasOwn(requiredSuites, file) && typeof log === "string"
    && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255);
  const planned = requiredSuites[file];
  const rows = [...log.matchAll(/^(not ok|ok) ([0-9]+)(?:[ \t]|$)([^\r\n]*)/gm)];
  requireCondition(rows.length <= planned && rows.every((row, index) => Number(row[2]) === index + 1));
  let observed = null, passed = [], failed = [], complete = false;
  if (rows.length) {
    observed = rows.length;
    passed = rows.filter(row => row[1] === "ok" && !/#\s*(?:SKIP|TODO)\b/i.test(row[3])).map(row => Number(row[2]));
    failed = rows.filter(row => row[1] === "not ok").map(row => Number(row[2]));
  } else if (file !== "moderation_compatibility.test.sql") {
    // pg_prove normally prints a summary, rather than every successful TAP row.
    const counts = [...log.matchAll(/^Files=1, Tests=([0-9]+),[^\r\n]*$/gm)];
    requireCondition(counts.length <= 1);
    if (counts.length) {
      observed = Number(counts[0][1]);
      requireCondition(observed <= planned);
      const failures = [...log.matchAll(/^\s*Failed tests:\s*([0-9, -]+)\s*$/gm)];
      requireCondition(failures.length <= 1);
      if (failures.length) {
        for (const part of failures[0][1].split(",")) {
          const range = part.trim().match(/^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/);
          requireCondition(range);
          const first = Number(range[1]), last = Number(range[2] ?? range[1]);
          requireCondition(first <= last && last <= observed);
          for (let number = first; number <= last; number++) failed.push(number);
        }
        requireCondition(new Set(failed).size === failed.length);
        failed.sort((a,b) => a-b);
        // A failure summary alone does not prove every other assertion passed.
      }
    }
  }
  try {
    parseSuiteLog(file, log, exitCode);
    complete = true;
    observed = planned;
    passed = Array.from({length: planned}, (_, index) => index + 1);
    failed = [];
  } catch { /* Preserve only observed counts/numbers; never infer a successful suite. */ }
  return {file, exitCode, assertionsObserved: observed, passed, failed, result: complete ? "PASS" : "NOT_VERIFIED"};
}
function collectSuiteEvidence(rawDirectory) {
  return Object.keys(requiredSuites).map(file => {
    try {
      const exit = readFileSync(path.join(rawDirectory, file + ".exit"), "utf8");
      requireCondition(/^(?:0|[1-9][0-9]{0,2})\n?$/.test(exit));
      return inspectSuiteEvidence(file, readFileSync(path.join(rawDirectory, file + ".log"), "utf8"), Number(exit.trim()));
    } catch { return {file, result:"NOT_VERIFIED", assertionsObserved:null, passed:[], failed:[]}; }
  });
}
function collectExtensionEvidence(rawDirectory) {
  const result = {};
  for (const [phase, file] of [["before","security-before.json"],["after","security-after.json"]]) {
    try { result[phase] = verifyExtensionInventory(readJson(path.join(rawDirectory, file)).checks?.extensions); }
    catch { /* Invalid/missing inventory never exports names, versions or raw text. */ }
  }
  return result;
}

export function collectEvidence(rawDirectory, directory) {
  let report = { schemaVersion: 1, success: false, reason: "Database CI incomplete or failed; raw output withheld" };
  let diagnostic=sanitizeDiagnostic(null);
  try {diagnostic=sanitizeDiagnostic(readJson(path.join(rawDirectory,"diagnostic.json")));} catch { /* Fixed unknown only. */ }
  report.diagnostic=diagnostic;
  let compatibility={executed:false,passed:false};
  try { const log=readFileSync(path.join(rawDirectory,"moderation_compatibility.test.sql.log"),"utf8"); const exit=Number(readFileSync(path.join(rawDirectory,"moderation_compatibility.test.sql.exit"),"utf8").trim()); inspectSuiteEvidence("moderation_compatibility.test.sql",log,exit); compatibility=inspectTap(log,exit); } catch { /* Fixed failure only; never export exception text. */ }
  report.compatibility=compatibility;
  const retainedSuites = collectSuiteEvidence(rawDirectory);
  report.suiteStatus = retainedSuites;
  report.extensionReview = collectExtensionEvidence(rawDirectory);
  let suites = [];
  let passed = false;
  let pendingExtensions = false;
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
      schemaVersion: 1, success: true, diagnostic, compatibility, executionExit: execution.exitCode,
      extensionReview: collectExtensionEvidence(rawDirectory),
      manifestSha256: manifest.sha256, manifestVerifiedBeforeAndAfter: manifest.before === true && manifest.after === true,
      tools: readJson(path.join(rawDirectory, "tools.json")), images: readJson(path.join(rawDirectory, "images.json")),
      isolationBefore: readJson(path.join(rawDirectory, "isolation-before.json")),
      isolationAfter: readJson(path.join(rawDirectory, "isolation-after.json")),
      securityBefore: readJson(path.join(rawDirectory, "security-before.json")),
      securityAfter: readJson(path.join(rawDirectory, "security-after.json")),
      cleanup: readJson(path.join(rawDirectory, "cleanup.json")), suites,
    };
    verifyExecutionContract(candidate, true);
    pendingExtensions = !candidate.extensionReview.before.approved || !candidate.extensionReview.after.approved;
    verifyDbResults(candidate);
    // Build an allowlist projection; never copy arbitrary log text or unknown input fields.
    const fixed = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
    const security = () => ({
      postgresVersion: "17.6", version_num: 170006, migration_versions: expectedMigrationVersions(),
      vault_count: 0, moderation_automation_enabled: "false", httpRequests: 0, httpResponses: 0,
      checks: { ...accepted.checks, rls: expectedRls, column_dml: expectedColumnDml,
        runtime_settings: accepted.checks.runtime_settings.filter(row => ["cron.database_name", "cron.host", "cron.launch_active_jobs"].includes(row.name)).map(row=>row.name==="cron.launch_active_jobs"?{...row,setting:"off"}:row) },
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
    suites = retainedSuites.filter(suite => Object.hasOwn(suite,"exitCode"));
    if (diagnostic.stage==="complete") report.diagnostic={stage:"artifact-validation",
      category:pendingExtensions ? "security-extension-approval-pending" : "evidence-validation-failed"};
    try {
      const cleanup = readJson(path.join(rawDirectory, "cleanup.json"));
      requireAllTrue(cleanup, cleanupKeys);
      report.cleanup = Object.fromEntries(cleanupKeys.map(key => [key, true]));
    } catch { report.cleanup = "UNVERIFIED"; }
  }
  writeEvidence(directory,report,suites);
  if (passed) verifyEvidence(directory);
  return passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, first, second, ...extra] = process.argv.slice(2);
    if (mode==="--cleanup-failed" && first && second && extra.length===1) {
      invalidateCleanupEvidence(first,{stage:second,category:extra[0]});
      throw new Error("Cleanup failed");
    }
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
