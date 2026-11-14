# Listing validity: 365 days

Local candidate, 11 November 2026. No hosted writes or GitHub actions performed.

Plan: patch only the publication interval in the installed manual/Azure approval
functions, preserve each target's body and privileges, extend eligible live
listings, then deliver consumer wording. Renewals continue through moderation and
retain the three-renewal limit. Historical migrations remain immutable.

Apply only this directory through the existing isolated, CLI-ledger-managed
release process: FairSwapTest `wpppxlnbzqynvhpeuavd`, automated verification, then
FairSwapProd `kriuhwppxgxsyyrbjsau` automatically. Capture each target's current
ledger independently. Do not apply the historical migration directory or copy
Test-only functions to Production. Preserve all existing CI/environment gates.
No new configuration, secrets or workflows are required by the SQL/client change.
Existing scoped Chat release tooling is not a general listing-release mechanism;
ChatGPT must resolve the applicable release runner before deployment.

The migration rejects unreviewed function drift. Read-only hosted definitions are
captured in `tests/listing-validity-365/hosted-functions.json`; fixtures contain
code only. Guard hashes normalize CRLF, because Test's manual function uses LF
while Production uses CRLF. Current Azure bodies match after inspection.

Backfill: only previously published active/reserved/paused listings with a finite
future expiry, active seller, current policy acceptance, active category and no
sold timestamp. Only shorter expiries change. Null expiry remains unlimited.
Expired/rejected/removed/sold listings and pending renewals are excluded.
Glass Jars is explicitly excluded and checked unchanged, including microseconds;
hosted read observed `2027-11-11 18:49:01.486986+00`.

Verification: run `node scripts/ci/test-listing-validity-365.mjs` using the existing
Web PGlite dependency, or pass `--pglite-module=<existing pinned module path>`.
Executed locally: 24/24 checks passed, including approval, renewal, authorization,
expiry boundaries, eligibility exclusions and atomic rollback on later drift.
This is an isolated PostgreSQL runtime test with synthetic auth/account/Vault and
supporting tables, not full hosted Supabase acceptance. Integrate the command
into the existing Backend database job when ChatGPT prepares GitHub changes.
Run each client's existing checks; automated hosted postflight must compare
function/grant/RLS snapshots, eligible expiry deltas, excluded-row immutability,
and Glass Jars expiry exactly. Never generate real notification traffic for tests.

Order: Backend Test → client staging/preview and native staging checks → automated
acceptance → selective Backend/clients Production delivery. HelpCenter staging
mapping and native production release channels remain unresolved in local docs.
Owner Production checks are automated receipt review and monitoring, not a
predeployment manual test gate.

Rollback: stop promotion on any failed check. Transaction failure changes nothing.
After success, forward-fix function bodies or restore reviewed previous bodies
through a new migration; do not shorten granted listing validity, undo the
backfill, delete ledger entries or revive expired listings. Revert consumer copy
only in coordination with the resulting backend policy.
