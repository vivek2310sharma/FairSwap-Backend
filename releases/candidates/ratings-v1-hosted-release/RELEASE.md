# Ratings V1 hosted release readiness

Prepared locally on 26 October 2026; **BLOCKED / NOT DEPLOYED**.
Exact starting HEAD: `213b57c84e2b3767e3ab3499846dd280bf3315c3`, branch `main`.
No fetch/pull or synchronization. This is an observed checkout SHA, not verified PR #59
HEAD. Read-only GitHub metadata now confirms PR #59 is draft/open at
`2c34f1135ae0ff59f4f8810b883980325ac96c84` with successful Backend CI run
`40340690551`. Source-to-PR byte verification remains NOT RUN; this task does not change GitHub.
Existing dirty/untracked work is recorded and byte-checked in `starting-state.json`.

This candidate supersedes the 61/52-baseline instructions in `ratings-v1/` and
`ratings-v1-contract-fix/` for a fresh hosted install. It consolidates their six
immutable files in `migration-order.json`; every copy must match the prior reviewed
SHA-256. No new migration, SQL contract change, environment variable, consumer edit,
CI edit, phone OTP, 90-day restriction, historical backfill or activation is included.

## Authoritative history reconciliation

| Environment | Project | Live ledger count | Latest | Expected after six |
|---|---|---:|---|---:|
| FairSwapTest | wpppxlnbzqynvhpeuavd | 87 | 20261025195824 | 93 |
| FairSwapProd | kriuhwppxgxsyyrbjsau | 71 | 20261025201712 | 77 |

The separate `hosted-evidence.json` files contain actual read-only MCP ledger results,
capture times and installed nonsecret function definitions/ACLs. No Ratings version
is in either ledger. `ledger_statements_json_sha256` is PostgreSQL SHA-256 over
UTF-8 `to_jsonb(statements)::text`. It fingerprints stored ledger statement arrays;
it is **not** a source SQL-file SHA-256. Never substitute it for file provenance.
Production `20261023160752` (`hdr03_production_unread_counts`) has NULL statements:
its hash is unavailable and explicitly BLOCKED, never manufactured from Test.
Test has statement fingerprints for 87/87; Production has 70/71. Both still lack a
complete reviewed mapping of current hosted history to original source bytes and
operator receipts. Recover that mapping from authoritative release records; do not
guess from filenames, copy Test-only SQL, invent timestamps, normalize immutable bytes,
or use migration repair to make histories appear aligned.

The environment `supabase/migrations/` copies contain ONLY six future payloads for
review. They are **not complete CLI deployment workspaces**. Do not run db push from
these folders, the raw 58-file chain, or the old 61/52 candidate. After history blockers
close, the protected operator must build separately reviewed full isolated workspaces
with exact installed histories and these six pending files. An approved, pinned CLI
dry-run must show exactly these six versions, in order, with no history repair,
backfill, Test-only promotion or unrelated SQL. The historical Production-52 verifier
can check only that historical prefix; it cannot certify today's 71-version baseline.
Any new ledger/function drift requires refreshing evidence, review and package hashes.

## Compatibility and permission preservation

Both live histories show seven Oct25 onboarding files and two mobile posting files.
Onboarding Test versions are `20261025132538` through `20261025132626`; Production
versions are `20261025134027` through `20261025134105` (see exact ledger rows).
There is no invented `...00007` onboarding migration. Mobile foundation/activation:
Test `20261025195136`, `20261025195824`; Production `20261025200401`, `20261025201712`.
The source IDs embedded in recorded migration names identify the corresponding
canonical Oct25 sources; they do not prove raw file-byte equality.

Onboarding already wraps `impl_fulfill_data_export_base` and adds `private_details`.
Ratings renames only the installed outer implementation to `ratings_export_base`,
adds `ratings`, calls the installed base first, and revokes client access to the
renamed base. Preserve the original onboarding base and Admin public wrapper.
The two independently captured installed outer-export ACLs currently both allow
authenticated/service_role and deny anon; both public Admin wrappers currently allow
authenticated/service_role. The base enforces owner OR active administrator AAL2.
Equality observed today does not authorize copying one environment's permissions.

`protected-functions.json` captures 37 pre-existing functions per environment:
body hashes, exact ACLs, security modes, search paths and effective EXECUTE checks.
Pre/postflight pin each environment separately. Preserve exact sold-transition body,
staff AAL2 helper and Admin/privacy permissions, including existing differences or
restrictions elsewhere. Public defaults are not tightened or broadened in this release.
The existing broad worker-trigger grants remain an unresolved security review item.

