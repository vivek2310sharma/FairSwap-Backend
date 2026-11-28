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
// The gate under test is the real backend-ci-success job, not a model of it.
const STRICT_JOBS = [
  ["changes", "CHANGES_RESULT"], ["unit-integrity", "UNIT_RESULT"], ["ratings-native-pg17", "PG17_RESULT"],
  ["ratings-hosted-readiness-pg17", "RATINGS_READINESS_RESULT"], ["chat-inbox-native-pg17", "CHAT_INBOX_RESULT"],
];
const SKIPPABLE_JOBS = [["database-pg15", "DATABASE_RESULT", "pg15", "PG15_RELEVANT"], ["forward-db-pg15", "FORWARD_RESULT", "forward", "FORWARD_RELEVANT"]];
const realWorkflow = () => readFileSync(path.join(root, ".github/workflows/backend-ci.yml"), "utf8");
const gateBlock = workflow => workflow.match(/^  backend-ci-success:\r?\n([\s\S]*?)(?=^  [\w-]+:\r?$|(?![\s\S]))/m)?.[1];
const jobBlock = (workflow, job) => workflow.match(new RegExp(`^  ${job}:\\r?\\n([\\s\\S]*?)(?=^  [\\w-]+:\\r?$|(?![\\s\\S]))`, "m"))?.[1];

