#!/usr/bin/env bash
# Native Linux CI ONLY. Disposable Unix-socket PG15 fixture; no hosted credentials/network.
set -euo pipefail
[[ $# == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]]
[[ $(docker info --format '{{.OSType}}') == linux ]]
[[ $(docker info --format '{{.OperatingSystem}}') != *Desktop* ]]
[[ $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix://* ]]
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd -- "$root"
# Reuse the existing immutable image pin, never a tag-only fallback.
image=$(node --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync("scripts/ci/toolchain.json")).database.images.postgres;console.log(p.tag.replace("public.ecr.aws/","").replace(/:[^:]+$/,"")+"@"+p.digest)')
[[ $image =~ ^supabase/postgres@sha256:[a-f0-9]{64}$ ]]
docker pull --platform linux/amd64 "$image" >/dev/null
chat_tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chat-net-privileges.XXXXXXXX")
chmod 700 "$chat_tmp"
chat_cid=''
cleanup() {
  if [[ $chat_cid =~ ^[a-f0-9]{64}$ ]]; then docker rm -f "$chat_cid" >/dev/null; fi
  # Leave no SQL/result contents in public artifacts; CI's temporary directory is ephemeral.
  rm -f -- "$chat_tmp/fixture.sql" "$chat_tmp/result.log"
  rmdir -- "$chat_tmp"
}
trap cleanup EXIT
node scripts/ci/emit-chat-net-privileges-sql.mjs >"$chat_tmp/fixture.sql"
chat_cid=$(docker run -d --pull never --platform linux/amd64 --network none --user postgres \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --pids-limit 128 --entrypoint bash "$image" -c '
    set -euo pipefail
    if command -v initdb >/dev/null; then bindir=$(dirname "$(command -v initdb)");
    else bindir=$(dirname "$(find /usr/lib/postgresql -type f -name initdb -print -quit)"); fi
    "$bindir/initdb" -D /tmp/chat-pg --username=chat_fixture_admin --auth-local=trust --auth-host=reject >/tmp/init.log 2>&1
    exec "$bindir/postgres" -D /tmp/chat-pg -k /tmp -c port=5432 -c listen_addresses="" -c shared_preload_libraries=""
  ')
[[ $chat_cid =~ ^[a-f0-9]{64}$ ]]
[[ $(docker inspect --format '{{.HostConfig.NetworkMode}}' "$chat_cid") == none ]]
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$chat_cid") == '{}' || $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$chat_cid") == null ]]
ready=false
for attempt in {1..60}; do
  if docker exec "$chat_cid" psql -X -Atq -h /tmp -p 5432 -U chat_fixture_admin -d postgres -c 'select 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]]
[[ $(docker exec "$chat_cid" psql -X -Atq -h /tmp -p 5432 -U chat_fixture_admin -d postgres -c 'show server_version_num') == 150008 ]]
if ! docker exec -i "$chat_cid" psql -X -Atq -v ON_ERROR_STOP=1 -h /tmp -p 5432 -U chat_fixture_admin -d postgres \
  <"$chat_tmp/fixture.sql" >"$chat_tmp/result.log" 2>&1; then
  echo 'FAIL: isolated PG15 dispatch privilege regression' >&2
  exit 1
fi
grep -E '^PASS [0-9]+ owner/invoker queue privilege checks' "$chat_tmp/result.log"
