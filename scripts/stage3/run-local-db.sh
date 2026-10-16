#!/usr/bin/env bash
# Native disposable Linux only. Never run from the canonical Supabase project.
set -euo pipefail
umask 077
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'FAIL: native Linux amd64 required' >&2; exit 1; }
[[ $# == 1 ]] || { echo 'Usage: bash run-local-db.sh <new evidence directory>' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
evidence=$(realpath -m -- "$1")
[[ $evidence != "$root" && $evidence != "$root/"* ]] || exit 1

# No hosted credentials, remote Docker contexts, dotenv files or operator settings.
if [[ ${FAIRSWAP_DB_CLEAN_ENV:-} != 1 ]]; then
  task=$(mktemp -d "${RUNNER_TEMP:-/tmp}/fairswap-stage3-ci.XXXXXXXX")
  mkdir -p "$task/home" "$task/tmp" "$task/docker" "$task/bin" "$task/raw" "$task/project"
  owner=$(cat /proc/sys/kernel/random/uuid)
  printf '%s\n' "$owner" >"$task/owner"
  exec env -i PATH="$PATH" HOME="$task/home" TMPDIR="$task/tmp" CI=true \
    DOCKER_CONFIG="$task/docker" DOCKER_HOST=unix:///var/run/docker.sock \
    SUPABASE_SKIP_UPDATE_CHECK=true SUPABASE_INTERNAL_IMAGE_REGISTRY=public.ecr.aws \
    FAIRSWAP_DB_CLEAN_ENV=1 FAIRSWAP_DB_TASK="$task" FAIRSWAP_DB_OWNER="$owner" \
    bash "$root/scripts/stage3/run-local-db.sh" "$evidence"
fi
task=$(realpath -- "${FAIRSWAP_DB_TASK:?}")
[[ $(basename -- "$task") == fairswap-stage3-ci.* && $task != "$root/"* ]] || exit 1
[[ ${FAIRSWAP_DB_OWNER:?} == "$(cat -- "$task/owner")" ]] || exit 1
raw="$task/raw"
project="$task/project"
cli="$task/bin/supabase"
project_id="fairswap-ci-$(node -p 'crypto.randomBytes(10).toString("hex")')"
network="${project_id}-net"
db="supabase_db_${project_id}"
probe="${project_id}-binding-probe"
# Kernel interface names are limited to 15 bytes; task-specific, never global.
fw_if="fs$(node -p 'crypto.randomBytes(6).toString("hex")')"
fw4_fwd=0
fw6_fwd=0
fw4_input=0
fw6_input=0
snapshotted=0
db_port=0
exec 3>&1
exec >>"$raw/runner.log" 2>&1
# Fixed, non-sensitive phase marker for fail-closed GitHub diagnostics.
failure_stage=preflight
failure_category=none

inventory() {
  docker ps -aq --no-trunc | sort >"$raw/containers-$1.txt" || return 1
  docker volume ls -q | sort >"$raw/volumes-$1.txt" || return 1
  docker network ls -q --no-trunc | sort >"$raw/networks-$1.txt" || return 1
}
cli_local() { (cd -- "$project" && "$cli" "$@" --workdir "$project" --network-id "$network"); }
json_true() {
  node --input-type=module - "$1" "${@:2}" <<'NODE'
import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(process.argv.slice(3).map(k => [k,true]))));
NODE
}
sanitize_failure() {
  failure_stage=${failure_stage:-unclassified}
  failure_category=${failure_category:-none}
  case ${failure_stage:-unclassified} in
    unclassified|preflight|manifest-before|cli-download|cli-check|images|network-setup|port-probe|db-start|isolation-before|migrations|security-before|pgtap|security-after|isolation-after|manifest-after|complete|port-probe-run|port-probe-inspect|port-probe-binding|port-probe-cleanup|firewall-hooks|firewall-setup|firewall-verify|route-isolation|security-before-sql|security-before-verify|cleanup|artifact-validation|image-postgres-buildx-check|image-postgres-index-fetch|image-postgres-index-digest|image-postgres-amd64-descriptor|image-postgres-child-fetch|image-postgres-child-digest|image-postgres-child-pull|image-postgres-child-id-inspect|image-pin-list|image-role-validate|image-postgres-child-id-verify|image-tools-evidence|image-postgres-reference-select|image-pgProve-reference-select|image-postgres-validate|image-postgres-reference-validate|image-postgres-pull|image-postgres-id-inspect|image-postgres-platform-inspect|image-postgres-platform-verify|image-postgres-repo-digests-inspect|image-postgres-repo-digests-verify|image-postgres-tag-probe|image-postgres-tag-existing-id-inspect|image-postgres-tag-existing-id-verify|image-postgres-tag-create|image-postgres-tag-final-id-inspect|image-postgres-tag-final-id-verify|image-postgres-evidence|image-pgProve-validate|image-pgProve-reference-validate|image-pgProve-pull|image-pgProve-id-inspect|image-pgProve-platform-inspect|image-pgProve-platform-verify|image-pgProve-repo-digests-inspect|image-pgProve-repo-digests-verify|image-pgProve-tag-probe|image-pgProve-tag-existing-id-inspect|image-pgProve-tag-existing-id-verify|image-pgProve-tag-create|image-pgProve-tag-final-id-inspect|image-pgProve-tag-final-id-verify|image-pgProve-evidence|image-authBootstrap-validate|image-authBootstrap-reference-validate|image-authBootstrap-pull|image-authBootstrap-id-inspect|image-authBootstrap-platform-inspect|image-authBootstrap-platform-verify|image-authBootstrap-repo-digests-inspect|image-authBootstrap-repo-digests-verify|image-authBootstrap-tag-probe|image-authBootstrap-tag-existing-id-inspect|image-authBootstrap-tag-existing-id-verify|image-authBootstrap-tag-create|image-authBootstrap-tag-final-id-inspect|image-authBootstrap-tag-final-id-verify|image-authBootstrap-evidence|image-storageBootstrap-validate|image-storageBootstrap-reference-validate|image-storageBootstrap-pull|image-storageBootstrap-id-inspect|image-storageBootstrap-platform-inspect|image-storageBootstrap-platform-verify|image-storageBootstrap-repo-digests-inspect|image-storageBootstrap-repo-digests-verify|image-storageBootstrap-tag-probe|image-storageBootstrap-tag-existing-id-inspect|image-storageBootstrap-tag-existing-id-verify|image-storageBootstrap-tag-create|image-storageBootstrap-tag-final-id-inspect|image-storageBootstrap-tag-final-id-verify|image-storageBootstrap-evidence|image-realtimeBootstrap-validate|image-realtimeBootstrap-reference-validate|image-realtimeBootstrap-pull|image-realtimeBootstrap-id-inspect|image-realtimeBootstrap-platform-inspect|image-realtimeBootstrap-platform-verify|image-realtimeBootstrap-repo-digests-inspect|image-realtimeBootstrap-repo-digests-verify|image-realtimeBootstrap-tag-probe|image-realtimeBootstrap-tag-existing-id-inspect|image-realtimeBootstrap-tag-existing-id-verify|image-realtimeBootstrap-tag-create|image-realtimeBootstrap-tag-final-id-inspect|image-realtimeBootstrap-tag-final-id-verify|image-realtimeBootstrap-evidence ) ;;
    *) failure_stage=unclassified; failure_category=unclassified ;;
  esac
  case ${failure_category:-none} in
    none|unclassified|required-tool-check-failed|manifest-retrieval-failed|digest-check-failed|descriptor-check-failed|image-pull-failed|image-inspect-failed|platform-check-failed|repo-digest-check-failed|child-image-id-check-failed|pin-check-failed|tag-check-failed|tag-create-failed|evidence-write-failed|cleanup-failed|evidence-validation-failed|manifest-not-found|registry-denied|rate-limited|transport-error|storage-error|unsupported-manifest|probe-run-error|probe-port-conflict|probe-network-rule-error|probe-entrypoint-error|probe-image-missing|probe-port-missing|probe-wildcard-binding|probe-other-binding|security-parse|security-version|security-ledger|security-vault|security-setting|security-queues|security-buckets|security-rls|security-column-grants|security-rls-shape|security-extensions|security-rpcs|security-cron|security-runtime|security-trigger|security-unclassified|security-rls-email_outbox-present|security-rls-email_outbox-relrowsecurity|security-rls-email_outbox-relforcerowsecurity|security-rls-email_outbox-policies|security-rls-email_outbox-anon_any_dml|security-rls-email_outbox-authenticated_any_dml|security-rls-listing_media-present|security-rls-listing_media-relrowsecurity|security-rls-listing_media-relforcerowsecurity|security-rls-listing_media-policies|security-rls-listing_media-anon_any_dml|security-rls-listing_media-authenticated_any_dml|security-rls-listings-present|security-rls-listings-relrowsecurity|security-rls-listings-relforcerowsecurity|security-rls-listings-policies|security-rls-listings-anon_any_dml|security-rls-listings-authenticated_any_dml ) ;;
    *) failure_category=unclassified ;;
  esac
}
cleanup() {
  local execution=$? cleanup_ok=1 collection=1
  trap - EXIT INT TERM
  set +e
  # Only UUID-scoped ownership labels; never prune, stop all, or touch other projects.
  if [[ $snapshotted == 1 ]]; then
    if [[ -x $cli ]]; then cli_local stop --project-id "$project_id" --no-backup >"$raw/stop.log" 2>&1; fi
    docker ps -aq --filter "label=com.supabase.cli.project=$project_id" >"$raw/owned-containers.txt" || cleanup_ok=0
    while IFS= read -r id; do
      [[ -n $id ]] || continue
      if grep -Fxq -- "$id" "$raw/containers-before.txt"; then cleanup_ok=0; continue; fi
      docker rm -f "$id" || cleanup_ok=0
    done <"$raw/owned-containers.txt"
    docker volume ls -q --filter "label=com.supabase.cli.project=$project_id" >"$raw/owned-volumes.txt" || cleanup_ok=0
    while IFS= read -r volume; do
      [[ -n $volume ]] || continue
      if grep -Fxq -- "$volume" "$raw/volumes-before.txt"; then cleanup_ok=0; continue; fi
      docker volume rm "$volume" || cleanup_ok=0
    done <"$raw/owned-volumes.txt"
    if docker network inspect "$network" >/dev/null 2>&1; then
      [[ $(docker network inspect -f '{{index .Labels "com.supabase.cli.project"}}' "$network") == "$project_id" ]] \
        && docker network rm "$network" || cleanup_ok=0
    fi
    docker ps -aq --filter "label=com.supabase.cli.project=$project_id" >"$raw/remaining-containers.txt" || cleanup_ok=0
    docker volume ls -q --filter "label=com.supabase.cli.project=$project_id" >"$raw/remaining-volumes.txt" || cleanup_ok=0
    [[ ! -s $raw/remaining-containers.txt && ! -s $raw/remaining-volumes.txt ]] || cleanup_ok=0
    docker network inspect "$network" >/dev/null 2>&1 && cleanup_ok=0
    # Reverse only the four exact per-interface rules installed by this task.
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
    inventory after || cleanup_ok=0
    for kind in containers volumes networks; do cmp -s "$raw/$kind-before.txt" "$raw/$kind-after.txt" || cleanup_ok=0; done
    if [[ $db_port != 0 ]]; then
      node --input-type=module - "$db_port" <<'NODE'
import net from 'node:net';
const socket=net.connect({host:'127.0.0.1',port:Number(process.argv[2])});
socket.setTimeout(2000,()=>{socket.destroy();process.exit(1)});
socket.on('connect',()=>{socket.destroy();process.exit(1)});
socket.on('error',error=>process.exit(error.code==='ECONNREFUSED'?0:1));
NODE
      [[ $? == 0 ]] || cleanup_ok=0
    fi
  else cleanup_ok=0; fi
  if [[ $cleanup_ok == 1 ]]; then
    json_true "$raw/cleanup.json" containersRemoved volumesRemoved networkRemoved portClosed baselineResourcesPreserved firewallRemoved
  fi
  printf '{"exitCode":%d}\n' "$execution" >"$raw/execution.json"
  if [[ $execution == 0 ]]; then
    if [[ $cleanup_ok == 1 ]]; then failure_stage=complete; failure_category=none
    else failure_stage=cleanup; failure_category=cleanup-failed
    fi
  fi
  sanitize_failure
  printf '{"stage":"%s","category":"%s"}\n' "$failure_stage" "$failure_category" >"$raw/diagnostic.json"
  node "$root/scripts/stage3/verify-db-results.mjs" --collect "$raw" "$evidence" >&3 2>&3
  collection=$?
  # Verified task-only temporary path, including local credentials/private raw logs.
  if [[ $(realpath -- "$task") == "$task" && $(basename -- "$task") == fairswap-stage3-ci.* && $task != "$root/"* \
    && $FAIRSWAP_DB_OWNER == "$(cat -- "$task/owner")" ]]; then
    rm -rf -- "$task" || cleanup_ok=0
  else cleanup_ok=0; fi
  if [[ $cleanup_ok != 1 ]]; then
    # Invalidate an earlier success artifact if private task-directory removal failed.
    if [[ $execution == 0 ]]; then failure_stage=cleanup; failure_category=cleanup-failed; fi
    sanitize_failure
    node "$root/scripts/stage3/verify-db-results.mjs" --cleanup-failed "$evidence" "$failure_stage" "$failure_category" >&3 2>&3
  fi
  if [[ $execution == 0 && $cleanup_ok == 1 && $collection == 0 ]]; then exit 0; fi
  if [[ $execution == 0 ]]; then
    if [[ $cleanup_ok != 1 ]]; then failure_stage=cleanup; failure_category=cleanup-failed
    else failure_stage=artifact-validation; failure_category=evidence-validation-failed
    fi
  fi
  sanitize_failure
  printf 'FAIL: database CI stage=%s; raw output withheld\n' "$failure_stage" >&3
  if [[ ${failure_category:-none} != none ]]; then
    printf 'FAIL: database CI category=%s; raw output withheld\n' "$failure_category" >&3
  fi
  echo 'FAIL: database CI or cleanup incomplete; see sanitized failure artifact' >&3
  exit 1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for tool in node docker curl tar sha256sum timeout sudo nsenter ip iptables ip6tables cmp; do command -v "$tool" >/dev/null; done
[[ $(node -p 'process.versions.node') == 24.15.0 ]]
sudo -n true
[[ $(docker version --format '{{.Server.Os}}/{{.Server.Arch}}') == linux/amd64 ]]
docker_version=$(docker version --format '{{.Server.Version}}')
[[ $docker_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && ${docker_version%%.*} -ge 28 ]]
[[ ! -d $evidence ]] || [[ -z $(ls -A -- "$evidence") ]]
inventory before
snapshotted=1
[[ -z $(docker ps -aq --filter "label=com.supabase.cli.project=$project_id") ]]
[[ -z $(docker volume ls -q --filter "label=com.supabase.cli.project=$project_id") ]]
! docker network inspect "$network" >/dev/null 2>&1
failure_stage=manifest-before
node "$root/scripts/ci/verify-baseline.mjs"

# Complete all downloads before creating the isolated network or database.
failure_stage=cli-download
mapfile -t cli_pins < <(node --input-type=module - "$root/scripts/stage3/toolchain.json" <<'NODE'
import {readFileSync} from 'node:fs'; const p=JSON.parse(readFileSync(process.argv[2])).database;
console.log(p.cliArchive);console.log(p.cliArchiveSha256);
NODE
)
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "${cli_pins[0]}" -o "$task/cli.tar.gz"
printf '%s  %s\n' "${cli_pins[1]}" "$task/cli.tar.gz" | sha256sum -c -
tar -xzf "$task/cli.tar.gz" -C "$task/bin" supabase
chmod 700 "$cli"
failure_stage=cli-check
[[ $(cli_local --version) == 2.117.0 ]]
cli_local db start --help >"$raw/start-help.txt"
cli_local migration up --help >"$raw/migration-help.txt"
cli_local test db --help >"$raw/test-help.txt"
failure_stage=images
# Stage/category arguments are fixed literals or validated role/operation pairs.
image_phase() { failure_stage=$1; failure_category=$2; }
classify_registry_failure() {
  # Read only task-private stderr; publish a fixed category, never matched text.
  if grep -Eiq 'toomanyrequests|too many requests|rate limit|(^|[^0-9])429([^0-9]|$)' "$1"; then
    failure_category=rate-limited
  elif grep -Eiq 'manifest unknown|manifest.*not found|blob unknown|(^|[^0-9])404([^0-9]|$)' "$1"; then
    failure_category=manifest-not-found
  elif grep -Eiq 'denied|unauthorized|authentication|authorization|forbidden|(^|[^0-9])(401|403)([^0-9]|$)' "$1"; then
    failure_category=registry-denied
  elif grep -Eiq 'unsupported.*manifest|unsupported media type|no matching manifest' "$1"; then
    failure_category=unsupported-manifest
  elif grep -Eiq 'no space left on device|insufficient (disk|storage)' "$1"; then
    failure_category=storage-error
  elif grep -Eiq 'timeout|connection reset|connection refused|network unreachable|no route to host|TLS handshake|context deadline|EOF|proxyconnect' "$1"; then
    failure_category=transport-error
  fi
}
image_phase image-postgres-buildx-check required-tool-check-failed
docker buildx version >"$raw/buildx-version.txt" 2>"$raw/buildx-check.log"
pg_index='sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb'
pg_child='sha256:16c0944c77885446d4f2ebbb2191b357feeb3b1295bde2fb1978c113129dbeb4'
pg_repository='public.ecr.aws/supabase/postgres'
image_phase image-postgres-index-fetch manifest-retrieval-failed
if ! docker buildx imagetools inspect --raw "$pg_repository@$pg_index" >"$raw/pg17-index.json" 2>"$raw/pg17-index-fetch.log"; then
  classify_registry_failure "$raw/pg17-index-fetch.log"; exit 1
fi
image_phase image-postgres-index-digest digest-check-failed
printf '%s  %s\n' "${pg_index#sha256:}" "$raw/pg17-index.json" | sha256sum -c -
image_phase image-postgres-amd64-descriptor descriptor-check-failed
node --input-type=module - "$raw/pg17-index.json" "$pg_child" <<'NODE'
import {readFileSync} from 'node:fs';
const [file,child]=process.argv.slice(2);const index=JSON.parse(readFileSync(file));
const matches=index.manifests?.filter(x=>x.platform?.os==='linux'&&x.platform?.architecture==='amd64');
if(matches?.length!==1||matches[0].digest!==child) process.exit(1);
NODE
image_phase image-postgres-child-fetch manifest-retrieval-failed
if ! docker buildx imagetools inspect --raw "$pg_repository@$pg_child" >"$raw/pg17-child.json" 2>"$raw/pg17-child-fetch.log"; then
  classify_registry_failure "$raw/pg17-child-fetch.log"; exit 1
fi
image_phase image-postgres-child-digest digest-check-failed
printf '%s  %s\n' "${pg_child#sha256:}" "$raw/pg17-child.json" | sha256sum -c -
image_phase image-postgres-child-pull image-pull-failed
if ! docker pull --platform linux/amd64 "$pg_repository@$pg_child" >"$raw/pg17-child-pull.log" 2>&1; then
  classify_registry_failure "$raw/pg17-child-pull.log"; exit 1
fi
image_phase image-postgres-child-id-inspect image-inspect-failed
pg_child_id=$(docker image inspect -f '{{.Id}}' "$pg_repository@$pg_child")
# Check the producer directly: process-substitution failure must not look like an empty successful loop.
image_phase image-pin-list pin-check-failed
node --input-type=module - "$root/scripts/stage3/toolchain.json" >"$raw/image-pins.tsv" <<'NODE'
import {readFileSync} from 'node:fs'; const p=JSON.parse(readFileSync(process.argv[2])).database;
for(const [key,{tag,digest}] of Object.entries(p.images)) console.log([key,tag,digest].join('\t'));
NODE
while IFS=$'\t' read -r key tag digest; do
  image_phase image-role-validate pin-check-failed
  case "$key" in postgres|pgProve|authBootstrap|storageBootstrap|realtimeBootstrap) ;; *) exit 1 ;; esac
  image_phase "image-$key-validate" pin-check-failed
  [[ $tag =~ ^public.ecr.aws/supabase/[a-z_-]+:[A-Za-z0-9._-]+$ && $digest =~ ^sha256:[a-f0-9]{64}$ ]]
  source_ref="${tag#public.ecr.aws/}"
  source_ref="${source_ref%:*}@$digest"
  if [[ $key == postgres ]]; then source_ref="$pg_repository@$pg_index"; fi
  image_phase "image-$key-reference-validate" pin-check-failed
  [[ $source_ref =~ ^(public.ecr.aws/)?supabase/[a-z_-]+@sha256:[a-f0-9]{64}$ ]]
  image_phase "image-$key-pull" image-pull-failed
  pull_log="$raw/image-pull-$key.log"
  if ! docker pull --platform linux/amd64 "$source_ref" >"$pull_log" 2>&1; then
    classify_registry_failure "$pull_log"; exit 1
  fi
  image_phase "image-$key-id-inspect" image-inspect-failed
  id=$(docker image inspect -f '{{.Id}}' "$source_ref")
  image_phase "image-$key-platform-inspect" image-inspect-failed
  platform=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$source_ref")
  image_phase "image-$key-platform-verify" platform-check-failed
  [[ $platform == linux/amd64 ]]
  image_phase "image-$key-repo-digests-inspect" image-inspect-failed
  repo_digests=$(docker image inspect -f '{{json .RepoDigests}}' "$source_ref")
  image_phase "image-$key-repo-digests-verify" repo-digest-check-failed
  node --input-type=module - "$repo_digests" "$source_ref" <<'NODE'
