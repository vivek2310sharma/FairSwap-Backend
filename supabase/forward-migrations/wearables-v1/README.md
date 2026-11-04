# Wearables V1 (Smartwatches & Wearables) — release candidate

Forward-only package, **default OFF**. Never part of the immutable `supabase/migrations/` set (`corepack pnpm verify:migrations` stays at 58). Nothing here has been applied to any hosted project.

| File | Purpose |
|---|---|
| `supabase/migrations/20261103090000_posting_v2_wearables.sql` | Foundation: release row (`enabled=false`), catalogue tables + seed, session binding, context + risk-flag tables, session core, wearable session/submit/search RPCs, listings guard |
| `activation/supabase/migrations/20261103090100_activate_wearables_v1.sql` | Separate activation (category active + release enabled). Apply only after Web has `POST_AD_WEARABLES_V1_ENABLED` and Test verification passed |
| `rollback/disable_wearables_v1.sql` | Review-only forward fix: disables the feature (always safe) |
| `rollback/restore_accessories_session_baseline.sql` | Review-only: restores the Accessories V1 session function body (only after wearable sessions have expired/been cleaned) |
| `SHA256SUMS` | Checksums of the two migrations; asserted by `scripts/ci/test-wearables-v1.mjs` |

## Dependency sequence (all must be INSTALLED; none need be ENABLED)
1. `20261025131116_posting_v2_mobiles.sql`
2. `20261025135152_activate_posting_v2_mobiles.sql` (phone enablement is irrelevant; tested ON and OFF)
3. `20261101234604_posting_v212_session_recovery.sql` (origin/main #85)
4. `20261102164135_accessories_v1.sql` (origin/main #92) — its `impl_posting_v2_session` body is the exact baseline moved into the session core.

Tablets V1 (`20261102165946_posting_v2_tablets.sql`, `20261102170611_activate_tablets_v1.sql`, origin/main) is **not** a dependency but is a verified coexistence target: it wraps `posting_v2_session`/`impl_submit_mobile_v2` and never redefines `impl_posting_v2_session`, so the baseline guard below holds with Tablets installed before or after Wearables (both orders are tested). The foundation aborts (no changes) with `WEARABLES_PREREQUISITE_MISSING`, `WEARABLES_BASELINE_DRIFT`, `WEARABLES_ALREADY_INSTALLED` or `WEARABLES_CATEGORY_CONFLICT` when its preconditions fail; treat any of these as BLOCKED, never work around them.

## Security model
* `wearable_session_bindings_v1` (no client grants) is the authority that ties an upload session to the wearables category. The session core `app_security.impl_posting_session_core_v1` takes the category selector as a parameter, has **no grants to any client role**, and is called only by two definer functions that hard-code their own selector (NULL for phone/accessory; the release-table category for wearables). No transaction setting or marker is used for authorization.
* `zz_wearable_listing_guard_v1` (listings trigger) requires a bound, owned session for a wearables listing, blocks a wearable session from becoming another category, runs the India payment/contact content guard, and **blocks activation of any flagged listing unless the caller is an active moderator** (`listing_wearable_risk_flags_v1`: `other_model`, `other_brand`, `still_paired`, `unknown_pairing`).
* `locked` devices and ownership/stolen declarations are rejected in `validate_wearable_v1`; `still_paired` and `unknown` stay distinct and are never `transfer_ready`.
* Quarantined/excluded catalogue rows cannot be reached through "Other model/brand" (matched on `name_key`/`base_key`).

## Tests (local only; do not replace hosted verification)
```sh
node scripts/ci/test-wearables-v1.mjs [--pglite-module=<path>] [--web=<FairSwap-Web path>]   # 33 checks, PGlite
corepack pnpm verify:migrations && corepack pnpm typecheck
```
```sh
bash tests/wearables-v1/run-native.sh /abs/path/to/pg17/bin [--web=/abs/path/to/FairSwap-Web]   # 16 checks (12 wearable + 4 Tablet/Wearable coexistence) on a private PG17 cluster, independent psql backends
```
Native checks cover concurrent session creation, ownership, cross-category isolation, duplicate submission, locking and moderation-bypass attempts. Tablet + Wearables coexistence (installed together; shared sessions, bindings, ownership, capacity, concurrent submissions): `node scripts/ci/test-wearables-tablets-v1.mjs --pglite-module=… --web=…` (30 checks, both install orders) and native checks 13-16. Not covered: hosted RLS/E2E.

## CI wiring (owner: ChatGPT; not done here)
* `backend-ci.yml`: add `node scripts/ci/test-wearables-v1.mjs --pglite-module=tests/ratings/node_modules/@electric-sql/pglite/dist/index.js` beside the Accessories runner; add `bash tests/wearables-v1/run-native.sh "$GITHUB_WORKSPACE/artifacts/ratings/pg17-source/install/bin"` in the native job beside the posting-v212 runs.
* Web CI pins Backend `b3d7eae6…` and materializes only the 58 immutable migrations, so it never sees this package; no pin change is needed for the Web unit tests.

## Rollback
Disable Web flag → run `rollback/disable_wearables_v1.sql` (forward, reviewed) → retain tables, sessions, contexts and listings. Anything else is a reviewed forward-fix migration.
