# Unified Publishing V3 — foundation contract review, 19 November 2026

**Incomplete implementation; no new category activation or migration is included.**
The Web foundation patch shares the existing specialist wizard controls, supplies
78 distinct canonical icons and retires competing creation screens. It retains
only the three proven canonical specialist contracts. The other 60 leaves remain
unavailable. This is not a claim that the requested V3 rollout is complete.

The exhaustive [63-category matrix](unified-v3-category-contracts.csv) records
selected Test/Production UUIDs, proposed persisted mapping, API/RPC, current
auth/RLS/review status, questions, publication mode and icon key. Proposed
contracts are explicitly unimplemented. The [existing subtype inventory](unified-v3-subtype-bindings.json)
records verified per-environment UUID/version/path/field bindings for 28 vehicle
and rental subtypes. Do not collapse these into canonical parent leaves or use
the deterministic fallback UUIDs of Phones, Tablets or Wearables.

Read-only hosted comparison: Test 115 migration versions; Production 98. Both
return configuration revision `e3013229e6f960c3044bcd4efa79df0e` and only three
enabled leaves. The three specialist UUIDs differ; the remaining 75 agree.
All 246 inspected listing/posting/category columns, 23 table RLS enable/force
settings and three private media bucket configurations agree. Grants and listing
triggers differ: Test additionally has the identity gate and two moderation probe
triggers; its submission lifecycle is Test-specific. Production uses its own
lifecycle and has 28 additional service-role REFERENCES column grants. Matching
trigger names have identical definitions. These differences are preserved;
schema equivalence and production identity-gate parity are not certified.
Ledger statement digests also differ; never copy/repair migration entries.

## Necessary follow-on schema work

No Supabase change is necessary for the current Web foundation batch. The
[preflight](../../supabase/forward-migrations/unified-publishing-v3/preflight.readonly.sql)
is read-only, outside the immutable baseline, and cannot activate anything.
Remaining V3 implementation requires additive disabled preparation and separate
per-leaf activation, in this order:

1. A canonical-selection-to-versioned-persisted-category binding, owner-scoped
   category-bound upload/session contracts and strict ordinary-Goods submit and
   AFTER-row validation. Generic table flags alone cannot establish safety.
   Preserve actor/account/policy/identity checks, all session limits, frozen media,
   retry idempotency, existing listing locks and ownership/RLS/grants.
2. Accessory subtype split without changing saved legacy meanings; explicit car
   and registered two-wheeler mappings and ownership/registration checks. Pedal
   bicycles need a distinct non-motor contract; exempt EVs require verified
   classification/evidence, never seller speed alone or scooter RC assumptions.
3. Distinct property sale/asking-price contract and wide INR financial context,
   commercial/land/warehouse validation; reuse compatible rental/PG/share
   contracts with rent/deposit/maintenance. Keep residence details private and
   BHK/amenities conditional. A rental label change cannot implement sale.
4. Kids model/recall/unsafe-condition denial, particularly crash history,
   missing parts and recall verification for child car seats. Insufficient
   evidence must prevent publication in direct/staff/worker paths.
5. Supplies-only pet validation. Dogs/cats require external legal clearance
   before a zero-price, zero-fee rehoming contract can activate. Ownership,
   age/health, domestic-species allowlist and abuse detection remain required.
   Other live species, paid sale, deposits and off-platform payment solicitation
   remain blocked in every publication path.
6. Other requires bounded description, mandatory human review in every finalizer,
   and AAL2-authorized, revision-safe audited reclassification into a validated
   target. Staff UI integration is outside this Web/Backend patch and remains a
   dependency; no catch-all generic activation is acceptable.
7. Verify public listing/search/category filters and image/storage privacy,
   then prepare exact ledger-matched activation candidates for verified leaves.
   Services and Jobs remain disabled/childless. No blanket update of 60 leaves.

Each adapter needs the brief's representative adversarial, RLS, moderation,
media, retry, recovery and narrow-screen automated evidence before activation.
No follow-on schema file or version is invented by this review; use the pinned
Supabase CLI to generate each additive migration after its contract is implemented.

## Release and rollback

ChatGPT owns GitHub and release. Stage compatible disabled Backend preparation
on FairSwapTest, then Web staging, automated contract checks, explicit safe-leaf
activation and automated postflight. Repeat using Production's independently
captured ledger and a focused Web main release. Do not merge staging wholesale.
New environment variables: none for this foundation. Existing flags stay in use.

Rollback restores the retained same-environment Web artifact and disables only
newly activated leaves. Preserve guards, identities, drafts, media and ledger;
forward-fix installed SQL. Owner production checks follow deployment: category
visibility, draft recovery, moderation queue/denials and submission error rates.
No manual predeployment test gate or hosted mutation is authorized here.

