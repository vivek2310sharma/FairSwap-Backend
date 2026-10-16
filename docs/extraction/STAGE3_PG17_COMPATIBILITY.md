# Stage 3 / Issue 2: PostgreSQL 17.6 moderation compatibility preflight

Status: BLOCKED before runtime creation. No compatibility test has executed.
This is a source/preflight report, not a PG17 acceptance or defect-reproduction result.
Date: 16 October 2026 (Europe/Copenhagen).

## Authorization and provenance

The owner authorized isolated local PG17.6 tests only. No correction, hosted
connection, worker invocation, Issue update, commit, push, merge or PR was authorized.
The newer owner request supersedes old stage text only for this local test scope.

- Original branch: chore/backend-extraction-baseline.
- Original HEAD: 972685ed13cbc7829539ceb3d6dcfcc36bd38fc4.
- Original dirty files: AGENTS.md, README.md, docs/extraction/POINT1_BASELINE.md,
  docs/operations/DEPLOYMENT_OWNERSHIP.md. Their initial SHA-256 values were captured
  and their preservation checked. They were not staged, edited or transferred.
- Dedicated branch: test/stage3-moderation-pg17-compat.
- Dedicated managed worktree: <CODEX_WORKTREES>/stage3-moderation-pg17/FairSwap-Backend.
  The exact local path is provided through the delivery link, without embedding
  identifying user-directory paths in this report.
- Exact rehearsal base: cd9d697dd620375c681f2cff42340011d6242201.
- Issue and activation comment read:
  https://github.com/vivek2310sharma/FairSwap-Backend/issues/2
  https://github.com/vivek2310sharma/FairSwap-Backend/issues/2#issuecomment-6219274429

The base was fetched by exact SHA with --no-tags --no-write-fetch-head. The
original branch was not advanced, rebased, reset or cleaned. A new worktree and
the explicitly requested test branch were created without a commit.

The verified base is ten commits ahead of the original branch, touching six
CI/documentation files: the workflow, STAGE2C_CI.md, assert-local-security.sql,
db-verification.test.mjs, run-local-db.sh and verify-db-results.mjs. Changes cover
failure diagnostics, scoped firewall isolation, exact column-level privileges,
push-event scoping and immutable official Docker Hub provisioning. A Git tree
comparison of supabase/, src/, tests/, package.json and pnpm-lock.yaml returned
no differences. The owner-supplied green PG15 CI result is historical context,
not a newly executed result in this rehearsal.

## Blocking environment evidence

Read-only Docker Desktop server version probe:
29.8.2, linux, amd64. This is engine metadata, not a PostgreSQL server version.

The Docker Desktop Linux host was inspected as root through WSL using a clean
PATH. nsenter, timeout, ip and busybox were present. The standard /usr/local/sbin,
/usr/local/bin, /usr/sbin, /usr/bin, /sbin and /bin locations did not provide
iptables, ip6tables or legacy variants; standard nft locations were also absent.

The verified base's scripts/ci/run-local-db.sh requires iptables and ip6tables,
checks both FORWARD -> DOCKER-USER hooks, and installs/verifies task-interface
IPv4/IPv6 forwarding and host-INPUT drops before starting any container. It then
removes only the task database's default routes and probes external denial.

That verified mechanism cannot be established with the observed host tools.
No rules, routes, Docker settings, containers, networks or volumes were changed.
No alternate firewall implementation, privileged helper, unrestricted network,
hosted target or bare PostgreSQL substitute was attempted. Per the owner's
mandatory stop rule, runtime provisioning and test implementation stopped here.
Missing executables are a concrete preflight blocker; this report does not
claim that every possible newly provisioned Linux environment would be unsuitable.

## Candidate image and toolchain: source verification only

Official CLI 2.117.0 source selects:
public.ecr.aws/supabase/postgres:17.6.1.167

Anonymous registry manifest/index bytes were read and hashed:
- Index: sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb
- Linux/amd64 child: sha256:16c0944c77885446d4f2ebbb2191b357feeb3b1295bde2fb1978c113129dbeb4

These identify a candidate compatible image selected by the pinned CLI source.
No image was pulled or run. Observed PostgreSQL version: NOT OBSERVED.
Local CLI binary version/PG17 bootstrap compatibility: NOT EXECUTED.
The existing toolchain pins CLI 2.117.0; that configuration was not changed.
Node v24.15.0 and pnpm 10.12.1 version probes both exited 0.

## Raw-byte checkout prerequisite

The canonical Git manifest blob SHA-256 is:
eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd

All 58 canonical migration Git blobs matched the manifest independently using
raw git show buffers. No migration or manifest Git blob was modified.

The managed worktree inherits core.autocrlf=true. Its checkout manifest hash is:
94cdb4d32f8a434f52ab9597f52bbd450b1fcb3d9f7cafa1db904fa3691d6f09

All 58 checked-out migration files also differ in raw bytes from their manifest
entries. Git reports a clean tracked worktree, consistent with checkout filters,
but raw migration verification correctly fails. The manifest verifier was not
weakened. No canonical file or checkout configuration was rewritten to mask this.
A future rehearsal must materialize exact canonical bytes without overwriting
developer work or changing historical Git blobs before database execution.

## Source observations, not demonstrated runtime failures

Inspected the five requested migrations, worker core, moderation contract,
mocked worker tests, current PG15 harness/toolchain and relevant seller/media,
category and publication guards. Important paths and source locations:

1. 20261011000038_create_moderation_queue_and_results.sql:
   enqueue supersedes active generations and inserts a new request when entering
   pending review or increasing a pending revision (around lines 118-179).
   Claiming uses revision/status matching and SKIP LOCKED, increments attempts,
   and handles expired leases against max_attempts (around lines 184-279).
2. The same migration's app_security.impl_finalize_moderation_result validates
   claim identity/lease and listing revision/text under locks. Eligible clean
   results update listings to active at line 615. invalid_input attempts rejected
   at line 731. These are candidate correction locations for a separately
   authorized forward migration; do not edit historical migration files.
3. 20261011092234_test_family_submission_v1.sql installs
   app_security.test_submission_lifecycle() at line 45 and the lifecycle trigger
   at line 74. Its unsupported transition branch at line 69 explicitly raises
   42501 with "New-family pending edits, approval and publication are disabled".
   Other family guards may also reject; actual trigger ordering/error precedence
   has not been exercised. No runtime SQLSTATE is claimed.
4. The activation migration enables three Test-family submission policies; seller
   submission follows actual owner/policy/revision/context/media validation.
   20261012120000_post_ad_current_base_compatibility.sql later replaces the
   seller submit/media completion implementation. Fixtures must use the final
   58-migration definitions, not an earlier function body alone.
5. The worker returns success=false when the finalizer RPC returns an error.
   Its handler can still return HTTP 200 with per-job failure results. HTTP 200
   therefore cannot by itself prove successful finalization or terminal queue state.
   This transport behavior is not a deployed-worker test.
6. Failed SQL finalization is expected to roll back its statement/transaction,
   while a claim made by an earlier separate RPC may remain claimed until lease
   recovery. This is an inference requiring database confirmation, not a measured
   queue/attempt/result count.
7. checks_incomplete and expired-lease recovery contain attempt bounds. Media wait
   decrements attempt_count and retries after 30 seconds, so max_attempts alone
   does not establish an overall bound on persistent media-wait processing.
   Actual repeated processing/evidence growth remains unmeasured.
8. Required evaluator contract remains prototype_v0.1.1 / title_description with
   three completed rule identifiers. No image-content moderation is implied.

