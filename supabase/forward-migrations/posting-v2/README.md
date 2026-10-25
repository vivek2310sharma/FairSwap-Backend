# Posting V2 / Mobile Phones local release candidate

25 October 2026. Source changes only; no hosted operation, GitHub operation or deployment was performed. Mobile Phones defaults **off** in the database and Web. Apply only reviewed patches to current remote release bases; the local release checks below pass. Hosted rehearsals and deployments remain ChatGPT-owned.

## Contract and ownership

Backend owns the seven new RLS tables, private implementation functions, public invoker wrappers, catalogue seeds and cleanup. Web owns cookie-authenticated HTTP, processing, account-bound IndexedDB recovery, the form and public presentation. Admin uses its existing same-origin mutation dispatcher, active staff/AAL2/current-policy checks and audited catalogue RPC. No new dependency, CI change, payment integration or AI inference is included.

The stable choice is `mobiles / mobile-phones / 2`, resolved to the database's category UUID. The common selection controller retains compatible common fields/photos and requires confirmation before clearing incompatible details. Existing vehicle/property forms and submission function bodies are unchanged. Historical Electronics listings/categories remain intact.

The catalogue RPC returns a version and revision, compact brands/models/aliases, the mapped category ID and eligibility. React request caching deduplicates reads without caching private account state across requests. Only enabled catalogue entries are accepted again at submission; the catalogue is deliberately focused rather than exhaustive. Proper model names remain in their manufacturer spelling. Sellers can select a staff-reviewed Other model. There is no model price benchmark.

Photos are decoded/compressed on the device, then independently decoded and sanitized by Sharp before Storage. Sanitized originals and derivatives use a private temporary bucket and owner/session/media/attempt paths. One upload at a time in the UI; database leases serialize same-photo retries and the session lock enforces eight slots. Retry blobs contain sanitized image bytes only. Failed attempts remain discoverable by recursive session-prefix cleanup, including superseded attempts.

Submission freezes the photo set, prepares create-only objects in the existing listing buckets, accepts byte-identical retry collisions, then calls `submit_mobile_v2` with the user's session. A single PostgreSQL transaction inserts the listing, mobile context and ready photo rows, then invokes the installed `seller_submit_listing(uuid)` for normal review/queue behavior. No active status is forced. Failed transactions leave prepared objects for retry or expiry compensation. Photo paths remain compatible with existing signed delivery and deletion APIs.

Mobile context facts are immutable from client APIs and include captured brand/model labels so later catalogue renames do not change buyer evidence. Existing common listing editing remains available; category reassignment is rejected for a saved mobile listing. Other-model and older-group listings require staff activation through the existing moderation RPC; automated activation fails closed and the listing remains pending. Giveaway, Other model and older-group flags are structured identifiers only. Advance/courier demands and contact/payment destinations are blocked rather than retaining their content in risk flags. Fraud pattern coverage is bounded, not a guarantee of fraud detection.

The existing media upload route also sanitizes originals before persistence, including subsequent edits and native API uploads. Its URL, cookie/Bearer behavior and response contract are unchanged; newly uploaded original objects are WebP. Old stored originals are not rewritten.

English/Hindi field labels, safety copy, AI placeholder, included-item declarations and PIN controls are included in the phone form. Catalogue names remain proper nouns. Phone-specific validation summaries, field messages, upload errors and transport failures now have Hindi presentation without changing unrelated legacy translations. Public detail pages retain their existing page-language behavior.

## Migrations and access

CLI 2.117.0 generated both filenames locally. Never place them in the immutable 58-file source directory and never push that raw historical directory.

1. Foundation: `supabase/migrations/20261025131116_posting_v2_mobiles.sql` relative to this directory. Add it to each environment's separately reconstructed, ledger-matched release workspace.
2. Activation, only after consumers are deployed and automated checks pass: `activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql`. Keep it outside the initial foundation apply set.

New tables: `posting_category_definitions`, `phone_brands`, `phone_models`, `posting_upload_sessions`, `posting_staged_media`, `listing_mobile_contexts`, `listing_phone_risk_flags`. All enable and force RLS. No client table writes are granted. Catalogue tables have authenticated read policies; sessions/media have owner-only reads; mobile facts have existing public-visibility/owner/staff read checks; risk flags are staff-only. Catalogue modifications run through staff MFA/policy validation and existing audit logging. Security/release controls are not accepted as catalogue metadata.

