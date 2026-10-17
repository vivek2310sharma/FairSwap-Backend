#!/usr/bin/env bash
# CI-only, credentials-free PostgreSQL 17.6 release rehearsal.
# Never run against a hosted project. Do not edit canonical SQL or deploy anything.
set -Eeuo pipefail
umask 077

[[ $# == 1 && ${GITHUB_ACTIONS:-} == true && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || exit 1
[[ -n ${RUNNER_TEMP:-} && -d ${RUNNER_TEMP:-/does-not-exist} ]] || exit 1
for name in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD DATABASE_URL PGHOST PGSERVICE; do
  [[ -z ${!name:-} ]] || { echo "FAIL: hosted connection credential/target prohibited" >&2; exit 1; }
done
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
evidence=$1
[[ $evidence == "$RUNNER_TEMP"/prod-category-rehearsal-evidence ]] || exit 1
[[ ! -e $evidence ]] || exit 1
mkdir -m 700 "$evidence"
task=$(mktemp -d "$RUNNER_TEMP/fairswap-category-rehearsal.XXXXXXXX")
project="$task/project"
cli="$task/bin/supabase"
stage=static-verification
project_id=''
network=''
db=''
started=0
success=0
fw_if=''
fw4_fwd=0
fw6_fwd=0
fw4_input=0
fw6_input=0
cleanup() {
  local rc=$? cleanup_ok=1 existing_id
  trap - EXIT INT TERM
  set +e
  if [[ -n $project_id && -n $network ]]; then
    if [[ -x $cli && -d $project ]]; then
      ( cd "$project" && "$cli" stop --project-id "$project_id" --no-backup --workdir "$project" --network-id "$network" ) >"$task/stop.log" 2>&1 || cleanup_ok=0
    fi
    # Remove only task-owned objects. No global prune, stop-all or destructive reset.
    docker ps -aq --filter "label=com.supabase.cli.project=$project_id" >"$task/task-containers.txt" || cleanup_ok=0
    while IFS= read -r existing_id; do
      [[ -n $existing_id ]] || continue
      docker rm -f "$existing_id" >>"$task/cleanup.log" 2>&1 || cleanup_ok=0
    done <"$task/task-containers.txt"
    docker volume ls -q --filter "label=com.supabase.cli.project=$project_id" >"$task/task-volumes.txt" || cleanup_ok=0
    while IFS= read -r existing_id; do
      [[ -n $existing_id ]] || continue
      docker volume rm "$existing_id" >>"$task/cleanup.log" 2>&1 || cleanup_ok=0
    done <"$task/task-volumes.txt"
    if docker network inspect "$network" >/dev/null 2>&1; then
      [[ $(docker network inspect -f '{{index .Labels "com.supabase.cli.project"}}' "$network") == "$project_id" ]] && docker network rm "$network" >>"$task/cleanup.log" 2>&1 || cleanup_ok=0
    fi
    [[ -z $(docker ps -aq --filter "label=com.supabase.cli.project=$project_id") ]] || cleanup_ok=0
    [[ -z $(docker volume ls -q --filter "label=com.supabase.cli.project=$project_id") ]] || cleanup_ok=0
    ! docker network inspect "$network" >/dev/null 2>&1 || cleanup_ok=0
  fi
  # Undo only this task's exact per-interface firewall rules, never flush/prune.
  if [[ $fw6_input == 1 ]]; then
    sudo -n ip6tables -w -D INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP || cleanup_ok=0
  fi
  if [[ $fw4_input == 1 ]]; then
    sudo -n iptables -w -D INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP || cleanup_ok=0
  fi
  if [[ $fw6_fwd == 1 ]]; then
    sudo -n ip6tables -w -D DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP || cleanup_ok=0
  fi
  if [[ $fw4_fwd == 1 ]]; then
    sudo -n iptables -w -D DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP || cleanup_ok=0
  fi
  if [[ $fw4_input == 1 ]] && sudo -n iptables -w -C INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP >/dev/null 2>&1; then cleanup_ok=0; fi
  if [[ $fw6_input == 1 ]] && sudo -n ip6tables -w -C INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP >/dev/null 2>&1; then cleanup_ok=0; fi
  if [[ $fw4_fwd == 1 ]] && sudo -n iptables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP >/dev/null 2>&1; then cleanup_ok=0; fi
  if [[ $fw6_fwd == 1 ]] && sudo -n ip6tables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP >/dev/null 2>&1; then cleanup_ok=0; fi
  [[ $rc == 0 && $success == 1 && $cleanup_ok == 1 ]] && outcome=true || outcome=false
  printf '{"schemaVersion":1,"releaseId":"category-foundation-v1","kind":"ISOLATED_PG17_45_TO_52","success":%s,"phase":"%s","cleanupVerified":%s,"hostedWrites":false,"backupVerified":false,"productionApproved":false}\n' \
    "$outcome" "$stage" "$([[ $cleanup_ok == 1 ]] && echo true || echo false)" >"$evidence/result.json"
  sha256sum "$evidence/result.json" | sed "s@  $evidence/@  @" >"$evidence/SHA256SUMS"
  rm -rf -- "$task"
  if [[ $outcome != true ]]; then
    echo "FAIL: Production category rehearsal; phase=$stage, cleanupVerified=$([[ $cleanup_ok == 1 ]] && echo true || echo false)" >&2
    exit 1
  fi
  echo 'PASS: isolated PostgreSQL 17.6 Production category rehearsal, exact 45-to-52 ledger, safeguards and regression suites'
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$task/bin" "$task/home"
export FAIRSWAP_CATEGORY_REHEARSAL_ONLY=1
export SUPABASE_SKIP_UPDATE_CHECK=true
export SUPABASE_INTERNAL_IMAGE_REGISTRY=public.ecr.aws

stage=source-integrity
node "$root/scripts/ci/production-category-rehearsal.mjs" --verify-source
node "$root/scripts/ci/production-category-rehearsal.mjs" --prepare "$project"
project_id=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).projectId' "$project/rehearsal.json")
[[ $project_id =~ ^fairswap-category-[a-f0-9]{16}$ ]] || exit 1
network="$project_id-net"
db="supabase_db_$project_id"
cli_local() { (cd "$project" && "$cli" "$@" --workdir "$project" --network-id "$network"); }
sql() { docker exec "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$1"; }

stage=cli-download
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "https://github.com/supabase/cli/releases/download/v2.117.0/supabase_linux_amd64.tar.gz" -o "$task/cli.tar.gz"
echo "69c05f85b9e47ee706d30f1a6ca8a526b4e337bfd12c7ef1ef522d24e7280d24  $task/cli.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$task/cli.tar.gz" -C "$task/bin" supabase
chmod 700 "$cli"
[[ $(cli_local --version) == 2.117.0 ]]
cli_local db start --help >"$task/cli-db-help.txt"
cli_local migration up --help >"$task/cli-migration-help.txt"
cli_local migration new --help >"$task/cli-new-help.txt"
cli_local test db --help >"$task/cli-test-help.txt"

# Pin the official immutable PG17 and pgTAP runner images, pulled before
# restricting the isolated database network. Do not accept mutable latest tags.
stage=postgres-image
# Same immutable OCI index digest as the official Supabase ECR publication.
# Prefer official GHCR to avoid anonymous public ECR rate limiting.
pg_ref="ghcr.io/supabase/postgres@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb"
docker pull --platform linux/amd64 "$pg_ref" >"$task/postgres-pull.log" 2>&1
pg_id=$(docker image inspect -f '{{.Id}}' "$pg_ref")
[[ -n $pg_id ]]
docker tag "$pg_ref" public.ecr.aws/supabase/postgres:17.6.1.167
[[ $(docker image inspect -f '{{.Id}}' public.ecr.aws/supabase/postgres:17.6.1.167) == "$pg_id" ]]
stage=pgtap-image
prove_ref="supabase/pg_prove@sha256:eda7c5e68719e9c8287e78c017118407b48df904a51c935f5ab6098b8c0bc6bc"
docker pull --platform linux/amd64 "$prove_ref" >"$task/pgprove-pull.log" 2>&1
docker tag "$prove_ref" public.ecr.aws/supabase/pg_prove:3.36

# GitHub's native Linux Docker daemon must support both DOCKER-USER chains.
# No fallback to an unprotected bridge or wildcard host binding is allowed.
stage=network-preflight
sudo -n iptables -w -C FORWARD -j DOCKER-USER
sudo -n ip6tables -w -C FORWARD -j DOCKER-USER
fw_if="fs$(node -p 'require("crypto").randomBytes(6).toString("hex")')"
[[ ${#fw_if} -le 15 && $fw_if =~ ^fs[a-f0-9]{12}$ ]]
v6="fd$(node -p 'require("crypto").randomBytes(1).toString("hex")'):$(node -p 'require("crypto").randomBytes(2).toString("hex")'):$(node -p 'require("crypto").randomBytes(2).toString("hex")')::/64"
stage=network-create
docker network create --driver bridge --ipv6 --subnet "$v6" \
  --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 \
  --opt "com.docker.network.bridge.name=$fw_if" \
  --label "com.supabase.cli.project=$project_id" "$network" >"$task/network-create.txt"
[[ $(docker network inspect -f '{{.Internal}}' "$network") == false ]]
[[ $(docker network inspect -f '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}' "$network") == 127.0.0.1 ]]
! sudo -n iptables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP >/dev/null 2>&1
! sudo -n ip6tables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP >/dev/null 2>&1
stage=network-firewall
sudo -n iptables -w -I DOCKER-USER 1 -i "$fw_if" ! -o "$fw_if" -j DROP
fw4_fwd=1
sudo -n ip6tables -w -I DOCKER-USER 1 -i "$fw_if" ! -o "$fw_if" -j DROP
fw6_fwd=1
sudo -n iptables -w -I INPUT 1 -i "$fw_if" -m conntrack --ctstate NEW -j DROP
fw4_input=1
sudo -n ip6tables -w -I INPUT 1 -i "$fw_if" -m conntrack --ctstate NEW -j DROP
fw6_input=1
verify_firewall() {
  sudo -n iptables -w -C FORWARD -j DOCKER-USER
  sudo -n ip6tables -w -C FORWARD -j DOCKER-USER
  sudo -n iptables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP
  sudo -n ip6tables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP
  sudo -n iptables -w -C INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP
  sudo -n ip6tables -w -C INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP
  ip link show "$fw_if" >/dev/null
}
stage=network-firewall-verify
verify_firewall
# Protected task-only bridge permits the local Supabase CLI bootstrap.
# The approved CLI Docker-create script must be rewritten with a server-wide
# cron -c option before PostgreSQL starts. Any changed CLI shape fails closed.
stage=database-bootstrap-adapter
real_docker=$(command -v docker)
[[ $real_docker == /* && $real_docker != "$task/bin/"* ]]
export FAIRSWAP_CATEGORY_REHEARSAL_TASK="$task"
export FAIRSWAP_EXPECTED_PG_IMAGE_ID="$pg_id"
printf '#!/usr/bin/env bash\nexec node %q %q %q %q %q "$@"\n' \
  "$root/scripts/ci/start-production-category-postgres-cron-off.mjs" \
  "$real_docker" "$db" "$task/startup-override.json" "$pg_id" \
  >"$task/bin/docker"
chmod 700 "$task/bin/docker"
stage=database-bootstrap-start
if ! PATH="$task/bin:$PATH" cli_local db start >"$task/bootstrap.log" 2>&1; then
  # Only a fixed, allowlisted category escapes CI. Never upload bootstrap output.
  if grep -Eiq 'toomanyrequests|too many requests|rate[ -]?limit|429' "$task/bootstrap.log"; then
    stage=database-bootstrap-registry-rate-limit
  elif grep -Eiq 'no route to host|network is unreachable|network.*(not found|failed)|connection refused|failed to connect|timeout|timed out' "$task/bootstrap.log"; then
    stage=database-bootstrap-network-or-timeout
  elif grep -Eiq 'manifest unknown|image.*not found|pull access denied|failed to pull' "$task/bootstrap.log"; then
    stage=database-bootstrap-image
  elif grep -Eiq 'invalid.*config|unsupported.*config|invalid argument|unrecognized option' "$task/bootstrap.log"; then
    stage=database-bootstrap-config
  else stage=database-bootstrap-unclassified
  fi
  exit 1
fi
started=1
stage=database-bootstrap-adapter-confirm
[[ $(cat -- "$task/startup-override.json") == '{"serverCronOff":true}' ]]
stage=database-bootstrap-network-check
[[ $(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{$n}}{{end}}' "$db") == "$network" ]]
published=$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$db")
node --input-type=module - "$published" <<'NODE'
import assert from 'node:assert/strict';
const ports=JSON.parse(process.argv[2]);
const db=ports['5432/tcp'];
assert.ok(Array.isArray(db)&&db.length>0,'Database port must be loopback-published');
assert.ok(db.every(p=>p.HostIp==='127.0.0.1'||p.HostIp==='::1'),'No wildcard or external port binding allowed');
NODE
stage=database-bootstrap-version-check
[[ $(sql 'SHOW server_version_num') == 170006 ]]
[[ $(sql "SELECT split_part(current_setting('server_version'), ' ', 1)") == 17.6 ]]
stage=database-bootstrap-namespace-check
db_pid=$(docker inspect -f '{{.State.Pid}}' "$db")
db_sandbox=$(docker inspect -f '{{.NetworkSettings.SandboxKey}}' "$db")
[[ $db_pid =~ ^[1-9][0-9]*$ && $db_sandbox == /var/run/docker/netns/* ]]
[[ $(sudo -n stat -Lc %i "/proc/$db_pid/ns/net") == $(sudo -n stat -Lc %i "$db_sandbox") ]]
stage=network-route-isolation
for family in 4 6; do
  for attempt in 1 2 3; do
    routes=$(sudo -n nsenter --target "$db_pid" --net -- ip "-$family" route show default)
    [[ -n $routes ]] || break
    sudo -n nsenter --target "$db_pid" --net -- ip "-$family" route del default
  done
  [[ -z $(sudo -n nsenter --target "$db_pid" --net -- ip "-$family" route show default) ]]
done
stage=network-isolation-verified
verify_firewall
# The command-line PG17 setting must exist before ANY historical FairSwap SQL
# and must not rely on mutable, session-level or database-level overrides.
admin_sql() { docker exec "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -c "$1"; }
stage=cron-disable-role-check
[[ $(admin_sql 'SELECT 1') == 1 ]]
stage=cron-disable-effective-setting
[[ $(admin_sql "SELECT current_setting('cron.launch_active_jobs')") == off ]]
stage=cron-disable-settings-table
[[ $(admin_sql "SELECT setting FROM pg_settings WHERE name='cron.launch_active_jobs'") == off ]]
stage=cron-disable-source
[[ $(admin_sql "SELECT source FROM pg_settings WHERE name='cron.launch_active_jobs'") == 'command line' ]]
stage=cron-disable-pending-restart
[[ $(admin_sql "SELECT pending_restart::text FROM pg_settings WHERE name='cron.launch_active_jobs'") == false ]]
stage=cron-disable-postgres-client
[[ $(sql 'SHOW cron.launch_active_jobs') == off ]]
stage=cron-disable-no-jobs
if [[ $(admin_sql "SELECT to_regclass('cron.job') IS NOT NULL") == t ]]; then
  [[ $(admin_sql 'SELECT count(*) FROM cron.job') == 0 ]]
fi

stage=baseline-apply
cli_local migration up --local >"$task/baseline.log" 2>&1
baseline_ledger=$(sql "SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations")
printf '%s\n' "$baseline_ledger" | node "$root/scripts/ci/production-category-rehearsal.mjs" --check-ledger "$project/rehearsal.json" 45
[[ $(sql "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)')") == 118d04445fdd9139d90decd2048945f1 ]]
[[ $(sql "SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_automation_enabled'") == false ]]
[[ $(sql 'SHOW cron.launch_active_jobs') == off ]]
printf '45\n' >"$project/baseline-confirmed"

stage=candidates-stage
node "$root/scripts/ci/production-category-rehearsal.mjs" --stage "$project" "$cli"
node "$root/scripts/ci/production-category-rehearsal.mjs" --verify-staged "$project"
stage=candidates-apply
cli_local migration up --local >"$task/candidates.log" 2>&1
final_ledger=$(sql "SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations")
printf '%s\n' "$final_ledger" | node "$root/scripts/ci/production-category-rehearsal.mjs" --check-ledger "$project/rehearsal.json" 52
[[ $(sql 'SHOW cron.launch_active_jobs') == off ]]

stage=postflight
verify_firewall
for family in 4 6; do [[ -z $(sudo -n nsenter --target "$db_pid" --net -- ip "-$family" route show default) ]]; done
( printf 'BEGIN READ ONLY; SET LOCAL statement_timeout = %s;\n' "'20s'"
  cat "$root/releases/production/category-foundation-v1/postflight.readonly.sql"
  printf '\nCOMMIT;\n'
) | docker exec -i "$db" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >"$task/postflight.log" 2>&1
# Goods and context RLS/ACL protections are checked independently as well.
[[ $(sql "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('listing_vehicle_contexts','listing_car_contexts','listing_property_contexts') AND c.relrowsecurity AND NOT has_table_privilege('anon',c.oid,'SELECT')") == 3 ]]
[[ $(sql "SELECT count(*) FROM pg_trigger WHERE tgrelid='public.listings'::regclass AND tgname IN ('z_vehicle_listing_guard','zz_car_listing_guard','zzz_property_listing_guard') AND tgenabled='O'") == 3 ]]
[[ $(sql "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)')") == 118d04445fdd9139d90decd2048945f1 ]]

stage=goods-regression
mkdir -m 700 "$task/suites"
for suite in admin_medium_operation.test.sql admin_reviewed_contract.test.sql \
             listings_insert_category_eligibility.test.sql moderation_vault_dispatch_auth.test.sql \
             pending_review_media_invalidation.test.sql schema_listings.test.sql \
             schema_post_ad_category_metadata.test.sql schema_security.test.sql \
             seller_listing_category_context.test.sql; do
  cp -- "$root/supabase/tests/$suite" "$project/supabase/tests/$suite" 2>/dev/null || {
    mkdir -p "$project/supabase/tests"
    cp -- "$root/supabase/tests/$suite" "$project/supabase/tests/$suite"
  }
  cli_local test db --local "supabase/tests/$suite" >"$task/suites/$suite.log" 2>&1
done
node --input-type=module - "$root" "$task/suites" <<'NODE'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [root,dir]=process.argv.slice(2);
const {requiredSuites,parseSuiteLog}=await import(pathToFileURL(root+'/scripts/ci/verify-db-results.mjs'));
// The historical 58-migration Test fixture has two additional dynamic assertions
// for ENABLED Vehicles/Property categories. This 52-migration Production-hidden
// schema must have none; the assertions do not execute because no such category
// is active or new-listing-enabled. All remaining assertions are mandatory.
const releaseExpected={...requiredSuites,
  'listings_insert_category_eligibility.test.sql':26};
let tests=0;
for(const [file,expected] of Object.entries(releaseExpected)) {
  const log=readFileSync(dir+'/'+file+'.log','utf8');
  if(expected===requiredSuites[file]) {
    assert.equal(parseSuiteLog(file,log,0).assertions,expected);
  } else {
    assert.ok(log.includes('/supabase/tests/'+file), 'Unexpected suite log identity');
    assert.ok(!/(?:^|\n)\s*(?:not ok\b|Bail out!|Dubious|Failed\b|Parse errors:)|\bERROR:|Result:\s*FAIL/i.test(log));
    const counts=[...log.matchAll(/^Files=(\d+), Tests=(\d+),[^\r\n]*$/gm)];
    assert.equal(counts.length,1);
    assert.deepEqual([Number(counts[0][1]),Number(counts[0][2])],[1,expected]);
    assert.equal((log.match(/^Result: PASS\r?$/gm)||[]).length,1);
    assert.equal((log.match(/^All tests successful\.\r?$/gm)||[]).length,1);
  }
  tests+=expected;
}
assert.equal(tests,268);
console.log('PASS: nine hidden-release security/regression suites, 268 assertions');
NODE
stage=passed
success=1