const [raw,reference]=process.argv.slice(2);
const refs=JSON.parse(raw);
if(!Array.isArray(refs)||!refs.some(ref=>ref===reference||ref==="docker.io/"+reference)) process.exit(1);
NODE
  if [[ $key == postgres ]]; then
    image_phase image-postgres-child-id-verify child-image-id-check-failed
    [[ $id == "$pg_child_id" ]]
  fi
  image_phase "image-$key-tag-probe" image-inspect-failed
  if docker image inspect "$tag" >/dev/null 2>&1; then
    image_phase "image-$key-tag-existing-id-inspect" image-inspect-failed
    tag_id=$(docker image inspect -f '{{.Id}}' "$tag")
    image_phase "image-$key-tag-existing-id-verify" tag-check-failed
    [[ $tag_id == "$id" ]]
  else
    image_phase "image-$key-tag-create" tag-create-failed
    docker tag "$source_ref" "$tag"
  fi
  image_phase "image-$key-tag-final-id-inspect" image-inspect-failed
  tag_id=$(docker image inspect -f '{{.Id}}' "$tag")
  image_phase "image-$key-tag-final-id-verify" tag-check-failed
  [[ $tag_id == "$id" ]]
  image_phase "image-$key-evidence" evidence-write-failed
  node --input-type=module - "$raw/images.json" "$key" "$tag" "$digest" "$id" <<'NODE'
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const [file,key,tag,digest,imageId]=process.argv.slice(2); const o=existsSync(file)?JSON.parse(readFileSync(file)):{};
o[key]={tag,digest,imageId,platform:'linux/amd64'};writeFileSync(file,JSON.stringify(o));
NODE
done <"$raw/image-pins.tsv"
image_phase image-tools-evidence evidence-write-failed
node --input-type=module - "$raw/tools.json" "$docker_version" <<'NODE'
import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2],JSON.stringify({nodeVersion:process.versions.node,cliVersion:'2.117.0',dockerVersion:process.argv[3],os:'linux',arch:'amd64'}));
NODE
image_ref() {
  node --input-type=module - "$root/scripts/stage3/toolchain.json" "$1" <<'NODE'
import {readFileSync} from 'node:fs';const p=JSON.parse(readFileSync(process.argv[2])).database.images[process.argv[3]];
if(!p?.tag?.startsWith('public.ecr.aws/supabase/')) process.exit(1);
console.log((process.argv[3]==='postgres'?'public.ecr.aws/':'')+p.tag.slice('public.ecr.aws/'.length,p.tag.lastIndexOf(':'))+'@'+p.digest);
NODE
}
image_phase image-postgres-reference-select pin-check-failed
pg_ref=$(image_ref postgres)
image_phase image-pgProve-reference-select pin-check-failed
prove_ref=$(image_ref pgProve)
failure_stage=port-probe
failure_category=none
mapfile -t ports < <(node --input-type=module <<'NODE'
import net from 'node:net';
const servers=[];
for(let i=0;i<5;i++){const server=net.createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));servers.push(server);console.log(server.address().port)}
for(const server of servers)server.close();
NODE
)
[[ ${#ports[@]} == 5 ]]
db_port=${ports[0]}
mkdir -p "$project/supabase"
cat >"$project/supabase/config.toml" <<EOF
project_id = "$project_id"
[db]
port = $db_port
shadow_port = ${ports[1]}
major_version = 17
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
EOF
v6="fd$(node -p 'crypto.randomBytes(1).toString("hex")'):$(node -p 'crypto.randomBytes(2).toString("hex")'):$(node -p 'crypto.randomBytes(2).toString("hex")')::/64"
failure_stage=network-setup
docker network create --driver bridge --ipv6 --subnet "$v6" \
  --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 \
  --opt com.docker.network.bridge.name="$fw_if" \
  --label "com.supabase.cli.project=$project_id" "$network"
# A normal bridge can publish loopback ports. Block external forwarding and
# new connections to host services for this task's interface before any container starts.
# Refuse nftables-only/unsupported Docker firewall backends rather than silently bypassing.
failure_stage=firewall-hooks
sudo -n iptables -w -C FORWARD -j DOCKER-USER
sudo -n ip6tables -w -C FORWARD -j DOCKER-USER
! sudo -n iptables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP >/dev/null 2>&1
! sudo -n ip6tables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP >/dev/null 2>&1
failure_stage=firewall-setup
sudo -n iptables -w -I DOCKER-USER 1 -i "$fw_if" ! -o "$fw_if" -j DROP
fw4_fwd=1
sudo -n ip6tables -w -I DOCKER-USER 1 -i "$fw_if" ! -o "$fw_if" -j DROP
fw6_fwd=1
sudo -n iptables -w -I INPUT 1 -i "$fw_if" -m conntrack --ctstate NEW -j DROP
fw4_input=1
sudo -n ip6tables -w -I INPUT 1 -i "$fw_if" -m conntrack --ctstate NEW -j DROP
fw6_input=1
verify_host_firewall() {
  [[ $fw4_fwd == 1 && $fw6_fwd == 1 && $fw4_input == 1 && $fw6_input == 1 ]]
  sudo -n iptables -w -C FORWARD -j DOCKER-USER
  sudo -n ip6tables -w -C FORWARD -j DOCKER-USER
  sudo -n iptables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP
  sudo -n ip6tables -w -C DOCKER-USER -i "$fw_if" ! -o "$fw_if" -j DROP
  sudo -n iptables -w -C INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP
  sudo -n ip6tables -w -C INPUT -i "$fw_if" -m conntrack --ctstate NEW -j DROP
  ip link show "$fw_if" >/dev/null
}
failure_stage=firewall-verify
verify_host_firewall
# Verify implicit publishing behavior before starting even the empty base database.
failure_stage=port-probe-run
if ! docker run -d --pull never --name "$probe" --label "com.supabase.cli.project=$project_id" \
  --network "$network" -p "${ports[4]}:5432" --entrypoint sleep "$pg_ref" infinity \
  >"$raw/probe-run.log" 2>&1; then
  failure_category=probe-run-error
  if grep -Eiq 'port is already allocated|address already in use|port allocation' "$raw/probe-run.log"; then
    failure_category=probe-port-conflict
  elif grep -Eiq 'iptables|ip6tables|programming external connectivity|failed to create endpoint' "$raw/probe-run.log"; then
    failure_category=probe-network-rule-error
  elif grep -Eiq 'executable file not found|exec:.*sleep|unknown command.*sleep' "$raw/probe-run.log"; then
    failure_category=probe-entrypoint-error
  elif grep -Eiq 'no such image|image.*not found|manifest unknown' "$raw/probe-run.log"; then
    failure_category=probe-image-missing
  fi
  exit 1
fi
failure_stage=port-probe-inspect
docker inspect "$probe" >"$raw/binding-probe.json"
failure_stage=port-probe-binding
if ! node --input-type=module - "$raw/binding-probe.json" "$raw/probe-category.txt" <<'NODE'
import {readFileSync,writeFileSync} from 'node:fs';
const [file,categoryFile]=process.argv.slice(2);
const p=JSON.parse(readFileSync(file))[0].NetworkSettings.Ports['5432/tcp'];
const fail=(category)=>{writeFileSync(categoryFile,category);process.exit(1)};
if(!Array.isArray(p)||p.length===0) fail('probe-port-missing');
if(p.some(x=>x.HostIp==='0.0.0.0'||x.HostIp==='::')) fail('probe-wildcard-binding');
if(!p.every(x=>x.HostIp==='127.0.0.1'||x.HostIp==='::1')) fail('probe-other-binding');
NODE
then
  failure_category=$(cat "$raw/probe-category.txt" 2>/dev/null || printf 'unclassified')
  exit 1
fi
failure_stage=port-probe-cleanup
docker rm -f "$probe"
failure_stage=db-start
cli_local db start >"$raw/start.log" 2>&1

# Validate the actual PG17 patch before canonical migrations or compatibility SQL.
[[ $(docker exec "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'SHOW server_version_num') == 170006 ]]
[[ $(docker exec "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SELECT split_part(current_setting('server_version'), ' ', 1)") == 17.6 ]]
# Task database only: no cron launches even while the transactional fixture switch is true.
docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "ALTER SYSTEM SET cron.launch_active_jobs = off" >"$raw/cron-config.log" 2>&1
docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT pg_reload_conf()" >>"$raw/cron-config.log" 2>&1
cron_safe=0
for attempt in 1 2 3 4 5; do
  if [[ $(docker exec "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'SHOW cron.launch_active_jobs') == off ]]; then cron_safe=1; break; fi
  sleep 1
done
[[ $cron_safe == 1 ]]
# Test infrastructure only; canonical migration files and ledger stay untouched.
docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions' >"$raw/pgtap-extension.log" 2>&1

# Defense in depth: remove default routes inside this disposable database
# namespace before introducing FairSwap SQL. Same-bridge SQL still works.
failure_stage=route-isolation
db_pid=$(docker inspect -f '{{.State.Pid}}' "$db")
[[ $db_pid =~ ^[1-9][0-9]*$ ]]
for family in 4 6; do
  for attempt in 1 2 3; do
    routes=$(sudo -n nsenter --target "$db_pid" --net -- ip "-$family" route show default)
    [[ -n $routes ]] || break
    sudo -n nsenter --target "$db_pid" --net -- ip "-$family" route del default
  done
  [[ -z $(sudo -n nsenter --target "$db_pid" --net -- ip "-$family" route show default) ]]
done

check_isolation() {
  local output=$1 pid sandbox
  docker network inspect "$network" >"$raw/network.json"
  docker inspect "$db" >"$raw/database.json"
  verify_host_firewall
  node --input-type=module - "$raw/network.json" "$raw/database.json" "$network" "$db_port" "$raw/images.json" "$fw_if" <<'NODE'
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const [nf,df,name,port,im,iface]=process.argv.slice(2);const n=JSON.parse(readFileSync(nf))[0],d=JSON.parse(readFileSync(df))[0];
assert.equal(n.Internal,false);assert.equal(n.EnableIPv6,true);assert.equal(n.Driver,'bridge');
assert.equal(n.Options['com.docker.network.bridge.host_binding_ipv4'],'127.0.0.1');
assert.equal(n.Options['com.docker.network.bridge.name'],iface);
assert.deepEqual(Object.keys(d.NetworkSettings.Networks),[name]);
const p=d.NetworkSettings.Ports['5432/tcp'];assert.ok(Array.isArray(p)&&p.length>0);
assert.ok(p.every(x=>(x.HostIp==='127.0.0.1'||x.HostIp==='::1')&&x.HostPort===port));
assert.equal(d.Image,JSON.parse(readFileSync(im)).postgres.imageId);
NODE
  pid=$(docker inspect -f '{{.State.Pid}}' "$db")
  sandbox=$(docker inspect -f '{{.NetworkSettings.SandboxKey}}' "$db")
  [[ $pid =~ ^[1-9][0-9]*$ && $sandbox == /var/run/docker/netns/* ]]
  # This fails on remote engines / Docker Desktop rather than probing the wrong host namespace.
  [[ $(sudo -n stat -Lc %i "/proc/$pid/ns/net") == $(sudo -n stat -Lc %i "$sandbox") ]]
  sudo -n nsenter --target "$pid" --net -- true
  [[ -z $(sudo -n nsenter --target "$pid" --net -- ip -4 route show default) ]]
  [[ -z $(sudo -n nsenter --target "$pid" --net -- ip -6 route show default) ]]
  timeout 2 bash -c 'exit 0'
  local status=0
  timeout 1 bash -c 'sleep 3' || status=$?
  [[ $status == 124 ]]
  sudo -n nsenter --target "$pid" --net -- timeout 3 bash -c 'exec 9<>/dev/tcp/127.0.0.1/5432'
  for address in 1.1.1.1 8.8.8.8 2606:4700:4700::1111 2001:4860:4860::8888; do
    status=0
    sudo -n nsenter --target "$pid" --net -- timeout 3 bash -c 'exec 9<>/dev/tcp/$1/443' -- "$address" || status=$?
    [[ $status == 1 || $status == 124 ]]
  done
  node --input-type=module - "$db_port" <<'NODE'
import net from 'node:net';const socket=net.connect({host:'127.0.0.1',port:Number(process.argv[2])});
socket.setTimeout(3000,()=>{socket.destroy();process.exit(1)});
socket.on('connect',()=>{socket.destroy();process.exit(0)});socket.on('error',()=>process.exit(1));
NODE
  cli_local db query --local 'SELECT 1 AS local_connectivity' >"$raw/host-query.log" 2>&1
  [[ $(docker run --rm --pull never --network "$network" --label "com.supabase.cli.project=$project_id" \
    -e PGPASSWORD=postgres -e PGCONNECT_TIMEOUT=5 --entrypoint psql "$prove_ref" -X -Atq -h "$db" -U postgres -d postgres -c 'SELECT 1') == 1 ]]
  json_true "$output" firewallIsolated loopbackOnly nativeNamespace hostSql runnerSql ipv4Denied ipv6Denied probesExecuted noExtraNetworks
}
failure_stage=isolation-before
check_isolation "$raw/isolation-before.json"

# Only now introduce FairSwap's byte-preserved migration history and nine required tests.
failure_stage=migrations
mkdir -p "$project/supabase/migrations" "$project/supabase/tests" "$project/docs/extraction"
cp -- "$root/docs/extraction/MIGRATION_MANIFEST.sha256" "$project/docs/extraction/"
cp -- "$root"/supabase/migrations/*.sql "$project/supabase/migrations/"
node --input-type=module - "$root/scripts/ci/verify-baseline.mjs" "$project" <<'NODE'
import {pathToFileURL} from 'node:url';const {verifyBaseline}=await import(pathToFileURL(process.argv[2]));verifyBaseline(process.argv[3]);
NODE
cli_local migration up --local >"$raw/migrations.log" 2>&1
failure_stage=security-before-sql
docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres \
  <"$root/scripts/stage3/assert-local-security.sql" >"$raw/security-before.json"
failure_stage=security-before-verify
if ! node --input-type=module - "$root/scripts/stage3/verify-db-results.mjs" "$raw/security-before.json" \
  "$root/docs/extraction/evidence/stage2b/r6/result.json" "$raw/security-category.txt" <<'NODE'
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
const [verifierPath,snapshotPath,referencePath,categoryPath]=process.argv.slice(2);
const {verifySecurity,expectedMigrationVersions,expectedRls,expectedColumnDml}=await import(pathToFileURL(verifierPath));
let snapshot;
try { snapshot=JSON.parse(readFileSync(snapshotPath,'utf8')); }
catch { writeFileSync(categoryPath,'security-parse'); process.exit(1); }
try { verifySecurity(snapshot); }
catch {
  const expected=JSON.parse(readFileSync(referencePath,'utf8')).security;
  const canonical=v=>Array.isArray(v)?v.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  const expectedSettings=expected.checks.runtime_settings.filter(row=>['cron.database_name','cron.host','cron.launch_active_jobs'].includes(row.name)).map(row=>row.name==='cron.launch_active_jobs'?{...row,setting:'off'}:row);
  const checks=[
    ['security-version',snapshot.postgresVersion==='17.6'&&snapshot.version_num===170006],
    ['security-ledger',equal(snapshot.migration_versions,expectedMigrationVersions())&&snapshot.migration_versions?.length===58],
    ['security-vault',snapshot.vault_count===0],
    ['security-setting',snapshot.moderation_automation_enabled==='false'],
    ['security-queues',snapshot.httpRequests===0&&snapshot.httpResponses===0],
    ['security-buckets',equal(snapshot.checks?.buckets,expected.checks.buckets)],
    ['security-rls',equal(snapshot.checks?.rls,expectedRls)],
    ['security-column-grants',equal(snapshot.checks?.column_dml,expectedColumnDml)],
    ['security-extensions',equal(snapshot.checks?.extensions,expected.checks.extensions)],
    ['security-rpcs',equal(snapshot.checks?.sensitive_rpcs,expected.checks.sensitive_rpcs)],
    ['security-cron',equal(snapshot.checks?.cron_jobs,expected.checks.cron_jobs)],
    ['security-runtime',equal(snapshot.checks?.runtime_settings,expectedSettings)],
    ['security-trigger',equal(snapshot.triggerAclContext,expected.triggerAclContext)],
  ];
  let failed=checks.find(([,passed])=>!passed)?.[0]??'security-unclassified';
  if(failed==='security-rls') {
    const names=['email_outbox','listing_media','listings'];
    const fields=['relrowsecurity','relforcerowsecurity','policies','anon_any_dml','authenticated_any_dml'];
    failed='security-rls-shape';
    for(const name of names){
      const observed=snapshot.checks?.rls?.find(row=>row.relname===name);
      const baseline=expectedRls.find(row=>row.relname===name);
      if(!observed||!baseline){failed='security-rls-'+name+'-present';break;}
      const field=fields.find(key=>!equal(observed[key],baseline[key]));
      if(field){failed='security-rls-'+name+'-'+field;break;}
    }
  }
  writeFileSync(categoryPath,failed);
  process.exit(1);
}
NODE
then
  failure_category=$(cat "$raw/security-category.txt" 2>/dev/null || printf 'security-unclassified')
  exit 1
fi
failure_stage=pgtap
suite_failure=0
while IFS= read -r file; do
  source="$root/supabase/tests/$file"
  if [[ $file == moderation_compatibility.test.sql ]]; then source="$root/tests/stage3/$file"; fi
  cp -- "$source" "$project/supabase/tests/$file"
  cmp -- "$source" "$project/supabase/tests/$file"
  status=0
  if [[ $file == moderation_compatibility.test.sql ]]; then
    # psql preserves TAP diagnostics and SQLSTATE observations; parser checks every assertion.
    docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres \
      <"$source" >"$raw/$file.log" 2>&1 || status=$?
    if [[ $status == 0 ]]; then
      node "$root/scripts/stage3/parse-compatibility.mjs" "$raw/$file.log" "$status" || status=1
    fi
  else
    cli_local test db --local "supabase/tests/$file" >"$raw/$file.log" 2>&1 || status=$?
  fi
  printf '%s\n' "$status" >"$raw/$file.exit"
  [[ $status == 0 ]] || suite_failure=1
done < <(node --input-type=module - "$root/scripts/stage3/verify-db-results.mjs" <<'NODE'
import {pathToFileURL} from 'node:url';const {requiredSuites}=await import(pathToFileURL(process.argv[2]));console.log(Object.keys(requiredSuites).join('\n'));
NODE
)
failure_stage=security-after
docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres \
  <"$root/scripts/stage3/assert-local-security.sql" >"$raw/security-after.json"
failure_stage=isolation-after
check_isolation "$raw/isolation-after.json"
failure_stage=manifest-after
node "$root/scripts/ci/verify-baseline.mjs"
node --input-type=module - "$raw/manifest.json" "$root/scripts/ci/verify-baseline.mjs" "$project" <<'NODE'
import {pathToFileURL} from 'node:url';import {writeFileSync} from 'node:fs';
const {manifestSha256,verifyBaseline}=await import(pathToFileURL(process.argv[3]));verifyBaseline(process.argv[4]);
writeFileSync(process.argv[2],JSON.stringify({sha256:manifestSha256,before:true,after:true}));
NODE
[[ $suite_failure == 0 ]] || { failure_stage=pgtap; exit 1; }
failure_stage=complete
# EXIT trap removes task resources, validates all results and emits only sanitized evidence.
