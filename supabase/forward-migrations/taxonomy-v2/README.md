# Taxonomy V2 — Packages 0 and 1

Local candidate; no activation or deployment. Base: `main` at
`1d475c3ff1326d2f2de3bb8e96b6947baaf77484`. Corrective work uses a disposable archive of this exact GitHub commit; the dirty original checkout is untouched.

## Dependency audit and decisions

- Immutable `supabase/migrations/`: all 58 files match their manifest. No edits.
- `india-taxonomy/20261024213147_india_goods_taxonomy.sql` and its separately gated
  activation retain the existing `category_attributes` contract and AFTER listing
  validation. Neither is replaced, replayed against hosted databases, or activated.
- `20261008210921_post_ad_category_metadata.sql` owns `macro_category` and
  `new_listing_enabled`; `20261013192336_post_ad_listing_insert_category_guard.sql`
  owns `app_security.is_new_listing_category_eligible(uuid)` and the listings
  INSERT policy. Preserve their functions, flags, account and policy checks.
- `20261009163210_seller_listing_category_context.sql` uses an explicit owner-only
  projection, including inactive references; preserve its result and grants.
  Existing metadata/eligibility/seller-context/security pgTAP files were inspected;
  their full Supabase baseline suites were NOT RUN by this standalone fixture.
- Five preserved catalogue/context systems: `phone_brands`/`phone_models` and
  `listing_mobile_contexts`/`posting_category_definitions`; `tablet_*_v1` and
  `listing_tablet_contexts`; `wearable_*_v1` and `listing_wearable_contexts_v1`;
  `car_brands`/`car_models` and `listing_car_contexts`; `vehicle_brands`/
  `vehicle_models` and `listing_vehicle_contexts`. Wearable IDs remain TEXT.
  Posting/upload sessions, release flags, snapshots and specialist RPCs are untouched.
- Read-only Web audit: `post-ad-category-catalogue.ts`, `post-ad-server.ts` and
  `src/app/account/listings/new/page.tsx` still route through legacy metadata and
  separate specialist contracts. Animals remain blocked in that selector. No Web
  changes or regulated-category activation are included.
- `listings.price_paise` remains INTEGER bounded at 100000000 paise (INR 10 lakh).
  Property sales/commercial vehicles need a later coordinated SQL/RPC/TS/Zod/API
  money-contract change. No price widening or rent/sale feature here.
- No hosted audit, SQL, config inspection or deployment runs in this corrective pass.
  Hosted category/listing counts and current runtime acceptance remain UNVERIFIED.
- All 18 tracked SQL, native-adapter and dependency/toolchain prerequisites match
  GitHub main blob IDs and SHA-256 in `tests/taxonomy-v2/prerequisites.json`.
  The runner checks these bytes before any fixture starts.
- Tracked Wearables foundation is `20261104120000_posting_v2_wearables.sql`:
  its body is byte-identical to the old untracked 20261103090000 candidate.
  No Wearables schema shim, UUID cast or specialist edit is needed. Actual upstream
  differences are Accessories' phone-body drift precondition and Tablets' checked,
  OID-preserving wrapper replacement. Fixtures load those tracked versions and the
  tracked Wearables V1.1 catalogue update. Test snapshots preserve all five systems.

## Legacy mapping strategy (Package 2 only; no mapping executes here)

| Existing source slug/family | Proposed treatment before any reference migration |
| --- | --- |
| `mobile-phones`, `tablets`, `wearables` | Preserve exact UUID and specialist catalogue/context; attach reviewed parent later. |
| `mobile-accessories` | Preserve typed Accessories context; review narrower target semantics and adapter before mapping. |
| `fashion-men`, `fashion-women`, `fashion-kids`, `fashion-watches`, `strollers-prams`, `toys-games`, `school-essentials`, `power-backup-solar`, `kitchenware-utensils` | UUID reuse candidates after attribute/meaning comparison; no blind rename. |
| `fashion-accessories` | Includes bags; ambiguous with separate Bags & Luggage. Keep hidden legacy references pending review. |
| `baby-furniture`, `baby-gear` | Meaning changes (kids furniture/car seats); preserve references until category-specific review. |
| `tvs-video`, `audio-home-theatre`, `other-home-appliances` | Broad meanings cross new leaves. Retain hidden legacy IDs; never arbitrarily split listings. |
| `electronics`, `furniture`, `home-appliances`, `bicycles-sports`, `books`, `hobbies` | Broad definitions span new leaves (even old Books includes textbooks/stationery). Preserve as legacy; reviewed per-listing classification later. |
| `car-*`, `tw-*`, rental/property contract categories | Preserve all existing category/version/context FKs; many legacy subtypes cannot be merged into one UUID without a separate specialist contract migration. |
| Unknown/environment-only rows | Preserve UUID and listing references; require inventory and explicit disposition. |

All existing rows keep NULL V2 metadata (explicit legacy compatibility state).
No canonical root or leaf is seeded in Package 1. Package 2 owns the deterministic
78-node seed, exact UUID map, hidden legacy retention and route activation.

## Additive contract

One CLI-generated migration: `supabase/migrations/20261117185218_taxonomy_v2_foundation.sql`
(relative to this directory). It adds parent/status/flow/mode to `categories`.
Two internal generated booleans support a composite self-FK: a parent must be a
V2 root. This enforces two levels/no cycles under database referential locking.
Roots cannot post. Hidden/blocked rows must also be inactive for old clients;
unavailable categories cannot enable the old posting flag. Existing rows stay unchanged.