## Batch 2 update, 19 November 2026

The matrix supersedes the foundation's Ordinary Goods status. All 35 Goods
leaves in the six approved groups have category-specific contracts and locally
verified submissions. All 35 start disabled. The full 63-row matrix continues
to describe the 25 remaining leaves.

The migration adds private contract and session-binding tables. The existing
upload core retains its ownership, capacity, leases and cleanup and recognizes
the new category-bound partition. The transaction freezes the validated JSON
and exact ready photos, then creates the listing and submits it through the
existing moderation queue. Category and revision checks protect retries and
the database validates saved edits and publication transitions. Clean current
five-check media evidence is required for publication. A two-check outcome
routes to staff review with the ad still pending. The provider-switching
finalizer and Wearables wrapper retain their existing behavior for other groups.

1. Check each target's release ledger and run the read-only Batch 2 preflight.
   Expected disabled inventory is 35 and fingerprint
   `61018a723e173a4b3b0f02b3c1297868`. Review the installed session core and
   provider finalizer before admitting the forward migration.
2. Apply `20261119092042_ordinary_goods_v3.sql` to Test through the normal release
   process. Deploy compatible Web. Verify the disabled routes, installed guard
   and provider prerequisites and use the local per-leaf evidence to review
   admission to the Test pilot.
3. Activate just that leaf using `activate-one.operator.sql` with the exact slug
   and actual deployed Web SHA. Run the hosted Test journey using approved
   fixtures. Confirm category/search visibility, active status after a clean
   scan, pending status after a fallback or flagged scan, and ownership/recovery
   behavior. Repeat per leaf and feed successful receipts into Production review. The script requires the
   four seller identity hooks and the existing five-check moderation settings.
4. Repeat against each independently captured Production ledger after Test.
   Read-only Production inspection found no matching DigiLocker helper or
   hooks. Bring Production identity enforcement into parity before activation.
   No new environment variables or secrets are required.

Use `deactivate-one.operator.sql` to close a leaf and retain listing and media
records. For emergency removal of already public ads, use the existing
moderation controls. Keep the additive schema and migration history and
forward-fix as needed. The Batch 2 release package includes the disposable
database and browser verification commands.

## Batch 3

Install the Batch 2 migration before `20261119100640_bounded_goods_v3.sql`.
The Batch 3 migration registers ten disabled leaves with distinct canonical
IDs and bounded fields and keeps legacy accessory IDs unchanged. Eight
leaves have the shared session-to-moderation path. Baby Gear & Car Seats and
Other Items remain hard-gated. The Pet Food & Accessories contract admits
only non-food supplies pending a verifiable sealed-food and expiry contract.

The single-leaf operator takes an explicit moderation mode. Five-check mode
still requires Azure and current verified media evidence. Staff intake
works with baseline moderation enabled and Azure off. Its finalizer routes
to staff and a database guard prevents publication, including direct staff
approval. A manual publication path would require separate authorization,
review-evidence validation and deployed acceptance.

## Batch 4 partial implementation

The forward migration registers three inactive canonical vehicle leaves for
pedal bicycles and non-safety-critical car and bike accessories. These use
the existing V3 session, moderation, identity and rollback controls. No
registered vehicles, electrically assisted cycles or property leaves are
admitted. Their legacy specialist listings and edit contracts are preserved.

## Batch 4B property intake

Six canonical property identities use the shared owner-bound V3 session and
staff-intake guard. The migration keeps item condition and item price columns
null for these contracts. Financial terms are exact bounded integer paise in
the frozen, category-validated attributes. Sale excludes rental deposits and
monthly charges. Existing rental and vehicle subtype contracts retain their
original identities, grants, validators and edit paths.

The activation operator admits only staff intake for property. No property
publication or authoritative title verification is implemented. Cars,
motorcycles, commercial vehicles and low-speed EVs still have no canonical
intake path. Keep them disabled.

## Batch 4C regulated vehicle drafts

Commercial Vehicles and Electric Cycles & Low-Speed EVs have disabled,
category-bound draft/photo contracts. Activation permits protected draft
access only. Both prepare/submit and direct listing writes are blocked.
Seller declarations never establish registration or exemption.

The next migration adds draft-only Cars and Motorcycles bindings. These require
an exact installed hatchback or commuter motorcycle subtype and contract
version from the per-environment inventory. The resolver matches UUID, legacy
slug, contract key, source path and field definitions. Each photo session pins
the resolved subtype/version. Binding drift closes recovery and upload for
that session. No legacy listing is created. Registration and transfer
verification and specialist listing submission remain unimplemented.
