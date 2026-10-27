import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { manifestSha256 } from "./verify-baseline.mjs";
import { cleanupKeys, collectEvidence, expectedMigrationVersions, expectedColumnDml, expectedRls,
  isolationKeys, parseSuiteLog, requiredSuites, verifyDbResults, verifyEvidence } from "./verify-db-results.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pins = JSON.parse(readFileSync(path.join(root, "scripts/ci/toolchain.json"))).database;
const accepted = JSON.parse(readFileSync(path.join(root, "docs/extraction/evidence/stage2b/r6/result.json"))).security;
const allTrue = keys => Object.fromEntries(keys.map(key => [key, true]));
function fixture() {
  const security = {
    postgresVersion: "15.8", version_num: 150008, migration_versions: expectedMigrationVersions(),
    vault_count: 0, moderation_automation_enabled: "false", httpRequests: 0, httpResponses: 0,
    checks: structuredClone(accepted.checks), triggerAclContext: structuredClone(accepted.triggerAclContext),
  };
  security.checks.rls = structuredClone(expectedRls);
  security.checks.column_dml = structuredClone(expectedColumnDml);
  security.checks.runtime_settings = security.checks.runtime_settings.filter(row => ["cron.database_name", "cron.host", "cron.launch_active_jobs"].includes(row.name));
  // Synthetic validator fixture only; these fields are not runtime evidence.
  return {
    schemaVersion: 1, success: true, executionExit: 0, manifestSha256, manifestVerifiedBeforeAndAfter: true,
    tools: { cliVersion: "2.117.0", nodeVersion: "24.15.0", os: "linux", arch: "amd64", dockerVersion: "28.0.1" },
    images: Object.fromEntries(Object.entries(pins.images).map(([key, pin]) => [key, { ...pin, platform: "linux/amd64", imageId: `sha256:${"a".repeat(64)}` }])),
    isolationBefore: allTrue(isolationKeys), isolationAfter: allTrue(isolationKeys), cleanup: allTrue(cleanupKeys),
    securityBefore: structuredClone(security), securityAfter: structuredClone(security),
    suites: Object.entries(requiredSuites).map(([file, assertions]) => ({ file, assertions, failedAssertions: 0, exitCode: 0, result: "PASS" })),
  };
}
function retainedLog(file) {
  return readFileSync(path.join(root, "docs/extraction/evidence/stage2b/r5", file.replace(".test.sql", ".tap.txt")), "utf8");
}
function temporary(callback) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(parent, "fairswap-db-validator-"));
  try { callback(directory); } finally {
    const resolved = realpathSync(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("fairswap-db-validator-"));
    rmSync(resolved, { recursive: true });
  }
}
function writeRaw(directory, report) {
  mkdirSync(directory);
  const json = (file, value) => writeFileSync(path.join(directory, file), JSON.stringify(value));
  json("execution.json", { exitCode: report.executionExit });
  json("manifest.json", { sha256: report.manifestSha256, before: true, after: true });
  for (const [file, key] of Object.entries({
    "tools.json": "tools", "images.json": "images", "isolation-before.json": "isolationBefore",
    "isolation-after.json": "isolationAfter", "security-before.json": "securityBefore",
    "security-after.json": "securityAfter", "cleanup.json": "cleanup",
  })) json(file, report[key]);
  for (const suite of report.suites) {
    writeFileSync(path.join(directory, `${suite.file}.log`), retainedLog(suite.file));
    writeFileSync(path.join(directory, `${suite.file}.exit`), String(suite.exitCode));
  }
}