Recommendation only: a later separately approved correction should consider an
explicit experimental-family terminal outcome in the finalizer while preserving
Goods auto-publication, guards, seller validation, revisions, leases and ACLs.
No category-specific correction or guard bypass has been implemented.

## Extra Test ledger migration: parity limitation

20261010214201_staff_listing_review_context is not in the Backend canonical 58.
Pinned Web documentation at 9e65bfc42eab9697a0a144ed8546afe8309eaea3 describes a
read-only staff-review RPC wrapper/private implementation with active staff,
AAL2, current-policy, non-self and pending-review projection checks:

https://github.com/vivek2310sharma/FairSwap-Web/blob/9e65bfc42eab9697a0a144ed8546afe8309eaea3/docs/reference/post-ad/Post-Ad-Readiness-Verification.md
https://github.com/vivek2310sharma/FairSwap-Web/blob/9e65bfc42eab9697a0a144ed8546afe8309eaea3/docs/reference/post-ad/Post-Ad-Draft-Flow-Closeout.md

That documentation is provenance/context, not the missing executable SQL.
No SQL was invented, copied into the canonical chain or read from hosted Test.
The worker path inspected does not call a staff-review-context RPC, but full
staff-access/schema parity cannot be established from that observation. A future
58-migration rehearsal is scoped moderation compatibility, not complete hosted
Test-schema parity.

## Commands and actual results

| Operation | Exit/result | Meaning |
| --- | --- | --- |
| Local branch/worktree/status/log inspection | 0 | Original branch and four dirty documents identified |
| Initial git cat-file for requested commit | nonzero | Exact commit was not yet present locally |
| GitHub Issue #2, activation comment and exact commit reads | success | Read-only source/planning evidence |
| Exact git fetch --no-tags --no-write-fetch-head | 0 | Requested object available; branches not moved |
| git diff --quiet original..verified-base -- supabase src tests package.json pnpm-lock.yaml | 0 | No changes in those trees/files |
| Managed worktree creation / git switch -c test/stage3-moderation-pg17-compat | success / 0 | Isolated branch at exact requested base |
| Docker Desktop version query | 0 | Engine 29.8.2 linux/amd64 only |
| WSL clean-environment host tool/location inventory | 0 | Inventory completed; required firewall executables absent; not isolation PASS |
| Official CLI source/changelog and anonymous registry reads | success / 0 | Candidate image provenance only |
| node scripts/ci/verify-baseline.mjs in new worktree | 1 | Correctly rejected raw checkout-byte mismatch |
| Independent raw canonical Git-blob SHA-256 verification | 0 | Manifest anchor and 58/58 canonical Git blobs match |
| node --version / corepack pnpm --version | 0 / 0 | v24.15.0 / 10.12.1 |
| PG17 start, migration replay, dedicated tests, existing nine pgTAP suites | NOT RUN | Mandatory isolation stop |
| Existing five unit files / 93 tests in this new worktree | NOT RUN | No Stage 3 unit pass claim; earlier results are historical |

## Requested scenario classification

| Scenario | Expected | Observed | PASS/FAIL/BLOCKED | Evidence |
| --- | --- | --- | --- | --- |
| A Goods | Valid supported submission and one generation; permitted clean publication/audit | No fixture or database created | BLOCKED | Isolation preflight |
| B Revisions/generations | Supersession, stale-token rejection, bounded claims, no duplicate publication | No runtime observations | BLOCKED | Isolation preflight |
| C Cars | Supported submission; actual guarded finalizer response and queue state captured | Source conflict identified; no SQLSTATE/state measured | BLOCKED | Finalizer/lifecycle source |
| D Two-Wheelers | Same family-specific compatibility coverage | No runtime observations | BLOCKED | Isolation preflight |
| E Property | Valid financial/context submission and guarded finalization | No runtime observations | BLOCKED | Isolation preflight |
| F Other outcomes/media/leases | Actual needs_review/invalid_input/checks_incomplete and retry behavior | Source paths inspected only | BLOCKED | Source observations above |
| G Security | Role-aware RLS, service-only moderation, privacy and guard enforcement | No roles exercised in a database | BLOCKED | Isolation preflight |
| Existing nine pgTAP suites | Nine successful exits, 270 assertions | Not run on PG17 | BLOCKED | No server |
| Existing unit suite | Five files, 93 passing assertions | Not run for this rehearsal | BLOCKED | Mandatory preflight stop |

No synthetic request IDs, generations, attempts, terminal states, listing states,
audit/result counts or captured SQL errors exist for this run. None are fabricated.

## Cleanup and next gate

No task-owned Docker container, network, volume, database or firewall rule was
created, so no runtime cleanup action was necessary. Registry responses were
processed in memory. The dedicated Git worktree/branch and this report are
retained for CTO review; no existing worktree was archived or deleted.

No hosted Supabase SQL, connection, credentials, Vault changes, deployed worker,
canary listing, trigger setting, GitHub issue update or external repository write
was performed. Web, mobile, Admin and Help Center files were not modified.

Resume only after a compatible disposable Linux/Docker host can prove the
required IPv4/IPv6 isolation and exact canonical checkout bytes. Installing or
validating an alternative host isolation mechanism is not silently treated as
the existing verified method. No Stage 3 acceptance or correction is authorized
by this blocked report.


## Step 1A continuation: infrastructure prerequisite assessment

Date: 16 October 2026. Final classification: **BLOCKED_HOST**.
This appendix updates prerequisite status only; all earlier source observations,
exceptions and unexecuted scenario classifications remain intact. Exact checkout
bytes are now verified in an independent Linux checkout. No runtime authorization
is implied by resolving that prerequisite.

### Read-only execution-host assessment

- Docker contexts: default and desktop-linux. Endpoints are respectively
  npipe:////./pipe/docker_engine and
  npipe:////./pipe/dockerDesktopLinuxEngine; current context is desktop-linux.
  No configured independent native Linux/SSH daemon was found.
- Actual selected daemon: Docker Desktop, Linux x86_64; server 29.8.2,
  linux/amd64. Engine version exceeds the PG15 harness minimum major 28,
  but that does not establish firewall or namespace compatibility.
- Installed WSL distributions: Ubuntu and docker-desktop. Ubuntu reports Ubuntu
  26.04 LTS, Linux x86_64, not the preferred Ubuntu 24.04 execution host.
  Its clean Linux PATH contains Git 2.53.0, nsenter, ip, timeout and sudo.
  Native docker, dockerd, node, iptables and ip6tables are absent; no
  /var/run/docker.sock exists. Installing utilities there would not fix the
  separate Docker Desktop daemon host.
- Docker Desktop's distro was inspected as root with the standard Linux PATH.
  iptables, ip6tables, their legacy variants and nft are absent. nsenter, ip
  and timeout exist. CapEff/CapBnd are 000001ffffffffff (including NET_ADMIN
  and SYS_ADMIN); nsenter --target 1 --net -- /bin/true exits 0.
  These are capability observations, not proof that task-container namespace
  identity, firewall installation or isolation works.
- /proc/net/ip_tables_names is readable and empty; the IPv6 counterpart is
  unavailable. Required IPv4 and IPv6 FORWARD -> DOCKER-USER hooks are
  **UNVERIFIED**, not asserted absent: no compatible executable is available
  to inspect them. No rules were added or removed.
- The unchanged runner requires the native host's namespace to correspond to
  Docker's task database PID/SandboxKey, both firewall hooks, task-interface
  forwarding/INPUT drops, route removal within that task namespace, working
  loopback and runner SQL, and demonstrated external IPv4/IPv6 denial.
  The available environment cannot establish those prerequisites without
  separately approved host changes. No alternative security model was tried.

