#!/usr/bin/env bash
# Disposable native PG17 IDV migration/RLS gate. Reuses the checksum-pinned install passed in.
set -euo pipefail
[[ $# == 1 && $1 == /* ]] || { echo "Usage: $0 <absolute-pg17-bin-dir>" >&2; exit 2; }
pg_bin=$1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$root"
test -x "$pg_bin/postgres"
[[ "$("$pg_bin/postgres" --version)" == 'postgres (PostgreSQL) 17.'* ]]
workdir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fairswap-idv-pg17-XXXXXX")"
datadir="$workdir/data"
started=false
cleanup() {
  if "$started"; then "$pg_bin/pg_ctl" -D "$datadir" -m fast -w stop >/dev/null 2>&1 || true; fi
  [[ "$workdir" == */fairswap-idv-pg17-* ]] && rm -rf -- "$workdir"
}
trap cleanup EXIT
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
if (( port < 49152 )); then port=$((49152 + RANDOM % 16383)); fi
"$pg_bin/initdb" -D "$datadir" -U postgres --auth=trust --encoding=UTF8 --locale=C > "$workdir/initdb.log" 2>&1
"$pg_bin/pg_ctl" -D "$datadir" -l "$workdir/postgres.log" -o "-h 127.0.0.1 -p $port -c unix_socket_directories=''" -w start
started=true
node tests/idv-pg17/run-disposable.mjs "--native-port=$port" "--pg-bin=$pg_bin"
node tests/idv-pg17/run-prod-v3-to-v1.mjs "--native-port=$port" "--pg-bin=$pg_bin"