test("accepted R5 summaries parse to exactly nine suites and 270 assertions", () => {
  const results = Object.keys(requiredSuites).map(file => parseSuiteLog(file, retainedLog(file), 0));
  assert.equal(results.length, 9);
  assert.equal(results.reduce((sum, suite) => sum + suite.assertions, 0), 270);
  assert.ok(!Object.hasOwn(requiredSuites, "schema_email_outbox.test.sql"));
  assert.equal(verifyDbResults(fixture()), true);
});
const changes = {
  "incomplete execution": r => { r.executionExit = 1; },
  "missing success": r => { delete r.success; },
  "wrong manifest anchor": r => { r.manifestSha256 = "0".repeat(64); },
  "missing post-migration integrity": r => { r.manifestVerifiedBeforeAndAfter = false; },
  "CLI drift": r => { r.tools.cliVersion = "2.121.0"; },
  "wrong Node": r => { r.tools.nodeVersion = "24.0.0"; },
  "old Docker": r => { r.tools.dockerVersion = "27.5.1"; },
  "Docker Desktop platform": r => { r.tools.os = "windows"; },
  "image drift": r => { r.images.postgres.digest = `sha256:${"0".repeat(64)}`; },
  "missing image": r => { delete r.images.authBootstrap; },
  "missing suite": r => { r.suites.pop(); },
  "duplicate suite": r => { r.suites[0] = structuredClone(r.suites[1]); },
  "excluded diagnostic": r => { r.suites[0].file = "schema_email_outbox.test.sql"; },
  "bad test count": r => { r.suites[0].assertions--; },
  "failed assertion": r => { r.suites[0].failedAssertions = 1; },
  "nonzero runner exit": r => { r.suites[0].exitCode = 3; },
  "changed history": r => { r.securityAfter.migration_versions.pop(); },
  "wrong PostgreSQL": r => { r.securityBefore.version_num = 170000; },
  "enabled moderation": r => { r.securityAfter.moderation_automation_enabled = "true"; },
  "nonempty Vault": r => { r.securityBefore.vault_count = 1; },
  "outbound request": r => { r.securityAfter.httpRequests = 1; },
  "outbound response": r => { r.securityAfter.httpResponses = 1; },
  "missing RLS": r => { r.securityBefore.checks.rls[0].relrowsecurity = false; },
  "listings column-level DML summary drift": r => { r.securityBefore.checks.rls[2].authenticated_any_dml = false; },
  "missing column grant matrix": r => { delete r.securityBefore.checks.column_dml; },
  "unexpected listing media update grant": r => { r.securityBefore.checks.column_dml[1].authenticated_update.push("display_order"); },
  "unexpected listing sensitive field grant": r => { r.securityAfter.checks.column_dml[2].authenticated_update.push("seller_id"); },
  "unexpected listing direct delete grant": r => { r.securityBefore.checks.column_dml[2].authenticated_table_delete = true; },
  "unexpected anonymous insert grant": r => { r.securityAfter.checks.column_dml[2].anon_insert.push("title"); },
  "missing seller mutable insert column": r => { r.securityBefore.checks.column_dml[2].authenticated_insert.pop(); },
  "broadened listing table-level update grant": r => { r.securityBefore.checks.column_dml[2].authenticated_table_update = true; },
  "public bucket": r => { r.securityBefore.checks.buckets[0].public = true; },
  "worker privilege drift": r => { r.securityAfter.checks.sensitive_rpcs[0].anon_execute = true; },
  "missing worker RPC": r => { r.securityAfter.checks.sensitive_rpcs.pop(); },
  "changed extension": r => { r.securityBefore.checks.extensions.pg_net = "0.15.0"; },
  "changed cron command": r => { r.securityBefore.checks.cron_jobs[0].command = "SELECT worker();"; },
  "disabled cron registration": r => { r.securityBefore.checks.cron_jobs[0].active = false; },
  "changed trigger exception": r => { r.securityBefore.triggerAclContext[0].returns = "void"; },
};
for (const [name, mutate] of Object.entries(changes)) {
  test(`rejects ${name}`, () => { const r = fixture(); mutate(r); assert.throws(() => verifyDbResults(r)); });
}
for (const phase of ["isolationBefore", "isolationAfter"]) {
  for (const key of isolationKeys) {
    test(`requires ${phase}.${key}`, () => { const r = fixture(); r[phase][key] = false; assert.throws(() => verifyDbResults(r)); });
  }
}
for (const key of cleanupKeys) {
  test(`requires cleanup.${key}`, () => { const r = fixture(); delete r.cleanup[key]; assert.throws(() => verifyDbResults(r)); });
}
test("TAP summaries cannot hide bad plans, errors, bailouts or extra runs", () => {
  const file = Object.keys(requiredSuites)[0], log = retainedLog(file);
  for (const text of ["", log.replace("Tests=6", "Tests=5"), `${log}\nnot ok 1\n`, `${log}\nBail out!\n`,
    `${log}\nERROR: hidden\n`, `${log}\nParse errors: Bad plan\n`, `${log}\n${log}`]) {
    assert.throws(() => parseSuiteLog(file, text, 0));
  }
  assert.throws(() => parseSuiteLog(file, log, 1));
});
test("collector publishes only normalized results with verified checksums", () => {
  temporary(directory => {
    const raw = path.join(directory, "raw"), out = path.join(directory, "out"), report = fixture();
    report.tools.private = "DO_NOT_DISCLOSE";
    report.securityBefore.private = "DO_NOT_DISCLOSE";
    writeRaw(raw, report);
    assert.equal(collectEvidence(raw, out), true);
    assert.equal(verifyEvidence(out), true);
    assert.ok(!readFileSync(path.join(out, "result.json"), "utf8").includes("DO_NOT_DISCLOSE"));
    writeFileSync(path.join(out, "suite-results.json"), "[]\n");
    assert.throws(() => verifyEvidence(out));
  });
});
test("incomplete collection, malformed exit status and raw secrets fail without leakage", () => {
  temporary(directory => {
    const raw = path.join(directory, "raw"), out = path.join(directory, "out");
    writeRaw(raw, fixture());
    writeFileSync(path.join(raw, "execution.json"), '{"exitCode":1,"secret":"DO_NOT_DISCLOSE"}');
    assert.equal(collectEvidence(raw, out), false);
    assert.equal(JSON.parse(readFileSync(path.join(out, "result.json"))).success, false);
    assert.ok(!readFileSync(path.join(out, "result.json"), "utf8").includes("DO_NOT_DISCLOSE"));
    assert.throws(() => verifyEvidence(out));
    writeFileSync(path.join(raw, "execution.json"), '{"exitCode":0}');
    writeFileSync(path.join(raw, `${Object.keys(requiredSuites)[0]}.exit`), "");
    assert.equal(collectEvidence(raw, out), false);
    writeFileSync(path.join(raw, `${Object.keys(requiredSuites)[0]}.exit`), "0");
    rmSync(path.join(raw, "cleanup.json"));
    assert.equal(collectEvidence(raw, out), false);
    assert.equal(JSON.parse(readFileSync(path.join(out, "result.json"))).cleanup, "UNVERIFIED");
    const cli = spawnSync(process.execPath, [path.join(root, "scripts/ci/verify-db-results.mjs"), "--verify", path.join(directory, "missing")], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.ok(!`${cli.stdout}${cli.stderr}`.includes(directory));
  });
});
test("evidence rejects unknown artifacts instead of copying private raw files", () => {
  temporary(directory => {
    const raw = path.join(directory, "raw"), out = path.join(directory, "out");
    writeRaw(raw, fixture());
    mkdirSync(out);
    writeFileSync(path.join(out, "private.log"), "DO_NOT_DISCLOSE");
    assert.throws(() => collectEvidence(raw, out));
    assert.throws(() => verifyEvidence(out));
  });
});
function assertWorkflowVerificationGate(workflow) {
  const gate = workflow.match(/^  backend-ci-success:\r?\n([\s\S]*?)(?=^  [\w-]+:\r?$|(?![\s\S]))/m)?.[1];
  assert.ok(gate, "backend-ci-success must exist");
  const jobs = ["unit-integrity", "database-pg15", "ratings-native-pg17"];
  const variables = ["UNIT_RESULT", "DATABASE_RESULT", "PG17_RESULT"];
  // Preserve the independent local Chat V2 gate whenever that job is installed.
  if (/^  chat-v2:\r?$/m.test(workflow)) {
    jobs.push("chat-v2");
    variables.push("CHAT_V2_RESULT");
  }
  jobs.push("ratings-hosted-readiness-pg17");
  variables.push("RATINGS_READINESS_RESULT");
  const needs = gate.match(/^    needs: \[([^\]\r\n]+)\]\r?$/m)?.[1].split(/,\s*/);
  assert.deepEqual(needs?.slice().sort(), jobs.slice().sort(), "all verification jobs must be required dependencies");
  assert.match(gate, /^    needs: .+\r?\n    if: \$\{\{ always\(\) \}\}\r?$/m);
  for (const [index, job] of jobs.entries()) {
    assert.match(workflow, new RegExp(`^  ${job}:\\r?$`, "m"), `${job} must exist`);
    assert.match(gate, new RegExp(`^          ${variables[index]}: \\$\\{\\{ needs\\.${job}\\.result \\}\\}\\r?$`, "m"), `${job} result must be bound`);
  }
  assert.match(workflow, /^  ratings-native-pg17:\r?\n    needs: unit-integrity\r?$/m);
  assert.match(workflow, /^  ratings-hosted-readiness-pg17:\r?\n    needs: unit-integrity\r?$/m);
  for (const job of ["ratings-native-pg17", "ratings-hosted-readiness-pg17"]) {
    const block = workflow.match(new RegExp(`^  ${job}:\\r?\\n([\\s\\S]*?)(?=^  [\\w-]+:\\r?$|(?![\\s\\S]))`, "m"))?.[1];
    assert.doesNotMatch(block, /continue-on-error|^\s+if:/m, `${job} cannot bypass or skip verification`);
  }
  assert.doesNotMatch(gate, /continue-on-error|^        if:/m, "aggregate step cannot bypass or skip verification");
  const condition = variables.map(variable => `"$${variable}" == success`).join(" && ");
  assert.deepEqual(gate.match(/^        run: .+$/gm)?.map(line => line.trimEnd()),
    [`        run: '[[ ${condition} ]]'`], "every verification result must equal success without a bypass");
}