### Exact-byte checkout: PASS

A new independent local clone is retained at:

/var/tmp/fairswap-stage3-step1a.Q5wd28gM/FairSwap-Backend

Its filesystem reports ext2/ext3 through stat -f (Linux-native storage, not
/mnt/c). It is detached at cd9d697dd620375c681f2cff42340011d6242201;
the existing Windows test branch/worktree and original branch were preserved.
Clone used --no-checkout --no-hardlinks --local from the existing local object
store, with no network fetch. Origin was removed only from this new clone.

Only destination .git/config was set to core.autocrlf=false and core.eol=lf.
Git system/global config and system attributes were excluded for materialization
and verification using process-scoped GIT_CONFIG_NOSYSTEM=1,
GIT_CONFIG_GLOBAL=/dev/null and GIT_ATTR_NOSYSTEM=1. No shared/global settings
were edited. No tracked .gitattributes or destination .git/info/attributes exist;
all 236 text/eol/filter/working-tree-encoding attribute results for the manifest
and 58 migrations are unspecified.

- Exact HEAD: PASS.
- Manifest raw SHA-256:
  eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd: PASS.
- sha256sum -c docs/extraction/MIGRATION_MANIFEST.sha256: 58/58 PASS.
- Canonical migration file count: exactly 58, PASS.
- node scripts/ci/verify-baseline.mjs: exit 0;
  "PASS: approved manifest digest and 58 canonical migration byte hashes".
  Available Windows Node v24.15.0 executed it against the Linux files over the
  WSL UNC share. This is baseline verification, not a native Linux Node/runtime
  or dependency-installation result. Native Linux Node remains a host prerequisite.
- Native Linux Git status --porcelain: empty. No tracked or untracked changes.

An earlier task-only clone under /tmp passed the raw hashes but disappeared
after WSL stopped because /tmp is tmpfs. The initial Windows Node attempt against
that vanished path exited 1 (MODULE_NOT_FOUND). It was superseded by the persistent
checkout, without resetting/deleting an existing worktree. The first persistent
clone shell wrapper completed all checks but returned 1 from a trailing carriage
return after the final output; the clean read-only recheck and Node verifier each
exited 0. Neither failure was a migration-content or database result.

### PostgreSQL 17 prerequisites: source review only

Retain the previously observed CLI 2.117.0 candidate:

- public.ecr.aws/supabase/postgres:17.6.1.167
- Index sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb
- linux/amd64 child
  sha256:16c0944c77885446d4f2ebbb2191b357feeb3b1295bde2fb1978c113129dbeb4

These are inherited official source/registry observations, not newly pulled or
executed images. No registry or hosted service was contacted during Step 1A.
CLI binary execution and actual PostgreSQL 17.6/server_version_num=170006 remain
UNVERIFIED. The existing PG15 toolchain and security validator deliberately
require 15.8/150008; they must remain unchanged and cannot certify this PG17 image.

A future separately authorized PG17 rehearsal must verify the exact CLI archive
and binary, image index/platform child and actual server version; preserve the
unchanged Supabase role/schema bootstrap using its pinned Auth, Storage and
Realtime migration sources; and establish required extensions (including Vault,
pg_net, pg_cron and pgTAP) before canonical replay. Existing PG15 bootstrap image
pins are source references, not demonstrated PG17 bootstrap compatibility.
Download all required immutable dependencies before isolation. Do not run
workers, providers or dispatch; preserve empty Vault, safe cron settings,
role/RLS/grant checks and the documented trigger authorization exceptions.
No missing Test-ledger SQL is invented. The prior staff-review-context parity
limitation and email-outbox diagnostic exclusion remain unchanged.

### Minimum owner-provisioned host plan

Provisioning itself requires separate owner authorization and was not attempted.
Use a disposable Ubuntu 24.04 Linux/amd64 VM with its own native Docker Engine
(compatible version >=28), a compatible iptables backend and verified IPv4/IPv6
FORWARD -> DOCKER-USER hooks. Provide node 24.15.0, pnpm 10.12.1, CLI 2.117.0,
Git, Bash, curl, tar, sha256sum, cmp, timeout, ip, nsenter, sudo, iptables and
ip6tables. Privileged package installation, daemon/firewall configuration and VM
creation remain owner setup work; do not modify Docker Desktop's internal VM.

The rehearsal account needs approved noninteractive access for precisely scoped
task firewall and namespace operations on the same daemon host, unique task
identity/ports and sufficient storage. Verify these capabilities read-only first.
Actual task-only rules, loopback publication, host/runner connectivity, dual-stack
external denial and cleanup must then be proved during a separately authorized
runtime rehearsal, with no unrestricted-network fallback. Host capability
readiness alone never establishes network isolation.

### Commands, preservation and stopping boundary

| Step 1A command/check | Actual result |
| --- | --- |
| Docker context show/list/inspect, info and server version | 0; only Docker Desktop daemon identified |
| WSL distribution, OS, clean-PATH tool/socket inventory | Completed; missing required host tooling is BLOCKED |
| Docker Desktop root capability/proc inventory; nsenter --target 1 --net -- /bin/true | Inventory completed; namespace probe 0; hooks UNVERIFIED |
| Local clone --no-checkout --no-hardlinks --local; destination-only config; checkout --detach exact base | Checkout succeeded; first wrapper exit 1 as explained above |
| Persistent Linux exact HEAD/count/hash/attribute/clean-status recheck | 0, PASS |
| Node v24.15.0 baseline verifier in persistent checkout through WSL share | 0, PASS |
| PostgreSQL/container start, migrations, unit/pgTAP/compatibility tests | NOT RUN |
| Host package install, VM creation, daemon/firewall/route changes | NOT PERFORMED |

The four original dirty documents were rehashed against the Step 1A starting
snapshot and remain byte-for-byte unchanged and unstaged. Both existing indexes
remain empty. Original branch remains at 972685ed13cbc7829539ceb3d6dcfcc36bd38fc4;
test branch remains at cd9d697dd620375c681f2cff42340011d6242201. Only this
untracked report was appended in the existing Windows test worktree; its previous
bytes were preserved. The new Linux clone is independent and clean.

No database, container, network, volume or task firewall rule was created; runtime
cleanup was unnecessary. No hosted Supabase/Test/Production connection or service
operation, GitHub write, commit, push, PR, worker invocation or moderation change
occurred. Stop for CTO review: **BLOCKED_HOST**.


## Step 1B: independent PG17 GitHub Actions rehearsal prepared

Date: 16 October 2026.
Classification: **PREPARED_AWAITING_CI_AUTHORIZATION**.
This is local source preparation and static verification only. Stage 3 remains
incomplete. No PostgreSQL compatibility result or correction is claimed.
The Step 1A findings and all previous report bytes are retained.

### Scope, authorization and exact affected files

Isolated branch: test/stage3-moderation-pg17-compat.
HEAD remains cd9d697dd620375c681f2cff42340011d6242201.
Nine additive source files were prepared, and this existing untracked report
was appended. Nothing was staged or committed:

- .github/workflows/stage3-pg17-compat.yml
- scripts/stage3/run-local-db.sh
- scripts/stage3/assert-local-security.sql
- scripts/stage3/verify-db-results.mjs
- scripts/stage3/parse-compatibility.mjs
- scripts/stage3/verify-source.mjs
- scripts/stage3/verification.test.mjs
- scripts/stage3/toolchain.json
- tests/stage3/moderation_compatibility.test.sql
- docs/extraction/STAGE3_PG17_COMPATIBILITY.md (append only)

