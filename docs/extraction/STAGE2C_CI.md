# Stage 2C: independent backend CI implementation; database execution UNVERIFIED

P1 and P1.1 are accepted and locally committed as
`7c040512bc4687868a51e76bde328ccf2640e150` on
`chore/backend-extraction-baseline`. P2 adds the database job and final gate as
uncommitted work for review. Database/Linux runtime execution is **UNVERIFIED**.
This implementation is not accepted full backend CI, production readiness or a
deployment handoff. No push, hosted workflow or hosted Supabase execution has
occurred. The historical P1 implementation baseline was
`495d6188b678587ab283e51a4aae1951e60c0197`.

## Implemented foundation

The accepted `unit-integrity` job remains unchanged, on Ubuntu 24.04,
with a 15-minute job timeout and explicit step timeouts. Event wiring remains
pull requests, pushes to main/the extraction branch and manual dispatch. This
local preparation does not activate those events or authorize a push.

Execution order:

1. Checkout with read-only contents permission and `persist-credentials: false`.
2. Set up Node 24.15.0; require pnpm 10.12.1 through Corepack and compare runtime
   and package pins against `scripts/ci/toolchain.json`.
3. Install with `corepack pnpm install --frozen-lockfile --ignore-scripts
   --engine-strict`. No lifecycle-script exceptions or lockfile updates.
4. Run `node scripts/ci/verify-baseline.mjs`: require raw manifest SHA-256
   `eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd`, then call
   the existing read-only migration verifier for exact 58-file membership and
   canonical file hashes. This does not execute migrations or SQL.
5. Run `corepack pnpm typecheck` with the existing TypeScript configuration.
6. Run `node --test scripts/ci/verification.test.mjs` for the new validators'
   acceptance/rejection and artifact privacy cases. Temporary migration copies
   are byte-check fixtures only; no database or SQL execution occurs.
7. First run `node scripts/ci/verify-unit-results.mjs --check-isolation` in the
   unit step; shell failure propagation prevents unit execution if it fails.
   Then run `corepack pnpm test:unit --reporter=default --reporter=json
   --outputFile=<runner-temp>/backend-unit-results.json` with an explicit
   PATH/HOME/CI/TMPDIR environment whitelist. Existing Vitest configuration keeps
   Node mode, `envDir: false`, exact discovery, zero-test rejection and the
   network-blocking setup. Test setup and test expectations are unchanged.
8. Validate the report and emit a sanitized summary. Require exactly the five
   configured filenames and 93 passing tests with these counts:

| Approved file | Passing tests |
| --- | ---: |
| src/__tests__/moderation-text-checker.test.ts | 39 |
| src/__tests__/moderation-target-guard.test.ts | 7 |
| src/__tests__/moderation-worker.test.ts | 10 |
| src/__tests__/moderation-worker-vault-auth.test.ts | 3 |
| tests/unit/email-outbox-worker.test.ts | 34 |

The validator inspects the literal `vitest.config.ts` include list and isolation
settings through the pinned TypeScript parser without executing the configuration.
It also pins the existing network setup's raw bytes. Report names must
be exact repository-relative paths or exact absolute paths within this checkout;
suffix-only matches are rejected. File/assertion statuses, totals and duplicate
identities are checked. Missing/malformed reports, failures, skips, pending/todo
tests, unexpected files or per-file count changes fail the job. Vitest 3's summary
suite counts include nested describe groups (26 in historical reports); the file
inventory is the five `testResults` records, not that nested suite count.

Neither unit execution nor report verification uses `continue-on-error`. Result
verification still runs after a failed test command and preserves the original
job failure. Only a sanitized summary is uploaded, including a generic failure
summary when validation fails. It contains fixed approved paths/counts/status,
never raw test names, messages, absolute paths or environment values. Raw JSON
remains temporary and is not uploaded. Missing expected artifacts fail upload;
retention is 14 days. No deployment secrets, environment, database services,
Supabase CLI, Docker steps or GitHub repository-setting changes are introduced.

## Toolchain evidence and limitations

`scripts/ci/toolchain.json` records Node 24.15.0, pnpm 10.12.1 and the existing
package versions: Supabase JS 2.116.0, Zod 3.24.2, TypeScript 5.9.3, Vitest 3.2.7
and Node declarations 20.19.43. Existing package/lock/configuration files remain
unchanged. Exact local runtime probes matched the proposed targets on 16 October
2026. The Stage 2A report supplies historical installation and unit evidence.

Action pins were verified on 16 October 2026 by credential-free, read-only
`git ls-remote --tags` queries of the named public repositories:

