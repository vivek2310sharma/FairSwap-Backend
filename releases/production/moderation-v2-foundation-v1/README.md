# Moderation V2 Foundation V1 — Production Release Package

This package prepares the **default-off database foundation** for Moderation V2 on FairSwapProd (`kriuhwppxgxsyyrbjsau`).

> **AUTHORITY NOTICE:** This package is **PREPARATION-ONLY**. Hosted execution is **NOT** authorized without explicit human CTO sign-off.

---

## 1. Release Inventory

### Executable Forward Migrations (Exactly 3)
1. `20261018172250_moderation_v2_private_foundation.sql`
   - **SHA-256:** `58c9ea477aa92a196107fb7d0b71089cf12dba9f4b2b986ad74b45d54e84d19e`
   - Creates private schema `app_moderation_v2`, system settings (`moderation_v2_enabled=false`, `moderation_v2_mode='disabled'`), `app_moderation_v2.policy_registry` (0 approved policies), and `app_moderation_v2.requests`.
2. `20261018182448_moderation_v2_input_validation.sql`
   - **SHA-256:** `721a7fcd2f32bfc41dbd55ad36dfe1d8bcce8b20d93e4da61b61be08370ca284`
   - Defines strict input boundary validation routines in `app_moderation_v2`: `enforce_request_immutability`, `js_trim`, `js_utf16_length`, `sha256_exact_utf8`, `validate_text_field`, `validate_v2_text_fields`, and `validate_v2_stored_text`.
3. `20261019102255_moderation_v2_input_lease.sql`
   - **SHA-256:** `47285a7f116ce4d6dc5ce671c20173cfec7a4156f41dd2c63e5ba3b78ea46f94`
   - Creates tables `app_moderation_v2.input_admission_slots` (pre-allocates 2 empty admission slots), `app_moderation_v2.input_claims`, and `app_moderation_v2.input_results`.
   - Defines claim management functions: `canonical_early_result_json`, `canonical_early_result_digest`, `recover_expired_input_claims`, `claim_moderation_v2_input`, `heartbeat_moderation_v2_input`, and `finalize_moderation_v2_input`, along with corresponding `public` schema wrappers execute-denied to anon/authenticated and granted to service_role.
   - *Note:* Preserves exact 3-byte UTF-8 BOM from PR #26 git blob.

### Quarantined / Excluded Artifacts (Test-Only)
The 4 FairSwapTest-specific SQL migrations are strictly **excluded** from this package:
- `20261019215421_moderation_v2_point3_c2_media_registry_test.sql`
- `20261019215550_moderation_v2_point3_c2_registry_owner_usage_test.sql`
- `20261020082513_moderation_v2_point3_c2_guarded_finalizer.sql`
- `20261020103242_moderation_v2_worker_bound_reads.sql`

All worker runtime entrypoints and OpenAI provider integration sources are excluded from this database-only foundation package.

---

## 2. Production Baseline & Prerequisites

- **Target Database:** FairSwapProd (`kriuhwppxgxsyyrbjsau`)
- **Recorded Production Engine:** PostgreSQL 17.6
- **Local Rehearsal Engine:** PostgreSQL 17.11 (Supabase CLI default; engine parity verified on 17.x, minor version deviation noted for explicit CTO approval)
- **Baseline Migration Count:** Exactly 52 migrations (45 historical baseline + 7 category foundation migrations up to `20261017205807`).
- **Post-Execution Migration Count:** Exactly 55 migrations.
- **Platform Prerequisite:** Helper function `storage.allow_only_operation(text)` must exist.
- **V1 Preservation:** `moderation_automation_enabled` switch, `app_security.impl_finalize_moderation_result` body hash (`118d04445fdd9139d90decd2048945f1`), and `trg_listing_moderation_enqueue` trigger are verified unchanged before and after execution.

---

## 3. Supported Execution Plan (Fail-Closed)

### Step 1: Preflight Verification (Read-Only)
Run the read-only preflight check against the target database:
```bash
psql "<db-url>" -v ON_ERROR_STOP=1 -f releases/production/moderation-v2-foundation-v1/preflight.readonly.sql
```
*Expected Output:* `NOTICE: PASS: FairSwap Production 52-migration baseline verified for V2 foundation (V1 moderation_automation_enabled=...)`

### Step 2: Isolated Workspace Dry-Run Verification
From an isolated migration workspace containing exactly the 52 baseline migrations and the 3 approved forward migrations:
```bash
supabase db push --workdir <isolated-migration-workspace> --linked --dry-run
```
*Verification:* Must list **exactly** the 3 candidate migrations (`20261018172250`, `20261018182448`, `20261019102255`) and no other migrations. If any other migration is listed, **HALT IMMEDIATELY**.

### Step 3: Forward Application
```bash
supabase db push --workdir <isolated-migration-workspace> --linked --skip-vault
```

### Step 4: Postflight Verification (Read-Only)
```bash
psql "<db-url>" -v ON_ERROR_STOP=1 -f releases/production/moderation-v2-foundation-v1/postflight.readonly.sql
```
*Expected Output:* `NOTICE: PASS: All postflight checks passed. V2 foundation successfully verified in default-off state (V1 moderation_automation_enabled=...).`

---

## 4. Recovery & Fail-Closed Procedures

- **Preflight Failure:** Execution halts immediately. Zero database mutations occur.
- **Dry-Run Discrepancy:** Execution halts immediately. Zero database mutations occur.
- **Migration Failure:** The PostgreSQL transaction aborts per statement. Supabase migration tracking preserves history. **STOP IMMEDIATELY.** Do NOT manually delete migration ledger rows or drop schemas. Preserve all logs and escalate to the CTO for a separately authorized remediation plan.
- **Postflight Failure:** Postflight runs in a read-only transaction/block. If any check fails, **STOP IMMEDIATELY**. All V2 features remain disabled by default. Escalate to the CTO.
