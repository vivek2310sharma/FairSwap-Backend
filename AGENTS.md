# FairSwap-Backend agent instructions

FairSwap is an India-first peer-to-peer classifieds marketplace. This repository is the **canonical source** for its shared Supabase backend: 58 historical SQL migrations, 10 pgTAP files, `supabase/config.toml`, three Auth email templates, two Edge Functions (`process-email-outbox`, `process-listing-moderation`), their shared worker cores, and the moderation evaluator in `src/lib/moderation`. Supabase is the runtime; there is no API server. Do not scaffold standalone services.

Last reviewed: 20 October 2026, from the repository and docs dated up to 18 October 2026. Documentation does not prove live hosted state; report hosted facts as documented, owner-confirmed, or NOT RUN.

This file replaces the earlier Stage 0–2A instructions. Those stages (bootstrap, "Stage 2A only", "no further commit, PR or remote write", "moderation must remain disabled", "the only authorized tests are the five copied unit tests") are **historical and no longer apply**. Older text in `README.md`, `docs/extraction/*` and `DEPLOYMENT_OWNERSHIP.md` that says otherwise is superseded by `docs/operations/POINT1_SOURCE_BOUNDARY_AND_OWNER_ACTION.md` and `docs/operations/BACKEND_ONLY_RELEASE_CUTOVER.md`.

## Authority

- Follow the latest explicit human instruction. Plans, repository files and passing checks never authorize the next step; approval for a scoped task covers only that scope.
- Read before work: `docs/operations/POINT1_SOURCE_BOUNDARY_AND_OWNER_ACTION.md`, `docs/operations/BACKEND_ONLY_RELEASE_CUTOVER.md`, `docs/operations/DEPLOYMENT_OWNERSHIP.md`, and `docs/extraction/POINT1_BASELINE.md`.
- Branches: `main` is the only long-lived branch here (there is no `staging`; that exists only in Web). Work on a topic branch and open a PR to `main`. Do not merge, force-push, or push to `main` unless the owner tells you to for that change. The intended required check is `backend-ci-success`; branch protection is not configured in the repo, so do not assume it is enforced.
- Merging does not deploy anything.

## Ownership and deployment authority

- Backend owns the shared SQL, config, templates, Edge worker source and moderation modules. Web owns Next.js, Vercel, Server Actions, Auth session integration, media HTTP routes and the generated `src/types/database.ts`; Web runtime Supabase keys stay in Web. Admin, iOS and Android are separate repos that consume this backend.
- Web keeps temporary byte-pinned mirrors of the worker cores, entrypoints, `deno.json` files, Auth templates, four moderation modules and `config.toml`; Web CI materializes Backend source at a pinned commit (`2f26f839c3fa0ae690cf5c3795a983d62e1b6c47`). Do not restore duplicate SQL to Web and do not blindly delete Web's `supabase/`. `process-email-outbox-s1-capture` is Test-only, excluded from Backend, and must not reach Production.
- **Hosted deployment authority has NOT transferred to Backend.** There is no deploy workflow and none may be added without explicit authorization. Production's 52-migration change was a one-off, explicitly authorized manual CLI operation and did not transfer authority. Never grant duplicate deployment authority to Web and Backend.
- Release gates still open (`docs/operations/BACKEND_ONLY_RELEASE_CUTOVER.md`): inventory of remaining Web/external privileged writers; independent negative proof that the four legacy personal PATs are revoked (currently owner-attested only); a Backend-owned least-privilege operator identity or protected GitHub Environment with human approval; an isolated 52-version Production workspace check; proof Web cannot deploy; an exact isolated Test history. Also open: review of broad EXECUTE grants on `public.handle_listing_moderation_enqueue()` and `app_security.trg_fn_notify_moderation_worker()`, and unverified Production backup/restore.
- Do not request or disclose old token values. Do not revoke Web runtime keys. Two repo-level Actions secrets hold project-scoped PATs; `backend-scoped-token-check.yml` is a manual, read-only check restricted to the owner on `main`. Never run or modify it without the owner. It proves read isolation only, not release authority.

## Environments and migrations

| Environment | Project ref | Applied migrations |
|---|---|---|
| Production (FairSwapProd, PG 17.6) | `kriuhwppxgxsyyrbjsau` | 52 = 45 baseline + 7 forward-only (final `20261017205807`) |
| Test (FairSwapTest) | `wpppxlnbzqynvhpeuavd` | 61 = 58 source + 3 Test-only |
| This repo `supabase/migrations/` | n/a | 58, immutable |