function assertWorkflowVerificationGate(workflow) {
  const gate = gateBlock(workflow);
  assert.ok(gate, "backend-ci-success must exist");
  const jobs = [...STRICT_JOBS.map(([job]) => job), ...SKIPPABLE_JOBS.map(([job]) => job)];
  const needs = gate.match(/^    needs: \[([^\]\r\n]+)\]\r?$/m)?.[1].split(/,\s*/);
  assert.deepEqual(needs?.slice().sort(), jobs.slice().sort(), "all verification jobs must be required dependencies");
  assert.match(gate, /^    needs: .+\r?\n    if: \$\{\{ always\(\) \}\}\r?$/m);
  for (const [job, variable] of [...STRICT_JOBS, ...SKIPPABLE_JOBS.map(([job, variable]) => [job, variable])]) {
    assert.match(workflow, new RegExp(`^  ${job}:\\r?$`, "m"), `${job} must exist`);
    assert.match(gate, new RegExp(`^          ${variable}: \\$\\{\\{ needs\\.${job}\\.result \\}\\}\\r?$`, "m"), `${job} result must be bound`);
  }
  for (const [job, , output, variable] of SKIPPABLE_JOBS) {
    assert.match(gate, new RegExp(`^          ${variable}: \\$\\{\\{ needs\\.changes\\.outputs\\.${output} \\}\\}\\r?$`, "m"));
    const block = jobBlock(workflow, job);
    assert.match(block, new RegExp(`^    needs: \\[unit-integrity, changes\\]\\r?\\n    if: \\$\\{\\{ needs\\.changes\\.outputs\\.${output} == 'true' \\}\\}\\r?$`, "m"), `${job} skip must come only from the fail-open filter`);
  }
  assert.match(workflow, /^  ratings-native-pg17:\r?\n    needs: unit-integrity\r?$/m);
  assert.match(workflow, /^  ratings-hosted-readiness-pg17:\r?\n    needs: ratings-native-pg17\r?\n    if: \$\{\{ always\(\) \}\}\r?$/m);
  assert.match(workflow, /^  chat-inbox-native-pg17:\r?\n    needs: ratings-native-pg17\r?\n    if: \$\{\{ always\(\) \}\}\r?$/m);
  assert.doesNotMatch(jobBlock(workflow, "unit-integrity"), /continue-on-error|^    if:/m, "unit-integrity cannot bypass verification");
  for (const job of ["ratings-native-pg17", "ratings-hosted-readiness-pg17", "chat-inbox-native-pg17"]) {
    const steps = jobBlock(workflow, job).replace(/^    if: \$\{\{ always\(\) \}\}\r?\n/m, "");
    assert.doesNotMatch(steps, /continue-on-error|^\s+if:/m, `${job} cannot bypass or skip verification`);
  }
  assert.doesNotMatch(gate, /continue-on-error|^        if:/m, "aggregate step cannot bypass or skip verification");
  const run = gate.match(/^        run: \|\r?\n((?:          .*\r?\n?)+)/m)?.[1];
  assert.ok(run, "aggregate must have a reviewed script");
  const strict = STRICT_JOBS.map(([, variable]) => `"$${variable}" == success`).join(" && ");
  assert.ok(run.includes(`[[ ${strict} ]] || exit 1\n`), "every strict result must equal success without a bypass");
  for (const [, variable, , relevant] of SKIPPABLE_JOBS) assert.ok(run.includes(`skip_proven "$${variable}" "$${relevant}" || exit 1\n`));
  assert.ok(run.includes('skip_proven() { [[ "$1" == success || ( "$1" == skipped && "$CHANGES_RESULT" == success && "$2" == false ) ]]; }'));
  assert.doesNotMatch(run, /\|\|\s*true|\bexit 0\b|set \+e/);
  assert.equal(run.trimEnd().split(/\r?\n/).filter(line => !/^\s*#/.test(line)).length, 4, "no unreviewed gate command");
}

test("real aggregate gate depends on every verification job and has no bypass", () => {
  assertWorkflowVerificationGate(realWorkflow());
});

const gateChanges = {
  "missing PG17 dependency": w => w.replace(", ratings-native-pg17", ""),
  "missing PG17 job": w => w.replace("  ratings-native-pg17:\n    needs: unit-integrity\n", ""),
  "missing PG17 success condition": w => w.replace(' && "$PG17_RESULT" == success', ""),
  "incorrect PG17 result binding": w => w.replace("PG17_RESULT: ${{ needs.ratings-native-pg17.result }}", "PG17_RESULT: ${{ needs.unit-integrity.result }}"),
  "missing unit success condition": w => w.replace('"$UNIT_RESULT" == success && ', ""),
  "missing changes dependency": w => w.replace("needs: [changes, ", "needs: ["),
  "missing database dependency": w => w.replace(", database-pg15,", ","),
  "missing forward-package dependency": w => w.replace(", forward-db-pg15,", ","),
  "missing Chat inbox dependency": w => w.replace(", chat-inbox-native-pg17,", ","),
  "missing Chat inbox success condition": w => w.replace(' && "$CHAT_INBOX_RESULT" == success', ""),
  "missing filter success condition": w => w.replace('[[ "$CHANGES_RESULT" == success && ', "[[ "),
  "database skip without relevance proof": w => w.replace('skip_proven "$DATABASE_RESULT" "$PG15_RELEVANT"', 'skip_proven "$DATABASE_RESULT" false'),
  "forward skip without relevance proof": w => w.replace('skip_proven "$FORWARD_RESULT" "$FORWARD_RELEVANT"', '[[ "$FORWARD_RESULT" != failure ]]'),
  "skip accepted without filter success": w => w.replace(' && "$CHANGES_RESULT" == success && "$2" == false', ' && "$2" == false'),
  "skip accepted for any relevance": w => w.replace('"$2" == false', '"$2" != true'),
  "OR bypass": w => w.replace('&& "$PG17_RESULT"', '|| "$PG17_RESULT"'),
  "unconditional success bypass": w => w.replace('skip_proven "$FORWARD_RESULT" "$FORWARD_RELEVANT" || exit 1', 'skip_proven "$FORWARD_RESULT" "$FORWARD_RELEVANT" || true'),
  "unenforced strict check": w => w.replace('"$CHAT_INBOX_RESULT" == success ]] || exit 1', '"$CHAT_INBOX_RESULT" == success ]]'),
  "missing always condition": w => w.replace("    if: ${{ always() }}\n    runs-on: ubuntu-24.04\n    permissions: {}\n    timeout-minutes: 2\n    steps:\n      - name: Require every verification job", "    runs-on: ubuntu-24.04\n    permissions: {}\n    timeout-minutes: 2\n    steps:\n      - name: Require every verification job"),
  "missing readiness dependency": w => w.replace(", ratings-hosted-readiness-pg17]", "]"),
  "extra unreviewed dependency": w => w.replace("ratings-hosted-readiness-pg17]\n", "ratings-hosted-readiness-pg17, unchecked]\n"),
  "missing readiness job": w => w.replace("  ratings-hosted-readiness-pg17:\n    needs: ratings-native-pg17\n    if: ${{ always() }}\n", ""),
  "missing readiness result binding": w => w.replace("          RATINGS_READINESS_RESULT: ${{ needs.ratings-hosted-readiness-pg17.result }}\n", ""),
  "missing readiness success condition": w => w.replace(' && "$RATINGS_READINESS_RESULT" == success', ""),
  "readiness ignored failure": w => w.replace("  ratings-hosted-readiness-pg17:\n", "  ratings-hosted-readiness-pg17:\n    continue-on-error: true\n"),
  "native PG17 step skipped": w => w.replace("      - name: Require IDV native PG17 migration, RLS and Production v3-to-v1 assertions\n", "      - name: Require IDV native PG17 migration, RLS and Production v3-to-v1 assertions\n        if: false\n"),
  "database job filtered by a free-form condition": w => w.replace("if: ${{ needs.changes.outputs.pg15 == 'true' }}", "if: ${{ github.event_name == 'push' }}"),
  "aggregate step skipped": w => w.replace("        timeout-minutes: 1\n        env:\n          CHANGES_RESULT", "        timeout-minutes: 1\n        if: false\n        env:\n          CHANGES_RESULT"),
  "aggregate ignored failure": w => w.replace("        timeout-minutes: 1\n        env:\n          CHANGES_RESULT", "        timeout-minutes: 1\n        continue-on-error: true\n        env:\n          CHANGES_RESULT"),
};
for (const [name, change] of Object.entries(gateChanges)) test(`workflow gate rejects ${name}`, () => {
  const workflow = realWorkflow();
  const altered = change(workflow);
  assert.notEqual(altered, workflow, "negative fixture must change the workflow");
  assert.throws(() => assertWorkflowVerificationGate(altered));
});

function executeGate(overrides = {}) {
  const gate = gateBlock(realWorkflow());
  const run = gate.match(/^        run: \|\r?\n((?:          .*\r?\n?)+)/m)[1].replace(/^ {10}/gm, "");
  const env = { PATH: process.env.PATH };
  for (const [, variable] of [...STRICT_JOBS, ...SKIPPABLE_JOBS]) env[variable] = "success";
  env.PG15_RELEVANT = "true";
  env.FORWARD_RELEVANT = "true";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]; else env[key] = value;
  }
  // Run only the reviewed gate script, with no inherited secrets or shell startup hooks.
  const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", run], { env, encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  assert.notEqual(result.status, null, "gate must execute instead of relying on process termination");
  return result.status;
}
test("gate executes successfully when every job succeeds, whatever the relevance flags", () => {
  assert.equal(executeGate(), 0);
  assert.equal(executeGate({ PG15_RELEVANT: "false", FORWARD_RELEVANT: "" }), 0);
});
for (const [, variable] of STRICT_JOBS) {
  for (const result of [undefined, "", "failure", "failed", "cancelled", "skipped"]) {
    test(`gate fails closed for ${variable} result ${result === undefined ? "missing" : JSON.stringify(result)}`, () => {
      assert.notEqual(executeGate({ [variable]: result, PG15_RELEVANT: "false", FORWARD_RELEVANT: "false" }), 0);
    });
  }
}
for (const [, variable, , relevant] of SKIPPABLE_JOBS) {
  for (const result of [undefined, "", "failure", "failed", "cancelled"]) {
    test(`gate fails closed for ${variable} result ${result === undefined ? "missing" : JSON.stringify(result)} even when proven irrelevant`, () => {
      assert.notEqual(executeGate({ [variable]: result, [relevant]: "false" }), 0);
    });
  }
  for (const flag of ["true", "", "True", "0", "no", undefined]) {
    test(`a skipped ${variable} without the literal false (${flag === undefined ? "missing" : JSON.stringify(flag)}) never passes`, () => {
      assert.notEqual(executeGate({ [variable]: "skipped", [relevant]: flag }), 0);
    });
  }
  test(`a skipped ${variable} passes only when the filter succeeded and proved it irrelevant`, () => {
    assert.equal(executeGate({ [variable]: "skipped", [relevant]: "false" }), 0);
    for (const changes of ["failure", "skipped", "cancelled", "", undefined]) {
      assert.notEqual(executeGate({ [variable]: "skipped", [relevant]: "false", CHANGES_RESULT: changes }), 0);
    }
  });
}