`get_category_catalogue_v2()` is read-only for anon/authenticated. Its explicit
projection returns `api_version=2`, `taxonomy_revision=foundation-1`, a content
revision and `nodes`; it returns an empty node list until V2 nodes are installed.
Hidden/blocked/legacy references are excluded, and `posting_enabled` also checks
parent availability and old flags. It does not claim a route is implemented.

Three new tables only: `generic_product_brands`, `generic_product_models`,
`listing_generic_product_identity`. Brand/model names have bounded, generated
lowercase/trimmed keys. Composite FKs enforce category/brand/model correspondence;
listing identity's composite FK prevents category edits that strand saved identity.
Both lookup tables are EMPTY after migration. Future queries use category-scoped
SELECT (plus brand for models), bounded pagination/search supplied by the consumer.
Only enabled catalogues in eligible live generic/accessory leaves are readable.

Client lookup writes are revoked. Identity RLS is owner-only; writes require an
active account/current policy acceptance and draft status. Identity writes lock
the listing before checking its status, preventing a submission race. Reviewed
identity cannot be changed or deleted, even by a privileged direct write; return
through the existing draft/edit lifecycle first. Remove a draft identity explicitly
before changing category. Text entry is optional; brand-only leaves reject models.
Catalogue snapshots are captured on selection, survive catalogue rename/disable,
and cannot be overwritten while retaining the same selected IDs. No moderation,
publication, trust, media or specialist function is replaced.

## Automated checks

From a clean Backend checkout (no Web checkout or new package required):

```sh
(cd tests/ratings && npm ci --ignore-scripts --no-audit --no-fund)
node tests/taxonomy-v2/run.mjs --category-count=53
node tests/taxonomy-v2/run.mjs --category-count=55
node --test tests/taxonomy-v2/integration.test.mjs tests/release/taxonomy-v2-release.test.mjs
node scripts/verify-migration-manifest.mjs
# Existing CI builds checksum-pinned PostgreSQL 17.6 first:
node tests/taxonomy-v2/run.mjs --category-count=53 --native-bin=/absolute/pg17/bin
node tests/taxonomy-v2/run.mjs --category-count=55 --native-bin=/absolute/pg17/bin
```

Actual results: **77 SQL assertions per inventory** on PGlite 0.5.8 / PostgreSQL
18.3 and native PostgreSQL 17.6. Both engines execute the real read-only release
snapshot/postflight SQL and exact preservation comparisons. Each native run also
passes **three independent-connection races**: identity versus submission, identity
versus category edit, and child insertion versus root reparent. Barriers observe
actual `pg_stat_activity` waits; no timing sleeps decide correctness.
Both generic lookups remain empty after transactional fixture rollback. Synthetic
53/55 inventories are not hosted copies. Auth/account/storage helpers are fixture
substitutes; specialist SQL and baseline listing UPDATE lifecycle are real source.
Native verification uses the existing tracked psql adapter; no `pg` package.

Both existing required jobs in `backend-ci.yml` now run taxonomy checks. Existing
`backend-ci-success` dependencies and all unrelated gates stay unchanged.
Separate passing regressions and exact commands appear in the corrective ZIP logs;
these pre-existing suites do not install Taxonomy SQL. The taxonomy suite supplies
migration-specific preservation, role checks and concurrency evidence.
Full Supabase PG15/pgTAP, hosted CI execution and hosted E2E are NOT RUN here.
No new dependency, workflow, secret or configured environment variable is needed.

## Integration order, recovery and remaining gates

Registered candidate: `taxonomy-v2-foundation`, pinned to the unchanged migration
SHA-256 `85e6e501e009dc56bc7ba4e28fb72b8b827e35c031fff7f283d0a373b92bbc25`.
Use the existing `reusable-supabase-release.yml` with `target=test`; Production-only
and adoption dispatches are rejected. The existing `verify_test` job verifies the
artifact checksum and taxonomy receipt (source, same commit/run/attempt, scope and
ledger digest). Production requires that proof and matching installed statement
hash. The runner rejects pre-existing/partial state and any ledger/data/security
change. `scripts/release/taxonomy-v2-release.mjs` returns only sanitized success;
row data stays in PostgreSQL and snapshots contain digests, not listing records.
`TAXONOMY_TEST_LEDGER_SHA` is internal artifact-derived evidence, not a new secret
or owner-configured variable. No workflow was dispatched by this task.

ChatGPT owns release integration. Capture each current target's authentic CLI
history independently; validate RLS/account/policy prerequisites and the candidate
hash, then apply only this reviewed forward migration in the existing isolated
release mechanism to **FairSwapTest**, execute native PG17 and automated postflight,
then **FairSwapProd** after Test gates succeed. The registered candidate uses the existing reusable lane and protected environments. No new environment variable or secret.
Do not push the raw historical directory or copy/repair ledgers. Preserve CI gates.

Automated postflight must check empty generic lookups, unchanged listing/reference
counts and specialist contracts, versioned read payload and deny paths. Re-capture
counts only with hosted read authorization. No manual owner testing gate. Web,
canonical seeds/activation and property sales follow in later packages.

On failure stop and investigate. Before commit, transaction rollback leaves no
partial migration. After application, use reviewed forward compensating SQL;
retain user data and applied history. Never drop populated identity/catalogue
records to roll back. Existing clients continue using the retained legacy contract.

## Package 2 follow-up

The separate [canonical catalogue candidate](catalogue/README.md) seeds the 78-node
tree and conservatively maps three specialist identities. It supersedes the
foundation-only empty-reader expectation after its own release; foundation SQL
bytes and its historical release gate remain unchanged.
