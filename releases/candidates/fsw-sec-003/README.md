# FSW-SEC-003 — isolated source candidate (31 October 2026)

Local preparation only. No GitHub operation, hosted write, deployment, or manual /
exploratory test was performed. Read-only hosted calls were restricted to migration
ledgers and the two search functions' catalog metadata, never listing/user data.
Existing unrelated dirty files were preserved. Observed Backend `main` HEAD:
`8f3abe1cb7a5053a7ce2f741ae66d6d969f0c180`; Web `main` HEAD:
`b09ac522ff58e40bfc90937ecb74b19c633725ba`. No fetch/pull; these are not verified
synchronized bases. Web source, generated types and package manifests remain unchanged. This continuation
changes only Backend files and performed no Git operation. Draft PR #74 is
owner-reported; it was not queried or modified.

## Exact files changed for the release-gate continuation

Modified:

- `.github/workflows/backend-ci.yml`
- `tests/fsw-sec-003/run-disposable.mjs`
- `releases/candidates/fsw-sec-003/README.md`

Added:

- `tests/fsw-sec-003/native-adapter.mjs`
- `tests/fsw-sec-003/run-native.sh`
- `tests/fsw-sec-003/postgrest-pin.json`
- `tests/fsw-sec-003/install-postgrest.mjs`
- `tests/fsw-sec-003/http-contract.mjs`
- `tests/fsw-sec-003/capture-release.sql`
- `tests/fsw-sec-003/release-gate.mjs`
- `tests/fsw-sec-003/release-gate.test.mjs`
- `tests/fsw-sec-003/cli-rehearsal.mjs`

The fixture, original history snapshot, approved migration and 58 historical
migrations are unchanged. The migration remains
`supabase/migrations/20261031110408_fsw_sec_003_public_search_hardening.sql` within
this isolated candidate directory. Raw reviewed SHA-256:
`b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd`.

CLI 2.117.0 generated the version via `supabase migration new
fsw_sec_003_public_search_hardening --workdir releases/candidates/fsw-sec-003`.
The isolated candidate directory contains ONE migration, not copied baseline SQL.
The CLI's ignored `.temp/cli-latest` cache is not part of the artifact.
Do not deploy this directory without the environment-specific preparation below.

## Contract and security

Only the private implementation is replaced. The complete two listing queries,
sort/ranking clauses, visibility restrictions and JSON-return tail are byte-identical
to historical migration 31. Signatures, defaults, public invoker wrapper, function
owner/ACL, stable volatility, fixed empty search path, table grants/RLS, exposed
schemas, vectors, indexes and language configuration are retained. No new grants.
An absent or drifted private implementation aborts before replacement (`55000`).

The raw query is bounded to 4096 bytes before trimming, Unicode code-point length
counting or full-text parsing. `btrim` preserves the existing SQL normalization;
more than 100 normalized characters fails without truncation. This accepts Hindi
and supplementary-plane Unicode. Web's existing Zod UTF-16 length guard is stricter
for supplementary characters; it is reused unchanged. No Unicode normalization or
search semantics were introduced. Existing empty/stop-word/punctuation browsing
behavior is preserved within the new limits.

Invalid page (<1 or >1000) raises `22023` before offset arithmetic; null defaults to
1. Existing per-page null/nonpositive default of 20 and upper clamp of 50 remain.
Maximum computed offset is 49,950. Unknown conditions/sorts, negative/inverted
prices, unknown/inactive/blank category slugs and conflicting category ID/slug
raise generic `22023` errors without echoing input. A null sort retains the existing
newest ordering. Typed integer/UUID parameters reject malformed or out-of-range
values at PostgreSQL's input boundary (`22P02`/`22003`). Unknown UUID filters remain
restrictive predicates returning empty results; they never remove the filter.

No extra network requests, services, runtime dependencies or ordinary-path listing
queries. Unfiltered browse adds no category lookup; a slug still uses one lookup.
A request specifying both ID and slug now validates the slug and rejects conflicts.
Web already handles RPC errors as unavailable/empty and validates search-page
filters; no Web change or deployment is required. Native clients were not changed
or executed; valid contract compatibility is inferred from unchanged signatures and
response behavior, not a native build.

## Mandatory CI gates and executed evidence