The owner explicitly clarified the settings restriction: "Authorize
transaction-only test setting". Consequently the authored SQL temporarily sets
moderation_automation_enabled=true only inside its future disposable test
transaction, ending in ROLLBACK. This exception does not authorize changing any
hosted setting or running the tests now. Empty Vault, no endpoint, disabled cron,
egress isolation and unchanged guards remain mandatory.

### Existing/proposed workflow separation

The accepted .github/workflows/backend-ci.yml, all scripts/ci files, PG15 pins,
historical SQL tests, canonical migrations, manifest, application and package
files were left unchanged. Git's tracked diff is empty in the Stage 3 worktree.

The additive workflow has one pg17-compatibility job on ubuntu-24.04. It uses
pull_request only, targeting chore/backend-extraction-baseline, and permits
only the designated same-repository test/stage3-moderation-pg17-compat head.
There is no pull_request_target, dispatch-only dependency, deployment, repository
secret reference or hosted Supabase credential. Permissions are contents: read;
checkout does not persist credentials. Existing verified full action SHAs are
reused from the accepted pipeline, without changing that pipeline.

Checkout selects the exact PR head with complete local history. Before tests,
verify-source.mjs requires the expected repository, head/base branches, head SHA,
base SHA exactly cd9d697dd620375c681f2cff42340011d6242201, ancestor relationship,
clean checkout and an allowlist of Stage 3-only changed paths. Base drift fails;
it is not automatically re-pinned or bypassed. If the remote target branch does
not have that exact base, stop for CTO reconciliation before a run.

The job first checks canonical bytes, static regressions and shell syntax, then
performs the unchanged frozen/no-lifecycle-script dependency install, typecheck,
network-setup guard, five-file/93-test unit execution and strict result validation.
Those future unit checks have NOT run in this preparation step. The original
workflow retains its own unit and PG15 jobs, conditions, artifacts and branch
behavior; a later PR can cause both workflows to run on separate hosted runners.
The new PG17 workflow does not replace the existing required gate.

### Independent runner, toolchain and isolation

The new runner is an independent derivative of the exact accepted PG15 runner.
It reuses its task ownership, clean environment, same-host namespace checks,
loopback-only bridge publication, both FORWARD -> DOCKER-USER checks, exact
task-interface IPv4/IPv6 forwarding/host-INPUT drops, removal of only task DB
default routes, host/runner SQL connectivity and external IPv4/IPv6 denial
probes before canonical replay and again afterward. There is no unrestricted
network fallback. Unsupported host firewall or namespace behavior fails closed.

Pinned Node is 24.15.0, pnpm 10.12.1 and CLI 2.117.0, retaining the verified CLI
archive SHA-256 and immutable Auth/Storage/Realtime/pg_prove bootstrap image pins.
Docker must be native Linux/amd64 and major >=28; exact hosted Engine/Buildx
versions are not invented. Buildx raw-manifest inspection is a required tool
whose availability and exact-byte behavior must be checked at runtime.

Postgres candidate remains public.ecr.aws/supabase/postgres:17.6.1.167 with
the exact previously observed index and amd64 child recorded above. The new
runner checks raw index SHA-256, one matching amd64 platform descriptor, raw
child SHA-256 and index/child local image ID equality before startup.
PG17 pulls use the directly observed ECR references rather than assuming a
Docker Hub mirror has those digests. Other bootstrap pulls retain the accepted
immutable official Docker Hub provisioning. All required downloads precede
network isolation. Actual server 17.6 and server_version_num=170006 are checked
before canonical replay and independently in security snapshots. No image or
CLI binary was pulled/executed locally during Step 1B.

Before FairSwap migrations, only the task database receives
cron.launch_active_jobs=off through ALTER SYSTEM and reload; bounded polling
must observe off. pgTAP is installed as test infrastructure, outside the
canonical migration ledger. The independent PG17 validator requires cron off,
not the historical PG15 on value; this strengthens the separate rehearsal
boundary without altering accepted PG15 expectations. Empty Vault and HTTP
queues, disabled moderation before/after tests, private buckets, exact RLS,
column grants, service RPC permissions and all 58 ledger versions remain strict.

The two historical trigger-function authorization review items remain:
public.handle_listing_moderation_enqueue() and
app_security.trg_fn_notify_moderation_worker(). No grants were repaired.
schema_email_outbox.test.sql remains excluded. The missing extra Test ledger
migration/staff-review-context parity limitation described earlier remains.

### Authored test matrix and evidence contract

| Coverage | Prepared assertions/behavior |
| --- | --- |
| A Goods | Valid owner submission, one generation, claim identity, real clean finalizer publication, one result/audit, no duplicate result |
| B Revisions | Canonical service-only media revision invalidation helper, supersession, one active generation, distinct identity, old-claim/stale-token rejection |
| C Cars | Canonical saved context and revision-aware submit, clean finalization attempt, actual guard SQLSTATE, unpublished state and lease/result observations |
| D Two-Wheelers | Independent equivalent saved-context/submit/finalizer/guard coverage |
| E Property | Actual Property save/submit with positive monthly INR rent and contract-compatible basis; item price/type/condition NULL; finalizer/guard observations |
| F Outcomes/leases/media | needs_review, invalid_input, checks_incomplete, expired leases below/at max attempts, retry limits, stale reclaimed lease, two bounded media-wait cycles and evidence growth |
| G Security | Ordinary unrelated seller/anon visibility, authenticated finalizer denial, RLS, worker append-only grants, empty Vault and no HTTP queue |

The single new SQL suite has exactly 74 planned assertions and ten synthetic
listing fixtures. It uses authenticated save/submit interfaces, the real
service-role media/claim/finalizer functions and invoker-only temporary helpers.
Queue timestamps/counters are explicitly elevated fixture data for expiry and
retry boundaries. No fixture writes a submission permit, disables triggers,
changes production functions, alters RLS or bypasses experimental-family guards.

Clean family finalization currently attempts forbidden publication in the
canonical baseline. The suite deliberately includes both baseline guard
reproduction assertions and compatibility assertions requiring successful
finalization and no stranded claim. A reproduced conflict therefore remains
a failed compatibility run, even if the reproduction assertions pass. No
correction is implemented or silently accepted. This suite is baseline-specific;
a future correction needs separately reviewed expectations and verification.

The new suite runs via local psql with ON_ERROR_STOP and a strict TAP parser:
exact plan/count/sequence, no failures/skips/TODO/bailout/SQL error, four validated
family observations and successful command exit are required. The unchanged nine
historical suites run explicitly through the pinned local CLI, requiring all
270 assertions. The combined new PG17 contract requires ten suites and 344
assertions. Ordinary suite failures do not hide later suite results, post-test
security/isolation checks or cleanup; final exit remains failure.

Only result.json, suite-results.json and their SHA256SUMS are uploaded.
Failure result.json retains bounded, allowlisted assertion numbers, family
labels, SQLSTATEs, request/listing states, attempt/result counts and revision/
lease booleans when available; unverified suites remain explicitly unverified.
It never copies raw SQL/tool output, fixture UUIDs, messages, credentials or
identifying paths. Raw output stays task-private and is removed by cleanup.
A failure artifact cannot satisfy --verify or turn the job green.

Cleanup retains exact UUID-scoped ownership labels, baseline resource inventory
comparison, task-only container/volume/network removal, four exact firewall-rule
removals, port closure checks and temporary directory removal. Any incomplete
cleanup invalidates success. Abrupt hosted-runner termination cannot be proven
safe by static review; cancellation/timeout cleanup remains runtime UNVERIFIED.

