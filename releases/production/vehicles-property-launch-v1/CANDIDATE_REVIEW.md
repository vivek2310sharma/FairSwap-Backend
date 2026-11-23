# Candidate: production family submission boundary (unreviewed)

**Status: REVIEW ONLY, intentionally non-executable, NOT applied to FairSwapProd or FairSwapTest.** This file is *not* a forward migration and MUST NOT be copied directly into the Production migration workspace.

## Scope

`candidate-family-submission.sql` is a **source review candidate** adapted from the historical tested Test submission migration `supabase/migrations/20261011092234_test_family_submission_v1.sql`. The candidate uses **different Production-only policy/permit/function names** and the separately proposed Web RPC names:

- `public.get_seller_production_submission_status(listing_id uuid)`
- `public.seller_submit_family_listing(listing_id uuid,expected_revision integer)`

The candidate is designed for **draft→pending_review only**. It does not approve, reject, publish, activate categories, configure Vercel, or replace the Goods submit function. All three policy rows default OFF, and it enforces a conservative 1–8 ready-photo rule so pending worker completion need not be permitted at this stage. It includes transaction-bound submission permits, owner/policy/revision checks, source-checked category definitions, private rental finance validation, and family-specific guards/context completeness. The existing Goods RPC stays unchanged.

**The first SQL block deliberately raises a `REVIEW ONLY` exception before ANY DDL.** Static CI asserts that this stopper stays present. This guards against unintended production installation even if somebody copies the source into the wrong migration workspace.

## Not yet verified

- Exact current Production schema compatibility, including moderation V1 OpenAI gate changes as of 2026-10-22.
- Correct lock ordering and transaction/revision behavior under simultaneous owner save / upload / submit / moderator actions. Test source history is not proof for a new Production migration.
- Direct authenticated vs anon, staff AAL1/AAL2, self-review, cross-owner, stale token, malformed category, duplicate context/price, and worker mutations in a fresh PG17 isolated full-ledger rehearsal.
- Production owner-policy revisions and availability after live category assignment.
- What error/status must be returned for late media processing, processing failure, unknown model, incomplete known rent, zero maintenance and future rejected-reedit.
- Human reviewer and publication transition implementation. Active/rejected/expired/removed lifecycle remains **blocked** here. Existing public presentation PR #220 alone cannot provide release certification.
- Verified backup restore and production go/no-go signoff. See `README.md` in the same folder.

## Required next engineering change

Create a **separately reviewed, forward-only** migration from the exact *current* Production Supabase migration ledger (not the mixed 58-file Test source directory). Adapt, test, and remove the deliberate stop **only when** DB schema, security and concurrency tests pass and the user can proceed through moderation in Test. A production release must include family-aware reviewer stale-status checks and public-safe projections **before** activating `reviewed_live` Web flags.

**No launch, no activation, no backups claimed.**
