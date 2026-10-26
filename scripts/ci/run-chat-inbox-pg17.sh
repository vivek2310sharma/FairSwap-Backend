#!/usr/bin/env bash
# Dedicated native Linux fixture; private Unix socket, no hosted URL or credentials.
set -euo pipefail
[[ $# == 0 && $(uname -s) == Linux ]]
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
classify(){ node scripts/release/protected-inbox-plan.mjs classify "$1"; }
task_tmp=$(mktemp -d "${RUNNER_TEMP:-/tmp}/chat-inbox-native.XXXXXXXX")
chmod 700 "$task_tmp"
cleanup(){ if [[ -f "$task_tmp/data/postmaster.pid" ]]; then "$task_tmp/install/bin/pg_ctl" -D "$task_tmp/data" -m immediate stop >/dev/null;fi; [[ $task_tmp == */chat-inbox-native.* ]] && rm -rf -- "$task_tmp"; }
trap cleanup EXIT
curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://ftp.postgresql.org/pub/source/v17.6/postgresql-17.6.tar.bz2 -o "$task_tmp/pg.tar.bz2"
echo 'e0630a3600aea27511715563259ec2111cd5f4353a4b040e0be827f94cd7a8b0  '"$task_tmp/pg.tar.bz2" | sha256sum --check --status
tar -xjf "$task_tmp/pg.tar.bz2" -C "$task_tmp"
(cd "$task_tmp/postgresql-17.6"; ./configure --prefix="$task_tmp/install" --without-readline --without-zlib --without-icu --without-openssl >"$task_tmp/build.log" 2>&1; make -j2 >>"$task_tmp/build.log" 2>&1; make install >>"$task_tmp/build.log" 2>&1)
"$task_tmp/install/bin/initdb" -D "$task_tmp/data" -U inbox_fixture_admin --auth-local=trust --auth-host=trust >"$task_tmp/init.log" 2>&1
task_port=$(shuf -i 49152-65535 -n 1)
"$task_tmp/install/bin/pg_ctl" -D "$task_tmp/data" -l "$task_tmp/server.log" -o "-k $task_tmp -p $task_port -c listen_addresses='127.0.0.1'" -w start >/dev/null
[[ $("$task_tmp/install/bin/psql" -XAt -h "$task_tmp" -p "$task_port" -U inbox_fixture_admin -d postgres -c 'show server_version_num') == 170006 ]]
if ! node scripts/ci/prepare-chat-inbox-cli-fixture.mjs "$task_tmp" seed >"$task_tmp/seed-plan.log" 2>&1; then echo "FAIL fixture preparation: $(classify "$task_tmp/seed-plan.log")";exit 1;fi
"$task_tmp/install/bin/psql" -XAtq -h "$task_tmp" -p "$task_port" -U inbox_fixture_admin -d postgres -v ON_ERROR_STOP=1 -f "$task_tmp/prepare.sql" >"$task_tmp/prepare.log" 2>&1
bash scripts/release/install-inbox-cli.sh
task_cli=$(tail -n1 "$GITHUB_PATH")
task_connection="postgresql://postgres@127.0.0.1:$task_port/postgres?sslmode=disable"
# Use a minimal explicit CLI environment: never inherit hosted connection credentials.
cli(){ env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 "$task_cli/supabase" "$@"; }
if ! cli migration up --include-all --db-url "$task_connection" --workdir "$task_tmp/seed" >"$task_tmp/seed-cli.log" 2>&1; then echo "FAIL CLI fixture seed: $(classify "$task_tmp/seed-cli.log")";exit 1;fi
# Capture metadata from genuinely CLI-applied fixtures; never invent ledger rows/files.
if ! "$task_tmp/install/bin/psql" -XAtq -h "$task_tmp" -p "$task_port" -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "select jsonb_agg(jsonb_build_object('version',version,'name',name,'statementsSha256',encode(sha256(convert_to(coalesce(to_jsonb(statements)::text,'null'),'UTF8')),'hex')) order by version) from supabase_migrations.schema_migrations" >"$task_tmp/history.json" 2>"$task_tmp/history.log"; then echo "FAIL CLI ledger capture: $(classify "$task_tmp/history.log")";exit 1;fi
if ! cli migration fetch --db-url "$task_connection" --workdir "$task_tmp" >"$task_tmp/fetch-cli.log" 2>&1; then echo "FAIL CLI history fetch: $(classify "$task_tmp/fetch-cli.log")";exit 1;fi
if ! node scripts/ci/prepare-chat-inbox-cli-fixture.mjs "$task_tmp" plan >"$task_tmp/plan.log" 2>&1; then echo "FAIL fixture history planning: $(classify "$task_tmp/plan.log")";exit 1;fi
task_migration="$task_tmp/supabase/migrations/20261025204922_chat_v2_inbox_and_safety.sql"
printf '\ndo $$begin raise exception '\''CHAT_FIXTURE_ROLLBACK'\'';end$$;\n' >> "$task_migration"
if cli migration up --include-all --db-url "$task_connection" --workdir "$task_tmp" >"$task_tmp/negative-cli.log" 2>&1; then echo 'FAIL CLI accepted intentionally failed migration';exit 1;fi
task_negative_class=$(classify "$task_tmp/negative-cli.log")
if [[ $task_negative_class != EXPECTED_SQL_ROLLBACK ]]; then echo "FAIL negative CLI did not reach rollback sentinel: $task_negative_class";exit 1;fi
if ! task_rollback=$("$task_tmp/install/bin/psql" -XAt -h "$task_tmp" -p "$task_port" -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "select to_regclass('app_security.chat_v2_flags') is null and not exists(select 1 from supabase_migrations.schema_migrations where version='20261025204922')" 2>"$task_tmp/rollback-check.log"); then echo "FAIL rollback check: $(classify "$task_tmp/rollback-check.log")";exit 1;fi
if [[ $task_rollback != t ]]; then echo 'FAIL schema/history atomicity check';exit 1;fi
cp -- "$task_tmp/approved.sql" "$task_migration"
if ! cli migration up --include-all --db-url "$task_connection" --workdir "$task_tmp" >"$task_tmp/cli.log" 2>&1; then echo "FAIL supported CLI history contract: $(classify "$task_tmp/cli.log")";exit 1;fi
if ! "$task_tmp/install/bin/psql" -XAtq -h "$task_tmp" -p "$task_port" -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$task_tmp/postflight.sql" >"$task_tmp/post.log" 2>&1; then echo "FAIL CLI history postflight: $(classify "$task_tmp/post.log")";exit 1;fi
if ! "$task_tmp/install/bin/psql" -XAtq -h "$task_tmp" -p "$task_port" -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$task_tmp/security.sql" >"$task_tmp/result.log" 2>&1; then echo "FAIL native inbox PG17 security fixture: $(classify "$task_tmp/result.log")";exit 1;fi
grep '^PASS native inbox security and migration contract$' "$task_tmp/result.log"
echo 'PASS supported Supabase migration up history contract'