The existing `unit-integrity` job now requires the full 115-check search suite,
using the existing Ratings lockfile's PGlite 0.5.8, plus release-validator tests.
The existing `ratings-native-pg17` job now requires the same search suite on exact
native PostgreSQL 17.6, real loopback PostgREST RPC verification, and an authentic
CLI migration/fetch/dry-run rehearsal. Its existing checksum-pinned PG17.6 builder
and CLI 2.117.0 installer are reused unchanged. A download/install/startup failure,
missing dependency or failed assertion is fatal; there are no skips or optional
success paths. All five existing jobs, their dependencies and the aggregate
`backend-ci-success` requirements are retained. No Actions permission was widened.

Concise workflow additions (existing steps remain):

```diff
 unit-integrity:
+  require search PGlite 115 checks using tests/ratings/node_modules
+  node --test tests/fsw-sec-003/release-gate.test.mjs
 ratings-native-pg17:
+  install checksum-pinned PostgREST test binary
+  bash tests/fsw-sec-003/run-native.sh <existing PG17.6 bin>
+  install existing checksum-pinned Supabase CLI 2.117.0
+  node tests/fsw-sec-003/cli-rehearsal.mjs <PG bin> <CLI>
```

PASS locally, with synthetic fixtures only:

- 115/115 checks on PGlite 0.5.8 / PostgreSQL 18.3.
- 115/115 checks on real native PostgreSQL 17.6 built from the existing Ratings
  source checksum pin. Same exact SQL candidate, 130 synthetic rows, both client
  roles; explicit owner, argument/return type, stable definer/invoker, search_path,
  ACL, pagination, Unicode/oversize, filters, privacy and visibility checks.
- 40/40 actual HTTP RPC checks on PostgREST 12.2.12 against that disposable native
  database. Anonymous and synthetic HS256 JWT authenticated calls; JSON shape,
  pagination, Hindi, lengths/pages, controlled invalid-filter/type errors,
  inaccessible implementation RPC and rejected `app_security` schema profile.
  HTTP binds only 127.0.0.1; PostgreSQL normally exposes only a private Unix socket.
- 37/37 release-validator tests, including wrong environment, stale metadata,
  missing TLS, wrong PG major, duplicate/changed histories, fabricated fetched
  SQL, checksum drift, extra pending migrations, ACL/RLS/signature/security drift,
  installed body mismatch and required successful Test receipt before Prod.
- Authentic CLI 2.117.0 rehearsal: generated synthetic seed version (never an
  invented ledger row), genuine CLI install and fetch, fetched SQL digest check,
  actual read-only catalog capture, genuine CLI dry-run parsing, exact candidate
  installation and CLI ledger digest check. The rehearsal uses a fresh local
  cluster and synthetic user only; `--include-all` occurs only in that disposable
  fixture because its CLI-generated seed is newer than the approved candidate.
  The release-preparation path does not use `--include-all`.
- All 58 migration bytes match via `node scripts/verify-migration-manifest.mjs`.
  JavaScript/shell syntax checks, workflow YAML parsing and whitespace checks pass.

CLI serialization differs from raw migration bytes. The **measured**, normalized
CLI ledger statement SHA-256 for this exact candidate under CLI 2.117.0 is
`9cc72ec137f4078b39e1c57065592ec008a63afae2a6b85cc8b06aa206b29c15`.
Both this and the raw artifact digest are pinned independently. Postflight checks
both installed private function body and authentic ledger statement digest.

Reproduce from Backend root:

```sh
npm ci --prefix tests/ratings --ignore-scripts --no-audit --no-fund
node tests/fsw-sec-003/run-disposable.mjs --pglite-module tests/ratings/node_modules/@electric-sql/pglite/dist/index.js
node --test tests/fsw-sec-003/release-gate.test.mjs
# CI/Linux: reuse existing checksum-pinned source builder and CLI installer.
bash tests/ratings/build-native-pg17.sh
node tests/fsw-sec-003/install-postgrest.mjs
bash tests/fsw-sec-003/run-native.sh /absolute/PG17.6/install/bin
node tests/fsw-sec-003/cli-rehearsal.mjs /absolute/PG17.6/install/bin /absolute/supabase-2.117.0
```

Local evidence used macOS ARM64, Node 24.21.0 and the pinned macOS PostgREST archive;
CI retains Node 24.15.0 and uses the independently checksum-pinned Linux static
archive. macOS HTTP tests point the child process's standard dynamic-library search
path at the locally built PG17.6 lib directory; no machine installation is needed.
Neither PostgREST nor PGlite is a new application/package dependency.

