# FairSwapTest moderation release receipt — 17 October 2026

**Scope:** Source-controlled staging evidence only. This folder is deliberately outside `supabase/migrations/`; no CI deployment, cloud write or promotion is authorized by these files. The immutable **58 migration** canonical baseline and its checksum manifest remain unchanged.

## Recorded Supabase-Test changes

| Hosted migration version | Purpose | Source receipt | Target |
| --- | --- | --- | --- |
| `20261017125456` | Replace experimental-category moderation finalizer with guarded, corrected function | `releases/test-only/20261017125456_stage3_experimental_finalizer_staging_validation.sql` | FairSwapTest only |
| `20261017172840` | Restore disabled listing moderation enqueue trigger after validating dispatch/Vault/experimental guards | `releases/test-only/20261017172840_fairswaptest_restore_moderation_enqueue_for_acceptance.sql` | FairSwapTest only |

The first SQL file is the exact reviewed `scripts/stage3/step1q-finalizer.proposed.sql` blob from `876a557bd206830720d41e4636d33357054c7a68` (Git blob `8d42e81ca1efc60164ef499bade9d03dac554444`); the hosted migration submitted its content under Supabase's migration transaction, removing the redundant outer `BEGIN`/`COMMIT` wrapper. Its original "proposal only" header is retained as historical source provenance. The second SQL file records the verified guarded operation as a transaction-wrapped replay reference, not a claim of identical bytes sent to Supabase MCP. Both are **not** executable production migrations and are not placed in the canonical migration directory.

Staging also contains an older independent Test-only migration `20261010214201_staff_listing_review_context`, not in the accepted 58-file migration baseline. Do not add it to Production implicitly.

## Hosted verification (read-only summary)

- FairSwapTest `wpppxlnbzqynvhpeuavd`: PostgreSQL 17.6; 61 recorded migrations; `trg_listing_moderation_enqueue` enabled; dispatch trigger and retry cron enabled; Vault worker URL and secret-format preconditions checked without exposing secret contents; moderation finalizer EXECUTE denied for `anon` and `authenticated`, allowed to `service_role`.
- Exactly three owner-submitted Electronics (Goods) listings from the 17:19–17:24 UTC cohort had been left pending with no queue request while the enqueue trigger was disabled. After the trigger was restored, one then two of those existing submissions were inserted into the existing normal moderation queue. All **3/3** requests completed in one attempt: **2 auto-approved and Active**; **1 routed to admin** for `rule_payment_before_viewing` and remained Pending Review.
- Cars, Two-Wheelers and Property: all three `app_security.test_submission_policies` entries have `enabled=true`, `maintenance=false`, `publication=blocked`. The four experimental listing guard triggers are enabled. No active Vehicle or Property listings were observed in the category aggregate. **Static security readiness was supplemented with three subtransaction-scoped negative checks against one existing Pending Review listing in each family. Direct attempts to change status to Active were denied with expected review/publication guard errors; the exception subtransactions rolled back, leaving **0 Active** Cars, Two-Wheelers and Property listings and the same 3 Goods moderation requests. These denial probes do **not** replace new end-to-end owner submission tests for the three experimental families.** Do not claim these flows are fully accepted.
- After the three publication-denial probes, one **already submitted** Pending Review listing from each of Cars, Two-Wheelers and Property (previously missing an enqueue request) was inserted into the ordinary staging moderation queue after strict Test project/guard/worker preconditions. The deployed Edge worker processed all **3/3 in one attempt**, each with `no_review_flags`, final decision `routed_to_admin`, completed queue request and `pending_review` listing status. **0 experimental listings became Active.** This verifies real worker/finalizer handling of pre-existing submitted records, not fresh browser form submissions.
- No user listing was manually marked Active or approved by direct SQL. Existing dispatch and trigger logic, including append-only result evidence, processed both Goods and experimental-category acceptance cohorts.

## Production separation / release decision

- FairSwapProd `kriuhwppxgxsyyrbjsau`: PostgreSQL 17.6; 45 migrations; no experimental policy table; queue trigger active; moderation automation switch `true`; moderation Edge worker active; two existing recorded moderation outcomes (one `auto_approved`, one `routed_to_admin`).
- Production finalizer body MD5 `118d04445fdd9139d90decd2048945f1` differs from Test finalizer MD5 `cdadff159778cd055e8e9b9150ce5715`. That difference is expected: the Test function requires experimental-only schema/guards absent from Production. **Never copy the Test function, Test-only migrations, or untested category features wholesale into Production.**
- **No production schema or Web release is needed for the existing Goods auto-moderation flow**, based on this narrow observed evidence. The limited text evaluator is not complete scam protection: it checks selected prohibited wording, two known URL shorteners, and explicit payment-before-viewing text.
- The 58-file Backend snapshot is a shared-source baseline, not a universal script safe to `supabase db push` to a 45-migration Production project. A future Production change must be a separately reviewed, forward-only, Production-compatible incremental release.

## Ownership and release gates

1. Merge and verify this Backend source snapshot on its default branch only after source integrity + Backend CI review. Source migration hashes and immutable PG15 baseline must remain intact. Draft diagnostic PR #3 has a different scope; do not merge its CI-only overlays into this release.
2. Web owns Next.js, auth integration, seller UI, protected server routes and Vercel deployment. Web still runs local disposable Supabase tests using its copied SQL schema and pgTAP. The current byte-identical Backend duplicates **must not be deleted yet**: private cross-repository CI access, pinned source checkout, failure-mode checks, and revocation of Web backend deployment authority remain unimplemented. Maintain sole deployment ownership until the cutover is verified.
3. Before any category Production launch: execute end-to-end Cars/Two-Wheelers/Property owner submissions in Test; verify auto-evaluation, RLS, staff review, and **publication remains blocked**. Then obtain a separately approved category-release change to remove those guards when ready.
4. For future Production migration: capture verified backup/recovery capability, full migration delta, exact DB/Edge/Secrets compatibility, authenticated negative tests, CI, release window, rollback/forward-fix, review signatures and post-release monitoring. Never apply all 61 Test migrations by default.

**Status:** Hosted Goods canary PASS; existing submitted Cars/Two-Wheelers/Property worker finalization PASS (3/3) and direct-publication-denial probes PASS (3/3); fresh browser submissions for each experimental family NOT VERIFIED; Backend ownership transfer PREPARED, NOT EXECUTED; Production unchanged.