function workflowGateFixture(chat = false) {
  const jobs = ["unit-integrity", "database-pg15", "ratings-native-pg17", ...(chat ? ["chat-v2"] : []), "ratings-hosted-readiness-pg17"];
  const variables = ["UNIT_RESULT", "DATABASE_RESULT", "PG17_RESULT", ...(chat ? ["CHAT_V2_RESULT"] : []), "RATINGS_READINESS_RESULT"];
  return jobs.map(job => `  ${job}:\n    needs: unit-integrity\n`).join("") +
    `  backend-ci-success:\n    needs: [${jobs.join(", ")}]\n    if: \$\{\{ always() \}\}\n    steps:\n      - name: Require every verification job\n        env:\n` +
    jobs.map((job, index) => `          ${variables[index]}: \$\{\{ needs.${job}.result \}\}\n`).join("") +
    `        run: '[[ ${variables.map(variable => `"$${variable}" == success`).join(" && ")} ]]'\n`;
}

test("workflow gate accepts all four mandatory jobs and preserves an installed Chat V2 gate", () => {
  assertWorkflowVerificationGate(workflowGateFixture());
  assertWorkflowVerificationGate(workflowGateFixture(true));
});
const gateChanges = {
  "missing PG17 dependency": workflow => workflow.replace(", ratings-native-pg17", ""),
  "missing PG17 job": workflow => workflow.replace("  ratings-native-pg17:\n    needs: unit-integrity\n", ""),
  "missing PG17 success condition": workflow => workflow.replace(' && "$PG17_RESULT" == success', ""),
  "incorrect PG17 result binding": workflow => workflow.replace("PG17_RESULT: ${{ needs.ratings-native-pg17.result }}", "PG17_RESULT: ${{ needs.unit-integrity.result }}"),
  "missing unit success condition": workflow => workflow.replace('"$UNIT_RESULT" == success && ', ""),
  "missing database success condition": workflow => workflow.replace('"$DATABASE_RESULT" == success && ', ""),
  "OR bypass": workflow => workflow.replace('&& "$PG17_RESULT"', '|| "$PG17_RESULT"'),
  "unconditional success bypass": workflow => workflow.replace(" ]]'", " ]] || true'"),
  "missing always condition": workflow => workflow.replace("    if: ${{ always() }}\n", ""),
  "missing readiness dependency": workflow => workflow.replace(", ratings-hosted-readiness-pg17]", "]"),
  "misspelled readiness dependency": workflow => workflow.replace("ratings-hosted-readiness-pg17]", "ratings-hosted-readiness-pg1]"),
  "extra unreviewed dependency": workflow => workflow.replace("ratings-hosted-readiness-pg17]", "ratings-hosted-readiness-pg17, unchecked]"),
  "missing readiness job": workflow => workflow.replace("  ratings-hosted-readiness-pg17:\n    needs: unit-integrity\n", ""),
  "missing readiness result binding": workflow => workflow.replace("          RATINGS_READINESS_RESULT: ${{ needs.ratings-hosted-readiness-pg17.result }}\n", ""),
  "incorrect readiness result binding": workflow => workflow.replace("RATINGS_READINESS_RESULT: ${{ needs.ratings-hosted-readiness-pg17.result }}", "RATINGS_READINESS_RESULT: ${{ needs.ratings-native-pg17.result }}"),
  "missing readiness success condition": workflow => workflow.replace(' && "$RATINGS_READINESS_RESULT" == success', ""),
  "readiness OR bypass": workflow => workflow.replace('&& "$RATINGS_READINESS_RESULT"', '|| "$RATINGS_READINESS_RESULT"'),
  "readiness nonfailure bypass": workflow => workflow.replace('"$RATINGS_READINESS_RESULT" == success', '"$RATINGS_READINESS_RESULT" != failure'),
  "readiness ignored failure": workflow => workflow.replace("  ratings-hosted-readiness-pg17:\n", "  ratings-hosted-readiness-pg17:\n    continue-on-error: true\n"),
  "readiness job skipped": workflow => workflow.replace("  ratings-hosted-readiness-pg17:\n    needs: unit-integrity\n", "  ratings-hosted-readiness-pg17:\n    needs: unit-integrity\n    if: false\n"),
  "readiness step skipped": workflow => workflow.replace("  ratings-hosted-readiness-pg17:\n    needs: unit-integrity\n", "  ratings-hosted-readiness-pg17:\n    needs: unit-integrity\n    steps:\n      - name: Verification\n        if: false\n"),
  "aggregate step skipped": workflow => workflow.replace("      - name: Require every verification job\n", "      - name: Require every verification job\n        if: false\n"),
  "aggregate ignored failure": workflow => workflow.replace("      - name: Require every verification job\n", "      - name: Require every verification job\n        continue-on-error: true\n"),
};
for (const [name, change] of Object.entries(gateChanges)) test(`workflow gate rejects ${name}`, () => {
  const workflow = workflowGateFixture();
  const altered = change(workflow);
  assert.notEqual(altered, workflow, "negative fixture must change the workflow");
  assert.throws(() => assertWorkflowVerificationGate(altered));
});
for (const variable of ["UNIT_RESULT", "DATABASE_RESULT", "PG17_RESULT", "RATINGS_READINESS_RESULT"]) {
  for (const result of ["failure", "cancelled", "skipped"]) test(`workflow gate rejects ${variable} accepting ${result}`, () => {
    assert.throws(() => assertWorkflowVerificationGate(workflowGateFixture().replace(`"$${variable}" == success`, `"$${variable}" == ${result}`)));
  });
}
test("workflow gate rejects removing an installed Chat V2 gate or success condition", () => {
  assert.throws(() => assertWorkflowVerificationGate(workflowGateFixture(true).replace(", chat-v2", "")));
  assert.throws(() => assertWorkflowVerificationGate(workflowGateFixture(true).replace(' && "$CHAT_V2_RESULT" == success', "")));
});

