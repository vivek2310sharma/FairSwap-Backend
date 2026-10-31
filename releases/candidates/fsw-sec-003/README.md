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

## Read-only environment-specific release automation

`tests/fsw-sec-003/release-gate.mjs` has only `prepare`, `preflight`, and `postflight`
commands. It cannot apply, repair, reset or deploy. No hosted command was run here.
It uses already protected libpq services named exactly `FairSwapTest` and
`FairSwapProd`, existing CLI authentication/database access, and CLI 2.117.0. No
credentials are printed, placed in command arguments, source files or receipts.
No new application/deployment environment variable or secret name is introduced.
A later protected release must supply existing access; missing access fails closed.

`prepare` independently captures each target's exact full version/name/statement
hash ledger with read-only SQL, validates verified TLS and its project-specific
hostname/user/session port, and records RPC owners/ACLs/signatures/body hashes and
all six search tables' RLS/policies/table/column grants. Captures expire in 15
minutes. It links a **fresh isolated workspace**, executes authentic CLI
`migration fetch --linked`, verifies exact filenames and every historical SQL file
against that target's ledger statement digest, recaptures live metadata to detect
races, copies the single checksum-pinned candidate, verifies complete pending
workspace membership and requires a genuine dry-run naming exactly that candidate.
Nothing manufactures historical files or ledger rows. Additive history is accepted
only as genuinely fetched, independently captured target history; it is never
copied between environments or inferred from the old snapshot counts.

`preflight` is the immediate-before-apply recheck of fresh live metadata and every
historical/pending workspace byte. `postflight` requires exactly the one expected
CLI ledger entry with the measured statement digest; all earlier history and all
captured RLS/ACL/policy/owner/signature/security metadata must remain identical.
It verifies the new private function body exactly and leaves each environment's
public wrapper fingerprint intact. Production preparation requires the matching
successful Test postflight receipt for this candidate. Receipts are created with
exclusive mode-0600 files and never overwrite earlier evidence. They are local
metadata evidence, not signed workflow attestations or deployment authorization.
Preserve existing protected release/recovery and CI safeguards; the Chat release
exception does not authorize this release.

Example invocation sequence after review, using separate fresh absolute workspaces
and new receipt paths (credential values stay in existing protected service/CLI
configuration):

```sh
node tests/fsw-sec-003/release-gate.mjs prepare FairSwapTest /absolute/psql /absolute/supabase /absolute/fresh-test /absolute/test-pre.json
node tests/fsw-sec-003/release-gate.mjs preflight FairSwapTest /absolute/psql /absolute/test-pre.json
# ChatGPT's separately authorized supported CLI-managed Test migration, then automated gates.
node tests/fsw-sec-003/release-gate.mjs postflight FairSwapTest /absolute/psql /absolute/test-pre.json /absolute/test-post.json
node tests/fsw-sec-003/release-gate.mjs prepare FairSwapProd /absolute/psql /absolute/supabase /absolute/fresh-prod /absolute/prod-pre.json /absolute/test-post.json
node tests/fsw-sec-003/release-gate.mjs preflight FairSwapProd /absolute/psql /absolute/prod-pre.json
# ChatGPT's separately authorized supported CLI-managed Production migration.
node tests/fsw-sec-003/release-gate.mjs postflight FairSwapProd /absolute/psql /absolute/prod-pre.json /absolute/prod-post.json
```

Release limitations/blockers: complete Linux CI and the independently authorized
hosted prepare/preflight/postflight sequence have not run. Effective hosted Data API
schema configuration must be confirmed by the protected release's read-only
configuration evidence: SQL captures `pgrst.db_schemas` when configured and rejects
`app_security`, but a null DB setting cannot attest PostgREST process-level config.
The standalone tool does not claim that missing evidence is proof of privacy. It
preserves the setting and the migration never changes API exposure. The real local
HTTP suite proves the intended `public`-only API configuration only. No manual or
exploratory hosted/user-data test is authorized or needed by this preparation.

Order: FairSwapTest Backend migration → automated gates/postflight → identical
reviewed FairSwapProd migration → automated postflight. No Web release. Owner
inspects production normal search, category/city/price filters, pagination,
Hindi/English behavior, errors and latency after deployment; no owner predeployment
test or approval gate is added.

Rollback: reviewed forward compensating SQL migration; never erase ledger history.
