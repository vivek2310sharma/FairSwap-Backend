import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function verifyMigrationManifest(root = repositoryRoot) {
  const manifest = readFileSync(path.join(root, "docs/extraction/MIGRATION_MANIFEST.sha256"), "utf8");
  const lines = manifest.endsWith("\n") ? manifest.slice(0, -1).split("\n") : manifest.split("\n");
  if (lines.length !== 58) throw new Error(`Expected 58 manifest entries; found ${lines.length}`);
  const entries = lines.map((line, index) => {
    const match = /^([a-f0-9]{64})  (supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql)$/.exec(line);
    if (!match) throw new Error(`Malformed manifest entry at line ${index + 1}`);
    return { hash: match[1], file: match[2] };
  });
  const paths = entries.map(entry => entry.file);
  if (new Set(paths).size !== 58) throw new Error("Duplicate migration paths in manifest");
  if (paths.some((file, index) => index > 0 && file <= paths[index - 1])) {
    throw new Error("Manifest paths must be strictly sorted");
  }
  const diskPaths = readdirSync(path.join(root, "supabase/migrations"), { withFileTypes: true })
    .filter(entry => entry.name.endsWith(".sql"))
    .map(entry => {
      if (!entry.isFile()) throw new Error(`Migration must be a regular file: ${entry.name}`);
      return `supabase/migrations/${entry.name}`;
    }).sort();
  if (JSON.stringify(paths) !== JSON.stringify(diskPaths)) {
    throw new Error("Manifest paths do not exactly match SQL files on disk (missing or additional migration)");
  }
  for (const entry of entries) {
    const actual = createHash("sha256").update(readFileSync(path.join(root, entry.file))).digest("hex");
    if (actual !== entry.hash) throw new Error(`Migration SHA-256 mismatch: ${entry.file}`);
  }
  return entries.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`PASS: ${verifyMigrationManifest()} migration files match the manifest`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Migration verification failed");
    process.exitCode = 1;
  }
}
