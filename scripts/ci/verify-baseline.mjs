import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMigrationManifest } from "../verify-migration-manifest.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const manifestSha256 = "eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd";

export function verifyBaseline(root = repositoryRoot) {
  const bytes = readFileSync(path.join(root, "docs/extraction/MIGRATION_MANIFEST.sha256"));
  if (createHash("sha256").update(bytes).digest("hex") !== manifestSha256) {
    throw new Error("Approved migration manifest raw SHA-256 mismatch");
  }
  const count = verifyMigrationManifest(root);
  if (count !== 58) throw new Error("Expected exactly 58 canonical migrations");
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("No command-line arguments are accepted");
    console.log(`PASS: approved manifest digest and ${verifyBaseline()} canonical migration byte hashes`);
  } catch {
    console.error("FAIL: approved migration baseline integrity check");
    process.exitCode = 1;
  }
}
