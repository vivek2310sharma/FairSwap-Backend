#!/usr/bin/env bash
# HDR-03 role, RLS, count and signal assertions on disposable native PG17 (replaces the Docker service).
set -euo pipefail
[[ $# == 1 && $1 == /* ]] || { echo "Usage: $0 <absolute-pg17-bin-dir>" >&2; exit 2; }
pg_bin=$1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$root"
[[ "$("$pg_bin/postgres" --version)" == 'postgres (PostgreSQL) 17.'* ]]
workdir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fairswap-hdr03-pg17-XXXXXX")"
datadir="$workdir/data"
started=false
cleanup() {
  if "$started"; then "$pg_bin/pg_ctl" -D "$datadir" -m fast -w stop >/dev/null 2>&1 || true; fi
  [[ "$workdir" == */fairswap-hdr03-pg17-* ]] && rm -rf -- "$workdir"
}
trap cleanup EXIT
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
if (( port < 49152 )); then port=$((49152 + RANDOM % 16383)); fi
"$pg_bin/initdb" -D "$datadir" -U postgres --auth=trust --encoding=UTF8 --locale=C > "$workdir/initdb.log" 2>&1
"$pg_bin/pg_ctl" -D "$datadir" -l "$workdir/postgres.log" -o "-h 127.0.0.1 -p $port -c unix_socket_directories=''" -w start
started=true
"$pg_bin/createdb" -h 127.0.0.1 -p "$port" -U postgres hdr03_disposable
node tests/hdr-03/run-disposable.mjs --emit-sql > "$workdir/hdr03-disposable.sql"
"$pg_bin/psql" -X -h 127.0.0.1 -p "$port" -U postgres -d hdr03_disposable -v ON_ERROR_STOP=1 -f "$workdir/hdr03-disposable.sql"
