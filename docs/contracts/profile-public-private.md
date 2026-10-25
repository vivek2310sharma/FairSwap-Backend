# Public / private profile contract (Web today; Android & iOS later)

Source: `supabase/forward-migrations/profile-onboarding/` (forward-only, additive). All RPCs are in `public` and called with the user's JWT unless marked **service**.
Failures return `{ "success": false, "error": CODE }` (HTTP 200) — not exceptions — except direct table writes (see Direct writes).

## Public (visible to other users)
`public.profiles` (SELECT granted to anon/authenticated, RLS active accounts): `id, display_name, avatar_url, bio, created_at`.
Do not read `city`/`state` as the user's location (legacy, may be NULL; **not** overwritten by this feature). `avatar_path` is internal bookkeeping; clients use `avatar_url` only.
Public location: `public_profile_location(p_user_ids uuid[])` → `[{ "user_id", "locality", "district" }]` (max 50 ids; only active + onboarded users; **never** PIN/ids/state). anon + authenticated.

## Private (owner only, `public.user_private_details`)
Columns: `full_name, pin_code (text, ^[1-9][0-9]{5}$), locality_id, city_id (district id), state, preferred_language ('en'), onboarding_completed_at`. RLS: owner SELECT only; no client INSERT/UPDATE/DELETE (no grants, no policies). Readable even when the account is restricted.
Email is read from Supabase Auth, never copied here.

## RPCs
| RPC | Args | Success | Error codes |
|---|---|---|---|
| `save_my_public_profile` | `p_display_name text, p_bio text default null` | `{success:true, display_name, bio}` | `NOT_AUTHENTICATED, ACCOUNT_RESTRICTED, INVALID_DISPLAY_NAME, INVALID_BIO` (+`reason`), `PROFILE_NOT_FOUND` |
| `complete_my_profile` | `p_full_name text, p_pin_code text, p_locality_id uuid, p_city_id uuid default null, p_preferred_language text default 'en'` | `{success:true, onboarding_completed:true, locality, district, state}` (no PIN) | `NOT_AUTHENTICATED, ACCOUNT_RESTRICTED, INVALID_LANGUAGE, INVALID_FULL_NAME, INVALID_PINCODE, PINCODE_NOT_FOUND, PINCODE_ADMIN_DATA_UNAVAILABLE, CONFLICTING_POSTAL_STATES, LOCALITY_REQUIRED, PIN_LOCALITY_MISMATCH, DISTRICT_REQUIRED, DISTRICT_MISMATCH` |
| `save_my_profile_details` (single Save Changes) | `p_display_name text, p_bio text default null, p_full_name text default null, p_pin_code text default null, p_locality_id uuid default null, p_city_id uuid default null, p_preferred_language text default 'en', p_clear_full_name boolean default false` | `{success:true, display_name, bio, onboarding_completed, locality?, district?, state?}` (location keys only when a PIN/locality was supplied; no PIN returned) | union of the `save_my_public_profile` and `complete_my_profile` codes. All validation runs before any write, so `success:false` means nothing was written; one function call = one transaction. No PIN/locality → public-only save (legacy users; no private row is created for it). Full name: `p_clear_full_name=true` clears it (no PIN needed); non-empty `p_full_name` sets it; NULL/empty with `p_clear_full_name=false` leaves it unchanged; both together → `INVALID_FULL_NAME` (`reason:conflicting_clear`). A name-only / clear-only call never completes onboarding and never changes a saved location. The superseded 7-arg overload does not exist (migration 8 was never applied anywhere). |
| `get_my_private_details` | — | `{exists, full_name, pin_code, locality_id, locality, city_id, district, state, preferred_language, onboarding_completed, onboarding_completed_at}`; no row → `{exists:false, onboarding_completed:false}` | — |
| `public_profile_location` | `p_user_ids uuid[]` | array above | — |
| `admin_list_profile_text_violations` | `p_limit int default 200` | `[{profile_id, display_name_reason, bio_reason}]` (administrator AAL2; raises on forbidden) | — |
| **service** `service_set_profile_avatar` | `p_user_id uuid, p_old_path text, p_new_path text, p_public_url text` | `{success:true, previous_path, avatar_url}` | `FORBIDDEN, NOT_AUTHENTICATED, ACCOUNT_RESTRICTED, INVALID_AVATAR_PATH, INVALID_AVATAR_URL, AVATAR_OBJECT_MISSING, PROFILE_NOT_FOUND, AVATAR_CONFLICT` |
| **service** `service_clear_profile_avatar` | `p_user_id uuid, p_old_path text` | `{success:true, previous_path}` | `FORBIDDEN, NOT_AUTHENTICATED, ACCOUNT_RESTRICTED, PROFILE_NOT_FOUND, AVATAR_CONFLICT` |