| Action | Tag | Verified commit |
| --- | --- | --- |
| actions/checkout | v4.2.2 | 11bd71901bbe5b1630ceea73d27597364c9af683 |
| actions/setup-node | v4.4.0 | 49933ea5288caeca8642d1e84afbd3f7d6820020 |
| actions/upload-artifact | v4.6.2 | ea165f8d65b6e75b540449e92b4886f43607fa02 |

These are verified tag-to-commit identities, not a claim that P1 ran those actions.
Linux optional binaries, Corepack/bootstrap availability, frozen installation on
Ubuntu 24.04, workflow execution and upload remain unverified until a separately
authorized hosted run. No Node/pnpm distribution digest is invented. There is no
fallback to a different runtime, dependency version or weaker installation flags.

## Local P1 verification (16 October 2026)

The following ran locally on Windows with Node 24.15.0 and pnpm 10.12.1:

| Command | Actual result |
| --- | --- |
| `corepack pnpm install --frozen-lockfile --ignore-scripts --engine-strict` | PASS; lockfile current, existing dependency tree already up to date; this was not a clean Linux installation |
| `node scripts/ci/verify-baseline.mjs` | PASS; approved manifest raw digest and all 58 canonical migration hashes |
| `corepack pnpm typecheck` | PASS |
| `node --test scripts/ci/verification.test.mjs` | PASS; 35 validator tests, zero failures/skips |
| `corepack pnpm test:unit --reporter=default --reporter=json --outputFile=artifacts/stage2c-p1-unit-results.json` | PASS; five files, 93 tests, zero failed/skipped/pending/todo |
| `node scripts/ci/verify-unit-results.mjs artifacts/stage2c-p1-unit-results.json --summary artifacts/stage2c-p1-sanitized/unit-summary.json` | PASS; exact filename/count mapping, sanitized summary generated |

Generated reports remain under ignored `artifacts/`; they are not source changes.
The installation emitted the existing Node DEP0169 `url.parse()` deprecation
warning. No flags were removed and no scripts enabled. Local checks do not prove
GitHub Actions YAML/runtime acceptance or the Linux environment-whitelist path;
those remain unexecuted. The workflow was inspected locally only.

## P1.1 isolation hardening (16 October 2026)

The pre-unit guard now requires exactly
`setupFiles: ["./tests/setup/no-network.ts"]`, `environment: "node"`,
`envDir: false`, `globals: false` and `passWithNoTests: false` as literal settings.
Missing, duplicate, computed or dynamic settings are rejected. Unreviewed root
or test options, including plugins, projects and per-file environment overrides,
are rejected because they could bypass the approved settings. Any encountered
`passWithNoTests` property with a non-literal-false value is rejected as well.

The existing `tests/setup/no-network.ts` was inspected without editing it. Its
raw SHA-256 is pinned in the validator and recorded in `toolchain.json`:
`c4a49badd88b567fa99b198f263f37308a16796bd026020522d29b0e2e95ce5f`.
The raw Git blob also matches `HEAD:tests/setup/no-network.ts`. Guard verification
checks both pin consistency and setup bytes, so altering the setup or changing
only the toolchain pin fails. Missing setup also fails. No newline normalization
is applied when hashing. Neither the config nor the setup file is modified.

The guard executes immediately before Vitest in the same fail-fast workflow
shell step and is repeated during post-run result verification. It runs without
importing the test configuration. The five-file/93-test contract, migration gate,
sanitized artifact schema, permissions, action pins and installation flags remain
unchanged. The workflow still contains only `unit-integrity`.

P1.1 local verification used Node 24.15.0 and pnpm 10.12.1:

