#!/usr/bin/env bash
# Fresh private PG17 cluster only. No URL, external host, real env files or Docker.
set -euo pipefail
[[ $# == 1 && $1 == /* ]] || exit 2
pg_bin="$1"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
expected="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$repo/tests/ratings/pg17-source.json")"
[[ "$("$pg_bin/postgres" --version)" == "postgres (PostgreSQL) $expected" && $expected == 17.* ]] || exit 2
run_dir="$(mktemp -d /tmp/fairswap-posting-native-XXXXXX)"
run_dir="$(cd "$run_dir" && pwd -P)"
chmod 700 "$run_dir"
printf '%s\n' 'fairswap-posting-native-v1' > "$run_dir/fixture-kind"
started=false
cleanup() {
  status=$?
  trap - EXIT
  if "$started"; then "$pg_bin/pg_ctl" -D "$run_dir/data" -m fast -w stop > "$run_dir/stop.log" 2>&1 || status=1; fi
  echo "Synthetic native evidence: $run_dir"
  exit "$status"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$run_dir/data" -U posting_fixture_admin --auth=trust --encoding=UTF8 --locale=C > "$run_dir/init.log" 2>&1
"$pg_bin/pg_ctl" -D "$run_dir/data" -l "$run_dir/server.log" -o "-k $run_dir -p 5432 -c listen_addresses=''" -w start > "$run_dir/start.log" 2>&1
started=true
cd "$repo"
node tests/tablets-v1/native.mjs "$pg_bin" "$run_dir" | tee "$run_dir/results.log"
