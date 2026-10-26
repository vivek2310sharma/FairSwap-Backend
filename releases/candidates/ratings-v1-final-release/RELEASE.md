# Ratings V1 final release preparation

27 October 2026. LOCAL SOURCE / BLOCKED NON-BACKUP GATES / NOT DEPLOYED.
Reviewed PR #59 head: `5d3378a9d35c734193bbfcf421864d3b91865947`.
Observed local starting HEAD: `213b57c84e2b3767e3ab3499846dd280bf3315c3`.
No Git fetch/pull or synchronization. This candidate supersedes the earlier
ratings-v1-hosted-release instructions for this release. Earlier artifacts remain historical.

## Owner backup waiver

Both environment release records and receipt templates record **WAIVED_BY_OWNER**
for backup/restore verification, solely for Ratings V1 under the explicit owner
instruction dated 27 October 2026. No backup is verified to exist and no isolated
restore test passed. Owner accepts irreversible data loss, downtime and limited
recovery options. **There is no guaranteed point-in-time recovery.** Backup/restore
is not a hard blocker for this release. This grants no deploy authority and changes
no migration, security, authorization, CI, integrity or source-provenance gate.

## Exact baselines and immutable payload

Fresh read-only ledgers still exactly match the prior full version/name/statement
fingerprints: FairSwapTest wpppxlnbzqynvhpeuavd = **87**, latest 20261025195824;
FairSwapProd kriuhwppxgxsyyrbjsau = **71**, latest 20261025201712. Neither has Ratings.
All 37 protected function body/ACL/security/search-path fingerprints per environment
still match. See each environment's fresh-ledger.json and fresh-readonly-checks.json.

The six original Ratings files match raw source fetched at the exact reviewed PR
head; both isolated payloads match migration-order.json. No historical or Ratings
migration was edited. Existing RLS, privacy/export chains, staff AAL2 permissions,
feature flags and unrelated jobs remain unchanged. No phone OTP, 90-day restriction,
historical ratings backfill or new environment variable is introduced.

The six-file folders are review payloads, not complete CLI workspaces. Full reviewed
historical source mappings and isolated environment workspaces remain BLOCKED;
never db push these folders, the raw 58-file directory or a Test history to Production.
Source-file SHA-256 and stored-statement JSON SHA-256 are different representations.
Only reviewed historical bytes/receipts may complete the mapping; never invent hashes.

## HDR-03 historical exception

PR #49 merged reviewed Production SQL at 24ed66196d8402fbfc0aa80f4f47abd943a61447.
Its deployment receipt (comment 6371622862) records an authorized atomic installation
and exact version 20261023160752_hdr03_production_unread_counts. Source LF SHA-256 is
818da324fdf625a25732bf8f70a297450e654aa4cb91fe5a34316777490f0a3f.
See hdr03/receipt.json, reviewed-source.json and verify-source.mjs.

Disposable PG17 execution of that reviewed, unmodified SQL reproduces the installed
RPC definitions/ACLs, signal table columns/constraints/indexes/RLS/ACLs, owner policy,
triggers and publication metadata exactly. Public-schema Supabase default service-role
grants are explicit fixture assumptions; private helper EXECUTE remains owner-only.
Definition fingerprints normalize CRLF to LF only; original SQL/ledger bytes are unchanged.
Source-table publication membership/filter and source RLS are checked; unrelated
source-table columns are outside HDR ownership and are not fingerprinted as HDR DDL.

Only Production's exact version/name with NULL statements is excepted. No other NULL
row is allowed. Complete 71-row comparison still pins every other version/name/hash.
production/hdr03-exception.sql and Production pre/postflight require exact reviewed
contract JSON equality and project identity; any object, ACL, policy, trigger,
publication, overload or row drift fails closed. This is an evidence substitution
for one absent historical statement array, not proof of raw executed byte equality,
a general NULL exception, a ledger repair or authority to deploy. The NULL remains NULL.
Positive and negative PG17 regressions exercise this exact generated guard.

## Current identity and authority blockers