### Local checks actually executed

| Check | Result |
| --- | --- |
| Branch/HEAD/index/status and tracked-diff inspection | 0; exact test base, empty index, no tracked changes |
| node --version | 0; v24.15.0 |
| node --test scripts/stage3/verification.test.mjs | Final exit 0: 37 passed, 0 failed/skipped/cancelled/TODO |
| node --check on all new .mjs files and 17 extracted runner Node heredocs | 0 |
| WSL Ubuntu bash -n scripts/stage3/run-local-db.sh | 0 |
| Existing WSL Python 3 + PyYAML 6.0.3: parse YAML, assert event/job/permissions/checkout/timeouts; bash -n each workflow run block | 0 |
| Source LF/trailing-whitespace/final-newline and identifying-path checks, nine new files | 0 |
| node scripts/ci/verify-baseline.mjs in retained exact-byte Linux checkout over WSL UNC | 0: approved manifest digest and 58 canonical migration hashes |
| Four original dirty-file SHA-256 comparison | PASS, unchanged |
| PG17/PG15 startup, migration replay, SQL suites, application unit tests, hosted CI | NOT RUN |

An initial static run had 34/35 regressions passing; the positive synthetic
security fixture incorrectly copied an older evidence shape without current
vault/setting fields. That fixture was corrected, explicit cron-off behavior
was added and final expanded regressions pass 37/37. No security assertion,
SQL expectation or count was relaxed to hide the failure. Windows default
Python/YAML were unavailable; existing WSL Python/PyYAML were used, with no
installation. File-comparison git diff --no-index returned 1 as expected for
the deliberately different PG15/PG17 implementations; it was source review,
not an integrity failure. Existing Windows CRLF canonical files were not
rewritten: the already verified Linux checkout supplied baseline validation.

