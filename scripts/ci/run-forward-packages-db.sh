#!/usr/bin/env bash
# Disposable-DB driver for the Moderation Analytics V1 and profile-onboarding forward packages.
# One verified CLI install, then each package gets its OWN fresh throwaway stack (`db start` + baseline
# `migration up`), so no package's applied migrations or fixtures can mask failures in the other. Before each
# suite the ledger is asserted to hold exactly the repo baseline. Supersedes the two former per-package drivers.
# Native disposable Linux + Docker only (GitHub-hosted ubuntu runner). Never run against, or
# with credentials for, a hosted Supabase project; the DB port is bound to loopback.
# Reuses the CLI pin from scripts/ci/toolchain.json (supabase db start + loopback ports + migration up --local).
set -euo pipefail
umask 077
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'FAIL: native Linux amd64 required' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)

# Fail closed: no hosted credentials or hosted project settings may be present in this job.
for v in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_SERVICE_ROLE_KEY SUPABASE_PROJECT_REF \
         SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY SUPABASE_JWT_SECRET NEXT_PUBLIC_SUPABASE_URL \
         DATABASE_URL POSTGRES_URL PGHOST PGHOSTADDR PGPASSWORD PGSERVICEFILE PGSERVICE; do
  [[ -z ${!v:-} ]] || { echo "FAIL: $v must not be set" >&2; exit 1; }
done
unset MODERATION_ANALYTICS_DB_URL PROFILE_ONBOARDING_DB_URL PROFILE_ONBOARDING_APPLY

task=$(mktemp -d "${RUNNER_TEMP:-/tmp}/fairswap-forward-db.XXXXXXXX")
mkdir -p "$task/bin"

cli_version=$(node -p "require('$root/scripts/ci/toolchain.json').database.cliVersion")
cli_url=$(node -p "require('$root/scripts/ci/toolchain.json').database.cliArchive")
cli_sha=$(node -p "require('$root/scripts/ci/toolchain.json').database.cliArchiveSha256")
curl -fsSL --proto '=https' --tlsv1.2 -o "$task/cli.tgz" "$cli_url"
[[ $(sha256sum "$task/cli.tgz" | cut -d' ' -f1) == "$cli_sha" ]] || { echo 'FAIL: CLI checksum mismatch' >&2; exit 1; }
tar -xzf "$task/cli.tgz" -C "$task/bin" supabase
cli="$task/bin/supabase"
[[ $("$cli" --version) == "$cli_version" ]] || { echo 'FAIL: CLI version mismatch' >&2; exit 1; }

project=""
project_id=""
stop_stack() {
  if [[ -n $project && -n $project_id ]]; then
    (cd -- "$project" && "$cli" stop --project-id "$project_id" --no-backup --workdir "$project" >/dev/null 2>&1 || true)
  fi
}
cleanup() { stop_stack; rm -rf -- "$task"; }
trap cleanup EXIT

export SUPABASE_SKIP_UPDATE_CHECK=true
baseline_count=$(ls -1 "$root"/supabase/migrations/*.sql | wc -l | tr -d ' ')
baseline_last=$(basename "$(ls -1 "$root"/supabase/migrations/*.sql | sort | tail -n1)" | cut -d_ -f1)

# run_suite <name> <db-url-variable> <runner.mjs>: fresh stack, exact clean baseline, then the suite.
run_suite() {
  local name=$1 url_var=$2 runner=$3
  project="$task/project-$name"
  project_id="fairswap-$name-$(node -p 'require("crypto").randomBytes(8).toString("hex")')"
  mkdir -p "$project/supabase/migrations"
  cli_local() { (cd -- "$project" && "$cli" "$@" --workdir "$project"); }

  # Free loopback ports (DB, shadow, SMTP, API placeholder) chosen dynamically so nothing uses defaults.
  mapfile -t ports < <(node --input-type=module -e '
import net from "node:net";
const s=[];
for(let i=0;i<4;i++){const x=net.createServer();await new Promise((r,j)=>x.once("error",j).listen(0,"127.0.0.1",r));s.push(x);console.log(x.address().port)}
for(const x of s)x.close();')
  [[ ${#ports[@]} == 4 ]] || { echo 'FAIL: could not reserve ports' >&2; exit 1; }
  local db_port=${ports[0]}

  cat >"$project/supabase/config.toml" <<CONFIG
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
CONFIG

  # Byte-preserved repo migrations: only the baseline is copied into the disposable stack.
  cp -- "$root"/supabase/migrations/*.sql "$project/supabase/migrations/"
  cli_local db start
  cli_local migration up --local

  # The DB URL is derived only from the local stack: loopback + reserved port.
  local db_url="postgresql://postgres:postgres@127.0.0.1:${db_port}/postgres"
  # Clean-baseline proof: the ledger holds exactly the repo baseline, nothing from any forward package.
  local ledger
  ledger=$(env -i PATH="$PATH" HOME="$HOME" PGCONNECT_TIMEOUT=15 psql "$db_url" -X -Atq -v ON_ERROR_STOP=1 \
    -c 'select count(*) || chr(32) || coalesce(max(version), chr(48)) from supabase_migrations.schema_migrations')
  [[ $ledger == "$baseline_count $baseline_last" ]] || { echo "FAIL: $name stack is not the clean baseline ($ledger)" >&2; exit 1; }

  export "$url_var=$db_url"
  node "$root/scripts/ci/$runner" --self-test
  node "$root/scripts/ci/$runner" --static
  node "$root/scripts/ci/$runner" --execute
  unset "$url_var"
  stop_stack
}

run_suite moderation-analytics MODERATION_ANALYTICS_DB_URL run-moderation-analytics-tests.mjs
run_suite profile-onboarding PROFILE_ONBOARDING_DB_URL run-profile-onboarding-tests.mjs