- The 58 files are immutable: names, order and exact bytes, pinned by `docs/extraction/MIGRATION_MANIFEST.sha256` (digest `eb2dfee7…1dd`). Do not edit, rename, add, remove or reorder them; CI fails if you do. New database work is a new, separately approved, forward-only, environment-specific migration, tested on Test first.
- **Never run `supabase db push` (or any apply) from the raw 58-file directory against Production or Test.** Production is built from an isolated workspace of the 45 baseline files plus 7 forward files renamed to CLI-issued versions and checked against `releases/production/category-foundation-v1/forward-migration-plan.json` and the receipt `production-deployment-20261018.json` (authoritative; the plan and `manifest.json` carry historical statuses). Verify with `node scripts/release/verify-production-52-baseline.mjs <absolute isolated workspace>` (no SQL, no network; refuses the Backend root).
- Test-only and never for Production: `enable_test_*` migrations (two-wheeler, car, property, family submission), `20261011092234_test_family_submission_v1`, `20261012120000_post_ad_current_base_compatibility` (source-review proposal, not applied), `20261010214201_staff_listing_review_context`, and everything under `releases/test-only/` (those are receipts, not auto-run migrations). Production's finalizer intentionally differs from Test's; never copy the Test function to Production.
- Production has Cars, Two-Wheelers and Property hidden and disabled (publication guards block review and publication). Do not activate categories or flip `releaseGates`.
- Any future Production change needs a fresh isolated 52-version workspace, a live-ledger comparison, reviewed forward-only migrations with new receipts and guards, a verified backup, compatibility and negative tests, a release window, rollback or forward-fix, and review signatures.
- New migrations follow the existing hardening header: `begin; set local lock_timeout='5s'; set local statement_timeout='30s';`.
- No hosted SQL, migration, reset, Auth, Storage, Vault, worker-activation or deployment operation without explicit authorization. Never query or change hosted config (including the moderation switch) as part of repository work.

## SQL conventions and invariants (do not break)

- Only `public` is API-exposed; `app_security` is private. New table: `ENABLE ROW LEVEL SECURITY` (use `FORCE` where the neighbors do), `REVOKE ALL … FROM PUBLIC, anon, authenticated`, then explicit minimal (often column-level) grants. Append-only evidence tables (for example `listing_moderation_results`) keep UPDATE/DELETE revoked.
- New function recipe: logic in `app_security.impl_*` as `SECURITY DEFINER SET search_path=''`; a thin `public.<name>` `SECURITY INVOKER SET search_path=''` wrapper for client calls (wrapper params unprefixed, impl params `p_`); `REVOKE ALL FROM PUBLIC` (and anon where non-public) then an explicit `GRANT`; fully qualified names (`pg_catalog.clock_timestamp()`, `public.*`). Staff functions check `app_security.is_active_staff_aal2(role)` inside the body (active account, JWT `aal2`, staff role; `administrator` satisfies every role).
- Preserve RPC names, parameter names, overloads (both `seller_submit_listing` overloads), result shapes, error codes (`PT409 MODERATION_REVIEW_CONFLICT`, `0A000 DEPRECATED_RPC`, `42501`, `POLICY_ACCEPTANCE_REQUIRED:`, `LISTING_MEDIA_NOT_EDITABLE:`), grants, RLS and triggers. Web, iOS, Android and Admin depend on them. Do not re-grant `public.moderate_listing` or `app_security.impl_moderate_listing` to clients, and do not re-grant staff location functions to anon. Keep `listings_insert_policy` (active account, policy accepted, category eligible) and the minimal listings column grants.
- Listing statuses: `draft, pending_review, active, reserved, sold, rejected, paused, expired, removed`. Review-visible edits bump `revision` and invalidate moderator tokens; lock order is listing row, then media; `moderate_listing_reviewed` takes `FOR UPDATE` and rejects stale revision or status; moderators cannot review their own listings.
- Moderation queue: one active request per listing, lease tokens, generation ids, append-only results. The finalizer requires ruleset `prototype_v0.1.1` and scope `title_description`, and must never auto-approve when the kill switch is off or missing. Dispatch triggers and cron must never raise or roll back the transaction.
- Secrets: the moderation worker secret lives only in Vault and is verified by the service-role-only RPC `verify_moderation_worker_secret`; never put secrets in Edge env, `cron.job` text or source. The email worker secret is also an Edge env var (`EMAIL_WORKER_SECRET`). Storage buckets stay private; clients get no direct access to `listing_moderation_*`, `email_outbox` or `app_system_settings`.
- Both Edge Functions use the service-role key with `verify_jwt=false`; safety rests on the worker secret, SQL grants and the kill switch. Keep the order: format check, config check, Vault verification (fail closed), then claim.

## Moderation status