Public documentation/source reads only:
[Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-db-start)
and [pg_cron configuration source](https://github.com/citusdata/pg_cron/blob/main/src/pg_cron.c).
The changelog Markdown endpoint was attempted but the reader rejected its
content type. Unpinned current docs do not replace the previously pinned CLI
source observations or actual runtime --help/version checks.

### Unexecuted validations and CTO review risks

- GitHub PR event discovery, checkout, action execution, Corepack/install/Linux
  optional binaries, the 93 unit tests, artifact upload and cancellation behavior
  are UNVERIFIED for this new workflow.
- Hosted Ubuntu firewall hooks, Buildx raw-manifest output/digest checks,
  registry availability, CLI bootstrap, actual PG17 image/server/extension
  versions, role behavior and all 344 SQL assertions are UNVERIFIED.
- PG15 extension-version expectations remain strict in the independent PG17
  validator; a different PG17 extension version fails for review, rather than
  being guessed or waived. The exact PG17 bootstrap has not been proven.
- SQL fixtures received static source review/count checks, not PostgreSQL
  parsing/execution. Any fixture/setup failure must be distinguished from the
  known baseline compatibility conflict using sanitized observations.
- Cars/Two-Wheelers/Property finalization is expected by source inspection to
  fail compatibility assertions. This expectation is not a reproduced defect.
- Existing missing Test migration and trigger-authorization exceptions limit
  parity/cutover claims. No hosted service state is inferred from local source.

### Proposed later GitHub execution sequence (not executed or authorized now)

1. CTO reviews these exact files, transaction-only setting exception, strict
   extension expectations and the baseline-specific failing assertions.
2. Obtain separate explicit authorization for a scoped commit, push of
   test/stage3-moderation-pg17-compat, and same-repository PR into
   chore/backend-extraction-baseline. Preserve the four original documents.
3. Before creating/updating that PR, verify target base is exactly
   cd9d697dd620375c681f2cff42340011d6242201 and the reviewed source head is its
   descendant. If it drifted, stop for approval; do not weaken the guard.
   PR creation/update is itself the proposed Actions trigger, so its
   authorization must include the first hosted CI run.
4. On that separately authorized PR event, leave existing Backend CI unchanged
   and inspect the separate Stage 3 job: provenance/static gates, strict 93-unit
   gate, downloads/pins, host firewall/loopback proof, PG17 bootstrap/version,
   dual-stack isolation, 58 canonical migrations, security snapshots, explicit
   74+270 assertions, final security/isolation/manifest checks and cleanup.
5. Download only sanitized artifacts, verify checksums and classify setup,
   baseline reproduction, compatibility and cleanup separately. A red baseline
   run is not Stage 3 acceptance. Any retry or correction needs CTO direction;
   do not push fixes, update Issue #2, merge or deploy automatically.

### Preservation and mandatory stop

Original branch remains chore/backend-extraction-baseline at
972685ed13cbc7829539ceb3d6dcfcc36bd38fc4. Its only modifications remain AGENTS.md,
README.md, docs/extraction/POINT1_BASELINE.md and
docs/operations/DEPLOYMENT_OWNERSHIP.md; all four hashes remain unchanged and
the index is empty. The test branch remains at the pinned base with only the
ten untracked paths listed above; its index and tracked diff are empty.
The existing report prefix was checked byte-for-byte before/after this append.

No Docker/container/PostgreSQL startup, migration, database/unit compatibility
execution, firewall change, privileged installation, hosted Supabase connection
or operation, worker/Edge invocation, GitHub write/settings change, commit,
push, PR or deployment occurred in Step 1B. Only permitted source/static checks
ran. No runtime resources needed cleanup; regression temporary directories were
removed by their test cleanup. Stop for CTO review and later CI authorization.


## Step 1E: image-provisioning diagnosis and local diagnostic preparation

Date: 16 October 2026.
Classification: **DIAGNOSTICS_PREPARED_AWAITING_CI_AUTHORIZATION**.
Local source/static work only. No publication or new CI execution occurred.
All previous report bytes, including the earlier blocked/prepared findings,
are retained as historical evidence rather than rewritten.

### Fixed revisions and observed run evidence

Draft PR #3 remains open/draft with head
573b63deffb0dc0cb7caf3738d9a53af5dbf355b and base
cd9d697dd620375c681f2cff42340011d6242201. The local Stage 3 branch remains at
that head. Read-only API inspection confirmed original PG17 run 38946859438
completed FAILURE, attempt 1, and Backend CI run 38946859389 completed SUCCESS,
attempt 1. No run was retried or restarted.

The precise retained PG17 marker remains:
FAIL: database CI stage=images; raw output withheld

No finer failure category was emitted. The job's private buildx-version,
manifest, pull/inspect and runner logs were removed by successful task cleanup;
they are not recoverable from the uploaded three-file sanitized artifact.
The previously collected artifact has compatibility.executed=false, no suite
results, all ten suites NOT_VERIFIED and every cleanup flag true. No actual
PG17 server version or SQLSTATE was observed; zero of 344 SQL assertions were
executed/verified. The moderation conflict remains UNREPRODUCED.

The existing public job log was read in memory only. A fixed-marker summary
was saved outside the repository; raw logs and arbitrary matched text were not
retained. Inspection does not identify which private command actually failed.
The historical root cause must therefore remain unresolved rather than guessed.

### Task A: every operation in the original coarse images window

The exact reviewed source at the failed head performs the following before
assigning its first role-specific image-$key-validate stage. Constant variable
assignments only select the existing immutable pins; they do not contact Docker.

| Original operation | Newly prepared fixed stage | Default safe failure category |
| --- | --- | --- |
| docker buildx version | image-postgres-buildx-check | required-tool-check-failed |
| Fetch pinned index using buildx imagetools inspect --raw | image-postgres-index-fetch | manifest-retrieval-failed |
| sha256sum -c of exact raw index file | image-postgres-index-digest | digest-check-failed |
| Node JSON parse and exact single linux/amd64 child-descriptor comparison | image-postgres-amd64-descriptor | descriptor-check-failed |
| Fetch pinned child manifest using buildx | image-postgres-child-fetch | manifest-retrieval-failed |
| sha256sum -c of exact raw child file | image-postgres-child-digest | digest-check-failed |
| Pull pinned child for linux/amd64 | image-postgres-child-pull | image-pull-failed |
| Inspect child's local image ID | image-postgres-child-id-inspect | image-inspect-failed |

The original loop's Node pin-list producer also executes before its first
iteration marker. Its process-substitution exit status was not directly checked.
Role validation precedes that marker too. If no iteration runs, later tools
evidence/reference selection can retain the coarse images label as well.
These control-flow qualifications prevent claiming that the eight main commands
are the only logically possible causes from stage=images alone.

### Confirmed source defects versus hypotheses

Confirmed observability/failure-handling defects:
- Multiple separately failing operations shared one coarse stage.
- The original collector discarded both stage and category from result.json.
- Prefix wildcards in console stage/category validation allowed arbitrary suffixes
  instead of an exact finite vocabulary.
- The pin-list producer ran inside process substitution: its own failure could
  be hidden by an empty successful loop. The new local source checks this producer
  as an ordinary command before consuming its task-private TSV output.
- The previous cleanup invalidation path replaced evidence from a nonexistent
  raw directory, losing an earlier image stage. The prepared invalidation now
  retains only a validated stage/category and explicitly reports cleanup FAILED.

None of those proves an incorrect image digest, incompatible image, missing
Buildx binary, failed registry request or bad platform descriptor in run
38946859438.

Independent hypothesis review:
- Buildx availability: the exact runner-image inventory referenced by the setup
  log advertises Buildx 0.38.0 and Docker 28.0.4. Its installation source places
  Docker plugins under a system CLI-plugin directory. That weighs against simply
  assuming the clean task HOME/DOCKER_CONFIG hides a user-only plugin, but actual
  Buildx command output was private and remains unobserved.
- Registry retrieval: anonymous transport, registry access or command failure
  remains possible; no HTTP status/error category was retained for index/child.
- Raw digest comparison: a mismatch, missing/unreadable file or checksum-command
  failure remains possible. Buildx v0.38.0 source writes raw manifest bytes
  without adding a newline; automatic newline insertion is not a demonstrated
  explanation. No trimming, reserialization, digest replacement or waiver was added.
- Descriptor validation: malformed JSON, missing/duplicate amd64 descriptor or
  child mismatch would fail the strict check; none was observed in this run.
- Child retrieval/hash and initial pull/inspect: each can fail independently.
  Their original private output is absent, so none is identified as the cause.

Primary source references used for this limited source review:
[Exact runner inventory](https://github.com/actions/runner-images/blob/ubuntu24/20261012.334/images/ubuntu/Ubuntu2404-Readme.md),
[runner Docker installation](https://github.com/actions/runner-images/blob/ubuntu24/20261012.334/images/ubuntu/scripts/build/install-docker.sh),
[Buildx v0.38.0 raw printer](https://github.com/docker/buildx/blob/v0.38.0/util/imagetools/printers.go).
These are source/image-inventory evidence, not a replacement for the missing
runtime command output or proof of a successful image-provisioning check.

### Task B: prepared local changes and sanitized contract

Exactly four authorized paths are changed locally:
- scripts/stage3/run-local-db.sh
- scripts/stage3/verify-db-results.mjs
- scripts/stage3/verification.test.mjs
- docs/extraction/STAGE3_PG17_COMPATIBILITY.md (this append only)

No workflow, pin file, registry selection, CLI/PostgreSQL version, digest,
network rule, migration, SQL test or moderation implementation was edited.
The new SQL suite remains exactly 74 authored assertions; the combined contract
remains 344 assertions, with the historical email-outbox diagnostic excluded.

The runner assigns separate stages to the eight initial operations, pin-list
production, role validation, tools-evidence writing and reference selection.
The five approved image roles each have explicit markers for pin/reference
validation, pull, ID/platform inspection and validation, repository-digest
inspection and validation, cached-tag inspection/validation or creation, final
tag inspection/validation and evidence writing. PostgreSQL's child/index ID
comparison has its own marker. There are 89 finite image-stage values in total.
Diagnostics use named operation markers; they do not assert which dependency
condition caused an operation to fail.

Registry/pull stderr remains task-private. Only fixed matching categories
manifest-not-found, registry-denied, rate-limited, transport-error, storage-error
or unsupported-manifest may replace an operation's default category. No matched
message, URL, image metadata, environment value or exception text is exported.

Bash and JavaScript share matching finite catalogs, verified by regression.
The collector requires exactly the stage/category keys with string values in
the approved sets (65 categories including retained non-image categories).
Unknown stages, malformed JSON, extra fields or arbitrary values become only:
{"stage":"unclassified","category":"unclassified"}

A hypothetical failed digest check would produce this safe diagnostic, not an
observed result from the first run:
{"diagnostic":{"stage":"image-postgres-index-digest","category":"digest-check-failed"},"success":false}

The EXIT handler writes that tiny diagnostic.json in private raw storage before
collection. It is projected into the existing result.json; no new uploaded
artifact path is introduced. The same allowlisted three files/checksums remain.
Raw registry/Docker outputs and temporary state retain automatic task cleanup.

Success now additionally requires exactly:
{"stage":"complete","category":"none"}
All original success gates remain strict: exit 0, pins/versions, 58 migration
bytes and ledger entries, isolation before/after, exact security checks,
74+270 SQL assertions and complete cleanup. A recognized image stage cannot
produce green evidence even if every other synthetic success field is present.
Unknown/missing diagnostics also cannot produce success.

Late cleanup failure uses a dedicated nonzero invalidation mode, retaining only
the safe original image diagnostic where applicable, clearing suite success and
setting cleanup="FAILED". If the raw failure was successful execution followed
by cleanup failure, the diagnostic is cleanup/cleanup-failed. Artifact validation
failures do not inherit a misleading complete success marker.

### Task C: actual local checks

- node --test scripts/stage3/verification.test.mjs: final exit 0,
  **174 passed, zero failed/skipped/cancelled/TODO**.
  Includes all 89 recognized image stages through the collector and rejection
  against otherwise complete synthetic success evidence; malformed/unknown
  fields, arbitrary raw/env text, missing cleanup, fatal late cleanup and
  nonzero CLI failure paths; plus all original regressions.
- node --check on both edited .mjs files and 17 extracted runner Node heredocs:
  exit 0.
- Existing WSL bash -n on the edited runner: exit 0; the runner was NOT executed.
- Existing baseline verifier against the retained exact-byte Linux checkout:
  exit 0; approved manifest digest
  eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd
  and all 58 canonical migration hashes PASS.
- Current-head raw Git manifest/migration blobs, protected-source byte snapshots,
  report-prefix preservation, exact changed-path set and Git diff integrity
  were checked. Original branch/four document hashes and empty indexes preserved.

All new test data are synthetic validator inputs, not fake runtime evidence.
No application unit suite or database test was executed locally in Step 1E.

### Remaining risks and required next authorization

The failed operation from the first attempt remains unknowable from retained
evidence; these local diagnostics make a later explicitly authorized run
observable. They have not executed on GitHub, and do not constitute a provisioning
fix. Tool/registry failures, digest/descriptor mismatch and bootstrap readiness
remain runtime questions. No immutable pin was guessed, weakened or replaced.

The Step 1B source-review inventory is historical and remains untouched; the
four local diagnostic changes naturally differ from the previously reviewed
source. A later review/publication needs a separately approved scope and must
not silently substitute a new inventory for that historical artifact.

CTO must review this local diff before authorizing a commit/push or another CI
run. A push to PR #3's branch would itself retrigger Actions and is NOT authorized
by Step 1E. No automatic correction, rerun or retry follows this report.

### Preservation and stop

Both original worktrees/branches remain in place. Original branch remains
chore/backend-extraction-baseline at 972685ed13cbc7829539ceb3d6dcfcc36bd38fc4;
AGENTS.md, README.md, POINT1_BASELINE.md and DEPLOYMENT_OWNERSHIP.md retain their
recorded exact hashes and remain unstaged. The Stage 3 branch HEAD remains
573b63deffb0dc0cb7caf3738d9a53af5dbf355b, with only the four allowed local changes;
both indexes are empty. Prior report bytes are preserved.

Step 1E performed zero GitHub writes, PR/Issue updates, pushes, commits, CI reruns,
manual dispatches, Docker/PostgreSQL starts, privileged installs, hosted Supabase
connections/operations or configuration changes. No task runtime resources were
created. Static regression temporary directories were removed by test cleanup.
**STOP for CTO review: DIAGNOSTICS_PREPARED_AWAITING_CI_AUTHORIZATION.**

## Step 1G — Bounded registry rate-limit recovery (source only)

Classification: **RATE_LIMIT_RETRY_PREPARED_AWAITING_CI_AUTHORIZATION**.

### Evidence and scope

The accepted Step 1F observation is run 38952406057 failing at
`image-postgres-index-fetch` with category `rate-limited`. This preparation did
not execute another workflow, contact a registry, or observe a PG17 server.
The previous 0/344 executed SQL assertions remain historical evidence; no new
SQL execution or compatibility acceptance is claimed.

Local preparation starts from Stage 3 HEAD
84c1304f635afb6fef67bb00df8b115f5a9245cd, base
cd9d697dd620375c681f2cff42340011d6242201. Read-only `git ls-remote` reconfirmed
both exact remote refs. Only run-local-db.sh, verification.test.mjs and this
append-only report change. verify-db-results.mjs remains byte-for-byte unchanged.

### Bounded recovery and failure behavior

The wrapper admits only immutable digest-qualified Buildx raw-manifest fetches
and linux/amd64 Docker pulls for the existing Supabase image references.
Each operation has at most three total attempts, including its original attempt.
Only clearly classified registry throttling can advance to another attempt.
Jittered waits are 10–20 seconds before attempt two and 30–50 seconds before
attempt three: at most 70 seconds of retry waits per operation.
Separate task-controlled registry operations have a five-second pacing delay.
There are eight operations (two manifest fetches, the child pull and five pinned
role pulls), so the maximum total programmed waits are 8*70 + 7*5 = 595 seconds
(9m55s), with at most 24 task-controlled command attempts. Command/network time
is additional; the existing enclosing 20-minute execution timeout is unchanged.

CLI diagnostic text does not expose trustworthy HTTP response headers.
Retry-After text is therefore not trusted or parsed; the bounded schedule applies.
No extra registry probes, fallback registry, mutable-tag pull, credentials,
authentication, new cache or external service is introduced.

Fatal digest/content, malformed-manifest, unsupported-platform, authorization,
not-found and storage diagnostics take precedence over throttle wording.
Ambiguous rate-limit mentions and unrelated embedded 429 digits do not qualify.
Transport errors are not retried. Invalid command/reference shapes fail before
any command or wait. Successful fetch bytes are copied exactly and then undergo
the original index SHA-256, Linux/amd64 descriptor, child SHA-256, image ID,
platform and repository-digest checks. Digest or security verification does not
enter retry handling. Exhaustion returns nonzero with the existing fixed
stage/category; it cannot produce successful evidence.

Every attempt writes separate stdout/stderr files inside existing task-private
storage. Raw diagnostics never enter sanitized artifacts; the existing evidence
allowlist, strict success contract and automatic cleanup remain unchanged.
Unknown fields/stages cannot escape sanitization. Cleanup failure remains fatal.
A regression pins the exact existing runner tail from network-setup onward;
firewall, connectivity, egress-denial, bootstrap, migrations, security and SQL
execution code remain byte-for-byte unchanged. All other tracked source bytes
were compared against the pre-edit snapshot, including image/toolchain pins,
the 74-assertion SQL suite, PG15 implementation and canonical migrations.

### Actual local verification

- Node 24.15.0: `node --test scripts/stage3/verification.test.mjs`:
  **197 passed, zero failed/skipped/cancelled** (174 existing plus 23 new tests).
  An initial attempt had 196 passes and one WSL startup/VM crash; the unchanged
  suite then passed. No retry was added to the test harness.
- Mocked Bash commands exercise throttle-then-success, exhaustion at three,
  immediate fatal/non-throttle responses, mixed fatal/throttle text, immutable
  argv and exact output bytes, digest mismatch without refetch, invalid pins,
  bounded jitter, ignored untrusted Retry-After text and inter-operation pacing.
  Docker and sleep are shell stubs; no live Docker/registry operation or real
  retry wait occurred. Mock temporary directories are removed by an EXIT trap.
- Broader unchanged CI suites were also attempted with
  `node --test scripts/ci/verification.test.mjs scripts/ci/db-verification.test.mjs scripts/stage3/verification.test.mjs`:
  **266 reported tests, 264 passed, two failed, zero skipped/cancelled**.
  The unit-validator module cannot load missing TypeScript in this isolated
  worktree. The PG15 successful-collector fixture fails because its unchanged
  collector invokes verifyBaseline against Windows checkout bytes; this
  checkout's manifest differs from canonical raw bytes due to CRLF conversion.
  No package installation, file normalization, PG15 edit or relaxed check was
  used to conceal these local limitations. The whole combined suite is NOT PASS.
- `node --check`: all four Stage 3 JavaScript modules PASS; syntax checks for
  all 17 embedded runner Node programs PASS.
- WSL Ubuntu `bash -n scripts/stage3/run-local-db.sh`: PASS.
- Existing `node scripts/ci/verify-baseline.mjs` against the retained exact-byte
  Linux clone: PASS, approved raw manifest digest
  eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd
  and all 58 canonical migration hashes. Independently recomputed the current
  Stage 3 HEAD manifest and all 58 migration Git blobs: PASS.
- Tracked-file byte inventory comparison and Git diff integrity/scope checks:
  only the three allowed paths; no staged changes. Prior report bytes retained.

### Limits and stop

Shared-runner throttling may persist through all three attempts. Docker/Buildx
can make internal HTTP requests outside task-level pacing. Ambiguous throttling
text deliberately fails without retry. Live registry recovery, Linux container
isolation and PG17 compatibility remain UNVERIFIED by Step 1G.
The two unchanged CI-suite local limitations above remain visible.

The original baseline branch remains at
972685ed13cbc7829539ceb3d6dcfcc36bd38fc4. All four original dirty developer
documents retain their recorded exact hashes and remain unstaged; both worktrees
and empty indexes are preserved. Source preparation performed zero commits,
pushes, GitHub writes, PR/Issue updates, CI runs/reruns, Docker/PostgreSQL starts,
hosted Supabase connections/operations, or hosted configuration changes.
No runtime task resources were created. STOP for CTO review; publication and
another CI execution require separate authorization.

## Step 1I — Granular PG17 startup diagnostics (local source only)

Classification: **DB_START_DIAGNOSTICS_PREPARED_AWAITING_CI_AUTHORIZATION**.

### Confirmed evidence versus unproven causes

Required local/published head is 3db64916bc9c00a3f6e2e171e48f02849d5d20e8;
base remains cd9d697dd620375c681f2cff42340011d6242201. Read-only remote and
PR #3 checks confirm those SHAs and the open draft state. No publication occurs.

Re-inspected failed PG17 run 38957391265 (attempt one, failure), successful
Backend run 38957391308 (attempt one, success), the exact published runner and
previously checksum-verified sanitized artifacts. PG17's observed diagnostic is
only db-start / none; exit code one was observed, not timeout code 124.
Provenance, static contracts and the strict five-file/93-unit foundation passed.
The result contains no observed PG17 server version, SQLSTATE or executed suite.
All ten SQL suites remain NOT_VERIFIED, with 0/344 assertions executed; all six
cleanup flags are true. The sanitized suite-results array is empty.

Confirmed source defect: the db-start marker spans multiple distinct operations,
making the actual failing command unobservable in the available evidence.
It is NOT proven that supabase db start failed. A version query/mismatch,
Cron alter/reload/confirmation failure, or pgTAP extension failure remains an
unproven alternative. No operational/configuration defect or corrective SQL
change is conclusively established, so no such correction is implemented.

### Source-first comparison and prerequisites

Canonical PG15 at the required base uses the same cli_local wrapper:
the task-private project is its cwd and explicit --workdir, with the task network
passed as --network-id. Both use pinned CLI 2.117.0 and a unique task identity;
the expected container is supabase_db_<task-project-id>. Task-only config.toml
selects major_version=17 in the separate PG17 runner; PG15 retains 15.
The private task config keeps API, Studio, analytics, Edge runtime and local SMTP
disabled, retains required bootstrap services and an empty Vault section.

PG17's pinned image remains public.ecr.aws/supabase/postgres:17.6.1.167,
index sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb,
amd64 child sha256:16c0944c77885446d4f2ebbb2191b357feeb3b1295bde2fb1978c113129dbeb4.
All existing image hashes/platform/ID/repository-digest checks precede startup.
Unlike PG15, PG17 adds actual 170006/17.6 checks, Cron disable/reload/confirmation,
and CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions before the
unchanged route-isolation phase. The extension package/schema and required SQL
privileges must already be available; no evidence proves which prerequisite failed.

Version-specific public CLI v2.117.0 source was inspected without running the CLI:
- [startup](https://github.com/supabase/cli/blob/v2.117.0/apps/cli-go/internal/db/start/start.go),
  blob dc8327c816d5bf9ff773d9901954cdd9f16137b8: loads task config, starts the
  container and checks readiness; failures can occur before returning to our runner.
- [configuration](https://github.com/supabase/cli/blob/v2.117.0/apps/cli-go/pkg/config/config.go),
  blob 04eae992898169f3444f934da8ff451480ae90eb: explicitly accepts major 17.
- [container identity](https://github.com/supabase/cli/blob/v2.117.0/apps/cli-go/internal/utils/config.go),
  blob d171d06753b6ce6dd0f67e96e62d83892964c05b: derives IDs from the project ID.
These are source prerequisites, not proof of successful startup in this run.
[PostgreSQL 17 ALTER SYSTEM documentation](https://www.postgresql.org/docs/17/sql-altersystem.html)
describes reload/restart-dependent application of settings. The existing explicit
reload and mandatory observed Cron-off confirmation are therefore retained.

### Diagnostic-only local patch and fixed mapping

Only run-local-db.sh, verify-db-results.mjs, verification.test.mjs and this
append-only report change. The old broad db-start value remains accepted solely
for historical sanitized evidence. New stage/category values are finite literals:

| Stage | Failure category |
| --- | --- |
| db-start-cli | db-start-command-failed |
| db-start-version-num-query | db-start-command-failed |
| db-start-version-num-verify | db-start-version-mismatch |
| db-start-version-text-query | db-start-command-failed |
| db-start-version-text-verify | db-start-version-mismatch |
| db-start-cron-alter | db-start-command-failed |
| db-start-cron-reload | db-start-command-failed |
| db-start-cron-confirm | db-start-command-failed or db-start-cron-not-disabled |
| db-start-pgtap-extension | db-start-command-failed |

Version query execution and exact-value validation now have distinct markers.
Both query stdout and stderr are redirected to the verified private task directory;
no SQL result becomes artifact content. The mandatory version comparisons remain
170006 and 17.6. A nonzero query cannot be accepted because it printed a matching
value, as required by the execution-versus-validation diagnostic split.

Cron confirmation retains the existing five attempts, one-second waits and required
off value. Failed queries cannot authorize continuation; exhaustion records command
failure if the last query failed, or cron-not-disabled if its returned setting
was unacceptable. Alter, reload and pgTAP failures remain fatal. No SQL statement,
security-critical execution order, pin or network access was added or substituted.
The category resets to none only after the entire startup block passes.

Illustrative sanitized failure only (not new runtime evidence):
{"stage":"db-start-version-num-verify","category":"db-start-version-mismatch"}
Unknown/malformed diagnostics remain unclassified. Raw stdout/stderr, SQL values,
connection strings, environment data and arbitrary errors are not exported.
The evidence three-file allowlist and strict complete-success checks remain intact.

### Actual verification and preservation

- node --test scripts/stage3/verification.test.mjs: **218 passed, zero failed,
  skipped or cancelled** (197 existing plus 21 new startup tests).
- Mocked CLI/Docker/sleep exercise all nine phases, both version mismatches,
  command errors with valid-looking stdout, five-attempt Cron exhaustion,
  pgTAP failure, no console leakage, unknown/malformed diagnostics, strict
  failure evidence, fatal cleanup and successful continuation into security checks.
  No live Docker, PostgreSQL, registry request or real retry wait was used.
- node --check: all four Stage 3 JavaScript modules PASS. Syntax checks for all
  17 embedded Node programs PASS. WSL Ubuntu bash -n on the runner PASS.
- Existing verify-baseline.mjs against the retained exact-byte Linux clone PASS:
  raw approved manifest SHA-256
  eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd
  and all 58 migration byte hashes. Independent current HEAD Git-blob verification
  of the same manifest and 58 migrations PASS. Windows checkout CRLF bytes were
  not normalized or substituted.
- Pre-edit raw inventory covers all 136 tracked paths. Every path outside the four
  allowed files is unchanged, including toolchain/image pins, workflow, all SQL,
  PG15 files and the manifest. Retry helper bytes and cleanup function bytes are
  unchanged. Separate hash guards preserve the pre-startup network checks and
  the complete post-startup route-isolation/security/migration/SQL tail.
- Git diff integrity/scope checks PASS; index remains empty. Previous report bytes
  are retained exactly, and the original four dirty developer documents remain
  unchanged and unstaged on their original branch/worktree.

### Remaining decision and stop

The next authorized rehearsal can identify the failing startup subphase; this
source-only work cannot recover the deleted task-private start.log or prove a
runtime cause. No further diagnostic fields, raw logs or operational correction
are proposed as evidence substitutes. If a concrete source/runtime defect is
established later, propose its correction separately for CTO approval.

Zero commits, pushes, GitHub writes, PR/Issue updates, Actions runs/reruns,
Docker/PostgreSQL starts, hosted Supabase connections/operations, merges or
deployments occurred in Step 1I. Both worktrees are preserved. Static-test
temporary directories are removed by their traps/finally cleanup; no runtime
database/network resources were created. STOP for CTO review.