The runner checks the complete listing-query/return tail byte-for-byte against the
old implementation and compares representative EXPLAIN JSON plans; both match.
Native median client wall time was 4.760 ms before and 4.740 ms after, dominated by
starting psql per assertion. These are synthetic regression timings, not hosted
latency evidence. The approved SQL and its ordinary query count remain unchanged.

NOT RUN / release acceptance still required: GitHub CI on Linux and pinned CI Node,
full existing CI/pgTAP suites, full historical-chain replay and hosted target
preflight/postflight. The source changes make search tests mandatory; they do not
prove an installed or passing GitHub run. Disposable HTTP infrastructure is available
and verified locally; there is no remaining local HTTP infrastructure blocker.

## Live history compatibility and release safeguards

`history-snapshot.json` contains exact version/name metadata returned independently
by Supabase `list_migrations` on 31 October 2026: Test 97, Prod 81; 54 shared
versions, 43 Test-only, 27 Prod-only; shared versions have identical names. These
are actual ledger identities, not fabricated applied filenames or CLI-fetched files.
Both latest versions are `20261028122328`. DigiLocker is present in both, under
`20261028091220` in Test and `20261028095605` in Prod. Older documentation saying
Prod lacks it is superseded by this read-only snapshot for this release only.

Both private bodies match source migration 31: MD5
`0ccc07eede6a6fa06b30acc06d9cdc10`; both are stable definers, empty search path,
with EXECUTE ACL for postgres/anon/authenticated/service_role only. Public wrappers
are stable invokers with the same ACL/search path but different body fingerprints:
Test `821f536ad89962bc345586f175c86d23`, Prod
`150b3b0298c05e2eb9733bd010e6f5a2`. They are deliberately untouched. MD5 here is a
source-drift fingerprint, not an artifact-authentication mechanism. Exact function
behavior and metadata remain subject to fresh release preflight.

## Protected release workflow

`.github/workflows/fsw-sec-003-protected-release.yml` is a single owner-only
`workflow_dispatch` on protected `main`. Input `approved_sha` must equal the exact
reviewed workflow/source commit. `FSW_SEC_003_RELEASE_ENABLED=true` is an explicit
repository/environment enable variable, not an application variable. Concurrency
cannot cancel an in-progress release. No automatic deployment follows a merge.

Order: successful independent `backend-ci.yml` push run at that exact SHA → protected
FairSwapTest approval, migration and automated postflight → checksum-bound successful
Test receipt validation in a credential-free job → separate protected FairSwapProd approval, migration and postflight.
Existing environment approvals, branch rules and required checks remain in force.
The existing GET-only protection auditor checks main head, owner/triggering actor,
reviewer, bypass and collaborator rules, and environment-only credential placement;
it confers no Chat-specific release or recovery exception. All existing workflows
remain enabled. New synthetic tests join independent CI without removing checks.
No Web, Admin, HelpCenter, Android or iOS release is involved.

Changed files for this workflow implementation:

- `.github/workflows/fsw-sec-003-protected-release.yml`: protected dispatch and receipt transfer.
- `scripts/release/fsw-sec-003-release.mjs`: dedicated orchestration and sanitized receipts.
- `scripts/release/install-fsw-sec-003-pg.sh`: same pinned PG17.6 source, TLS-enabled build.
- `tests/fsw-sec-003/protected-release.test.mjs`: injected, synthetic release/failure tests.
- `.github/workflows/backend-ci.yml`: adds the new test file to the existing search test command.
- This README. Existing unrelated checkout changes are preserved.

`release-gate.mjs` and `capture-release.sql` remain unchanged. Their independent
history, byte, function and RLS validators are reused. Their standalone commands
are read-only preparation tools, not a substitute for protected release authority.
Approved SQL SHA-256 remains
`b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd`;
none of the 58 historical migrations changes.

### Credentials and supported CLI path

| Existing protected input | Use / requirement |
| --- | --- |
| `FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN` | Test-only CLI link and Management API reads; previously proven project metadata access only, not sufficient release permissions by assumption |
| `FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN` | Independent Prod-only equivalent; no cross-project token substitution |
| `CHAT_DATABASE_PASSWORD` | Existing environment-only database password; explicitly reused for this reviewed database release, with no Chat authorization inference |
| `CHAT_DB_SSL_ROOT_CERT_PEM` | Existing environment-specific trusted CA; valid CA/time/PEM required |
| `CHAT_DB_POOLER_HOST` | Existing environment-specific raw session-pooler host, fixed 5432 and `postgres.<expected-ref>` |
| `CHAT_RELEASE_AUDIT_TOKEN` | Existing environment-only GitHub protection-read token; complete ruleset/bypass/environment metadata required |
| `github.token` | Read-only Actions evidence for exact-commit independent CI |

