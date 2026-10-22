# Vehicles + Property Production public-launch release gate

**2026-10-22 — IN PROGRESS; production activation has NOT happened.** This is an actionable read-only gate for the owner-requested FairSwap launch, not the submission/publication implementation itself.

## Verified starting state

- FairSwap Web Production: `https://fairswap.in`; Vercel project `fairswap-web`; GitHub `main`.
- FairSwapProd project ref `kriuhwppxgxsyyrbjsau`. Do not point an operator's session to FairSwapTest `wpppxlnbzqynvhpeuavd`.
- 7 category foundation migrations applied, containing 9 two-wheeler, 9 car and 10 Property rental category contracts.
- 18 Vehicle category records and 10 Property category records exist. All are inactive and cannot be assigned to new listings.
- All three contract versions have `new_assignment_enabled=false`.
- Three database `listings` guards reject non-draft status. Legacy seller submission is Goods-oriented and Property intentionally has NULL Goods price/condition fields.
- Web Production missing family release flags; current `POST_AD_EXPERIMENTAL_PRODUCTION_MODE=draft_only` intentionally forbids a live posting release.
- Existing Goods moderation must not change unintentionally. The family's approval/rejection and public-visible lifecycle need a *separately reviewed* implementation.

## Step 1 — read-only preflight

Independently verify target project and privileged session, then run `baseline.readonly.sql` against **FairSwapProd** with a read-only DB connection (or SQL Editor read-only transaction). Expected today: PASS *baseline only*; all experimental categories remain hidden. The SQL explicitly aborts if category assignments have been opened prematurely, if RLS/anon grants changed, if Test-only policies were copied, or if pinned foundation objects are missing.

## Step 2 — complete backend lifecycle in a new forward-only migration

Build from the exact current Production migration ledger, **not** the mixed Test `supabase/migrations` directory. Implement and review the following:

1. `public.seller_submit_family_listing(uuid,integer)`: authenticated owner+active-account+current-policy, pinned family context/category/version, exact supported path/fields, answer validation, property rent financial basis and null item pricing, six-digit Indian PIN/city/locality, known positive rent and vehicle amount rules, ready cover/gallery, expected revision and row locks. No caller-provided family or public status.
2. Transaction-scoped private actor-permits / lifecycle guards: only submit-owner transitions draft→pending; only AAL2 reviewer non-self approval/rejection pending→active/rejected; denial for unauthorized direct REST/RPC status write; preserve existing Goods pathway. Keep guards enabled throughout release.
3. **Moderation and freshness**: staff reads only bounded safe review projection, verified category/source and photos; review token must cover content, context, price, images and revision. Lock and compare at decision time; ensure worker-delivered status/media mutations cannot bypass review.
4. **Privacy**: never expose Property society names, private seller PIN/address, raw context or storage paths. Public Property must use known INR/month rent with explicit basis and separate deposit/maintenance; Vehicles use INR listing price.
5. **Recovery/expiry**: rejected edit/resubmit, material active edit returning to moderation, expired and removed flows; safe status notifications after moderation.

**Hard release invariant:** Server-controlled publication only after staff review, never a seller-controlled status switch or bypass of RLS.

## Step 3 — Web and Admin release

Use exact matching code in `FairSwap-Web` + `FairSwap-Admin`. Web production family submission must call the reviewed production RPC, fail closed on unsupported saved family, and not reuse the Test-only `POST_AD_SUBMISSION_TEST_ENABLED`. Confirm create, edit, photo processing, revision, submit, pending, staff review, public search and listing detail. Distinguish Vehicles and rental property units. Review English/Hindi fraud prompts for UPI collect requests, fake army officer, courier/advance-payment scams. Align future iOS/Android API separately.

## Step 4 — independent Test proof and production go/no-go

- Positive/negative pgTAP or equivalent cases for all 28 approved leaves and denied anon/other-owner/AAL1/self/stale-token clients; direct RPC status write, races and worker mutation; verify existing Goods regression.
- Exact Production-forward 55+ migration baseline (including subsequent 2026-10-22 moderation migration), isolated PG17 rehearsal and reviewed source SHAs. Never issue `db push` from the mixed historical Test tree.
- Fresh database recovery plan, owner-reviewed backup/restore evidence, performance and security advisors, fixed or accepted findings.
- Staged production Vercel build, synthetic authenticated test with consent and nonpublic fixture; promote tested build; observe worker logs and public anonymous visibility.
- Run `database-ready.readonly.sql` **only after** backend and category activation. Its PASS is necessary, not sufficient; do not infer external E2E/human approvals from DB schema.
- Explicit production rollout switch and kill-switch to stop new drafts/submissions without exposing private context; preserve existing live Goods records.

## Current GO / NO-GO

**NO-GO for customers** until the above lifecycle, tests and independent operator checks pass. Setting Vercel draft flags or flipping category booleans now would let users invest time in listings they cannot publish.

No production settings, migrations, user rows or Vercel deployment are modified by this release-preparation PR.