Public invoker RPCs: `posting_v2_catalogue`, `posting_v2_session`, `submit_mobile_v2`, `admin_phone_catalogue`; service-only invoker RPCs: `posting_v2_media_ready`, `posting_v2_cleanup`. Their privileged bodies live in `app_security` with empty search paths and explicit EXECUTE revocations/grants. The mobile listing trigger applies contact/payment/price/context/category guards to existing listing writes. Required categories, postal tables and installed submission functions must exist; conflicting legacy Mobile Phones attributes abort the migration for review.

`posting-staged` has no client Storage policy. Existing listing buckets remain private and server-mediated. Session cleanup tombstones intentionally retain the owner UUID without an auth-user FK until cleanup, so account deletion cannot erase the object cleanup inventory. Acknowledged cleanup removes the tombstone and staged-media rows. Submitted sessions retain their committed listing/media; unreferenced prepared objects are removed. Objects and PostgreSQL are not treated as one atomic transaction.

## Exact task file manifest

Paths below are repository relative. Many Web paths were dirty before this task; preserve their other changes and select only reviewed Posting V2 hunks for release. Do not publish the entire current working tree. No fetch/pull or branch synchronization was authorized or performed.

Observed HEADs (not synchronized release bases): Web `93163a7cac11ac7b49f641fc3853d5ce9ebde8cb`, Backend `213b57c84e2b3767e3ab3499846dd280bf3315c3`, Admin `eed97a8cf0b95569ffd471367dd16461f7212c97`.

### FairSwap-Backend

Created:

- `supabase/forward-migrations/posting-v2/supabase/migrations/20261025131116_posting_v2_mobiles.sql`
- `supabase/forward-migrations/posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql`
- `supabase/forward-migrations/posting-v2/README.md` (this handoff)
- `scripts/cleanup-posting-v2.mjs`
- `scripts/ci/test-posting-v2.mjs`
- `scripts/ci/verify-canonical-checkout.mjs`
- `scripts/ci/canonical-checkout.test.mjs`

### FairSwap-Web

Created:

- `src/lib/listings/mobiles/contract.ts`
- `src/lib/listings/mobiles/server.ts`
- `src/lib/listings/mobiles/public.ts`
- `src/lib/listings/mobiles/locale.ts`
- `src/lib/listings/posting-selection.ts`
- `src/lib/listings/posting-recovery.ts`
- `src/components/listings/MobilePhoneForm.tsx`
- `src/components/listings/PreListingMediaUploader.tsx`
- `src/components/listings/PostingAIAssistant.tsx`
- `src/components/listings/MobileListingDetails.tsx`
- `src/app/api/post-ad/sessions/route.ts`
- `src/app/api/post-ad/sessions/[id]/media/route.ts`
- `src/app/api/post-ad/submit/route.ts`
- `tests/unit/mobile-posting-v2.test.ts`
- `tests/unit/mobile-phone-form.test.tsx`
- `tests/unit/posting-selection.test.ts`
- `tests/unit/posting-v2-media-processing.test.ts`
- `tests/unit/posting-v2-upload-recovery.test.ts`
- `tests/unit/mobile-validation-locale.test.ts`

Modified:

- `src/app/account/listings/new/page.tsx` — gated typed phone entry, catalogue capability loading.
- `src/app/listings/[slug]/page.tsx` — shared seller-declared mobile facts.
- `src/app/api/listings/[id]/media/route.ts` — sanitize before persistent upload.
- `src/components/listings/GoodsPostAdEntry.tsx` — loaded mobile capability.
- `src/components/listings/PostAdSubcategoryChooser.tsx` — dedicated phone link; removed Available badges.
- `src/components/listings/MacroCategorySelector.tsx` — truthful mobile safety copy; Other Coming soon.
- `src/components/listings/PincodeLocationPicker.tsx` — optional resolved-location callback, hidden landmark and Hindi labels; legacy defaults retained.
- `src/components/listings/post-ad-category-icons.tsx` — Wearables icon replaces mobile General Electronics.
- `src/lib/listings/post-ad-category-catalogue.ts` — mobile mapping; unreleased tablet/wearable/accessory choices; blocked animals remain blocked.
- `src/types/database.ts` — service media-completion RPC type.
- `tests/unit/post-ad-selector.test.tsx`, `tests/unit/post-ad-goods-entry.test.tsx` — changed category/badge expectations.
- `tests/security/seller-media-api.test.ts` — sanitized WebP original expectation and pre-storage metadata-stripping assertion.
- `README.md`, `docs/CURRENT_STATE.md`, `docs/ROADMAP.md`, `docs/WORKFLOW.md` — local candidate/handoff pointers.
- `.env.example` — default-off server-only Mobile Phones flag (selective patch only; no environment file is included in the ZIP).
- `src/app/page.tsx`, `src/app/account/listings/page.tsx` — required generated PageProps signature with preserved no-argument/default-query behavior.
- `docs/MOD_03A_AUTOMATIC_MODERATION.md` — authoritative pinned Backend Vault-migration link.