The new disposable PG17 regressions apply real onboarding private-details/privacy
sources, the complete mobile foundation, the six Ratings files and captured
environment-specific sold/staff/Admin exporter definitions. They exercise export
authorization/audit/wrapper chaining, existing mobile guard, permission preservation,
flags OFF, inactive scheduler retries, unrelated cron preservation and erasure.
Auth/JWT, policy provider, pg_cron, Storage buckets and postal prerequisites are explicit
fixtures. Full 87/71 reconstruction, real cron scheduling, Storage, hosted Data API,
mobile activation source execution and performance/load qualification remain NOT RUN
or BLOCKED. No full-chain or cross-client hosted compatibility claim follows.

## Required evidence before any apply

All blockers are enumerated in `BLOCKERS.md`; neither preflight SQL nor CI success
grants authority. An owner-approved protected release must first close them for the
specific project and window. Required backup proof is separate for EACH environment,
current for that window, and includes demonstrated isolated restore of that backup.
Keep backup contents and credentials outside this package. Gate receipts are references,
hashes, timestamps, principal IDs, reviewer IDs and pass/fail only.

Under future explicit operator authorization, verify package hashes offline, then run
the environment's preflight with psql `-X -v ON_ERROR_STOP=1` against its independently
verified protected connection. Use secure connection injection; no token/URL literals
in commands or logs. The SQL is a read-only transaction with project/PG17/full-ledger
and function guards; it prints no Vault values. Production deliberately refuses the
missing historical statement evidence. Reconcile the dry-run with the reviewed full
workspace; stop on mismatch. Keep source hashes and actual CLI-issued ledger names in
the receipt; a mismatch requires review, never an assumed name/version translation.

## Exact deployment sequence (all steps NOT EXECUTED)

1. Authorized **Backend migrations to FairSwapTest**: close Test authority/history/
   backup gates, run fresh Test preflight, verify six hashes and six-only dry-run,
   apply the original six sequentially in the documented order. Record each committed
   version/name, applied time, operator approval and stored-statement fingerprint.
2. Run **Test `inactive.sql`** only after all six commit. This provisions only
   `ratings-v1-publication` (`*/5 * * * *`) and `ratings-v1-reminders` (`17 * * * *`),
   deactivated in the same transaction. Run Test postflight; flags remain OFF.
3. Release **Web staging + Admin staging, flags OFF**, using separately authorized
   focused consumer changes and existing automated CI/deployment checks. Consumer
   target/build/flag mappings are unresolved; do not invent an Admin staging branch.
4. Run **independent Production preflight** after fresh Production authority/history/
   backup proof and dry-run. Do not reuse Test baseline, ACLs, connection or receipts.
5. Authorized **Backend migrations to FairSwapProd**, the exact six reviewed payloads,
   with independent migration receipts. No Test-only history or finalizer promotion.
6. Run **Production `inactive.sql`**, then Production postflight. Expected ledger count
   77 only if the baseline remains 71; verify the entire ledger, never count alone.
7. Release **focused Web production + Admin production**, compatible strict DTOs,
   all Ratings consumer/backend flags OFF, existing automated availability checks.
8. **Separate feature activation after safety gates**, with new explicit approval:
   compatible Web/Admin builds, automated negative authorization/privacy checks,
   aggregate/idempotency/backlog and load qualification, owner review of telemetry,
   protected authority, current recovery evidence and recorded rollback decision.
   This package contains no activation script. Do not enable jobs/flags as deployment
   smoke tests. No owner manual testing or extra owner staging signoff is imposed.

Consumer acceptance must cover conversation lookup, safe listing/name DTOs, expired
Given-history entries without counterpart submission disclosure, NULL versus true
zero scores, separate event cursors, metadata-only staff queues, reason-required
audited evidence and AAL2 restrictions. Native apps retain existing contracts;
no native deployment is required by this Backend package. HelpCenter is unchanged.
Chat V2 PR #58 and its scheduler are independent and must not enter this release.

## Production owner checks and rollback

The production owner records automated outputs after each step: exact ledger delta,
six source hashes plus application receipts, all flags OFF, exactly two inactive
Ratings jobs with correct commands/cadence, no modification of unrelated jobs,
unchanged protected functions/ACLs, onboarding export/erasure, mobile posting and
existing category gates, service availability/error trend versus pre-window baseline.
Use existing synthetic accounts only through approved automated checks; do not place
customer rows, export bodies or secrets in receipts. Record consumer build IDs and
roll back on contract/ACL drift, unexpected ledger entries, activation, availability
regression, duplicate events/receipts, aggregate inconsistencies or privacy leakage.
Thresholds and monitoring window must be approved in the release receipt before apply.

One-line rollback: **Disable Ratings flags and only its two jobs using the matching
environment rollback-disable.sql; revert affected Web/Admin builds; preserve additive
data and privacy erasure; use a reviewed forward fix.**

Each environment has its own `recovery.md` and receipt template. No table drops,
historical rollback, privacy-exporter reset, automatic restore or migration repair.

Supabase Cron API semantics checked against the official
[Cron quickstart](https://supabase.com/docs/guides/cron/quickstart).
Changelog index fetch was unavailable (unsupported markdown content type); no
Supabase API/client/version behavior was changed by this package.
