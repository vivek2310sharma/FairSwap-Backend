# Moderation V2 Foundation V1 — Production Release Package

This package prepares the **default-off database foundation** for Moderation V2 on FairSwapProd (`kriuhwppxgxsyyrbjsau`).

> **AUTHORITY NOTICE:** This package is **PREPARATION-ONLY**. Hosted execution is **NOT** authorized without explicit human CTO sign-off.

---

## 1. Release Inventory

### Executable Forward Migrations (Exactly 3)
1. `20261018172250_moderation_v2_private_foundation.sql`
   - **SHA-256:** `58c9ea477aa92a196107fb7d0b71089cf12dba9f4b2b986ad74b45d54e84d19e`
   - Creates private schema `app_moderation_v2`, system settings (`moderation_v2_enabled=false`, `moderation_v2_mode='disabled'`), `policy_registry` (0 approved policies), and pre-allocated `admission_control` (2 slots).
2. `20261018182448_moderation_v2_input_validation.sql`
   - **SHA-256:** `721a7fcd2f32bfc41dbd55ad36dfe1d8bcce8b20d93e4da61b61be08370ca284`
   - Defines strict input boundary validation rules (`app_moderation_v2.validate_listing_inputs`).
3. `20261019102255_moderation_v2_input_lease.sql`
   - **SHA-256:** `47285a7f116ce4d6dc5ce671c20173cfec7a4156f41dd2c63e5ba3b78ea46f94`
   - Implements worker-bound input claim leases (`app_moderation_v2.input_claim_leases`), lease heartbeat/expiration, and snapshot sealing (`app_moderation_v2.listing_moderation_snapshots`).
   - *Note:* Preserves 3-byte UTF-8 BOM from PR #26 git blob.

### Quarantined / Excluded Artifacts (Test-Only)
The 4 FairSwapTest-specific SQL migrations are strictly **excluded** from this package and quarantined under `releases/test-only/mod-v2-point3/test-specific-migrations/`:
- `20261019215421_moderation_v2_point3_c2_media_registry_test.sql`
- `20261019215550_moderation_v2_point3_c2_registry_owner_usage_test.sql`
- `20261020082513_moderation_v2_point3_c2_guarded_finalizer.sql`
- `20261020103242_moderation_v2_worker_bound_reads.sql`

All synthetic worker entrypoints (`test-listing-moderation-v2-diagnostic`, `process-listing-moderation-v2`) are excluded from Production deployment.

---

## 2. Production Baseline & Prerequisites

- **Target Database:** FairSwapProd (`kriuhwppxgxsyyrbjsau`)
- **Engine Version:** PostgreSQL 17.6
- **Baseline Migration Count:** Exactly 52 migrations (45 historical baseline + 7 category foundation migrations up to `20261017205807`).
- **Post-Execution Migration Count:** Exactly 55 migrations.
- **Platform Prerequisite:** Helper function `storage.allow_only_operation(text)` must exist (provided by standard Supabase Storage API tenant migrations).

---

## 3. Execution Plan

1. **Preflight Check (Read-Only):**
   ```bash
   psql -X -v ON_ERROR_STOP=1 -f preflight.readonly.sql
   ```
   *Verifies:* PostgreSQL 17.x, exact 52-migration ledger, absence of existing `app_moderation_v2` objects, intact V1 finalizer hash (`118d04445fdd9139d90decd2048945f1`), and V1 default-off switch (`moderation_automation_enabled = false`).

2. **Apply Forward Migrations:**
   ```bash
   supabase db push --workdir <verified-workspace> --linked --skip-vault
   ```
   Applies only the 3 candidate migrations sequentially.

3. **Postflight Verification (Read-Only):**
   ```bash
   psql -X -v ON_ERROR_STOP=1 -f postflight.readonly.sql
   ```
   *Verifies:* Ledger count reaches 55, RLS enabled on all 5 tables, deny on `anon` and `authenticated` for all 13 RPCs, service-role access granted, default-off system settings, 0 approved policies, and unchanged V1 functions.

---

## 4. Recovery & Rollback

- **Fail-Closed Principle:** Any preflight or migration error halts execution immediately.
- **Rollback SQL (Maintenance Window Only):**
  ```sql
  BEGIN;
  DROP SCHEMA app_moderation_v2 CASCADE;
  DELETE FROM public.app_system_settings WHERE setting_key IN ('moderation_v2_enabled', 'moderation_v2_mode');
  DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261018172250', '20261018182448', '20261019102255');
  COMMIT;
  ```
