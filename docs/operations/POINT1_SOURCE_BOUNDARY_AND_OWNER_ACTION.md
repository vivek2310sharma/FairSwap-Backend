# Point 1 — accepted source boundary and remaining operator handover

**Checkpoint:** 18 October 2026. **Original Point 1 is COMPLETE** ([accepted and closed #16](https://github.com/vivek2310sharma/FairSwap-Backend/issues/16)). This is the authoritative disposition of still-retained Web consumers, not an authorization for a hosted release, secret access or code deletion. OpenAI moderation and new approval logic belong to separate points; they are expressly excluded here.

## Original acceptance, without overclaiming

| Requirement | Evidence and precise acceptance |
| --- | --- |
| Create Backend repository | FairSwap-Backend exists with merged, independent baseline CI. |
| Move backend source | Backend has 58 immutable historical migration files, 10 pgTAP files, Supabase config, three Auth HTML templates, two Edge Function entrypoints and their Deno configs, shared worker cores and moderation modules. [Web staging #159](https://github.com/vivek2310sharma/FairSwap-Web/pull/159) and [main #160](https://github.com/vivek2310sharma/FairSwap-Web/pull/160) removed all **68 tracked duplicate SQL/test files**. Web's disposable CI reads exact reviewed Backend commit `2f26f839c3fa0ae690cf5c3795a983d62e1b6c47` via a Contents-read GitHub App. |
| Keep APIs/listing submission functional | Owner explicitly confirmed PASS. This is **owner-reported compatibility**, not a newly executed cross-platform end-to-end test. No Web API route or listing submission code was removed. |

## Source ownership is NOT identical to runtime-file location

**Canonical Backend source:** Supabase migrations, RLS/RPC contracts, server-side worker source, shared text-moderation contracts, Auth configuration/templates and future hosted releases **only after** writer ownership cutover.

**Web remains the application owner:** Next.js routes, server actions, HTTP APIs, Auth session integration, Supabase browser/server clients, generated application types, media/listing submission flows, app tests and Vercel deployment.

**Temporary, justified Web mirrors:** Two Edge worker cores, their two entrypoints + Deno configs, four moderation modules, three Auth templates and local Supabase config. Current Web tests and Edge relative import maps still consume these exact paths. Both Web branches fail closed against **13 pinned Git blobs** and independently byte-check Supabase config; their source matches pinned Backend. Keep until a verified runtime packaging/import replacement exists. Do **not** auto-copy privileged runtime modules into deployed Web builds or blindly delete `supabase/`. Web staging has additional **Test-only S1 non-delivering email capture** that must not be promoted to Production.

## Other Web-side operator utilities — inventoried, NOT silently transferred

Audited current Web `main` against Backend `main`: the paths below still exist only in Web. Copying them into Backend unchanged is **not** safe evidence of ownership transfer.

| Current Web path(s) | Observed coupling | Decision |
| --- | --- | --- |
| `tools/sync-supabase-auth-emails.mjs`, `tools/sync-supabase-recovery-email.mjs` | Manual Management API GET/PATCH, Test/Prod project targets, confirmation flags, local Auth config/template files, `SUPABASE_ACCESS_TOKEN` | **Hosted-write candidate.** Retain current known operator flow until owners/tokens inventoried; transfer only with controlled, non-overlapping authority. Never run `apply`/`rollback` as a source cleanup check. |
| `tools/preview-auth-emails.mjs` | Local-only fake token substitution and local template preview | **Web developer preview consumer**; non-deployment utility. Can later share Backend template fixture; no immediate deletion needed. |
| `scripts/backup-database.ts`, `scripts/backup-storage.ts`, `scripts/verify-restore.ts` | Manual Test/local backup and storage restore tools; require local artifacts, CLI/keys and dependencies. Database backup reads account/message/support/audit data. Restore uses PGlite and can write to explicitly selected recovery storage buckets. | **Requires independent privacy, recovery and dry-run audit.** Do not copy as an authorized Production restore solution or run against hosted systems. Web SQL files are no longer tracked, so restore's local migration-directory assumption needs reconciliation. |
| `scripts/check-expired-listings.ts`, `scripts/cleanup-orphan-media.ts` | Depend on Web-generated `Database` types and service-role key; can mutate listing or media status unless dry-run | **Operational consumers pending scheduler, RLS and privilege audit.** Do not move/remove or invoke by default. |
| `scripts/import-india-postal-data.ts`, `scripts/validate-official-csv.ts` | Depend on Web-generated types and shared CSV validation; importer supports remote targets with explicit guard; validator invokes importer | **India location tooling split needed.** Retain until call sites, target isolation, source provenance and idempotency are verified. |
| `scripts/bootstrap-admin.ts`, `scripts/seed-listings.ts` | Explicitly local-only development fixtures, local Supabase/project roles; seed also uses Sharp + Web-generated database types | **Web local developer setup**, not hosted Backend release authority. Retain. |

This is a source audit, **not** proof that every external cron, Vercel integration, manual device token or schedule has been exhaustively inventoried.

## Live boundary and release safety (read-only discovery)

Read-only Supabase migration and Edge Function metadata checked 18 October 2026:

- **FairSwapTest** `wpppxlnbzqynvhpeuavd`: **61 applied migrations**; `process-email-outbox` ACTIVE v9; `process-listing-moderation` ACTIVE v2.
- **FairSwapProd** `kriuhwppxgxsyyrbjsau`: **52 applied migrations**; `process-email-outbox` ACTIVE v3; `process-listing-moderation` ACTIVE v2.
- Corresponding Edge function bundle-hash metadata matches between Test and Production; differing versions or environment settings still require separate validation. Both hosted moderation switches are intentionally **ON**; do not reset them. Experimental Cars, Two-Wheelers and Property must remain gated.
- **Never push raw Backend's 58 historic SQL files to Production**: neither hosted migration ledger matches it. No migration, Edge/Auth patch, credential change or token read is needed to finish this original Point 1 scope.

## Exact remaining owner action — exclusive deploy writer only

[Backend follow-up #15](https://github.com/vivek2310sharma/FairSwap-Backend/issues/15) cannot be certified complete solely from source-control evidence: **three legacy Windows CLI tokens and one legacy Mac/iOS CLI token** have unknown active consumers. Web manual Auth PATCH and other operator scripts may still be executable with old Management API PATs. The two project-scoped Backend PAT checks proved **read scope and project isolation**, not write authority or old-token revocation.

**Owner action requested (metadata only, no secrets):** For each of those four *named* legacy CLI tokens, state **still used / no longer used / unsure** and its machine or deployment purpose. Confirm whether manual hosted Supabase releases from the Web/Windows/Mac workflows may now be frozen. **Never provide token values or screenshots showing values.**

After that answer, stage a **Test-first** cutover plan: remove existing Web/manual hosted write rights, verify negative permission tests without disrupting Web runtime, then separately enable reviewed Backend-owned releases with approval gates. Only after Test evidence should a Production handover be proposed. Do not revoke Web browser/server runtime Supabase keys.

Remaining file-by-file de-duplication is tracked in [#14](https://github.com/vivek2310sharma/FairSwap-Backend/issues/14). It is an optional safety-preserving cleanup, not a condition for closed original Point 1. Neither #14 nor #15 authorizes OpenAI moderation or approval-logic changes.
