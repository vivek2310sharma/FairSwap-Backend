# FairSwap Production category foundation: isolated PG17 rehearsal

**Status: candidate CI only. Never interpret this file or an opened pull request as
approval to run SQL against FairSwapProd.** Live schema migrations, category
activation, deployments, changes to existing Goods moderation, and billable
Supabase environments require separate explicit owner approvals.

## Scope

Rehearse a *schema-only* reconstruction of the observed FairSwapProd PostgreSQL
17.6 ledger: the 45 immutable migrations listed in
`releases/production/category-foundation-v1/manifest.json`, then seven pinned
historical source SQL files copied byte-for-byte into **new, forward-numbered
migration files allocated by `supabase migration new` in the CI sandbox**.
This avoids modifying historical sources or falsely applying their older version
numbers after the Production ledger tip (`20261013235311`).

This does not deploy those generated filenames. The runner additionally emits
an allowlisted `forward-proposal.json` with exactly seven CLI-allocated
forward migration filenames, source paths and SHA-256 hashes, only when the
45→52 rehearsal, postflight, regression and cleanup all pass. The artifact is
checksum-verified and contains no raw SQL or private data. We can then pin
those names in a reviewed release manifest, switch CI to enforce them, and
re-run the same full acceptance. No filename proposal is a deployment approval.

The CI workflow accepts pull requests only from the exact dedicated rehearsal
branch into `main`; it checks out the source without persistent GitHub token
credentials and does not receive any Supabase secrets or hosted database
connection. The runner creates a fresh local Supabase PG17 database on a unique
loopback-bound Docker bridge. Before bootstrap, it installs four exact per-task
IPv4/IPv6 firewall rules in the native runner to block database-container
egress and new connections to host services. A strict task-only Docker create
adapter injects `-c cron.launch_active_jobs=off` into the **owned PG17 process
startup**; an unrecognized CLI/bootstrap shape fails closed. It checks the
Supabase CLI's Docker labels, pinned image ID and one-time startup receipt, and
verifies `pg_settings.source='command line'` before introducing FairSwap SQL.
After bootstrap it verifies namespace identity and removes IPv4/IPv6 default
routes **before any FairSwap SQL is introduced**. The runner requires PostgreSQL
17.6. Crucially, **the local Supabase migration directory remains empty
throughout database bootstrap**. Before copying any FairSwap SQL, the runner
checks that `public.categories`, `public.listings` and the Goods moderation
table do not exist, and that the migration ledger is absent or empty. It then
writes a task-scoped isolation receipt, copies and checksum-verifies exactly
45 baseline migrations, and explicitly replays 45 followed by seven. The
runner requires `cron.launch_active_jobs=off` with command-line provenance
from PostgreSQL startup. Before the 45-file replay, both `cron.job` and
`cron.job_run_details` must be **absent**, proving no FairSwap pg_cron
migration was prematurely applied. After the baseline, both tables must
exist; any schedules installed by reviewed migration SQL remain inert and
the execution-history table must be empty after baseline, after candidates,
and after Goods regression tests. No cron schedules are deleted or run.
Cleanup removes only task-owned objects and reverses precisely those four
firewall rules.

The runner pulls the **official Supabase PostgreSQL 17.6.1.167 OCI index** by
its pinned digest `sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb`
from `ghcr.io/supabase/postgres`. Supabase publishes the same tag and
digest through GHCR and its public ECR repository; the source switch avoids
an intermittent registry throttle without changing the approved image bytes.

Bootstrap image sources are also checksum-pinned: Supabase Auth v2.196.0, Storage v1.72.1 and Realtime v2.130.0 are fetched by their reviewed OCI digest from the official Supabase Docker Hub repository and retagged only to the CLI's matching ECR names. Image acquisition uses bounded rate-limit-only retries; any unresolved registry failure is a blocked rehearsal, not a reason to loosen database isolation.

After migration, the runner applies the checked-in read-only category
postflight, checks unchanged Goods finalizer hash, enabled category guards,
private context RLS and anonymous grants, and runs the nine Goods-oriented
pgTAP suites. Expected total: 268 assertions in the hidden Production release (the historical Test baseline has 270 when its two enabled-family-only checks run). It retains no synthetic listing
data and only uploads a minimal sanitized result, plus checksum.

## What constitutes a PASS

- Exact source hashes: 45 baseline migrations and seven candidate SQL sources.
- Verified isolated PostgreSQL **17.6** (server version 170006), without any
  Production/Test database connection or Vault credentials.
- Exact local migration ledgers of **45**, then **52**, with seven *forward*
  versions; no Test submission/activation/finalizer SQL.
- 52-migration read-only postflight PASS: inactive new categories, disabled new
  contract assignments, three guard triggers, context RLS/ACL protections,
  zero experimental Active listings and unchanged Goods moderation finalizer.
- Nine regression suites, 268 assertions for inactive experimental families, zero failures.
- Container, volume and network removal verified; sanitized `success=true`.

If the image registry rate-limits the runner, Docker cannot prove firewall and network-namespace
isolation, the CLI cannot bootstrap PostgreSQL 17.6, the source
reproduction drifts, or any SQL/test check fails, **the outcome is BLOCKED/FAIL,
not a rehearsal pass**. Previous Stage 3 evidence was blocked at a registry
rate-limit before PostgreSQL started and is not being reused here.

## Non-goals / explicit limits

- No actual FairSwapProd data or storage objects are copied into the CI sandbox;
  successful schema replay is not a point-in-time restore rehearsal.
- No public experimental listing publication, submission canaries, activation
  flags, or finalizer correction are authorized.
- No source-ownership transfer from Web to Backend.
- **Owner deferred backup and recovery work**. Backup restoration remains
  `NOT VERIFIED`; this CI cannot satisfy or waive it.
- The pre-existing Production advisory review (including public
  SECURITY DEFINER grants and leaked password protection) is separately
  tracked; a green migration test is not blanket security-advisor approval.

## Release gates

Keep the release manifest's four gates **false**. This workflow neither
modifies those flags nor changes Production. Require owner review of a passing
artifact and of any new remediation migration before further action.