Location rules: `complete_my_profile` re-runs `lookup_pincode`; the locality must be mapped to the PIN in `postal_pincode_localities`; district = the locality's `cities` row and must be one of the PIN's districts (multi-district PIN requires `p_city_id` → else `DISTRICT_REQUIRED`); state is derived. Names are never accepted from the client. `onboarding_completed_at` is set only on success (and never cleared).
Validation `reason` values: `LENGTH, CONTROL_CHARS, CONTACT_INFO, PHONE_NUMBER, LINK, PAYMENT_INSTRUCTION, IMPERSONATION`. Display name 2–50 chars; bio ≤ 500. Signup fallback name: `Member-<8 letters>` (never from email).

## Avatar semantics
- Bucket `avatars` (public, `image/webp`, ≤200 KB). Clients **never** write storage or `profiles.avatar_url/avatar_path` (column UPDATE revoked). Only the authenticated Web route, using the service role, uploads a re-encoded EXIF-free WebP to `<user_id>/<8–64 hex>.webp`, then calls `service_set_profile_avatar` with the **already-verified** user id.
- `avatar_path` = bucket-relative path (CAS key); `avatar_url` = full public URL, must end with `/avatars/` + `avatar_path` (so existing readers keep using `avatar_url` directly). No hostname is stored in DB constraints.
- **Immediate deletion only (no queue, worker, scheduler or cleanup secret).** `service_set_profile_avatar` / `service_clear_profile_avatar` return `previous_path`. The authenticated Web route uploads the new object, calls the RPC, and **only after the RPC succeeds** deletes the old object (`previous_path`, always under `<user_id>/`). If the RPC fails or reports `AVATAR_CONFLICT`, the route deletes the new object instead. A failed Storage delete is logged immediately and not retried in the background (the orphan stays in the public bucket until a manual sweep).
- CAS: pass the `avatar_path` you read as `p_old_path` (NULL if none); `AVATAR_CONFLICT` means a concurrent change — delete the new object and retry.

## Direct writes
`profiles.display_name/bio` direct UPDATE (legacy column grant) is still validated by trigger `trg_profiles_public_text` and raises SQLSTATE `22023` with message `INVALID_DISPLAY_NAME:<reason>` / `INVALID_BIO:<reason>`. Validation only applies when the value changes, so legacy values do not block unrelated updates.

## Privacy rights / deletion
Export includes `private_details`. Moving an account to `deletion_pending|deleted` deletes its private row and nulls `profiles.avatar_path`/`avatar_url`. **Account deletion does NOT erase the avatar file from Storage** — physical erasure is deferred to a separate implementation (the object lives under the `<user_id>/` prefix of the public `avatars` bucket, so a future sweep can find it). Do not claim avatar files are erased on account deletion.

## FORCE RLS notes
`user_private_details` is FORCE RLS. Every definer function that reads/writes it (signup trigger, RPC impls, export, deletion cleanup) relies on its owner (`postgres`) having BYPASSRLS/superuser, exactly like the existing forced tables (`policy_acceptance_records`, `favourites`); the pgTAP suite asserts this per function owner. Legacy-safe validation: display name/bio are checked only when they differ from the stored values (RPCs and trigger).

## Release notes (per environment; apply files individually, never bulk `db push`)
**Migration 006 (export + deletion) approach:** `app_security.impl_fulfill_data_export` is renamed to `impl_fulfill_data_export_base` (historical body untouched; it still enforces authentication, owner-or-administrator-AAL2, request resolution and audit exactly once). A thin definer function under the original name/signature/ACL calls the base and appends only `private_details`. The base ACL is revoked from all client roles and `service_role`. `public.admin_fulfill_data_export` is unchanged. A later migration that re-declares the export in full would drop `private_details` and must call the `_base` function instead.