Both full hosted preflight attempts returned RATINGS_ENVIRONMENT_MISMATCH at the
existing Vault project_url guard. Its absence/mismatch is not bypassed, inferred
from the connector project argument or corrected through hosted writes. A protected
operator must resolve identity evidence through a separately reviewed method and
rerun the unchanged full preflight. Independent fresh ledger and protected-function
comparisons passed; full preflight has NOT passed. No Vault values are included.

Exclusive Backend operator authority, project-specific permissions, revocation of
all legacy overlapping Web/manual/external deploy paths and exact historical-source
workspaces remain unproven. Metadata and independent negative/audit evidence must
close these gates, without exposing tokens or revoking necessary Web runtime keys.
See BLOCKERS.md. No prior one-off release or read-scoped token proves exclusivity.

## Mandatory CI integration

The local backend-ci.yml adds ratings-hosted-readiness-pg17 and requires its success
in backend-ci-success, retaining pre-existing local jobs. The job builds the existing
checksum-pinned PostgreSQL 17.6 source, runs both environment suites and all HDR-03
negative checks without hosted credentials, and fails on a missing/skipped/failing job.
No path/conditional bypass or continue-on-error is added.

Local CI contains unrelated Chat work; do not overwrite the reviewed PR workflow
with that full local file. The handoff scoped.diff applies the workflow change to
ci-reviewed-head.before.yml (exact reviewed PR workflow) and produces
ci-reviewed-head.after.yml, preserving all original unit/PGlite and ratings-native-pg17
steps/gates. CI contract regressions prove removal of only the new gate restores the
reviewed workflow exactly. ChatGPT owns integration/commit/push and GitHub administration.
Remote CI run 40391229761 passed on the reviewed head. The new job is NOT PUSHED/NOT RUN
on GitHub; Linux source-build execution is NOT RUN locally on Windows. Its actual
remote success and aggregate enforcement remain required, not assumed from local tests.

## Authorized release sequence — no steps executed

1. FairSwapTest: close non-backup authority/identity/provenance gates; bind protected
   operator to Test; fresh full preflight and reviewed six-only dry-run; apply the six
   Backend files in manifest order with per-migration receipts. Expected ledger 93.
2. Test: run its inactive.sql only after all six, then automated postflight. Both
   Ratings schedules inactive; enabled/public_reads/jobs_enabled/staff_enabled all OFF.
3. Web staging and Admin staging: focused compatible builds, consumer flags OFF,
   automated CI/deployment results. Unknown target/flag mappings remain unresolved.
4. Independent FairSwapProd preflight and project-specific authorization, complete
   71-history workspace, historical exception and six-only dry-run. Reuse no Test proof.
5. FairSwapProd: six Backend files in manifest order, independent receipts; no Test-only
   migration/finalizer copied. Expected ledger 77 if the entire baseline is unchanged.
6. Production: inactive schedules and automated postflight, all Ratings flags OFF.
7. Web production and Admin production: focused compatible builds, flags OFF.
8. Separate controlled activation only after compatibility, security, privacy,
   concurrency/load, aggregate/idempotency/backlog and automated availability gates.
   No activation script or permission is included here.

No manual/exploratory testing or extra owner staging acceptance step is required.
Every apply receipt binds project, operator/reviewer, release window, source SHA,
exact file hashes, ledger before/after, dry-run, postflight and inactive schedules.
Secure credential injection is required; never log tokens, connection URLs or user rows.
Use psql -X -v ON_ERROR_STOP=1 --file for future authorized pre/postflight via the
protected connection; preserve both independently verified target bindings.

Production owner checks use automated evidence after deployment: exact six-version
ledger delta, unchanged protected sold/staff/export/mobile contracts, no category-gate
changes, all flags OFF, correct inactive job commands/cadence, unrelated jobs unchanged,
consumer build IDs, availability/error trends and explicit rollback decision. Approve
monitoring thresholds/window before apply. DTO/permission/privacy, duplicate event,
aggregate or availability regressions stop the release; use synthetic automated fixtures,
not customer exports or manual browser tests.

Rollback: disable Ratings flags and schedules, revert affected Web/Admin deployments,
preserve existing database records and privacy erasure, and use reviewed forward fixes.
There is no guaranteed point-in-time recovery under the waiver. No DROP, historical
undo, exporter reset, history repair or automatic restore. Each recovery.md addresses
partial application and lost acknowledgements without replaying committed files.
