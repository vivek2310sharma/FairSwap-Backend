# Package 2 — canonical catalogue

Baseline: GitHub main `8e6769b3bf7acd756a353174181b9bac0bb6920b`.
The subsequent Azure-only changes after foundation baseline `5208081` are preserved.
Prepared in an isolated archive; the dirty original checkout is untouched.
The attachment reports foundation release `44173256159`; no hosted verification
or mutation is performed here. The foundation migration and all 58 historical
migrations retain their exact bytes.

## Migration and identity policy

`supabase/migrations/20261118092010_taxonomy_v2_catalogue.sql` is CLI-generated,
forward-only, transactional and independently registered as `taxonomy-v2-catalogue`.
It defines the exact 15-root / 63-leaf catalogue, with 35 `brand_model`, 17
`brand_only`, 11 `none`. Capability is optional, never a mandatory seller answer.
The single production definition is private SQL function
`app_security.impl_taxonomy_v2_expected_nodes()`; the JSON under tests is the
acceptance fixture transcribed from the attachment, not another client catalogue.

75 new UUIDs use UUIDv5(URL namespace, `https://fairswap.in/taxonomy/v2/<slug>`),
literalized in the migration, requiring no extension. New slugs have `v2-` prefixes
to avoid claiming broad legacy identities. Mobile Phones, Tablets and Wearables
retain their original UUIDs/slugs only after exact name, metadata and versioned
binding checks. No listing or specialist context is re-keyed. The migration adds
75 rows; synthetic 53/55 inventories therefore end at 128/130 total rows, with
exactly 78 canonical nodes each. All other original category rows remain unchanged.

`legacy-review.readonly.sql` returns the three actual-ID/fallback-ID mappings and
an exhaustive review list for all other legacy IDs, with reference counts. It
reclassifies nothing. The agent executes it only on disposable fixtures.

| Legacy source | Package 2 disposition |
| --- | --- |
| `mobile-phones`, `tablets`, `wearables` | Retain UUID; attach Mobiles & Tablets parent; add exact flow/mode/order. Preserve old active and generic-posting flags. |
| Electronics, Books, TVs & Video, Audio & Home Theatre, broad Property | Retain every UUID, listing FK and attribute. No arbitrary leaf assignment. |
| Car/two-wheeler/property versioned subtypes | Retain category/version/context FKs and existing gates. New canonical Cars/Motorcycles/Property leaves stay Coming Soon; no many-to-one collapse. |
| Accessories (including headphones), Baby Gear, Furniture and other overlaps | Retain original meanings and typed/attribute contracts pending a consumer/reference review. No car-seat verification or live-animal sales route. |
| Same-label generic leaves, unknown or environment-only rows | A label alone is not proof of compatible saved attributes and posting contracts. Preserve as legacy; review explicitly later. |

“Hidden legacy” means excluded from the V2 reader. Legacy `is_active` and
`new_listing_enabled` are preserved so old Web/discovery/posting clients keep their
existing contracts. Globally hiding active legacy rows here would break that
compatibility; retirement belongs after the consumer rollout.

## Availability and security

All 60 unimplemented leaves are inactive, `coming_soon`, generic-posting disabled.
Services and Jobs are inactive, childless Coming Soon roots. The explicit read-only
V2 projection shows these labels while old active-category RLS hides them. Roots
never accept listings. Dogs/Other Pets remain adoption/rehoming capabilities only;
Other Pets covers permitted cats/fish/birds. No animal restriction is relaxed.
Baby Gear & Car Seats is one ordinary generic leaf, with no new verification rules.

Existing phone/tablet/wearable gates deliberately keep `new_listing_enabled=false`.
The new private `impl_taxonomy_v2_can_post(uuid)` honors their actual enabled
release/version bindings, active category and parent. The V2 listing guard and API
use it. No specialist RPC, wizard, draft/media contract, old eligibility helper,
RLS policy/grant or release flag is replaced. Direct generic INSERT remains denied
for those specialist categories. Disabled specialist gates stay disabled.

A private canonical config trigger rejects unreviewed ID/slug/name/parent/flow/mode/
order edits, including writes routed through legacy staff CRUD. Existing safety
deactivation flags remain operable. Future config changes need a deliberately
reviewed forward migration. The existing composite self-FK still enforces two
levels/no cycles; AFTER listing validation sees final lifecycle transitions.

Both generic lookup tables stay empty. No new catalogue table, brand/model import,
translation, property-sale feature, price widening, dependency or workflow is added.

## Reader and revision

`get_category_catalogue_v2()` keeps its public signature and grants. It returns all
78 canonical nodes in order, `taxonomy_revision=catalogue-2`, availability from the
current bindings, and no unresolved legacy rows. The existing `revision` hashes the
actual payload for caching. New `configuration_revision` excludes environment UUIDs
and availability flags: **`e3013229e6f960c3044bcd4efa79df0e`** for this exact canonical
slug/parent/name/flow/mode/order configuration. Compare this plus taxonomy revision
across environments; do not assume raw UUID equality for the three retained IDs.

## Automated verification and release

```sh
(cd tests/ratings && npm ci --ignore-scripts --no-audit --no-fund)
node tests/taxonomy-v2/run.mjs --category-count=53 --package=2
node tests/taxonomy-v2/run.mjs --category-count=55 --package=2
node --test tests/taxonomy-v2/integration.test.mjs tests/release/taxonomy-v2-release.test.mjs tests/release/taxonomy-v2-catalogue-release.test.mjs
node tests/taxonomy-v2/run.mjs --category-count=53 --package=2 --native-bin=/absolute/pg17/bin
node tests/taxonomy-v2/run.mjs --category-count=55 --package=2 --native-bin=/absolute/pg17/bin
node scripts/verify-migration-manifest.mjs
```

The existing required CI jobs run these PGlite/native checks. Twenty prerequisite
source/toolchain files are pinned to current main's Git blob and SHA-256 identities.
Fixtures include real property/vehicle contracts, saved broad assignments and six
nonempty specialist/rental contexts, with different Wearables availability. Auth,
account, storage and submission infrastructure is explicitly synthetic. The suite
checks exact labels/counts/modes, old-row preservation, no-op replay, atomic drift/
collision failures, root/Coming Soon denial, client permissions, canonical config
immutability and valid specialist review transitions. Native tests observe actual
independent-connection lock waits. Final exact results are in the delivery logs.
Full hosted acceptance, GitHub Actions execution and Supabase PG15/pgTAP are NOT RUN.

ChatGPT owns integration and release. Use the existing reusable Supabase workflow
with `candidate=taxonomy-v2-catalogue,target=test`, the reviewed main commit and SQL
hash. It requires foundation ledger version `20261117185218`, independently captured
history, candidate-only dry run and real read-only postflight. The verified same-run,
same-attempt Test receipt and installed-statement digest gate automatic Production
through the existing protected environments. No new owner testing gate, secret or
configured variable; `TAXONOMY_TEST_LEDGER_SHA` remains artifact-derived evidence.

Postflight permits only the three reviewed metadata mappings and 75 new categories.
It compares original listing/media/attribute/context/catalogue/contract/flag/session
and security fingerprints, checks all counts/modes/UUIDs/configuration revision,
empty lookups, guarded private helpers and no new route activation. Snapshots keep
listing data inside PostgreSQL; receipts contain only sanitized success evidence.
On failure stop and investigate. Before commit the transaction rolls back. After
application, retain data/history and use reviewed forward compensation; never edit
applied migrations or delete referenced rows. No deployment is run by this task.
