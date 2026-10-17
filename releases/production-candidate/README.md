# FairSwap Production — cold category foundation candidate
17 October 2026 · **Preparation / review only, NOT a deployment authorization or migration set**

## Decision and expected outcome
Prepare a separately reviewed, production-compatible *schema-only* foundation for Cars, Two-Wheelers, and Property. **All categories must remain unavailable for new assignment and publication.** No auto-approval for these families. No Goods behaviour changes. This is phase A of a future release; it does not launch public category posting.

The actual 7 pinned candidate migrations are already preserved under `supabase/migrations/` in the immutable 58-file source baseline. They are intentionally **not copied into a new migration directory**, and historical hashes are not modified. The manifest selects their exact source bytes but is not an automatic execution list. Applying `supabase db push` with the full Backend migration history to 45-migration Production is strictly prohibited: it would include excluded Test activation scripts and unreviewed functions. A new explicitly reviewed production migration sequence, fresh version identities, dry run against a Production-compatible disposable PostgreSQL 17 database, and an actual backup/recovery gate are required before any hosted DDL.

## Freshly verified environments
- Production `kriuhwppxgxsyyrbjsau`: PostgreSQL 17.6, **45 migrations**, Goods-only categories (5 enabled), no experimental family policy table, moderation worker/trigger working (1 auto-approved, 1 admin-routed; no queued requests), Web `main` `e6bb784`.
- FairSwapTest `wpppxlnbzqynvhpeuavd`: PostgreSQL 17.6, **61 migrations**, 7/7 moderation requests completed (2 Goods Active, 5 routed to admin); all new-family publication guards enabled.
- Backend main source `1ee5894edef7cd194f3710e904bd84fb1fd221c2` includes 58 historical migration hashes plus historical Test-only correction receipts. The candidate verifier refuses unexpected migration drift.

## Exact Phase A source candidates (all must stay COLD)
| Sequence | Canonical file | Notes |
| --- | --- | --- |
| 1 | `20261009201151_two_wheeler_draft_v1.sql` | Two-Wheeler tables/catalogue (830 rows), RLS, guards, inactive category seeds |
| 2 | `20261009202059_two_wheeler_catalogue_lookup.sql` | Authenticated bounded model lookup |
| 3 | `20261009203141_two_wheeler_unresolved_mapping_correction.sql` | Before any new category assignment |
| 4 | `20261009215128_two_wheeler_reference_errors.sql` | Correct reference checks |
| 5 | `20261010064518_car_draft_v1.sql` | Cars tables/catalogue (578 rows), RLS, guards, inactive category seeds |
| 6 | `20261010084523_property_rental_draft_v1.sql` | Rental categories, financial validation, inactive category seeds |
| 7 | `20261010091239_property_scoped_draft_lock.sql` | Owner-scoped draft safeguards |

**These original scripts predate the latest Production migration and include their own transaction wrappers.** They have only been observed together in Test's broader migration history, which is not identical to Production. Do not run them in Production directly. Build a forward-only and independently verified release with fresh migration timestamps and durable ledger provenance after the backup/restore and isolated PG17 gates.

## Explicitly excluded from Phase A
- Source: `20261009203412_enable_test_two_wheeler_draft_categories.sql`, `20261010064519_enable_test_car_draft_categories.sql`, `20261010084524_enable_test_property_rental_drafts.sql` (**Test category activation**).
- Source: `20261011092234_test_family_submission_v1.sql`, `20261011095100_enable_test_family_submission_v1.sql` (**Test-only queue/submission permit workflow**).
- Source: `20261012120000_post_ad_current_base_compatibility.sql` (**review-only proposal, modifies Goods function bodies and requires Test-only dependencies**).
- Hosted Test-only versions absent from canonical source: `20261010214201_staff_listing_review_context`, `20261017125456_stage3_experimental_finalizer_staging_validation`, `20261017172840_fairswaptest_restore_moderation_enqueue_for_acceptance`.

## Mandatory release gates
1. Open <https://supabase.com/dashboard/project/kriuhwppxgxsyyrbjsau/database/backups> and confirm a recent usable backup **and a documented recovery procedure**. Supabase MCP does not expose backup inventory, so no agent may assert this is verified. Supabase documentation notes database backups omit Storage object bytes: verify critical Storage recovery separately.
2. Generate a fresh, **forward-only Production-compatible migration** from the seven reviewed source files, with only draft-foundation objects. No Test activation or the Test finalizer. Explicit source hashes and dependency/order must be recorded, preserving original 58 canonical migration SHA-256 values.
3. Run a disposable PostgreSQL 17.6 migration rehearsal based on the exact existing 45 Production migrations. Verify RLS, grants, cross-category/category swap bypasses, order, locks, data changes, and Goods moderation negative cases. Never infer PG17 compatibility from PG15 CI alone.
4. Dry-run the read-only `00_prod_preflight.sql` before DDL; fail closed if environment/branch/version/queue/category counts drift. After the future guarded release, run `01_post_foundation_assertions.sql`. Assert **0 newly assignable, 0 public/active** Cars/Two-Wheelers/Property and 0 Goods behaviour regression.
5. Confirm Vercel Production has **none** of the new-family activation flags. Phase A must not change Vercel environment variables, Production Edge worker, Vault, dispatch, notification email, RLS of existing Goods or Web `main`.
6. Phase B (later, separate): a dedicated production review-only submission function/guard, staff review path, fresh Web seller flow acceptance and explicit launch approval. Release never requires overlapping backend deployment owners.

## Release and rollback
- Back up first. Schema extensions should remain dormant after Phase A. Never delete/rewrite production data or replay all 61 Test migrations.
- Failures before activation: halt further migrations and leave original Goods routing unchanged; repair with a new forward-only corrective migration after identifying fault.
- Web: stage a production-targeted build without domain assignment; promote tested build only after DB safeguards. Vercel rollback is separate from database recovery.
- Future staff review cannot be considered complete until the unpinned Test-only staff-context migration is independently sourced and audited.

**Current status:** Source candidate scoped with hashes and read-only SQL, but **no Production backup/recovery proof, no exact 45→foundation PG17 rehearsal, and no Production DDL or Web promotion**.