- V1 is live: three regex rules (prohibited wording, shortened link, payment-before-viewing) on title and description only. It does not detect Hindi/Hinglish scams and does no image moderation.
- `app_system_settings.moderation_automation_enabled` defaults to `'false'` in migrations and CI asserts `false` on the local database. Per owner-confirmed 17–18 Oct 2026 receipts it is intentionally **ON** in hosted Test and Production. Do not toggle it or assume either state; the Vault copy can only veto.
- V2 (`docs/moderation/MODERATION_V2_CONTRACT.md`, policy `fairswap_moderation_v2.0.0`) is **design only**. It does not authorize implementation, SQL, provider calls or rollout. Do not add OpenAI calls or new approval logic.
- Changes to `src/lib/moderation/*` affect the Edge worker and the Web mirror. Rule IDs, ruleset version and scope are asserted by tests and the DB finalizer; bump them only in coordination with the DB.

## Commands and CI

Node `>=24.15.0 <25` (CI uses 24.15.0), pnpm 10.12.1 via corepack, exact dependency pins checked against `scripts/ci/toolchain.json`.

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts --engine-strict
corepack pnpm verify:migrations   # 58 files match the manifest exactly
corepack pnpm typecheck           # tsc --noEmit over the explicit tsconfig include list only
corepack pnpm test:unit           # vitest run: 5 files, 93 tests, network blocked
```

There is no lint or build script. `.github/workflows/backend-ci.yml` runs `unit-integrity` (toolchain pins, baseline and Production-category verifiers, typecheck, unit tests under `env -i`), `database-pg15` (disposable PG 15.8 with all 58 migrations, 9 pgTAP suites, 270 assertions, local security snapshot) and the aggregate `backend-ci-success`. CI has no secrets and no deploy step. Hosted CI verification of the full 270-assertion contract was last recorded as UNVERIFIED.

- **Adding or changing a test is a multi-file change.** `vitest.config.ts` uses an explicit `include` list, so a new `*.test.ts` is silently not run. Update together: `vitest.config.ts` `include`, `tsconfig.json` `include`, `approvedFiles` and the 93 total in `scripts/ci/verify-unit-results.mjs`, and the fixture counts (`[39,7,10,3,34]`, 26 suites) in `scripts/ci/verification.test.mjs`. Changing counts inside an existing file needs the same updates. Never use `it.skip`, `it.todo` or `.only`.
- `tests/setup/no-network.ts` is pinned by SHA-256 in `toolchain.json` and `verify-unit-results.mjs`; editing it breaks CI. Unit tests use mocked clients and an injected `fetch`, no env loading, and a pure-Node environment. The five copied unit tests keep their bytes and expectations; fix harness issues, not production logic, unless asked.
- Adding a pgTAP file or changing a plan count requires updating `requiredSuites` in `scripts/ci/verify-db-results.mjs` (9 suites, 270 assertions). `schema_email_outbox.test.sql` is deliberately excluded (its standalone run FAILED: 34 planned, 32 authored, 31 emitted); do not call it passing.
- `scripts/ci/run-local-db.sh` needs native Linux amd64, Docker 28+, and `sudo iptables`/`nsenter`. Run it only on a disposable machine, never on Windows, Docker Desktop or a laptop. It never uses `--linked`, `--db-url` or `--project-ref`.
- The CTO or integration owner exclusively edits `package.json`, `pnpm-lock.yaml`, `vitest.config.*`, `tsconfig.json`, `supabase/config.toml` and CI workflows unless you are explicitly told otherwise.
- Not tested anywhere in this repo: Edge entrypoints and the Deno runtime, the real Resend path, and hosted Vault auth.

## Code conventions

- ESM, TypeScript strict, zod 3.24.x. Parse every external boundary (config, payloads, claimed jobs, RPC results) with `safeParse` and fail closed with generic messages. Imports are extensionless relative paths, plus `@/` in tests. Edge entrypoints use a `declare const Deno` shim and guard `Deno.serve`.
- Moderation evaluator is pure: no network or DB. `checker.ts` calls rules through the `rulesModule` namespace so `vi.spyOn` works; do not switch to direct named imports. Flags carry only rule id, field and a fixed reason, never raw text, URLs or PII.
- Email worker (`supabase/functions/_shared/email-outbox-worker.ts`): auth by `x-email-worker-secret` or Bearer (plain `===` comparison); RPC `data === true` is required or the run returns 500; backoff 60/300/900/3600/7200 s, max 5 attempts; Resend `Idempotency-Key` per job. Preserve outbox deduplication, idempotency, lease recovery and cron contracts.

## Safety and evidence

- Never expose credentials, tokens, private user data or backup contents. Use credential-free remote URLs. Do not commit `.env*` (ignored), keys, dumps or `artifacts/`.
- Do not modify Web, Admin, iOS or Android from Backend work unless explicitly authorized; preserve existing work in other checkouts.
- Report exact changed files, branch/base, commands and actual results. Separate source inspection, local verification and hosted acceptance. Use PASS only for checks that ran; otherwise NOT RUN, BLOCKED or UNVERIFIED. Web/iOS/Android/Admin compatibility with this backend is owner-reported, not an executed cross-platform test.
