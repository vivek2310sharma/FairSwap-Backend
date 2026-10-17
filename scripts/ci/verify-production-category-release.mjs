import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { verifyMigrationManifest } from "../verify-migration-manifest.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "releases/production/category-foundation-v1";
export const ALLOWLIST = Object.freeze([
  "20261009201151_two_wheeler_draft_v1.sql",
  "20261009202059_two_wheeler_catalogue_lookup.sql",
  "20261009203141_two_wheeler_unresolved_mapping_correction.sql",
  "20261009215128_two_wheeler_reference_errors.sql",
  "20261010064518_car_draft_v1.sql",
  "20261010084523_property_rental_draft_v1.sql",
  "20261010091239_property_scoped_draft_lock.sql",
]);
export const EXCLUSIONS = Object.freeze([
  "20261009203412_enable_test_two_wheeler_draft_categories",
  "20261010064519_enable_test_car_draft_categories",
  "20261010084524_enable_test_property_rental_drafts",
  "20261011092234_test_family_submission_v1",
  "20261011095100_enable_test_family_submission_v1",
  "20261012120000_post_ad_current_base_compatibility",
  "20261010214201_staff_listing_review_context",
  "20261017125456_stage3_experimental_finalizer_staging_validation",
  "20261017172840_fairswaptest_restore_moderation_enqueue_for_acceptance",
]);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validateReleasePlan(plan, manifestText, readText) {
  assert(plan?.schema === 1 && plan.releaseId === "category-foundation-v1", "Invalid release identity");
  assert(plan.status === "PREPARATION_ONLY_NOT_APPROVED_FOR_EXECUTION", "Release must remain non-executable");
  assert(plan.targetProjectRef === "kriuhwppxgxsyyrbjsau", "Unexpected production target");
  assert(plan.productionBaseline?.postgresVersion === "17.6", "Changed PostgreSQL baseline");
  assert(plan.productionBaseline?.migrationCount === 45, "Unexpected production migration count");
  assert(plan.productionBaseline?.finalizerBodyMd5 === "118d04445fdd9139d90decd2048945f1", "Changed Goods moderation finalizer pin");
  assert(Array.isArray(plan.productionBaseline.appliedVersions) && plan.productionBaseline.appliedVersions.length === 45, "Expected 45 applied migration versions");
  assert(new Set(plan.productionBaseline.appliedVersions).size === 45, "Duplicate applied migration version");
  assert(same([...plan.productionBaseline.appliedVersions].sort(), plan.productionBaseline.appliedVersions), "Unsorted production migration versions");
  assert(plan.productionBaseline.appliedVersions.at(-1) === "20261013235311", "Unexpected final baseline migration version");
  assert(plan.configuration?.newListingsEnabled === false && plan.configuration?.experimentalPublicPublicationAllowed === false && plan.configuration?.stageOneCreatesOnlyHiddenDraftFoundations === true, "Experimental publication must stay blocked");
  assert(Object.values(plan.releaseGates || {}).length === 4 && Object.values(plan.releaseGates).every(v => v === false), "No release gate may be claimed complete by static source review");
  assert(same(plan.excludedTestOrRiskyMigrations, EXCLUSIONS), "Test-only exclusion list was changed");
  assert(Array.isArray(plan.candidateSourceMigrations) && same(plan.candidateSourceMigrations.map(x => x.path), ALLOWLIST.map(x => "supabase/migrations/" + x)), "Candidate migration allowlist drift");
  const manifest = new Map(manifestText.trim().split("\n").map(line => {
    const match = /^([a-f0-9]{64})  (supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql)$/.exec(line);
    assert(!!match, "Invalid source checksum manifest");
    return [match[2], match[1]];
  }));
  assert(manifest.size === 58, "Canonical source migration manifest must have 58 entries");
  assert(plan.productionBaseline.appliedVersions.every(version => [...manifest.keys()].some(path => path.endsWith("/" + version + "_" + path.split("/").at(-1).split("_").slice(1).join("_")))), "Production version absent from baseline");
  for (const {path,sha256} of plan.candidateSourceMigrations) {
    assert(/^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/.test(path), "Unexpected SQL path");
    assert(typeof sha256 === "string" && sha256 === manifest.get(path), "Candidate source SHA-256 differs from approved baseline");
    const sql = readText(path);
    assert(createHash("sha256").update(sql).digest("hex") === sha256, "Candidate SQL bytes changed: " + path);
    assert(!sql.includes("wpppxlnbzqynvhpeuavd") && !sql.includes("kriuhwppxgxsyyrbjsau"), "Target-specific migration cannot be in allowlist");
    assert(!/\bupdate\s+public\.categories\s+\w*\s*set\s+(?:is_active|new_listing_enabled)\s*=\s*true/i.test(sql), "Category activation SQL in allowlist");
  }
  for (const id of EXCLUSIONS) {
    assert(!plan.candidateSourceMigrations.some(z => z.path.includes(id)), "Test-only migration included: " + id);
  }
  const pre = readText(BASE + "/preflight.readonly.sql");
  const post = readText(BASE + "/postflight.readonly.sql");
  assert(pre.includes("45-version snapshot") && pre.includes("kriuhwppxgxsyyrbjsau") && pre.includes("118d04445fdd9139d90decd2048945f1"), "Production preflight was weakened");
  assert(post.includes("experimental categories became publicly available") && post.includes("Goods finalizer unexpectedly changed") && post.includes("52"), "Fail-closed postflight was weakened");
  return { approvedMigrations: plan.candidateSourceMigrations.length, baselineMigrations: manifest.size, productionBaselineCount: plan.productionBaseline.migrationCount };
}
export function verify(root = ROOT) {
  verifyMigrationManifest(root);
  const source = name => readFileSync(join(root, name), "utf8");
  return validateReleasePlan(JSON.parse(source(BASE + "/manifest.json")), source("docs/extraction/MIGRATION_MANIFEST.sha256"), source);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const outcome = verify(); console.log("PASS: read-only Production category release allowlist", outcome); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