| Command | Actual result |
| --- | --- |
| `node scripts/ci/verify-unit-results.mjs --check-isolation` | PASS before unit execution; settings and raw setup hash verified |
| `node --test scripts/ci/verification.test.mjs` | PASS; 58 tests, zero failures/skips; includes removed/changed setup, configuration overrides, pin drift and guard ordering |
| `node scripts/ci/verify-baseline.mjs` | PASS; approved manifest digest and 58 canonical migration hashes |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm test:unit --reporter=default --reporter=json --outputFile=artifacts/stage2c-p11-unit-results.json` | PASS on filesystem-access rerun; five files, 93 passed, zero failed/skipped/pending/todo |
| `node scripts/ci/verify-unit-results.mjs artifacts/stage2c-p11-unit-results.json --summary artifacts/stage2c-p11-sanitized/unit-summary.json` | PASS; exact filenames/counts and sanitized summary |

The initial restricted-sandbox Vitest attempt failed before discovery because
esbuild could not read parent directories. The same command and pre-unit guard
then passed with approved filesystem access; no config, setup, flags or counts
were relaxed. Reports are ignored local artifacts. No packages were installed
for P1.1, and no hosted workflow was run.

Linux installation, Corepack bootstrap, workflow runtime acceptance, environment
whitelisting and artifact upload remain unverified. The guard protects the
reviewed literal configuration/setup contract; the existing network harness is
an in-process fetch/socket guard, not an operating-system network sandbox.
Runtime CLI arguments and future edits to the guard/workflow still require review.
Database/Linux egress isolation remains outside this partial implementation.

## P2 database job and final gate

`database-pg15` depends on `unit-integrity`, runs on Ubuntu 24.04 and has a
30-minute job timeout. Its execution step has a 25-minute timeout around a
20-minute process timeout with TERM and a 30-second forced-stop allowance.
Checkout/Node/artifact actions use the same verified commit pins and read-only
permissions. No package dependency installation is needed for database validators.
The `backend-ci-success` job uses `always()` and requires both jobs' explicit
`success` results, rejecting failed, cancelled or skipped prerequisites. It is
the intended required check; no GitHub branch-protection settings were changed.

`scripts/ci/run-local-db.sh` implements the retained Stage 2B sequence: fresh
temporary project outside checkout, base-schema `db start` before copying any
FairSwap migrations, `migration up --local` and nine explicit `test db --local`
paths. It uses a clean environment, isolated home/Docker config, native local
Unix Docker socket and no linked project, hosted credentials, provider settings
or worker endpoints. Base initialization uses transient Auth/Storage/Realtime
schema migration jobs; it does not start their service stack or Edge Functions.

Before creating the network, it downloads and checksum-verifies the CLI archive,
pulls all five pinned images by digest and checks Linux/amd64 image IDs and local
tag consistency. It refuses to overwrite an existing conflicting image tag.
It then creates one uniquely labelled **internal** IPv4/IPv6 bridge with a
loopback default binding. A disposable sleep-only container verifies implicit
publishing behavior before even starting the base database. No unrestricted
network fallback, global daemon change, relay or firewall relaxation exists.

Before copying FairSwap SQL, the executor requires all of the following:

- Actual database bindings contain only loopback host addresses at the chosen
  task port, and the database has exactly the intended internal network/image.
- Host-visible Docker namespace identity matches the database PID's namespace;
  remote engines and Docker Desktop namespace mismatches fail closed.
- Both IPv4 and IPv6 default routes are absent inside that namespace.
- Probe tools work, a localhost socket succeeds inside the database namespace,
  and TCP attempts to two external IPv4 and two external IPv6 addresses fail.
- A host loopback TCP connection, local CLI SQL query and SQL query from the
  pinned pg_prove image on the task network all succeed.

Those checks repeat after tests. If publishing, safe connectivity and egress
denial cannot coexist, execution stops with no fallback. All dependencies are
downloaded before isolation; no FairSwap migration is introduced before proof.
The runner verifies manifest and copied migration hashes before/after execution.
The nine-suite allowlist and assertion counts remain exactly the Stage 2B
6/10/28/11/31/28/59/22/75 contract, totalling 270. It never copies or runs the
excluded email-outbox diagnostic.

`assert-local-security.sql` is a read-only transaction that returns catalog
evidence without selecting secret values or invoking dispatch functions.
`verify-db-results.mjs` compares it before/after tests against retained R6
expectations: exact 58 migration versions, PostgreSQL 15.8/150008, RLS and policy
counts, table permissions, both private buckets, all 27 recorded sensitive RPC
permission/definer tuples, three extensions, empty Vault, disabled moderation,
zero HTTP queue/response counts and both canonical cron registrations/config.
The two broad trigger-grant exceptions are preserved and remain review items.
No blanket service-only rule is imposed on authenticated staff/seller RPCs.

Runner exit status, file identity, exact assertion counts and pg_prove success
markers are mandatory. Bad plans, missing/duplicate suites, nonzero exits, SQL
errors and absent isolation/cleanup evidence prevent success. Validator tests use
retained R5 summaries and clearly synthetic state fixtures; they do not constitute
a new database execution.

## P2 pins, evidence and cleanup

The official CLI v2.117.0 release API records Linux amd64 archive SHA-256
`69c05f85b9e47ee706d30f1a6ca8a526b4e337bfd12c7ef1ef522d24e7280d24`.
Pinned source `apps/cli-go/pkg/config/constants.go` selects PostgreSQL image tag
`15.8.1.085`; `templates/Dockerfile` supplies the bootstrap/test image tags.
On 16 October 2026, anonymous ECR manifest/index bytes were hashed directly:

| Image | Verified manifest/index SHA-256 |
| --- | --- |
| postgres:15.8.1.085 | af083ef64d0408c8f098ee6f5c364a59b26f36fbc0f3a334a62c5c1d57362e9b |
| pg_prove:3.36 | eda7c5e68719e9c8287e78c017118407b48df904a51c935f5ab6098b8c0bc6bc |
| gotrue:v2.196.0 | c0c25187a6b835e65a6f6e6c6b39d090e832d40e6de5186f2c038e0411944232 |
| storage-api:v1.72.1 | 105a2584129c9600aebed6f5ac49ca4371c92b996ecd1af7179750333e9e2120 |
| realtime:v2.130.0 | 002193c9ff840a4946918641901bb6aa9e2036dc9ff7590e2b11e91d1e06bf86 |

Full registry references and provenance are in `scripts/ci/toolchain.json`.
The pg_prove pin matches the retained Stage 2B digest. Index verification is not
an image execution claim: runtime must still verify image IDs, platform, CLI
version and the actual PostgreSQL server version. Docker must be native Linux,
amd64 and version 28 or later; an exact Docker patch version is **unresolved**
and recorded as null rather than invented. Runtime records the actual version.

Private raw logs/configuration remain in a mode-0700 task directory. EXIT/INT/TERM
handling performs task-project stop without backups, then removes only resources
with the unique task ownership label. Container/volume/network inventories must
match preflight and the task port must be closed. No global prune or repair of
unrelated resources is allowed. The private task directory is ownership-checked
and removed; removal failure invalidates the evidence. Hard-kill/cancellation
cleanup behavior still needs native-runner verification; process traps cannot
guarantee execution after SIGKILL. GitHub's disposable VM is the outer boundary.
Downloaded image caches/tags are retained as tool dependencies, not database
acceptance evidence; they are excluded from container/volume/network inventories.

Only three files are uploaded: `result.json`, `suite-results.json` and
`SHA256SUMS` (covering the two JSON files). Successful artifacts contain normalized,
validated observations and fixed known catalog expectations, not raw TAP/error
text, secret values, local paths, Docker environment dumps or database backups.
Failure artifacts are generic and never assert success. Strict schema/count and
checksum validation runs before upload; artifact retention is 14 days.

## P2 local verification and unresolved runtime acceptance

An Ubuntu WSL distribution exists, but inventory found no native `dockerd`, Node
or firewall tools; its Docker command points to Docker Desktop. It is not an
approved native Linux database-verification environment. No Docker/CLI runtime,
base startup, migrations, pgTAP or security SQL was executed for P2.

| Local check | Actual result |
| --- | --- |
| `node --test scripts/ci/db-verification.test.mjs scripts/ci/verification.test.mjs` | PASS; 117 validator tests (59 database + 58 existing), zero failures/skips |
| `node scripts/ci/verify-baseline.mjs` | PASS; approved manifest digest and all 58 canonical migration hashes |
| `corepack pnpm typecheck` | PASS |
| `bash -n scripts/ci/run-local-db.sh` | PASS in Git Bash and native Ubuntu WSL Bash; syntax only |
| `node --check scripts/ci/verify-db-results.mjs` | PASS |
| Guarded `corepack pnpm test:unit --reporter=default --reporter=json --outputFile=artifacts/stage2c-p2-unit-results.json` and strict JSON verification | PASS; unchanged five files, 93 tests, zero failures/skips |

The Windows unit run used approved parent-directory filesystem access for esbuild
and retained the unchanged network-blocking harness. No dependencies or package
files changed. Linux image startup, bootstrap jobs, SQL syntax/catalog results,
network coexistence/egress probes, test-runner connectivity, runtime cleanup,
workflow execution and artifact upload are all **UNVERIFIED**, not PASS. The
original internal-network startup problem may recur; the implementation must
stop at that boundary rather than substitute another environment. A native
Linux rehearsal is required for runtime acceptance. No hosted run was attempted.

## Stage 2B exceptions retained

The accepted [Stage 2B record](STAGE2B_VERIFICATION.md) remains authoritative for
its local evidence and exceptions; static/unit CI does not revalidate that state:

- `schema_email_outbox.test.sql` remains historically excluded from required CI.
  The standalone diagnostic failed: unsupported `has_constraint` at line 59,
  34 planned versus 32 authored calls, and only 31 assertions executed. Its zero
  assertion failures are not a passing diagnostic. No test repair is included.
- Broad EXECUTE grants on `public.handle_listing_moderation_enqueue()` and
  `app_security.trg_fn_notify_moderation_worker()` require explicit authorization
  review and disposition before cutover. Their trigger return type means catalog
  grants alone do not establish ordinary RPC exploitability. No ACL changes.
- Loopback publication did not prove complete outbound isolation. Hosted
  end-to-end authorization, provider/worker delivery and deployment network
  controls remain separate acceptance prerequisites.
- Default Docker bridge IDs changed in some earlier runs; the cause remains
  unverified. P2 performs no live Docker-state inspection or repair locally.

## Existing work and approval boundary

AGENTS.md, README.md, POINT1_BASELINE.md and DEPLOYMENT_OWNERSHIP.md retain their
pre-existing modified bytes, unstaged. Their older Stage 2B startup/authorization
text conflicts with later accepted evidence; reconciliation needs separate scope.
This file does not alter their deployment-ownership restrictions. P1 does not
change canonical migrations, SQL tests, copied unit tests, test setup, lockfile,
deployment configuration or application behavior. P2 implementation was separately
authorized and remains uncommitted for review. No implementation acceptance,
commit/push/PR, hosted execution or deployment is implied by static checks.

## P2 GitHub Actions runtime findings and revised isolation approach

After approved publication of the extraction branch, GitHub-hosted Ubuntu 24.04
repeatedly passed `unit-integrity`, but `database-pg15` stopped **before**
starting PostgreSQL or applying FairSwap migrations. The first runs were blocked
by ECR image-pull rate limits; the subsequent PR run reached the pre-start
port probe and observed no usable port mapping on the `--internal` bridge.
The final required gate correctly failed and the retained failure evidence
reported task-owned cleanup. No database migration or pgTAP result from these
runs may be described as passing.

The current draft-PR revision replaces that internal network with a disposable,
task-named **ordinary** dual-stack bridge, retaining loopback-only port
publication. Before any container starts, it installs task-interface-specific
IPv4 and IPv6 DROP rules in Docker's `DOCKER-USER` forwarding chain and INPUT
rules blocking new container-to-host connections. It explicitly verifies the
Docker firewall hooks, all four rules and the named bridge; unsupported firewall
backends fail closed. After base database startup, it removes default routes
inside the task's database network namespace, and repeats host firewall,
loopback, namespace, IPv4/IPv6 outbound probes and SQL-connectivity checks
before any FairSwap migration and again after tests. Cleanup must delete exactly
the task-owned firewall rules, remove task resources, and record `firewallRemoved`.
Sanitized evidence now uses `firewallIsolated` rather than claiming the Docker
network is `--internal`. Neither ordinary loopback publishing nor a finite set
of egress probes, by itself, proves universal outbound-network isolation.

The extraction branch is no longer a `push` trigger while an open PR also
triggers CI; `main` push, `pull_request` and manual dispatch remain. This
reduces duplicate heavy image pulls. Registry rate limiting is still a
possible external dependency failure; no unsigned or floating-image fallback
was added. All revised runtime network and cleanup behavior is **UNVERIFIED**
until GitHub Actions exercises it successfully. Draft PR #1 remains unmerged;
no hosted Supabase, provider or deployment operations are authorized.

## GitHub security-catalog verification — explicit column ACLs

The first GitHub-hosted database run successfully crossed the scoped firewall,
started PostgreSQL 15 and completed the migration command, then failed its
read-only security snapshot comparison. The accepted Stage 2B catalog evidence
marked `listings.authenticated_any_dml=false` because that historical check
was not a uniform column-level grant inventory; `listing_media` was handled
differently. The canonical migration history deliberately grants sellers limited
column-level INSERT/UPDATE on listings and INSERT on listing_media. Treating the
historic boolean as proof of no seller mutations is incorrect.

This CI-only correction leaves the Stage 2B evidence, all 58 migrations, all
RLS policies and existing role grants unchanged. It retains the exact historic
RLS enablement/policy-count expectations, corrects the new summary for
`listings.authenticated_any_dml=true`, and **also** requires a read-only
per-column matrix for `email_outbox`, `listing_media` and `listings`. The matrix
fails on any unauthorized anon INSERT/UPDATE/DELETE, whole-table seller DML,
unauthorized seller column, missing approved seller column or unexpected direct
seller DELETE. The seller listing allowlist comes from Migration 31, with
`cover_photo_id` UPDATE removed by Migration 33. The media list comes from
Migration 6, with direct `display_order` UPDATE removed by Migration 33.
Synthetic regression tests cover both excessive and missing grants.

The revised GitHub pipeline remains **UNVERIFIED** until a hosted run proves the
full nine-suite/270-assertion contract, both security snapshots and exact
firewall cleanup. No hosted credentials, migrations or deployment access added.
