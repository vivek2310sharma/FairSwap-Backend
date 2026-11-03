# Accessories V1 — canonical forward release candidate

2 November 2026. Local source only; no hosted migration or verification. Web consumer and full plan/release handoff: FairSwap-Web/docs/operations/ACCESSORIES_V1.md (separate repository). This directory must be applied only inside independently ledger-matched release workspaces, never as the historical 58-file directory.

## Apply order

Prerequisites: installed Posting V2 foundation, its current media infrastructure, V2.1.2 recovery contract and installed seller_submit_listing/moderation behavior. Foundation 20261102164135_accessories_v1.sql is closed by default. It creates accessory metadata and immutable structured context with FORCE RLS, safe public/owner/staff reads, no client writes, private validated implementation and invoker wrappers. It extends only session release availability and submitted phone-retry category isolation; actor/limits/rotation/cleanup contracts are preserved.

Deploy matching Web while category stays unavailable; then reviewed activation 20261102164137_activate_accessories_v1.sql. Activation authorizes the typed route only: generic new_listing_enabled remains false. Existing incompatible metadata, required attributes or legacy Accessories work aborts foundation pending reviewed backfill; never bypass by deleting work. Actual target ledgers/data are NOT VERIFIED.

Existing GitHub CI → Test foundation/Web/activation → automated authenticated verification → automatic selective Production promotion only if Test passes → automated Production verification. ChatGPT owns all delivery and any existing-workflow test integration; no Actions file is changed here. No new dependency/environment variable/service.

## Contracts

- accessories_v1_catalogue(): version 1/revision accessories-v1, category ID and runtime availability.
- submit_accessory_v1(payload jsonb): strict selection Mobiles/Accessories version 1; complete domain/safety/price/location and owner-session/media checks. Uses existing seller_submit_listing, never forces active. Repeated owner-session submission returns one existing accessory listing. Phone/accessory cross-category retries fail.
- search_accessories_v1(filters jsonb): bounded exact type/manufacturer/device/condition filters plus public visibility/account/expiry, keyword, price, location, sorting and count-before-pagination. No PIN/address output. Other-category RPC is unchanged.
- taxonomy.json: 21 types/seven groups and typed conditional specifications. No catalogue-confirmed compatibility rules seeded. Seller/unknown labels only, no substring proof. Meaningful/legacy/media drafts and existing phone recovery are untouched.

## Automated commands

From Backend (installed existing dependencies):

```
node scripts/ci/test-accessories-v1.mjs
# Backend-only CI with the already-installed pinned Ratings dependency:
node scripts/ci/test-accessories-v1.mjs --pglite-module=tests/ratings/node_modules/@electric-sql/pglite/dist/index.js
bash tests/posting-v212/run-native.sh /absolute/checksum-pinned-pg17-build/bin --accessories-v1
node scripts/ci/test-posting-v2.mjs ../FairSwap-Web
corepack pnpm verify:migrations
corepack pnpm typecheck
corepack pnpm test:unit
```

The SQL harness uses disposable PGlite with actual candidate migrations and synthetic supporting auth/storage; no connection URL or real environment is read. Native option reruns the existing 13 independent-backend session assertions with the combined Accessories foundation installed. The default native command remains compatible. Web tests exercise real components and compression against local synthetic APIs. These do not establish hosted Supabase JWT/storage/provider/moderation acceptance. Full result logs and file hashes are in the ZIP.

Rollback is a scoped application revert/previous Vercel deployment plus reviewed forward compensating SQL when necessary; retain data and contexts, do not drop tables or alter applied migration bytes. Coordinate later shared-function changes. No deployment, Git or GitHub operation was performed.
