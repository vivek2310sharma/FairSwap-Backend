# Ratings V1 consumer-contract delta

Prepared locally; NOT DEPLOYED. Observed local base `213b57c84e2b3767e3ab3499846dd280bf3315c3`
on `main`; no fetch/pull. PR #59 / `d5cc399d2b8e0ae3f3fcc91c800bcc2be4d7af19`
is the user-reported integration prerequisite, not this checkout's HEAD. No Chat V2
PR #58 dependency. No GitHub/workflow edits or hosted operations were performed.

One new CLI-generated forward migration: `20261026094908_ratings_consumer_contract.sql`.
Initial five Ratings migrations and the immutable historical baseline are preserved.
New RPCs: `ratings_trade_for_conversation`, `ratings_given_history`, `admin_ratings_cases`.
Review DTO adds safe context and current public names. Strict DTO consumers must update
before activation. Existing `ratings_given` stays review-only; Web's private Given screen
must use the new typed history RPC to include expired missing submissions.

No new environment variables, credentials, jobs, extensions or flag activation.
All four Ratings flags remain OFF. No historical rating backfill, 90-day restriction,
phone login or OTP requirement. No score/aggregate write is introduced by this delta.

## Staging order

Target: FairSwapTest / `wpppxlnbzqynvhpeuavd`. Standing deployment branch mapping remains
unresolved; this is an operator plan, not permission or a new workflow.

1. Authorized Backend operator reconciles exact isolated Test ledger with the documented
   61-version historical baseline plus subsequent independently authorized migrations.
   Preserve Test-only historical differences. Capture backup/restore receipt, approved
   release identity, exporter/sold/staff definitions and ACLs. Never push the raw chain.
2. If initial Ratings is absent, apply its original staging preflight and five reviewed
   migrations using the original `ratings-v1/staging.manifest.json`. If present, verify
   its exact ledger versions and bytes; do not replay it. Keep flags OFF/jobs inactive.
3. Verify hashes in this candidate's `staging.manifest.json`, then run its read-only
   `staging.preflight.sql`: exact project identity, PG17, initial RPC prerequisites,
   all flags OFF, inactive Ratings schedules, delta absent. Capture definitions/ACLs.
4. Apply only this manifest's `applyOrder` migration. For a fresh install, original
   `ratings-v1/staging.inactive.sql` follows all six migrations; no new infrastructure
   is otherwise needed. Record exact resulting ledger and flags/jobs in the receipt.
5. Release compatible Web/Admin contracts separately, run automated CI/deployment checks,
   retain flags OFF. Activation remains a separate authorized release. No owner manual
   testing or additional owner staging signoff is imposed by this task.

## Production order

Target: FairSwapProd / `kriuhwppxgxsyyrbjsau`, after staging's automated release evidence.

1. Separately reconcile its isolated 52-version Production baseline and approved later
   versions with the current authorized ledger. Use the existing production baseline
   verifier on the isolated workspace, preserve category guards and restricted staff
   grants. Capture a separate production backup/restore receipt and release window.
2. Verify initial Ratings installed or install its original five migrations through the
   original production-specific plan/preflight. Never import Test historical finalizers
   or Test-only versions. Initial PR CI success does not prove hosted installation.
3. Verify `production.manifest.json`, run this candidate's `production.preflight.sql`,
   capture separate definitions/ACLs, apply only `applyOrder` in its isolated workspace.
4. On fresh install only, provision original production inactive infrastructure after
   all six migrations. Keep all four flags OFF and both Ratings schedules inactive.
5. Release compatible production consumers and record automated checks/receipt. Preserve
   existing release restrictions; activation is outside this task. Do not hold production
   for owner staging approval or ask the owner to manually test before deployment.

Existing Backend release ownership, privileged-writer inventory, restricted release
identity, backup/restore and current ledger gates in
`docs/operations/BACKEND_ONLY_RELEASE_CUTOVER.md` remain unresolved by this source task.
Preflights inspect existing Vault `project_url` solely for identity and do not print it.

Rollback: **Disable Ratings flags and only its two schedules using the original
`ratings-v1/rollback-disable.sql`; revert affected consumers; preserve data/privacy
erasure and apply reviewed forward fixes.** No DROP, destructive undo or exporter reset.

## Production review checklist (automated receipts, after deployment)

- Listing-linked Received/Given cards resolve safe titles, roles and identities;
  removed/deleted listings display `Listing removed` without private title/media data.
- Chat lookup works for participants across pending, confirmed, rated, disputed and
  expired states; existing conversation with no matching trade returns null; outsiders
  cannot enumerate trades. Chat V2 transport/events/cursors remain independent.
- Private Given history shows expired Not rated entries, 20 per page with stable tuple
  cursors, and never exposes counterpart sealed review content or submission existence.
- Both staff queues require active moderator/administrator, AAL2 and `staff_enabled`;
  conflicted cases are excluded; detailed evidence still requires a reason and audit.
- Fresh/no-review users have null score and zero counted reviews/completed trades;
  read projections neither backfill nor inflate reputation.
- Confirm reviewed migration receipts, all flags OFF, schedules inactive, unchanged
  staff/export ACLs and category gates, automated availability/error trend, and record
  rollback decision. No browser/manual/exploratory testing is requested.

## Native CI integration

`ci-pg17.yml.example` is an unapplied job proposal. ChatGPT integrates it into the real
workflow AND requires success in `backend-ci-success`, preserving all existing checks.
Node/action pins and the PostgreSQL 17.6 source archive SHA-256 are explicit. The runner
builds a private native server/client, creates a unique loopback-only cluster, runs
the existing independent-session suite plus consumer regressions, stops it and removes
only its own data directory. It does not use a DB URL, service container or hosted API.
Source checksum authority:
[PostgreSQL 17.6 official checksum](https://ftp.postgresql.org/pub/source/v17.6/postgresql-17.6.tar.bz2.sha256).

Linux source-build/job execution is NOT RUN in this Windows workspace. Local native
results use the existing embedded PG17.6 server and installed psql17.11 client. Auth,
policy provider and pg_cron are fixtures; Supabase Data API, actual cron extension,
full environment migration chains, load tests and hosted acceptance remain NOT RUN.
