#!/usr/bin/env bash
# Disposable-DB driver for the profile-onboarding forward package. NOT RUN locally.
# Native disposable Linux + Docker only (a GitHub-hosted ubuntu runner). Never run against, or
# with credentials for, a hosted Supabase project; it uses only a throwaway local stack whose
# DB port is bound to loopback. Reuses the CLI pin from scripts/ci/toolchain.json and the same
# start flow as the historical scripts/ci/run-local-db.sh (`db start` + a generated config.toml
# with explicit loopback-free ports + `migration up --local`), which stays untouched.
# CLI note: v2.117.0 (pinned) provides `supabase db start`; the pinned baseline runner uses it,
# so this driver does too. `supabase start` would also bring up the API gateway/Studio, which
# these SQL-level tests do not need.
set -euo pipefail
umask 077
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'FAIL: native Linux amd64 required' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)

# Fail closed: no hosted credentials or hosted project settings may be present in this job.
for v in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_SERVICE_ROLE_KEY SUPABASE_PROJECT_REF \
         SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY SUPABASE_JWT_SECRET NEXT_PUBLIC_SUPABASE_URL \
         DATABASE_URL POSTGRES_URL PGHOST PGPASSWORD PGSERVICEFILE PGSERVICE; do
  [[ -z ${!v:-} ]] || { echo "FAIL: $v must not be set" >&2; exit 1; }
done
unset PROFILE_ONBOARDING_DB_URL PROFILE_ONBOARDING_APPLY

task=$(mktemp -d "${RUNNER_TEMP:-/tmp}/fairswap-profile-onboarding.XXXXXXXX")
project="$task/project"
mkdir -p "$project/supabase/migrations" "$task/bin"
project_id="fairswap-po-$(node -p 'require("crypto").randomBytes(8).toString("hex")')"

cli_version=$(node -p "require('$root/scripts/ci/toolchain.json').database.cliVersion")
cli_url=$(node -p "require('$root/scripts/ci/toolchain.json').database.cliArchive")
cli_sha=$(node -p "require('$root/scripts/ci/toolchain.json').database.cliArchiveSha256")
curl -fsSL --proto '=https' --tlsv1.2 -o "$task/cli.tgz" "$cli_url"
[[ $(sha256sum "$task/cli.tgz" | cut -d' ' -f1) == "$cli_sha" ]] || { echo 'FAIL: CLI checksum mismatch' >&2; exit 1; }
tar -xzf "$task/cli.tgz" -C "$task/bin" supabase
cli="$task/bin/supabase"
[[ $("$cli" --version) == "$cli_version" ]] || { echo 'FAIL: CLI version mismatch' >&2; exit 1; }

cli_local() { (cd -- "$project" && "$cli" "$@" --workdir "$project"); }
cleanup() {
  (cd -- "$project" && "$cli" stop --project-id "$project_id" --no-backup --workdir "$project" >/dev/null 2>&1 || true)
  rm -rf -- "$task"
}
trap cleanup EXIT

export SUPABASE_SKIP_UPDATE_CHECK=true SUPABASE_INTERNAL_IMAGE_REGISTRY=public.ecr.aws

# Free loopback ports (DB, shadow, SMTP, API placeholder) chosen up front so nothing uses defaults.
mapfile -t ports < <(node --input-type=module -e '
import net from "node:net";
const s=[];
for(let i=0;i<4;i++){const x=net.createServer();await new Promise((r,j)=>x.once("error",j).listen(0,"127.0.0.1",r));s.push(x);console.log(x.address().port)}
for(const x of s)x.close();')
[[ ${#ports[@]} == 4 ]] || { echo 'FAIL: could not reserve ports' >&2; exit 1; }
db_port=${ports[0]}

cat >"$project/supabase/config.toml" <<EOF
project_id = "$project_id"
[db]
port = $db_port
shadow_port = ${ports[1]}
major_version = 15
[api]
enabled = false
port = ${ports[2]}
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
port = ${ports[3]}
[db.vault]
EOF

# Byte-preserved repo migrations only; the forward package is applied by the runner so that it is
# exercised exactly as ChatGPT will release it (individually, in filename order).
cp -- "$root"/supabase/migrations/*.sql "$project/supabase/migrations/"

cli_local db start
cli_local migration up --local

# The DB URL is derived only from the local stack we just created: loopback + reserved port.
export PROFILE_ONBOARDING_DB_URL="postgresql://postgres:postgres@127.0.0.1:${db_port}/postgres"
node "$root/scripts/ci/run-profile-onboarding-tests.mjs" --self-test
node "$root/scripts/ci/run-profile-onboarding-tests.mjs" --static
node "$root/scripts/ci/run-profile-onboarding-tests.mjs" --execute
