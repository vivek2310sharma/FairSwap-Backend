> Integration correction — 3 November 2026: this unapplied tablet candidate now preserves the installed phone implementation OID, copied delegate owner/body and unchanged public wrapper. Source drift aborts transactionally. Accessories foundation must precede tablet foundation and refuses the reverse order. Run the authorized read-only `phone-preflight.sql` receipt before a hosted release; repository/local checks do not establish hosted function-body acceptance.

Combined local commands (Backend, with sibling Web checkout or explicit absolute Web path):

```sh
node scripts/ci/test-posting-v2.mjs /absolute/path/to/FairSwap-Web --with-accessories --with-tablets
node scripts/ci/test-accessories-v1.mjs
node scripts/ci/test-tablets-v1.mjs /absolute/path/to/FairSwap-Web --with-accessories
node scripts/ci/test-tablet-phone-wrapper.mjs /absolute/path/to/FairSwap-Web
bash tests/tablets-v1/run-native.sh /absolute/path/to/pinned-PG17.6/bin
```

PGlite suites and the native combined concurrency suite pass locally with synthetic supporting helpers. The native run also checks actual concurrent phone finalization and lost-response retries; the unchanged baseline native suite is separately recorded. Do not edit an applied migration: a target already containing the prior tablet candidate needs a reviewed new forward migration instead. Existing GitHub Actions/configuration and package/toolchain pins are unchanged.

# Tablets V1 release candidate

Foundation `supabase/migrations/20261102165946_posting_v2_tablets.sql` is disabled by default. Activation is separate under `activation/supabase/migrations/20261102170611_activate_tablets_v1.sql`. Requires Posting V2 and V2.1.2 recovery, with phone posting enabled for shared session/media infrastructure. Existing immutable migrations are unchanged.

Apply only from an authorized ledger-matched isolated environment package: FairSwapTest → matching Web staging with `POST_AD_TABLETS_V1_ENABLED` → automated acceptance → selective Production release. Never use the raw baseline directory or a Chat-specific release exception. No migrations have been applied by this task.

Local automated checks, from Backend:

```sh
node scripts/ci/test-tablets-v1.mjs /absolute/path/to/FairSwap-Web
node scripts/ci/test-posting-v2.mjs /absolute/path/to/FairSwap-Web --with-tablets
corepack pnpm verify:migrations
```

The SQL harness uses PGlite from Web and real candidate SQL/RPC bodies with fixture supporting auth/storage functions. It is not full hosted or native multi-connection acceptance. Preserve all existing CI gates; ChatGPT owns any Actions wiring.

Tablet-bound sessions cannot be rebound from legacy/phone sessions. Direct client writes are revoked. Public fields exclude sensitive identifiers and private review flags. Unresolved Activation Lock/FRP/organization management, parts-only devices, forbidden payment instructions and invalid catalogue variants fail closed. Uncertain/Other entries require staff review.

Rollback disables the Web flag and tablet release gate, retaining existing listings, contexts, sessions and applied schema. Database recovery uses reviewed forward fixes. Owner production availability checks follow authorized automated release checks; no owner predeployment testing.
