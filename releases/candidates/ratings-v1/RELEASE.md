# Ratings V1 release candidate

Local preparation only. No GitHub operations, hosted SQL, migrations, Edge deployment,
activation, browser or manual/exploratory tests. This candidate is not deployed.
Source HEAD `213b57c84e2b3767e3ab3499846dd280bf3315c3`; no synchronization performed.
Ratings made no edits to unrelated paths; `package.json` has only added scoped test scripts.
Six previously inventoried Chat V2/CI files changed concurrently during this session;
`concurrent-unrelated-changes.json` records their initial/current hashes. They are
excluded from the scoped patch and ZIP payload; no restoration/overwrite was attempted.
Its pre-existing root PGlite dependency belongs to the separate local Chat V2 work and
is not promoted by the Ratings scoped diff. Ratings supplies its own exact
`@electric-sql/pglite` 0.5.8 package/lock under `tests/ratings/`; install with
`npm ci --prefix tests/ratings --ignore-scripts --no-audit --no-fund` before running
the test command on a checkout without that dependency. This does not change the
root lock/toolchain or depend on merging Chat V2.

## Separate environment plans

The two JSON manifests list the same environment-compatible additive SQL bytes,
separate project identities, separate inactive infrastructure scripts and independent
ledger prerequisites. Never copy Test's historical migrations or finalizers to Prod.
Neither manifest authorizes execution. Record the current exact ledger before each
release; the documented 61/52 histories are dated 18 October, not live verification.

**Staging / FairSwapTest / `wpppxlnbzqynvhpeuavd`:**

1. Authorized operator reconciles exact isolated Test ledger against the documented
   61-version history plus independently authorized later releases. No raw 58-chain apply.
2. Capture reviewed hashes, backup/restore receipt, exporter definition/ACLs, sold RPC
   definition/ACLs, existing category gates and independent release identity.
3. Run `staging.preflight.sql` in the approved isolated release process. Apply the five
   migrations in `staging.manifest.json` order, retaining flags OFF.
4. Provision `staging.inactive.sql`; both pg_cron jobs remain inactive.
5. Release compatible Web/Admin/HelpCenter consumers (separate tasks). No handle system.
6. Automated CI gates and deployment smoke checks pass. Only then activate the four
   settings as appropriate and the two named schedules under a separately authorized
   activation receipt; no owner manual test or extra staging signoff is required here.

**Production / FairSwapProd / `kriuhwppxgxsyyrbjsau`:**

1. Reconstruct/reconcile the isolated 52-version baseline against
   `releases/production/category-foundation-v1/production-deployment-20261018.json`
   and any independently approved subsequent releases. Run existing
   `scripts/release/verify-production-52-baseline.mjs` on that isolated workspace,
   never on Backend root. Compare current live ledger only under operator permission.
2. Capture separate production backup/restore, owner/operator approval, reviewed hashes,
   release window and unchanged production-restricted staff/exporter ACLs.
3. Run `production.preflight.sql`; apply five migrations in `production.manifest.json`
   order. Keep settings OFF and category guards unchanged.
4. Provision `production.inactive.sql`; do not activate jobs.
5. Release compatible production Web/Admin/HelpCenter consumers.
6. Require automated CI/deployment checks, then separately authorized feature/schedule
   activation and receipt. Test precedes Prod; no manual owner-testing prerequisite.

There are no new credentials, secrets, Vault secrets, Edge functions, external provider
calls or environment variables. `project_url` in the existing Vault is used only by
operator preflight to verify identity; no secret values are printed. A missing/ambiguous
project_url or unavailable pg_cron blocks provisioning, rather than inventing a value.
Migrations do not create extensions or alter any existing job.

## Activation and rollback ownership

Authorized owner/operator alone may update `app_security.ratings_settings` and activate
only `ratings-v1-publication` / `ratings-v1-reminders`. Client, anon, authenticated and
service_role cannot call provisioning, reminders or publisher. `enabled` controls user
APIs and future sold capture; `public_reads` controls public projections; `jobs_enabled`
controls notifications/publication; `staff_enabled` controls new Ratings staff actions.
Existing production Admin restrictions must remain unchanged. Activation SQL is not
included as an executable auto-run artifact.

Rollback: **Disable Ratings flags and scheduled jobs; revert affected consumer
deployment; preserve additive ratings data pending reviewed rollback.**
`rollback-disable.sql` is an owner-run reviewed kill switch, never an automatic migration.
Do not drop tables, reset history, delete reviews or restore an old privacy exporter.
Privacy erasure stays effective while disabled. SQL is forward-only; use reviewed
forward fixes for schema defects.

## Documented ownership blockers

`docs/operations/BACKEND_ONLY_RELEASE_CUTOVER.md` still documents untransferred Backend
hosted deployment authority, remaining Web/external privileged-writer inventory,
independent negative proof of old PAT revocation, protected least-privilege Backend
release identity, exact isolated Test history, isolated Prod baseline verification,
proof Web cannot deploy, and unverified production backup/restore. Two broad existing
worker-trigger EXECUTE grants remain an independent review item. This task does not
resolve or bypass those gates. No hosted state was inspected.

Chat V2 PR #58 is separate: no dependency on its tables, messages, flags, worker,
scheduler or transport; no files in its scope are modified. It may add messaging
contracts independently. Keep Ratings event cursor separate. Optional profile-onboarding
privacy code was inspected and is not a dependency. Apply Ratings after any approved
onboarding exporter wrapper when releasing together. The Ratings exporter captures the
installed base definition and permissions, including restricted environments. Any later
full exporter replacement requires preserving both wrapper features and new tests.

## Automated evidence and limits

Use the packaged `checks.json`/logs for actual final results. No existing CI workflow,
93-test whitelist, no-network digest, typecheck include list, baseline DB assertion
count or security gate is weakened. `ci-snippet.yml.example` is an integration proposal
for ChatGPT, not installed Actions configuration.

Local SQL tests load canonical migrations 1–14 except Storage, remove only Realtime
publication statements, and install the latest sold RPC body from policy migration 21.
The legal-policy provider, Auth identity/JWT and pg_cron are explicit fixtures. The
privacy base used by these fixtures is migration 14's exporter; environment preflight
must verify the actually installed later exporter definition/ACLs. Native PostgreSQL
17.6 checks include independent-session concurrency; PGlite 18 is supplementary.
Actual pg_cron scheduling, Supabase Data API transport, hosted ledgers and all consumer
deployments are NOT RUN. Full Supabase 58-migration/52-production-history regression,
performance/load qualification and hosted release acceptance remain release gates.

The standard manifest verifier fails on this Windows checkout's CRLF representation.
`tests/ratings/verify-baseline.mjs` separately verifies all 58 canonical Git blob hashes
against the immutable manifest and working files under Git's EOL conversion. It does
not rewrite any historical file or replace the existing CI verifier.

After authorized deployment, owner production checks are automated: verify matching
migration receipts, settings/job state, zero error trend, no duplicate event/notification
keys, aggregate consistency and no unauthorized EXECUTE grants. Record automated
results and rollback decision in the environment receipt template. No manual testing.
