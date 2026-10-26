#!/usr/bin/env bash
# Disposable native PG17 only: no URL, secrets, external server or Supabase CLI.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
pg_bin="${1:?absolute PostgreSQL bin directory required}"
[[ "$pg_bin" = /* && $# = 1 ]] || exit 2
[[ "$("$pg_bin/postgres" --version)" = 'postgres (PostgreSQL) 17.'* ]] || exit 2
mkdir -p "$repo/artifacts/ratings"
run_dir="$(mktemp -d "$repo/artifacts/ratings/native-XXXXXX")"
data_dir="$run_dir/data"
# The adapter restricts ports to the dynamic range and fixes host/user/database.
port="$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
if (( port < 49152 )); then port=$((49152 + RANDOM % 16383)); fi
started=false
cleanup() {
  if "$started"; then "$pg_bin/pg_ctl" -D "$data_dir" -m fast -w stop > "$run_dir/stop.log" 2>&1; fi
  # Never remove an unverified/computed path outside this invocation's mktemp.
  [[ "$run_dir" = "$repo/artifacts/ratings/native-"* && "$data_dir" = "$run_dir/data" ]] || return 1
  rm -rf -- "$data_dir"
  echo "Disposable run artifacts: $run_dir"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$data_dir" -U ratings_fixture_admin --auth=trust --encoding=UTF8 --locale=C > "$run_dir/initdb.log" 2>&1
"$pg_bin/pg_ctl" -D "$data_dir" -l "$run_dir/postgres.log" -o "-h 127.0.0.1 -p $port -c unix_socket_directories=''" -w start > "$run_dir/start.log" 2>&1
started=true
cd "$repo"
node tests/ratings/run.mjs "--native-port=$port" "--pg-bin=$pg_bin" | tee "$run_dir/results.txt"