### FairSwap-Admin

Created:

- `src/app/admin/catalogue/mobiles/page.tsx`
- `src/app/admin/catalogue/mobiles/actions.ts`
- `src/lib/admin/mobile-catalogue.ts`
- `src/components/mobile-review-evidence.tsx`

Modified:

- `src/app/admin/categories/page.tsx` — Mobile Catalogue navigation.
- `src/app/admin/listings/[listingId]/page.tsx` — phone facts and structured moderation signals.
- `src/lib/admin/mutations.ts` — validated catalogue operation in existing authorization/audit path.
- `tests/admin-migration.test.ts` — catalogue operations across existing positive/negative role tests.

## Automated release-readiness evidence

All evidence below was rerun locally on 25 October 2026. GitHub CI and hosted environments were not queried or changed.

| Check | Result |
| --- | --- |
| Web typecheck | PASS |
| Web full lint | PASS, zero errors; one pre-existing unused-variable warning in production-family-submission-boundary.test.ts |
| Web docs check | PASS, 81 tracked Markdown files and 9 active guides |
| Web focused unit/security/default/query tests | PASS, 17 files / 209 tests |
| Web standard production build | PASS, unchanged pnpm build / Next 16.3.5 Turbopack |
| Admin typecheck and full lint | PASS |
| Admin complete automated suite | PASS, 22 files / 540 tests |
| Admin standard production build | PASS, unchanged pnpm build / Next 16.3.5 Turbopack |
| Backend typecheck and existing unit suite | PASS, 5 files / 93 tests |
| Posting V2 disposable PostgreSQL contract checks | PASS, 30 checks |
| Canonical migration/manifest verification | PASS, exact approved manifest digest and all 58 SQL SHA-256 hashes |
| Canonical-checkout negative tests | PASS, 2 tests; modified SQL/whitespace/BOM/mixed newlines rejected |
| Cleanup script syntax check | PASS |

Standard builds used isolated source copies with unchanged lockfiles, offline-installed physical dependency trees and no environment files. No Webpack fallback or production bundler configuration change was needed. Both standard Turbopack builds passed, confirming that the old external-junction error was a fixture limitation. Web emits existing metadataBase warnings and an unavailable sitemap-enrichment message in this environment-file-free build; build exit status is zero.

The original strict raw-byte manifest checker is unchanged. This Windows checkout has core.autocrlf=true; its manifest and SQL working files are CRLF conversions of the approved LF Git blobs. Run `node scripts/ci/verify-canonical-checkout.mjs` from Backend: it first proves each working file is byte-identical or exactly LF-to-CRLF converted, checks the complete on-disk SQL inventory, verifies Git blob hashes against the approved manifest, then runs the original strict baseline verifier in an isolated canonical directory. It never rewrites protected files, changes actual hashes, edits pins or permits arbitrary normalization. Use the normal strict check on canonical LF release/CI checkouts. Raw Windows working-tree verification still rejects different raw bytes by design.

The PostgreSQL runner applies both exact new artifacts in memory and loads the existing submission function with explicit fixture auth/staff/reference helpers. Owner isolation, eight-slot enforcement, immutable attempt leases, media/submission idempotency, context permissions, catalogue staff guards, rollback, pending-review transition and committed-media preservation are covered. This is not a live Supabase Storage/worker test or an environment-specific history rehearsal.

Remaining integration work: ChatGPT must port the selective changes onto current remote bases (owner reports Web main +33, Web staging +37, Backend main +15 and diverged Admin staging), run exact-history rehearsals and existing CI there, then release staging before production. No fetch, pull, rebase, merge, commit, push or hosted operation occurred here. Preserve newer remote behavior when resolving patch-context differences.

## Runtime variables and cleanup configuration