Order: `…100001` private table → `…100002` validation + avatar_path → `…100003` RPCs → `…100004` signup trigger → `…100005` bucket + avatar RPCs → `…100006` export + deletion cleanup → `…100008` atomic save + legacy-safe validation. **Seven files** (the number `…100007` is intentionally unused: the cancelled avatar-cleanup consumer was never applied anywhere). Apply individually and in order (forward-only; 8 re-declares functions from 3 with unchanged signatures).

## Release sequence (ChatGPT executes; nothing here touches hosted systems)
Ledgers at ChatGPT's last read-only inspection: **FairSwapTest 78, FairSwapProd 62**; neither has an `avatars` bucket yet. Re-read both ledgers immediately before each apply and reconcile; do not assume these counts.
1. Disposable-DB security gate green (job below) on the exact PR head.
2. **Staging** (FairSwapTest): apply the seven forward files individually, in order, never a bulk `db push`; confirm the `avatars` bucket (public, `image/webp`, 204800 bytes) exists and listing buckets are still private.
3. **Regenerate `FairSwap-Web/src/types/database.ts` from the staging schema** (the committed file is hand-aligned to this contract because no database was available); diff against the hand-aligned file, reconcile any signature differences (notably `save_my_profile_details` incl. `p_clear_full_name`, `user_private_details`; the avatar cleanup queue and its RPCs must NOT appear) before the Web release.
4. Staging Web deploy (no new environment variables, no Cron).
5. **Production** (FairSwapProd): same seven files, independently verified against the Prod ledger, same bucket check; then Production Web.
Rollback: restore the previous Vercel deployment and revert the app release; keep the additive DB objects until a reviewed forward-fix.

## CI wiring (for ChatGPT; nothing under .github/ was changed)
- `scripts/ci/run-profile-onboarding-tests.mjs --self-test` (no DB; unit checks of the loopback allowlist and hosted-credential guard), `--static` (no DB; supplementary dollar-quote/grant/definer scan) and `--execute`. `--execute` fails closed: `PROFILE_ONBOARDING_DB_URL` must parse as `postgres(ql)://`, host exactly `localhost`/`127.0.0.1`/`[::1]`, explicit unprivileged port, database `postgres`, no query string, and none of `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `NEXT_PUBLIC_SUPABASE_URL`, `DATABASE_URL`, `POSTGRES_URL`, `PG*` host/password/service variables may be set. psql runs with a scrubbed environment so libpq variables cannot redirect it. It creates pgTAP, applies the forward files, runs `tests/profile_onboarding.test.sql`, requires zero `not ok`, `1..N` plan = passing count, and at least 175 passing assertions.
- The suite seeds its own fixtures inside a rolled-back transaction (fake PINs 999001 single-district and 999002 multi-district, fake cities/localities, legacy-style user without a private row); it does not need the real postal import or any hosted credentials.
- `scripts/ci/run-profile-onboarding-db.sh` drives a throwaway PG15 on a native Linux runner: CLI downloaded from `scripts/ci/toolchain.json` (checksum + `2.117.0` verified), generated `config.toml` with reserved loopback-free ports, `supabase db start` (the same start command the pinned baseline `run-local-db.sh` uses; `supabase start` would additionally launch the API gateway/Studio, which these SQL tests do not need), `migration up --local` for the 58 repo migrations, then the three runner modes against `127.0.0.1:<reserved port>`. Teardown is `supabase stop --project-id … --no-backup` plus removal of the temp dir.
- Proposed workflow: `docs/contracts/profile-onboarding-db-tests.workflow.yml.example` → add as `.github/workflows/profile-onboarding-db-tests.yml` (separate from `backend-ci.yml`; pinned actions copied from it; no secrets; fails closed on any hosted variable). Historical baseline files are untouched. **pgTAP and the CLI flow have NOT been run**; acceptance requires a green run of this job. Production repo migration count caveat: the disposable stack applies the repo's 58 migrations, which differs from the hosted ledgers; that is expected for a security gate.
