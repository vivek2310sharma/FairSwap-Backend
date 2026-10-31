#!/usr/bin/env bash
# Automated disposable cluster only; never accepts a URL, password or hosted target.
set -euo pipefail
[[ $# == 1 && $1 == /* ]] || exit 2
pg_bin="$1"
[[ "$("$pg_bin/postgres" --version)" == 'postgres (PostgreSQL) 17.6' ]] || exit 2
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/fsw-search-native-XXXXXXXX")"
# macOS /tmp can be a symlink; the adapter checks canonical cluster paths.
run_dir="$(cd "$run_dir" && pwd -P)"
chmod 700 "$run_dir"
started=false
cleanup() {
  if "$started"; then "$pg_bin/pg_ctl" -D "$run_dir/data" -m fast -w stop > "$run_dir/stop.log" 2>&1; fi
  echo "Synthetic evidence retained at $run_dir"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$run_dir/data" -U search_fixture_admin --auth=trust --encoding=UTF8 --locale=C > "$run_dir/init.log" 2>&1
# No TCP listener; only a mode-0700 private Unix socket. Fixed port is socket-local.
"$pg_bin/pg_ctl" -D "$run_dir/data" -l "$run_dir/server.log" -o "-k $run_dir -p 5432 -c listen_addresses=''" -w start > "$run_dir/start.log" 2>&1
started=true
cd "$repo"
node tests/fsw-sec-003/run-disposable.mjs --native "$pg_bin" "$run_dir" | tee "$run_dir/search-results.json"
node --input-type=module - "$pg_bin" "$run_dir" "$repo/artifacts/fsw-sec-003/postgrest/postgrest" <<'NODE' | tee "$run_dir/http-results.json"
import { verifyHttp } from './tests/fsw-sec-003/http-contract.mjs';
await verifyHttp(...process.argv.slice(2));
NODE
