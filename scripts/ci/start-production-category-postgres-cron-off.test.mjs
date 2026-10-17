import test from "node:test";
import assert from "node:assert/strict";
import { rewriteOwnedPostgresLaunch } from "./start-production-category-postgres-cron-off.mjs";

const name = "supabase_db_fairswap-category-0123456789abcdef";
const project = "fairswap-category-0123456789abcdef";
const image = "public.ecr.aws/supabase/postgres:17.6.1.167";
const script = [
  "cat <<'EOF' > /etc/postgresql.schema.sql", "bootstrap", "EOF",
  "cat <<'EOF' >> /etc/postgresql/postgresql.conf", "other safe config", "EOF",
  "exec docker-entrypoint.sh postgres -D /etc/postgresql ", "",
].join("\n");
const args = (source = script) => [
  "create", "--name", name,
  "--label", "com.supabase.cli.project=" + project,
  "--label", "com.docker.compose.project=" + project,
  "--entrypoint", "sh", image, "-c", source,
];
test("only one exact owned PG17 Docker create has launch-level cron disabled", () => {
  const changed = rewriteOwnedPostgresLaunch(args(), name);
  assert.equal(changed.changed, true);
  assert.match(changed.args.at(-1), /postgres -D \/etc\/postgresql -c cron\.launch_active_jobs=off\n$/);
  assert.equal((changed.args.at(-1).match(/cron\.launch_active_jobs=off/g) || []).length, 1);
  assert.equal(changed.args.at(-3), image);
});
test("unrelated container calls remain untouched", () => {
  const c = ["image", "inspect", "-f", "{{.Id}}", image];
  assert.deepEqual(rewriteOwnedPostgresLaunch(c, name), { args: c, changed: false });
});
test("fails closed for unexpected database identity or changed bootstrap", () => {
  assert.throws(() => rewriteOwnedPostgresLaunch(args(), "supabase_db_wrong"));
  assert.throws(() => rewriteOwnedPostgresLaunch(args("exec postgres -D /etc/postgresql\n"), name));
  assert.throws(() => rewriteOwnedPostgresLaunch(args().map(x => x === image ? "postgres:latest" : x), name));
  assert.throws(() => rewriteOwnedPostgresLaunch(args().filter(x => !x.includes("com.docker.compose.project=")), name));
  assert.throws(() => rewriteOwnedPostgresLaunch(["rm", name], name));
});