No application variables, credentials or permissions are created. `FSW_ENVIRONMENT`,
`FSW_PSQL`, `FSW_CLI`, `APPROVED_SHA`, `TEST_RECEIPT_SHA` and `FSW_RELEASE_ENABLED`
are workflow-local bindings, not secrets. The existing Supabase tokens are recorded
as repository-level secrets; their scope does not itself confer deployment authority.
They are supplied only to the respective protected job. Any eventual relocation
must preserve their names and existing consumers and is outside this local task.

CLI 2.117.0 is installed using the existing archive/checksum installer. Fresh private
workspaces execute genuine `init`, `link --project-ref` and `migration fetch --linked`.
The link-generated project-ref is verified. Linked preparation needs the matching
Supabase Management API token as well as the existing database password. Missing
password blocks before link, avoiding CLI temporary-role creation. Missing API
access blocks; no login, secret creation, password reset or privilege widening occurs.
The [CLI link contract](https://supabase.com/docs/reference/cli/supabase-link) documents
`SUPABASE_DB_PASSWORD`. The pinned implementation's
[connection configuration](https://github.com/supabase/cli/blob/v2.117.0/apps/cli-go/internal/utils/flags/db_url.go)
and [TLS preservation](https://github.com/supabase/cli/blob/v2.117.0/apps/cli-go/internal/utils/connect.go)
were inspected for this path.

Unlike the Chat release's URL-only preparation, linked preparation here is genuine;
no link cache or migration ledger is fabricated. Every historical fetched statement
checksum and filename must match independently captured target history. Only then
is the single pinned candidate copied. Genuine `db push --db-url <verified-url>
--dry-run` must list exactly that pending candidate. Apply uses the same supported
`db push --db-url` path and explicit session/TLS URL, avoiding an implicit linked
endpoint/fallback for deployment. Passwords stay in subprocess environment, never
arguments; raw subprocess output is captured privately and never logged. No repair,
reset, raw historical-directory push, include-all, seed or roles flags are used.

The existing PG17.6 fixture build disables OpenSSL. The release-only helper verifies
the same pinned archive and enables OpenSSL, without changing the original fixture
build. Both clients require `verify-full`, the trusted CA and session port 5432.
All fetched histories, CLI caches, passwords and certificates stay under a private
mode-0700 temporary parent, removed on normal success/failure. Abrupt runner death
relies on GitHub's ephemeral runner disposal. Only allowlisted receipts are uploaded.

### Exposure, recovery and authority gates

See [the recovery/authority evidence audit](EVIDENCE_GAPS.md) for available source records, unproven permissions, evidence provenance gaps, and the required automated evidence producers. This audit is documentation only and does **not** authorize a hosted migration.

Each target independently requires read-only
`GET /v1/projects/{ref}/postgrest` immediately before release and after migration.
Only exactly `public` is accepted as `db_schema`; absent/unknown config, any extra
schema (including `app_security`), denied reads or transport failures block.
Only the project ref and schema allowlist are retained; the response's optional
JWT secret and all other fields are discarded without hashing, logging or persistence.
The [Management API schema](https://api.supabase.com/api/v1-json) specifies
`rest:read` / `data_api_config_read`; secret-config read access is unnecessary.
A null `pgrst.db_schemas` SQL setting never substitutes for this evidence.

The same token must support the CLI's required link metadata reads, including its
API-key/service configuration reads. Existing project-read scope is not assumed to
suffice. The workflow must stop if it is insufficient. No genuinely missing secret
can be asserted from local source: credential availability and permissions remain
UNVERIFIED. If current scoped tokens cannot satisfy link and read-only configuration
access, a separately authorized environment-scoped least-privilege credential and
reviewed wiring are required; no broader token is silently substituted.

The earlier Chat no-backup/authority exception is explicitly excluded. Before any
database access, each job requires a reviewed, sanitized recovery record at
`releases/candidates/fsw-sec-003/recovery/<FairSwapTest|FairSwapProd>.json` in the
approved source commit. **Neither record exists in this checkout.** This intentionally
blocks release with `FSW_REVIEWED_RECOVERY_AND_AUTHORITY_EVIDENCE_REQUIRED`.
Do not invent records to make the gate pass.

A record must contain `status: PASS`, exact `environment`, `projectRef`, candidate
`sha256`, `verifiedAt` within 24 hours, `backupId`, `backupAvailable: true`,
`automatedRestoreVerified: true`, `exclusiveBackendAuthority: true` and SHA-256
references `backupSha256`, `automatedRestoreReceiptSha256`,
`privilegedWriterInventorySha256`, `retiredWriterProofSha256`. Restore and authority
references are reviewed evidence assertions, not independently discovered proof;
review must inspect the actual automated restore result and authority/retirement
proof behind those digests. A boolean or arbitrary digest alone supplies no evidence.
No manual/exploratory predeployment test is required or authorized.

Backup availability is independently rechecked using read-only
`GET /v1/projects/{ref}/database/backups` (`database:read` / `backups_read`). The
reviewed ID must identify exactly one `COMPLETED` backup, created within 24 hours.
`backupSha256` is SHA-256 of UTF-8 `JSON.stringify` over exactly these keys, in order:
`{id,status,inserted_at,is_physical_backup}`. Both recovery freshness and live backup
availability are checked again immediately before apply. Unavailable restore,
exclusive-authority or recovery evidence is a blocker; no waiver is inferred.
Backup contents are never downloaded or uploaded by this workflow.

### Postflight, receipts and recovery

Fresh metadata must preserve the independent environment's full prior ledger,
public wrapper, function owner/signatures/ACL/security, all captured table/column
grants, RLS and policies. Additional read-only schema inspection preserves owners,
ACLs and effective role privileges on `public` and `app_security`, rejecting client
schema CREATE privileges. The installed private SQL body must match exactly; the
single new CLI ledger entry must match measured statement digest
`9cc72ec137f4078b39e1c57065592ec008a63afae2a6b85cc8b06aa206b29c15`.

Success/failure receipts contain only identity, phase, migration-attempt status,
allowlisted blocker codes and evidence digests. Raw SQL/history/catalog/API response
bodies and credentials never enter artifacts. Mode-0600 receipts are exclusively
created with SHA256SUMS; artifacts cannot overwrite earlier evidence. Production
uses the artifact ID and receipt hash output by the successful Test job and rechecks
status, run, attempt, commit, project, migration SHA/version, postflight and freshness
(maximum 24 hours) before any Production read. A failed or rerun Test receipt cannot
start Production. Separate protected environment approvals are retained.

If migration was attempted and postflight failed, stop and review the failure receipt;
do not rerun blindly or infer rollback. Rollback is a reviewed forward compensating
SQL migration, preserving all history. No automatic destructive recovery is added.

### Local verification and remaining blockers

On local `main` at `8f3abe1cb7a5053a7ce2f741ae66d6d969f0c180` (different from the
requested `068f8168...` baseline), existing dirty/untracked work was preserved.
No fetch, commit, push, PR, dispatch or hosted operation occurred.

PASS: Node 24.21.0, `node --test tests/fsw-sec-003/release-gate.test.mjs
 tests/fsw-sec-003/protected-release.test.mjs`: 60 tests (37 existing + 23 new),
zero failed/skipped. This includes complete injected Test→Prod flow, wrong target/SHA,
stale receipt/run/attempt, missing permissions, TLS failure, duplicate migration,
unexpected pending migrations, history mismatch and catalog/schema drift.
PASS: immutable migration manifest (58/58), candidate digest and shell/JS syntax.

NOT RUN: pinned CI Node 24.15.0, Linux TLS build, full independent/native/HTTP CI,
real linked CLI preparation and hosted acceptance. Synthetic tests do not prove
network/TLS behavior or credential permissions. The 115 SQL and 40 HTTP suites are
retained in independent CI; this implementation did not rerun them locally.

BLOCKED for release: missing reviewed per-environment recovery/authority evidence;
exact new reviewed main commit and successful CI; live environment/branch protection,
credential/least-privilege access, effective exposure and backup checks remain
unverified until separately authorized orchestration. No production writes are
necessary to complete this local implementation.

After deployment, owner production checks: English/Hindi search, category/city/price
filters, pagination, errors and latency. No owner testing before deployment is added.

## Read-only recovery/authority audit continuation

A separate owner-dispatched evidence workflow now prepares independent protected
Test/Prod metadata receipts. It does not enable or modify deployment gates.
See [collection contract, permissions, trust boundary and remaining blockers](EVIDENCE_GAPS.md#protected-read-only-producer-added-locally--fsw-sec-003-continuation).
