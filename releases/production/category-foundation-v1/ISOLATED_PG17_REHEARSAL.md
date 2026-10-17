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

This does not deploy those generated filenames. Before an actual release, pin
reviewed forward migration filenames and checksums in a separate authorized
Production release change, review dependency ordering, and re-run full acceptance.

The CI workflow accepts pull requests only from the exact dedicated rehearsal
branch into `main`; it checks out the source without persistent GitHub token
credentials and does not receive any Supabase secrets or hosted database
connection. The runner creates a fresh local Supabase PG17 database on an
internal-only Docker network, verifies no IPv4/IPv6 default routes in its
namespace, disables cron launches before introducing FairSwap schema, verifies
the real PostgreSQL version, and then replays 45 followed by seven.

After migration, the runner applies the checked-in read-only category
postflight, checks unchanged Goods finalizer hash, enabled category guards,
private context RLS and anonymous grants, and runs the nine Goods-oriented
pgTAP suites. Expected total: 270 assertions. It retains no synthetic listing
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
- Nine regression suites, 270 assertions, zero failures.
- Container, volume and network removal verified; sanitized `success=true`.

If the image registry rate-limits the runner, Docker cannot prove internal
network isolation, the CLI cannot bootstrap PostgreSQL 17.6, the source
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
