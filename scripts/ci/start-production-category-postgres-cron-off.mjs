// Task-scoped Docker CLI adapter: modify only the expected disposable PG17 launch.
// Never change Supabase CLI, image digests, historical SQL, or any hosted instance.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.167";
const ALLOWED_DIGEST = "sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb";
const images = Object.freeze([
  ALLOWED_IMAGE,
  "public.ecr.aws/supabase/postgres@" + ALLOWED_DIGEST,
  "ghcr.io/supabase/postgres@" + ALLOWED_DIGEST,
]);

export function rewriteOwnedPostgresLaunch(args, database) {
  assert.match(database, /^supabase_db_fairswap-category-[a-f0-9]{16}$/);
  const named = args.some((x, i) => (x === "--name" && args[i + 1] === database) || x === "--name=" + database);
  if (args[0] !== "create") {
    assert.equal(named, false, "Unexpected Docker operation targeting PG17 database");
    return { args: [...args], changed: false };
  }
  if (!named) return { args: [...args], changed: false };
  const optionArgs = args.slice(1, -3);
  assert.equal(optionArgs.filter(x => x === "--name").length, 1);
  const n = optionArgs.indexOf("--name");
  assert.equal(optionArgs[n + 1], database);
  assert.equal(optionArgs.filter(x => x === "--entrypoint").length, 1);
  assert.equal(optionArgs[optionArgs.indexOf("--entrypoint") + 1], "sh");
  assert.ok(!optionArgs.some(x => x.startsWith("--name=") || x.startsWith("--entrypoint=") || x.startsWith("--label-file")));
  const labels = [];
  for (let i = 0; i < optionArgs.length; i++) {
    if (optionArgs[i] === "--label") labels.push(optionArgs[++i]);
    else if (optionArgs[i].startsWith("--label=")) labels.push(optionArgs[i].slice("--label=".length));
  }
  const project = database.slice("supabase_db_".length);
  for (const key of ["com.supabase.cli.project", "com.docker.compose.project"]) {
    assert.deepEqual(labels.filter(x => x.startsWith(key + "=")), [key + "=" + project]);
  }
  assert.ok(images.includes(args.at(-3)), "Unexpected PostgreSQL image");
  assert.equal(args.at(-2), "-c");
  const script = args.at(-1);
  assert.equal(typeof script, "string");
  const line = "exec docker-entrypoint.sh postgres -D /etc/postgresql \n";
  assert.equal(script.split(line).length, 2, "PostgreSQL bootstrap shape changed");
  assert.ok(script.includes("cat <<'EOF' > /etc/postgresql.schema.sql"));
  assert.ok(script.includes("cat <<'EOF' >> /etc/postgresql/postgresql.conf"));
  assert.ok(!script.includes("/etc/backup.sql"));
  assert.equal((script.match(/^exec docker-entrypoint\.sh /gm) || []).length, 1);
  const replaced = script.replace(line, line.replace(" \n", " -c cron.launch_active_jobs=off\n"));
  assert.notEqual(replaced, script);
  return { args: [...args.slice(0, -1), replaced], changed: true };
}

function checkTask(realDocker, marker, expectedImageId, database, env) {
  assert.ok(path.isAbsolute(realDocker) && path.isAbsolute(marker));
  assert.equal(path.basename(marker), "startup-override.json");
  const task = path.dirname(marker);
  assert.match(path.basename(task), /^fairswap-category-rehearsal\.[A-Za-z0-9]{8}$/);
  assert.equal(realpathSync(task), task);
  assert.ok(lstatSync(task).isDirectory() && !lstatSync(task).isSymbolicLink());
  assert.equal(env.FAIRSWAP_CATEGORY_REHEARSAL_ONLY, "1");
  assert.equal(realpathSync(env.FAIRSWAP_CATEGORY_REHEARSAL_TASK), task);
  assert.equal(env.FAIRSWAP_EXPECTED_PG_IMAGE_ID, expectedImageId);
  assert.match(expectedImageId, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!realDocker.startsWith(task + path.sep));
  assert.match(database, /^supabase_db_fairswap-category-[a-f0-9]{16}$/);
}
export function runOwnedDocker(realDocker, database, marker, expectedImageId, args, { run = spawnSync, env = process.env } = {}) {
  checkTask(realDocker, marker, expectedImageId, database, env);
  const updated = rewriteOwnedPostgresLaunch(args, database);
  if (updated.changed) {
    assert.ok(!existsSync(marker), "PostgreSQL adapter cannot run twice");
    const inspect = run(realDocker, ["image", "inspect", "-f", "{{.Id}}", args.at(-3)], {
      encoding: "utf8", stdio: ["inherit", "pipe", "pipe"],
    });
    assert.ok(!inspect.error && !inspect.signal && inspect.status === 0);
    assert.equal(inspect.stdout.trim(), expectedImageId, "PG image ID changed");
  }
  const result = run(realDocker, updated.args, { stdio: "inherit" });
  if (result.error || result.signal || !Number.isInteger(result.status) || result.status !== 0) {
    return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
  }
  if (updated.changed) writeFileSync(marker, '{"serverCronOff":true}\n', { flag: "wx", mode: 0o600 });
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [realDocker, database, marker, imageId, ...args] = process.argv.slice(2);
    process.exitCode = runOwnedDocker(realDocker, database, marker, imageId, args);
  } catch {
    // Do not leak command lines, SQL, image authentication, or private paths.
    console.error("FAIL: strict disposable PostgreSQL cron-off startup adapter rejected");
    process.exitCode = 1;
  }
}
