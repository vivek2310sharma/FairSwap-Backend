import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const approvedNetworkSetup = Object.freeze({
  file: "tests/setup/no-network.ts",
  sha256: "c4a49badd88b567fa99b198f263f37308a16796bd026020522d29b0e2e95ce5f",
});
export const approvedFiles = Object.freeze({
  "src/__tests__/moderation-text-checker.test.ts": 39,
  "src/__tests__/moderation-target-guard.test.ts": 7,
  "src/__tests__/moderation-worker.test.ts": 10,
  "src/__tests__/moderation-worker-vault-auth.test.ts": 3,
  "tests/unit/email-outbox-worker.test.ts": 34,
  "src/__tests__/moderation-v2-contract.test.ts": 103,
  "src/__tests__/moderation-v2-provider.test.ts": 83,
  "src/__tests__/moderation-v2-evaluator.test.ts": 60,
});

export const approvedFileCount = Object.keys(approvedFiles).length;
export const approvedTestCount = Object.values(approvedFiles).reduce((sum, count) => sum + count, 0);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

// Inspect the existing literal configuration without importing/executing it.
export function verifyConfiguredFiles(source) {
  const ast = ts.createSourceFile("vitest.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  requireCondition(ast.parseDiagnostics.length === 0, "Malformed Vitest configuration");
  const exports = ast.statements.filter(ts.isExportAssignment);
  requireCondition(exports.length === 1, "Expected one default Vitest configuration");
  const call = exports[0].expression;
  requireCondition(ts.isCallExpression(call) && ts.isIdentifier(call.expression)
    && call.expression.text === "defineConfig" && call.arguments.length === 1,
  "Expected literal defineConfig configuration");
  function property(object, name) {
    requireCondition(ts.isObjectLiteralExpression(object), "Expected configuration object");
    requireCondition(object.properties.every(p => ts.isPropertyAssignment(p)
      && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))), "Dynamic configuration is unsupported");
    const names = object.properties.map(p => p.name.text);
    requireCondition(new Set(names).size === names.length, "Duplicate configuration properties are unsupported");
    const properties = object.properties.filter(p => p.name.text === name);
    requireCondition(properties.length === 1, `Expected one ${name} configuration property`);
    return properties[0].initializer;
  }
  const configuration = call.arguments[0];
  const test = property(configuration, "test");
  requireCondition(property(configuration, "envDir").kind === ts.SyntaxKind.FalseKeyword,
    "envDir must be the literal false");
  const environment = property(test, "environment");
  requireCondition(ts.isStringLiteral(environment) && environment.text === "node", "Node test environment is required");
  requireCondition(property(test, "globals").kind === ts.SyntaxKind.FalseKeyword, "globals must remain false");
  requireCondition(property(test, "passWithNoTests").kind === ts.SyntaxKind.FalseKeyword,
    "passWithNoTests must be the literal false");
  const setup = property(test, "setupFiles");
  requireCondition(ts.isArrayLiteralExpression(setup) && setup.elements.length === 1
    && ts.isStringLiteral(setup.elements[0]) && setup.elements[0].text === `./${approvedNetworkSetup.file}`,
  "Exactly the approved network-blocking setup is required");
  // Unreviewed plugins/projects/workspaces or per-file overrides could bypass these settings.
  requireCondition(configuration.properties.every(p => ["envDir", "resolve", "test"].includes(p.name.text))
    && test.properties.every(p => ["environment", "globals", "passWithNoTests", "setupFiles", "include"].includes(p.name.text)),
  "Unreviewed configuration overrides are unsupported");
  function rejectZeroTestOverrides(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
      if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "passWithNoTests") {
        requireCondition(node.initializer.kind === ts.SyntaxKind.FalseKeyword,
          "passWithNoTests overrides must remain false");
      }
    }
    ts.forEachChild(node, rejectZeroTestOverrides);
  }
  rejectZeroTestOverrides(ast);
  const include = property(test, "include");
  requireCondition(ts.isArrayLiteralExpression(include) && include.elements.every(ts.isStringLiteral),
    "Expected explicit literal test filenames");
  const actual = include.elements.map(e => e.text);
  const expected = Object.keys(approvedFiles);
  requireCondition(actual.length === expected.length && new Set(actual).size === expected.length
    && expected.every(file => actual.includes(file)), "Vitest discovery differs from the approved files");
}

export function verifyUnitIsolation(root = repositoryRoot) {
  verifyConfiguredFiles(readFileSync(path.join(root, "vitest.config.ts"), "utf8"));
  const pins = JSON.parse(readFileSync(path.join(root, "scripts/ci/toolchain.json"), "utf8"));
  requireCondition(pins.unitIsolation?.file === approvedNetworkSetup.file
    && pins.unitIsolation?.sha256 === approvedNetworkSetup.sha256, "Network setup pin differs from the reviewed baseline");
  const bytes = readFileSync(path.join(root, approvedNetworkSetup.file));
  requireCondition(createHash("sha256").update(bytes).digest("hex") === approvedNetworkSetup.sha256,
    "Approved network-blocking setup raw SHA-256 mismatch");
}

