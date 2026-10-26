#!/usr/bin/env bash
# Automated native PG17 fixtures only. No DB URL, hosted client or deploy credential.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$here/../../.." && pwd)"
pg_bin="${1:?absolute PG17 bin required}"
[[ $# = 1 && "$pg_bin" = /* ]] || exit 2
[[ "$("$pg_bin/postgres" --version)" = 'postgres (PostgreSQL) 17.'* ]] || exit 2
cd "$repo"
node "$here/hdr03/verify-source.mjs"
for environment in test production; do
 mkdir -p "$repo/artifacts/ratings"
 run_dir="$(mktemp -d "$repo/artifacts/ratings/hosted-final-XXXXXX")"
 data_dir="$run_dir/data"
 port="$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
 if (( port < 49152 )); then port=$((49152 + RANDOM % 16383)); fi
 started=false
 cleanup() {
  if "$started"; then "$pg_bin/pg_ctl" -D "$data_dir" -m fast -w stop > "$run_dir/stop.txt" 2>&1 || return 1; fi
  [[ "$run_dir" = "$repo/artifacts/ratings/hosted-final-"* && "$data_dir" = "$run_dir/data" ]] || return 1
  rm -rf -- "$data_dir"
 }
 trap cleanup EXIT
 "$pg_bin/initdb" -D "$data_dir" -U ratings_fixture_admin --auth=trust --encoding=UTF8 --locale=C > "$run_dir/initdb.txt" 2>&1
 "$pg_bin/pg_ctl" -D "$data_dir" -l "$run_dir/postgres.log" -o "-h 127.0.0.1 -p $port -c unix_socket_directories=''" -w start > "$run_dir/start.txt" 2>&1
 started=true
 node "$here/regression.mjs" "--environment=$environment" "--native-port=$port" "--pg-bin=$pg_bin" | tee "$run_dir/results.txt"
 cleanup
 started=false
 trap - EXIT
done
