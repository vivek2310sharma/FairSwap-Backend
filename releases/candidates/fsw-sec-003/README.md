# FSW-SEC-003 — isolated source candidate (31 October 2026)

Local preparation only. No GitHub operation, hosted write, deployment, or manual /
exploratory test was performed. Read-only hosted calls were restricted to migration
ledgers and the two search functions' catalog metadata, never listing/user data.
Existing unrelated dirty files were preserved. Observed Backend `main` HEAD:
`8f3abe1cb7a5053a7ce2f741ae66d6d969f0c180`; Web `main` HEAD:
`b09ac522ff58e40bfc90937ecb74b19c633725ba`. No fetch/pull; these are not verified
synchronized bases. Web source, generated types, manifests and CI remain unchanged.

## Exact new files

- `releases/candidates/fsw-sec-003/supabase/migrations/20261031110408_fsw_sec_003_public_search_hardening.sql`
- `releases/candidates/fsw-sec-003/history-snapshot.json`
- `releases/candidates/fsw-sec-003/README.md`
- `tests/fsw-sec-003/fixture.sql`
- `tests/fsw-sec-003/run-disposable.mjs`

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

## Executed evidence

- PASS: `node scripts/verify-migration-manifest.mjs`: all 58 immutable files match.
- PASS: `git diff --check` (tracked changes); new candidate SQL/test files also
  inspected for whitespace. No historical SQL or existing tests were edited.
- PASS: 115 standalone automated checks, zero skips, on in-memory PostgreSQL 18.3
  (installed PGlite 0.5.8), 130 synthetic rows, two client roles. Coverage includes
  100/101 ASCII/Hindi/emoji lengths, padded/oversized payloads, page boundaries and
  integer extremes, per-page defaults/clamps, malformed numeric/UUID filters,
  invalid conditions/categories/prices/sorts, empty searches, Hindi/English,
  pagination, all nonactive statuses, expired active listings, suspended sellers,
  location privacy, valid response equality, catalog identity/ACL/security equality,
  drift rejection and representative plan equality.

Reproduce from Backend root without a database URL or hosted credentials:

```sh
node tests/fsw-sec-003/run-disposable.mjs --pglite-module '../FairSwap-Web/node_modules/.pnpm/@electric-sql+pglite@0.5.8/node_modules/@electric-sql/pglite/dist/index.js'
```

The runner uses reduced synthetic table prerequisites and the actual old function,
public wrapper, grants and discovery indexes. It does not reconstruct the full
Supabase schema or simulate PostgREST/Auth. The existing pgTAP/CI registration is
untouched; this standalone suite is not silently registered as a baseline suite.
NOT RUN: native PostgreSQL 17, existing pgTAP/security CI suites, HTTP RPC transport,
full-chain migration replay, Web typecheck/lint/build (no Web edits), hosted tests.
The repository's Linux/Docker-only DB runner is forbidden on this laptop and was
not invoked. Preserve and run existing CI gates during ChatGPT review/release.

Five warmed batches of 50 calls each over the same valid scenarios and fixture:
baseline ms/call `[0.734, 0.700, 0.680, 0.673, 0.663]`; candidate
`[0.673, 0.669, 0.663, 0.655, 0.693]`. Medians: 0.680 vs 0.669 ms.
Both representative EXPLAIN JSON plans (keyword count/fetch) matched exactly;
the runner also compares the complete listing-query/return tail byte-for-byte.
No observed avoidable regression in this small WASM fixture. These timings do not
prove native/hosted latency; bounds limit single-request work, not request rate.

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

After review, ChatGPT's separately authorized release must:

1. Capture each environment's full current ledger independently; compare exact
   version/name sequences to this snapshot. Stop for review on additive history,
   missing versions, name changes, an existing candidate version or function drift.
   Capture full function definitions/owners/ACLs, RLS/grants and API exposed schemas
   for before/after checks; confirm `app_security` remains unexposed.
2. Use authentic CLI `migration fetch` history in separate disposable Test and Prod
   release workspaces, following existing Backend release safeguards. Compare the
   fetched identities exactly to that target's live ledger; copy only this reviewed
   candidate as pending SQL. Never manufacture ledger rows or placeholder historical
   files, repair history, use raw `supabase/migrations`, or reuse Test history for Prod.
   Review SHA-256 of the candidate artifact and a CLI dry-run showing precisely one
   pending migration before any write. The scoped Chat release exception does not
   authorize this release; retain applicable environment/recovery protections.
3. Run the existing mandatory CI/SQL/security gates and native PG17 synthetic
   validation. Apply Backend to FairSwapTest first using supported atomic CLI-managed
   migration/history handling. Verify unchanged prior ledger, single new candidate,
   wrapper/ACL/owner/RLS/catalog invariants and automated synthetic gates.
4. Apply the identical reviewed candidate to FairSwapProd after staging automated
   gates, using independently verified Prod history. Verify the same invariants and
   unchanged prior ledger. No owner predeployment/manual testing gate is added.

Deployment order: Backend staging migration → staging Web only if subsequently
changed → automated gates → Backend production migration → production Web only if
subsequently changed. This patch needs no Web release and no environment variables.

After production deployment, owner inspection: normal search; category/city/price
filtering; pagination; Hindi/English results; error rate and latency. No owner test
is requested before deployment.

Rollback: reviewed forward compensating SQL migration; if Web later changes, revert
its commit or restore its previous Vercel deployment. Never delete migration history.