Web: new server-only `POST_AD_MOBILES_V2_ENABLED` (unset/false until activation); existing `NEXT_PUBLIC_SUPABASE_URL`, publishable/anon key and existing server `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. Keep each deployment paired to its existing Test/Prod project. No browser service secret and no AI key.

Admin: no new environment variable; existing environment/project validation, production release controls, host-only sessions, staff MFA and current-policy checks continue.

Cleanup worker: `POSTING_CLEANUP_SUPABASE_URL`, `POSTING_CLEANUP_SERVICE_ROLE_KEY`, privately injected by a separately configured operator scheduler. Once daily is sufficient; objects expire after about 24 hours and are removed on the next successful run (normally 24–48 hours). A short grace period protects in-flight preparation. A failure is retried idempotently on the next run; do not acknowledge failed Storage deletion.

Example commands, to be configured by ChatGPT in the respective private scheduling environment, not run during this task:

```text
node scripts/cleanup-posting-v2.mjs --execute --project-ref=wpppxlnbzqynvhpeuavd
node scripts/cleanup-posting-v2.mjs --execute --project-ref=kriuhwppxgxsyyrbjsau
```

The script validates the exact URL/project pairing, loads no environment files, limits each run to 1,000 sessions, enumerates all temporary attempt prefixes before deletion, and preserves committed media. No 15-minute schedule, Vercel Hobby cron or avatar-cleanup change is included. Scheduler setup itself was not performed.

## ChatGPT release sequence

Documented targets: Web staging `https://fair-swap-git-staging-fairswap.vercel.app`, Production `https://fairswap.in`; Admin staging `https://fairswap-admin-git-staging-fairswap.vercel.app/admin`, Production `https://admin.fairswap.in`. These are source-documented mappings, not freshly verified hosted state. The Admin runbook records a Preview-only ignored-build restriction that skips ordinary Production builds: a main merge alone does not deploy Admin. The release owner must use the separately authorized exact-source Production build path and preserve/restore the existing boundary; this task changes no Vercel setting.

1. Preserve unrelated local work; review/select this manifest's source hunks on environment-appropriate bases. Retain the focused PageProps/docs fixes and canonical-checkout verifier; rerun the passing release checks after integration onto newer sources. Keep existing CI gates and run the new focused tests; do not ship Test-only vehicle/property or email-capture source into Production.
2. Reconstruct the actual FairSwapTest migration ledger in an isolated disposable release workspace; the documented historical 61/52 counts are not live evidence. Rehearse the additive foundation and negative RLS/ownership/Storage/cleanup cases against the exact installed Test contract. The in-memory fixture does not replace this automated prerequisite.
3. Apply only `20261025131116_posting_v2_mobiles.sql` to FairSwapTest (`wpppxlnbzqynvhpeuavd`) through the authorized release owner. Keep activation out of that apply set. Deploy compatible staging Admin and Web through GitHub/Vercel with the Web route flag false. Run automated deployed contract checks.
4. Apply the separate activation migration to Test and deploy Web with `POST_AD_MOBILES_V2_ENABLED=true`. Verify the automated complete posting/moderation/public-display and legacy-edit regression suite. No owner manual staging approval/testing gate is added.
5. Reconstruct and compare the actual FairSwapProd ledger (`kriuhwppxgxsyyrbjsau`) in a separate isolated workspace; preserve its existing submission/finalizer contracts. Verify backup/release authority and rehearse the additive foundation against that exact baseline. Apply the same foundation artifact only, then deploy selected compatible Production Admin and Web source with the route flag false.
6. Apply the separate activation artifact to Production after automated release checks; deploy Web with the route flag true. Configure separate daily Test/Prod cleanup runs and capture automated release receipts. Do not toggle unrelated category release gates or moderation switches.

## Owner production acceptance, after deployment

Review automated evidence that: Sell/fixed/negotiable and zero-price Give away enter review; 0/9/unready photos and another account's session are denied; refresh/retry does not duplicate listings; persisted objects have no EXIF/GPS; expired and failed preparations are removed while committed photos survive; phone badges explicitly say seller-declared and show pickup only/area-city privacy; unrecognized models remain staff-reviewed; nonstaff/AAL1 catalogue writes fail; legacy listing editing, media delivery and existing vehicle/property contracts remain compatible. Record the deployed SHA/migration versions and cleanup completion counts. No predeployment owner manual test is requested.

Rollback: disable the Web flag and definition eligibility, use Git revert/previous Vercel deployments, and leave additive tables/data intact; prefer a reviewed forward fix over destructive down migrations or dropping referenced objects.

## Documentation checks consulted

Supabase [changelog](https://supabase.com/changelog), [Storage access controls](https://supabase.com/docs/guides/storage/security/access-control), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), and installed CLI help were reviewed. Catalogue references include [Apple India](https://www.apple.com/in/shop/buy-iphone), [HMD manuals](https://www.hmd.com/en_int/support/user-guides), [JioBharat](https://www.jio.com/jcms/jiobharat/) and [JioPhone Prima](https://www.jio.com/jcms/jiophone-prima/). No manufacturer prices are used as listing benchmarks.