export function verifyUnitResults(report, root = repositoryRoot) {
  requireCondition(report !== null && typeof report === "object" && !Array.isArray(report), "Expected JSON report object");
  requireCondition(report.success === true, "Vitest success must be true");
  for (const key of ["numTotalTests", "numPassedTests"]) {
    requireCondition(report[key] === approvedTestCount, `Expected ${approvedTestCount} in ${key}`);
  }
  for (const key of ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"]) {
    requireCondition(report[key] === 0, `Expected zero in ${key}`);
  }
  // Vitest 3 counts nested describe groups here; testResults is the file inventory.
  requireCondition(Number.isSafeInteger(report.numTotalTestSuites) && report.numTotalTestSuites >= approvedFileCount
    && report.numPassedTestSuites === report.numTotalTestSuites, "Suite totals must all pass");
  for (const key of ["numSkippedTests", "numSkippedTestSuites", "numRuntimeErrorTestSuites", "unhandledErrorCount"]) {
    requireCondition(report[key] === undefined || report[key] === 0, `Unexpected ${key}`);
  }
  for (const key of ["unhandledErrors", "testResultsProcessorErrors"]) {
    requireCondition(report[key] === undefined || (Array.isArray(report[key]) && report[key].length === 0),
      "Unexpected report errors");
  }
  requireCondition(report.snapshot?.failure === false, "Snapshot failure state must be false");
  requireCondition(Array.isArray(report.testResults) && report.testResults.length === approvedFileCount, "Expected exactly the approved test files");
  const normalizedRoot = path.resolve(root).replaceAll("\\", "/").replace(/\/$/, "");
  const seen = new Set();
  for (const result of report.testResults) {
    requireCondition(result !== null && typeof result === "object" && typeof result.name === "string", "Missing test filename");
    const name = result.name.replaceAll("\\", "/");
    const file = Object.keys(approvedFiles).find(candidate => name === candidate || name === `${normalizedRoot}/${candidate}`);
    requireCondition(file !== undefined && !seen.has(file), "Unexpected or duplicate test filename");
    seen.add(file);
    requireCondition(result.status === "passed" && result.message === "", "Test file did not pass cleanly");
    requireCondition(result.testExecError == null, "Unexpected test execution error");
    requireCondition(Array.isArray(result.assertionResults) && result.assertionResults.length === approvedFiles[file],
      "Per-file test count mismatch");
    const names = new Set();
    for (const assertion of result.assertionResults) {
      requireCondition(assertion !== null && typeof assertion === "object" && assertion.status === "passed",
        "Every assertion must pass; skipped/pending/todo results are rejected");
      requireCondition(typeof assertion.fullName === "string" && assertion.fullName.trim().length > 0
        && !names.has(assertion.fullName), "Missing or duplicate assertion identity");
      names.add(assertion.fullName);
      requireCondition(Array.isArray(assertion.failureMessages) && assertion.failureMessages.length === 0,
        "Unexpected assertion failure messages");
    }
  }
  return {
    schemaVersion: 1,
    success: true,
    files: Object.entries(approvedFiles).map(([file, passed]) => ({ file, passed })),
    totalFiles: approvedFileCount,
    totalPassed: approvedTestCount,
    failed: 0,
    skippedOrPending: 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let summaryPath;
  let summary = { schemaVersion: 1, success: false, reason: "Unit report or configuration validation failed" };
  try {
    if (args.length === 1 && args[0] === "--check-isolation") {
      verifyUnitIsolation();
      console.log("PASS: approved Node unit isolation settings and network setup raw SHA-256");
    } else {
      requireCondition(args.length === 1 || (args.length === 3 && args[1] === "--summary"),
        "Usage: verify-unit-results.mjs --check-isolation OR <report.json> [--summary <sanitized.json>]");
      summaryPath = args.length === 3 ? args[2] : undefined;
      requireCondition(!summaryPath || path.resolve(summaryPath) !== path.resolve(args[0]), "Summary must not overwrite raw report");
      verifyUnitIsolation();
      summary = verifyUnitResults(JSON.parse(readFileSync(args[0], "utf8")));
      console.log(`PASS: exactly ${approvedFileCount} approved files and ${approvedTestCount} passed tests`);
    }
  } catch {
    // Never echo raw JSON, assertion messages, report filenames or local absolute paths.
    console.error("FAIL: unit isolation/configuration or report missing, altered, malformed or outside the approved contract");
    process.exitCode = 1;
  }
  if (summaryPath) {
    try {
      requireCondition(path.resolve(summaryPath) !== path.resolve(args[0]), "Unsafe summary path");
      mkdirSync(path.dirname(summaryPath), { recursive: true });
      writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    } catch {
      console.error("FAIL: sanitized summary could not be written");
      process.exitCode = 1;
    }
  }
}
