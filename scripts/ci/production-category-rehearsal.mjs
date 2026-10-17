import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verify as verifyImmutablePlan } from "./verify-production-category-release.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RELEASE = join(ROOT, "releases/production/category-foundation-v1");
const JSON_FILE = join(RELEASE, "manifest.json");
const expectedRelease = "category-foundation-v1";
const hash = data => createHash("sha256").update(data).digest("hex");
const fail = (condition, message) => { if (!condition) throw new Error(message); };
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const exactSql = name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name);
const mustBeLocal = dir => {
  fail(process.env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY === "1", "Rehearsal-only authorization marker missing");
  for (const key of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "DATABASE_URL", "PGHOST", "PGSERVICE"]) {
    fail(!process.env[key], "Hosted database environment variable present: " + key);
  }
  const path = resolve(dir);
  fail(path.startsWith("/tmp/fairswap-category-rehearsal.") || path.includes("/_temp/fairswap-category-rehearsal."), "Refusing unsafe rehearsal working directory");
  fail(!path.includes(".."), "Unsafe working directory");
  return path;
};
export function approvedPlan(root = ROOT) {
  verifyImmutablePlan(root);
  const plan = readJson(join(root, "releases/production/category-foundation-v1/manifest.json"));
  fail(plan.releaseId === expectedRelease && plan.status === "PREPARATION_ONLY_NOT_APPROVED_FOR_EXECUTION", "Not a preparation-only release");
  fail(plan.productionBaseline.postgresVersion === "17.6" && plan.productionBaseline.migrationCount === 45, "Unexpected Production baseline");
  fail(plan.candidateSourceMigrations.length === 7, "Expected 7 candidates");
  const filenames = readdirSync(join(root, "supabase/migrations")).filter(exactSql);
  const hashes = new Map(readFileSync(join(root, "docs/extraction/MIGRATION_MANIFEST.sha256"), "utf8").trim().split("\n").map(line => {
    const match = /^([a-f0-9]{64})  (supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql)$/.exec(line);
    fail(match, "Invalid canonical manifest line");
    return [match[2], match[1]];
  }));
  fail(hashes.size === 58, "Expected 58 canonical source hashes");
  const baseline = plan.productionBaseline.appliedVersions.map(version => {
    const matches = filenames.filter(name => name.startsWith(version + "_"));
    fail(matches.length === 1, "Missing or ambiguous baseline source " + version);
    const source = "supabase/migrations/" + matches[0];
    fail(hashes.has(source) && hash(readFileSync(join(root, source))) === hashes.get(source), "Changed baseline SQL: " + source);
    return { version, source, sha256: hashes.get(source) };
  });
  fail(new Set(baseline.map(row => row.version)).size === 45, "Duplicate baseline version");
  fail(baseline[44].version === "20261013235311", "Baseline tip drift");
  for (const row of plan.candidateSourceMigrations) {
    fail(hashes.get(row.path) === row.sha256, "Candidate manifest mismatch");
    fail(hash(readFileSync(join(root, row.path))) === row.sha256, "Candidate source drift");
    fail(!baseline.some(item => item.source === row.path), "Candidate already applied");
  }
  return { baseline, candidates: plan.candidateSourceMigrations, projectRef: plan.targetProjectRef };
}
export function prepare(workDir, root = ROOT) {
  const dir = mustBeLocal(workDir);
  fail(!existsSync(dir), "Rehearsal target exists");
  const { baseline } = approvedPlan(root);
  const migrationDir = join(dir, "supabase/migrations");
  mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
  const projectId = "fairswap-category-" + randomBytes(8).toString("hex");
  const portBase = 30000 + Math.floor(Math.random() * 22000);
  writeFileSync(join(dir, "supabase/config.toml"), `project_id = "${projectId}"
[db]
port = ${portBase}
shadow_port = ${portBase + 1}
major_version = 17
[api]
enabled = false
port = ${portBase + 2}
[studio]
enabled = false
[auth]
enabled = true
[storage]
enabled = true
[realtime]
enabled = true
[analytics]
enabled = false
[edge_runtime]
enabled = false
[local_smtp]
enabled = false
port = ${portBase + 3}
`, { mode: 0o600 });
  for (const row of baseline) {
    copyFileSync(join(root, row.source), join(migrationDir, basename(row.source)));
  }
  const stage = { releaseId: expectedRelease, projectId, postgres: "17.6", baselineVersions: baseline.map(x => x.version), candidates: [] };
  writeFileSync(join(dir, "rehearsal.json"), JSON.stringify(stage, null, 2) + "\n", { mode: 0o600 });
  return stage;
}
export function checkLedger(input, stageFile, expectedCount) {
  const stage = readJson(stageFile);
  const observed = input.trim().split(",").filter(Boolean);
  const baseline = stage.baselineVersions;
  const expected = expectedCount === 45 ? baseline : [...baseline, ...stage.candidates.map(x => x.version)].sort();
  fail(expectedCount === 45 || expectedCount === 52, "Unsupported ledger target");
  fail(observed.length === expectedCount && JSON.stringify(observed) === JSON.stringify(expected), "Migration history mismatch for expected " + expectedCount);
  return true;
}
export function stageCandidates(workDir, cliPath, root = ROOT) {
  const dir = mustBeLocal(workDir);
  const marker = join(dir, "baseline-confirmed");
  fail(readFileSync(marker, "utf8").trim() === "45", "45-migration baseline has not been verified");
  const stagePath = join(dir, "rehearsal.json");
  const stage = readJson(stagePath);
  fail(stage.candidates.length === 0, "Candidates already staged");
  const plan = approvedPlan(root);
  const migrationDir = join(dir, "supabase/migrations");
  fail(readdirSync(migrationDir).filter(exactSql).length === 45, "Unexpected baseline staging inventory");
  for (const [i, row] of plan.candidates.entries()) {
    const before = new Set(readdirSync(migrationDir));
    const suffix = basename(row.path, ".sql").replace(/^\d{14}_/, "");
    const migrationName = "category_foundation_" + String(i + 1).padStart(2, "0") + "_" + suffix;
    const child = spawnSync(cliPath, ["migration", "new", migrationName, "--workdir", dir],
      { cwd: dir, encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "/tmp", SUPABASE_SKIP_UPDATE_CHECK: "true" } });
    fail(child.status === 0, "Supabase CLI failed to allocate a forward migration");
    const added = readdirSync(migrationDir).filter(name => !before.has(name));
    fail(added.length === 1 && exactSql(added[0]), "Expected exactly one new CLI-generated migration");
    const version = added[0].slice(0, 14);
    fail(version > "20261013235311" && !stage.candidates.some(x => x.version === version), "Forward version collision or regression");
    copyFileSync(join(root, row.path), join(migrationDir, added[0]));
    fail(hash(readFileSync(join(migrationDir, added[0]))) === row.sha256, "Forward SQL bytes mismatch");
    stage.candidates.push({ source: row.path, file: added[0], version, sha256: row.sha256 });
    writeFileSync(stagePath, JSON.stringify(stage, null, 2) + "\n", { mode: 0o600 });
    if (i < 6) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  }
  fail(readdirSync(migrationDir).filter(exactSql).length === 52, "Rehearsal inventory is not 52 migrations");
  return stage;
}
export function verifyPrepared(workDir, root = ROOT) {
  const dir = mustBeLocal(workDir);
  const stage = readJson(join(dir, "rehearsal.json"));
  const plan = approvedPlan(root);
  fail(stage.candidates.length === 7, "Incomplete candidate staging");
  fail(stage.baselineVersions.length === 45, "Incomplete baseline staging");
  for (const row of stage.candidates) {
    fail(plan.candidates.some(x => x.path === row.source && x.sha256 === row.sha256), "Unapproved candidate in staging");
    fail(hash(readFileSync(join(dir, "supabase/migrations", row.file))) === row.sha256, "Altered staged migration");
  }
  fail(new Set(stage.candidates.map(x => x.version)).size === 7, "Duplicate forward version");
  fail(stage.candidates.every(x => x.version > stage.baselineVersions.at(-1)), "Non-forward migration version");
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === "--verify-source" && args.length === 0) {
      const p = approvedPlan(); console.log("PASS: 45 baseline and 7 candidates, source hashes verified", p.baseline.length, p.candidates.length);
    } else if (mode === "--prepare" && args.length === 1) {
      const p = prepare(args[0]); console.log("PASS: staged 45 source migrations into isolated project", p.projectId);
    } else if (mode === "--check-ledger" && args.length === 2) {
      checkLedger(readFileSync(0, "utf8"), args[0], Number(args[1])); console.log("PASS: exact ledger", args[1]);
    } else if (mode === "--stage" && args.length === 2) {
      const p = stageCandidates(args[0], args[1]); console.log("PASS: 7 forward SQL copies created by Supabase CLI", p.candidates.length);
    } else if (mode === "--verify-staged" && args.length === 1) {
      verifyPrepared(args[0]); console.log("PASS: 52 exact staged migration source hashes");
    } else throw new Error("Unsupported arguments");
  } catch (error) {
    console.error("FAIL: guarded category rehearsal plan - " + error.message);
    process.exitCode = 1;
  }
}