test("workflow and executor preserve the local-only fail-closed boundaries", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/backend-ci.yml"), "utf8");
  assert.match(workflow, /database-pg15:\r?\n\s+needs: \[unit-integrity, changes\]/);
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

test("forward-package suites each run on their own clean baseline stack", () => {
  const script = readFileSync(path.join(root, "scripts/ci/run-forward-packages-db.sh"), "utf8");
  const calls = script.match(/^run_suite \S+ \S+_DB_URL run-\S+\.mjs$/gm);
  assert.deepEqual(calls?.map(call => call.split(" ")[1]), ["moderation-analytics", "profile-onboarding"]);
  // The stack, ports, project id and baseline migration are created inside run_suite, once per package.
  const body = script.slice(script.indexOf("run_suite() {"), script.indexOf("\nrun_suite moderation-analytics"));
  for (const needle of ["db start", "migration up --local", "project_id=", "stop_stack", "unset \"$url_var\"",
    "supabase_migrations.schema_migrations", "is not the clean baseline"]) assert.ok(body.includes(needle), needle);
  assert.equal(script.split("cli_local db start").length - 1, 1, "db start only inside run_suite");
  assert.ok(body.indexOf("is not the clean baseline") < body.indexOf("--execute"), "baseline proof precedes the suite");
  assert.doesNotMatch(script, /export (?:MODERATION_ANALYTICS|PROFILE_ONBOARDING)_DB_URL=/);
});