function executeFixtureGate(chat, rejectedVariable, rejectedResult) {
  const workflow = workflowGateFixture(chat);
  assertWorkflowVerificationGate(workflow);
  const command = workflow.match(/^        run: '(\[\[ .+ \]\])'$/m)[1];
  const variables = [...workflow.matchAll(/^          (\w+): \$\{\{ needs\./gm)].map(match => match[1]);
  // Run only the validated, fixed fixture expression, with no inherited secrets or shell startup hooks.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  for (const variable of variables) {
    if (variable === rejectedVariable && rejectedResult === undefined) continue;
    env[variable] = variable === rejectedVariable ? rejectedResult : "success";
  }
  const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", command],
    { env, encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  return result.status;
}
for (const chat of [false, true]) test(`workflow gate executes successfully only when every result succeeds (Chat V2 ${chat})`, () => {
  assert.equal(executeFixtureGate(chat), 0);
});
for (const variable of ["UNIT_RESULT", "DATABASE_RESULT", "PG17_RESULT", "CHAT_V2_RESULT", "RATINGS_READINESS_RESULT"]) {
  for (const result of [undefined, "", "failure", "failed", "cancelled", "skipped"]) {
    test(`workflow gate fails closed for ${variable} result ${result === undefined ? "missing" : JSON.stringify(result)}`, () => {
      const status = executeFixtureGate(true, variable, result);
      assert.notEqual(status, null, "gate must execute instead of relying on process termination");
      assert.notEqual(status, 0);
    });
  }
}

test("workflow and executor preserve the local-only fail-closed boundaries", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/backend-ci.yml"), "utf8");
  assert.match(workflow, /database-pg15:\r?\n\s+needs: unit-integrity/);
  assertWorkflowVerificationGate(workflow);
  assert.doesNotMatch(workflow, /continue-on-error|pull_request_target|secrets\./);
  assert.match(workflow, /branches: \[main\]/);
  assert.doesNotMatch(workflow, /branches: \[[^\]]*chore\/backend-extraction-baseline/);
  const script = readFileSync(path.join(root, "scripts/ci/run-local-db.sh"), "utf8");
  // Registry switch never changes image identity or relaxes pin enforcement.
  assert.ok(script.includes('source_ref="${tag#public.ecr.aws/}"'));
  assert.ok(script.includes('source_ref="${source_ref%:*}@$digest"'));
  assert.ok(script.includes('docker pull --platform linux/amd64 "$source_ref"'));
  assert.ok(!script.includes('docker pull --platform linux/amd64 "$ref"'));
  assert.ok(script.includes('else docker tag "$source_ref" "$tag"; fi'));
  assert.ok(script.includes('"docker.io/"+reference'));
  assert.match(script, /--driver bridge --ipv6/);
  assert.doesNotMatch(script, /--driver bridge --internal/);
  assert.match(script, /com\.docker\.network\.bridge\.host_binding_ipv4=127\.0\.0\.1/);
  assert.match(script, /sudo -n iptables -w -I DOCKER-USER 1/);
  assert.match(script, /sudo -n ip6tables -w -I DOCKER-USER 1/);
  assert.match(script, /sudo -n iptables -w -D DOCKER-USER/);
  assert.match(script, /sudo -n ip6tables -w -D DOCKER-USER/);
  assert.match(script, /failure_stage=firewall-verify/);
  assert.ok(script.indexOf("verify_host_firewall\n# Verify implicit") < script.indexOf('cli_local db start >'));
  assert.ok(isolationKeys.includes("firewallIsolated") && !isolationKeys.includes("internalNetwork"));
  assert.ok(cleanupKeys.includes("firewallRemoved"));
  assert.match(script, /DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock/);
  assert.match(script, /trap cleanup EXIT/);
  assert.ok(script.indexOf('check_isolation "$raw/isolation-before.json"') < script.indexOf('cli_local migration up --local'));
  assert.match(script, /cli_local test db --local "supabase\/tests\/\$file"/);
  assert.doesNotMatch(script, /--linked|--db-url|--project-ref|docker (?:system|container|volume|network) prune|--network host/);
  const sql = readFileSync(path.join(root, "scripts/ci/assert-local-security.sql"), "utf8");
  assert.match(sql, /BEGIN READ ONLY/);
  assert.match(sql, /'column_dml'/);
  assert.match(sql, /has_column_privilege\('authenticated',c\.oid,a\.attnum,'UPDATE'\)/);
  assert.match(sql, /has_table_privilege\('authenticated',c\.oid,'DELETE'\)/);
  // Explicit column-level INSERT/UPDATE grants are intentional for seller uploads.
  // The older table-only privilege check incorrectly returned false for these roles.
  for (const role of ["anon", "authenticated"]) {
    assert.ok(sql.includes(`has_any_column_privilege('${role}',c.oid,'INSERT,UPDATE')`));
    assert.ok(sql.includes(`has_table_privilege('${role}',c.oid,'DELETE')`));
    assert.ok(!sql.includes(`has_table_privilege('${role}',c.oid,'INSERT,UPDATE,DELETE')`));
  }
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\s+(?:TABLE|FUNCTION|INTO|FROM)\b/i);
});
