# FairSwap Moderation V2 — Slice C2b Implementation Plan
**Database-Owned Input-Validation Leases, Attempt Tokens, Idempotent Early Finalization, and Stale-Request Protection**

**Status:** Consolidated Design Proposal for CTO Sign-Off  
**Worktree:** `C:\Users\VivekKumar\OneDrive - Nobly A S\Documents\FairSwap-Backend-InputLease`  
**Branch:** `feat/moderation-v2-input-lease`  
**Base Commit:** `fc4dcedd7f039be70ddb1e9fee62491112a872cf` (Frozen Slice C2a)  
**Parent PR:** Draft PR #25 (`feat/moderation-v2-text-validation`, unmerged)  
**Stack:** Draft PR #26 (this plan) stacked on PR #25  
**Target Migration Path:** Additive forward lane (`supabase/forward-migrations/moderation-v2/`)  
**Design Authority:**
- `docs/moderation/MODERATION_V2_CONTRACT.md` §§5–8
- `docs/moderation/MODERATION_V2_APPROVAL_IMPLEMENTATION.md` §4 Slice C/E/F
- `docs/moderation/MODERATION_V2_INPUT_VALIDATION_ANTIGRAVITY.md` §Follow-on Slice C2b

---

## 1. Scope, System Boundaries, and Strict Negative Invariants

Slice C2a established server/DB-owned immutable text binding on `app_moderation_v2.requests` and deterministic UTF-16 scalar validation (`app_moderation_v2.validate_v2_stored_text`).

Slice C2b establishes the database-owned lease and attempt lifecycle for the early `input_validation` phase:
1. **DB-Owned Input-Validation Processing Lease & Attempt Accounting:**
   - Dedicated private tables: `app_moderation_v2.input_admission_slots` (pre-allocated atomic slots), `app_moderation_v2.input_claims` (fenced active claims), and `app_moderation_v2.input_results` (immutable idempotency ledger).
   - Provisional timing: Exactly **two** pre-seeded admission slots for disposable testing; **30s initial lease**; **60s renewal ceiling** (attempt start + 60s). These are provisional limits for isolated local validation, not fixed production assumptions.
   - Cryptographically strong, DB-generated `claim_token` (32-byte hex secret) and unique `attempt_id`.
2. **Pre-Queue Authentication & Gate Verification:**
   - Worker must prove possession of the vault worker secret prior to queue operations, verified via existing `app_security.verify_moderation_worker_secret`.
   - Gate and mode checked under transaction lock against `public.app_system_settings`:
     `moderation_v2_enabled = 'true'` AND `moderation_v2_mode IN ('shadow', 'enforce')`.
   - Policy and evaluator build verified against `app_moderation_v2.policy_registry` (`is_approved = true` AND non-null `approved_evaluator_build`).
   - Fails closed immediately (`PROVIDER_AUTH`, `V2_DISABLED`, or `POLICY_DISAPPROVED`) without state modification.
3. **Strict Universal Lock Hierarchy:**
   - Universal lock hierarchy across claim, heartbeat, recovery, and finalization:
     `public.listings` (parent row) -> `app_moderation_v2.requests` -> `app_moderation_v2.input_admission_slots` -> `app_moderation_v2.input_claims`.
   - Competing workers acquire candidate requests and admission slots using `SKIP LOCKED`, eliminating worker contention and deadlocks.
4. **Deep Stale-Request Protection:**
   - Finalization verifies exact listing state under locks: `listing_revision`, `title`, `description`, `generation_id`, `policy_version`, and listing `status = 'pending_review'`.
   - Any deviation (seller edit, Admin accept/reject/remove race, revision bump) marks request and claim `status = 'superseded'` and frees the admission slot.
5. **Normative Schema Alignment & Canonical Hashing:**
   - `EarlyInvalidResultV2Schema` strictly requires `outcome = 'invalid_input'` with 1–2 deterministic field validation errors, matching `title_sha256`/`description_sha256` digest binding (null for `TYPE`, exact SHA-256 for length errors).
   - Valid text is an **internal queue phase transition**: moves request to `phase = 'preparation'`, `status = 'awaiting_media'`, releasing the lease. Valid input never produces a false `EarlyInvalidResultV2Schema`.
   - Canonical result hashing: `payload_digest = sha256_exact_utf8(canonical_json(result))`.
6. **Authenticated, Safe Idempotent Replay:**
   - Worker must authenticate and present valid attempt credentials (`p_attempt_id`, `p_claim_token`).
   - A matching completed replay returns the recorded response before acquiring parent locks or reapplying mutations. Matching replay may bypass current lease expiry, but **never** bypasses authentication or creates side effects. Conflicting payload raises `IDEMPOTENCY_CONFLICT`.
7. **Failure Escalation & Deferral of Seller Enforce Transitions:**
   - Retry exhaustion (attempt count reaching 3) escalates safely to Admin review (`status = 'failed'`), **never** auto-rejecting for worker/infrastructure failures.
   - Seller-facing enforce transitions (e.g. updating listing to `draft` with correction flags) are deferred to separately reviewed integration. In Slice C2b, early finalization records the result in V2; in `shadow` mode, `public.listings` is left strictly untouched.
8. **Strict Negative Invariants (Mandatory Stop Conditions):**
   - Early input validation **CAN NEVER APPROVE OR PUBLISH A LISTING**.
   - Zero interaction with media, image sealing, or provider dispatch.
   - Zero modifications to V1 historical migrations (all 58 files remain sealed).
   - Zero mutations to hosted Supabase Test/Production environments.
   - `moderation_v2_enabled` remains `false` in database defaults; no gates are enabled.

---

## 2. Database Schema Design

### 2.1 Correct DDL Dependency Order (No Circular Foreign Keys)

To avoid circular dependencies, `input_claims` is created first without a foreign key to `input_admission_slots`, followed by `input_admission_slots`, with the slot reference established cleanly:

```sql
-- 1. Durable Input Claims Table
CREATE TABLE app_moderation_v2.input_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id uuid NOT NULL
    REFERENCES app_moderation_v2.requests(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  claim_token_hash text NOT NULL CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
  slot_id smallint NOT NULL CHECK (slot_id IN (1, 2)),
  worker_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  attempt_started_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  max_renewal_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned', 'expired', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT uq_v2_input_claims_attempt UNIQUE (request_id, attempt_id)
);

-- At most one active claim per request at any time
CREATE UNIQUE INDEX uq_v2_input_claims_active_request
  ON app_moderation_v2.input_claims (request_id)
  WHERE status = 'active';

CREATE INDEX idx_v2_input_claims_active_lease
  ON app_moderation_v2.input_claims (lease_expires_at)
  WHERE status = 'active';

-- 2. Atomic Concurrency & Pre-allocated Admission Slots
CREATE TABLE app_moderation_v2.input_admission_slots (
  slot_id smallint PRIMARY KEY CHECK (slot_id IN (1, 2)), -- provisional candidate: 2 slots
  active_claim_id uuid REFERENCES app_moderation_v2.input_claims(id) ON DELETE SET NULL,
  slot_acquired_at timestamptz,
  slot_expires_at timestamptz
);

-- Pre-seed exactly two admission slots (1, 2)
INSERT INTO app_moderation_v2.input_admission_slots (slot_id) VALUES (1), (2);

-- At most one active claim per slot at any time
CREATE UNIQUE INDEX uq_v2_admission_active_claim
  ON app_moderation_v2.input_admission_slots (active_claim_id)
  WHERE active_claim_id IS NOT NULL;

-- 3. Idempotent Early Results Ledger
CREATE TABLE app_moderation_v2.input_results (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id uuid NOT NULL
    REFERENCES app_moderation_v2.requests(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('valid', 'rejected_invalid', 'superseded')),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT uq_v2_input_results_idempotency UNIQUE (request_id, attempt_id)
);

CREATE INDEX idx_v2_input_results_request
  ON app_moderation_v2.input_results (request_id, recorded_at DESC);
```

---

## 3. Function & RPC Specifications

All functions are declared `SECURITY INVOKER`, `SET search_path = ''`, with privileges revoked from `PUBLIC`, `anon`, and `authenticated`, granted solely to `service_role`.

### 3.1 Vault Worker Secret Verification

Delegates to existing, verified `app_security.verify_moderation_worker_secret(p_candidate)`:
- Missing, malformed, or invalid tokens fail closed immediately with `PROVIDER_AUTH`.
- Verified at the start of `claim_moderation_v2_input` and `finalize_moderation_v2_input`.

### 3.2 Canonical Result Hashing Specification

To guarantee reproducible cross-runtime digests matching Node.js `crypto.createHash('sha256')`:
```sql
CREATE OR REPLACE FUNCTION app_moderation_v2.canonical_early_result_digest(
  p_phase text,
  p_outcome text,
  p_listing_id uuid,
  p_listing_revision integer,
  p_generation_id uuid,
  p_validation_errors jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT encode(
    sha256(
      convert_to(
        jsonb_build_array(
          'fairswap:v2:early_result_v1',
          p_phase,
          p_outcome,
          p_listing_id,
          p_listing_revision,
          p_generation_id,
          p_validation_errors
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;
```

**Reproducible Test Vectors:**
1. Valid Input Tuple:
   - Preimage: `["fairswap:v2:early_result_v1", "input_validation", "valid", "44444444-0000-4000-8000-000000000099", 1, "99999999-0000-4000-8000-000000000099", []]`
2. Invalid Input Tuple (Short Title):
   - Preimage: `["fairswap:v2:early_result_v1", "input_validation", "invalid_input", "44444444-0000-4000-8000-000000000099", 1, "99999999-0000-4000-8000-000000000099", [{"code": "TOO_SHORT", "field": "title"}]]`

---

### 3.3 `claim_moderation_v2_input(p_worker_id text, p_worker_secret text)`

- **Universal Lock Hierarchy:**
  1. System gates & policy approval verification (shared catalog read).
  2. `public.listings` (parent row `FOR SHARE`).
  3. `app_moderation_v2.requests` (`FOR UPDATE SKIP LOCKED LIMIT 1`).
  4. `app_moderation_v2.input_admission_slots` (`FOR UPDATE SKIP LOCKED LIMIT 1`).
  5. `app_moderation_v2.input_claims` (`INSERT`).

- **Execution Flow:**
  1. **Pre-Queue Authentication:**
     `IF NOT app_security.verify_moderation_worker_secret(p_worker_secret) THEN RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '28000'; END IF;`
  2. **Gate Verification:**
     Verify `moderation_v2_enabled = 'true'` AND `moderation_v2_mode IN ('shadow', 'enforce')`. Else return `{ success: false, error: 'V2_DISABLED' }`.
  3. **Policy & Build Verification:**
     Verify `app_moderation_v2.policy_registry` has `is_approved = true` and non-null `approved_evaluator_build`. Else return `{ success: false, error: 'POLICY_DISAPPROVED' }`.
  4. **Atomic Admission Slot Reservation & Expired Slot Recovery:**
     Acquire 1 slot `FOR UPDATE SKIP LOCKED`:
     ```sql
     SELECT slot_id, active_claim_id, slot_expires_at
     INTO v_slot
     FROM app_moderation_v2.input_admission_slots
     WHERE active_claim_id IS NULL OR slot_expires_at <= clock_timestamp()
     ORDER BY slot_id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1;
     ```
     If none available, return `{ success: false, error: 'NO_ADMISSION_SLOT' }`.
     *Atomic Invalidation of Expired Owner:* If `v_slot.active_claim_id IS NOT NULL`, atomically mark previous claim `status = 'expired'`, `updated_at = clock_timestamp()` before reassigning.
  5. **Select Candidate Request:**
     ```sql
     SELECT r.id, r.listing_id, r.listing_revision, r.generation_id, r.request_lane,
            r.policy_version, r.original_title, r.original_description, r.attempt_count
     INTO v_req
     FROM app_moderation_v2.requests r
     JOIN public.listings l ON l.id = r.listing_id
     WHERE r.phase = 'input_validation'
       AND r.status IN ('pending_input', 'retry')
       AND r.next_attempt_at <= clock_timestamp()
       AND r.attempt_count < 3
       AND NOT EXISTS (
         SELECT 1 FROM app_moderation_v2.input_claims c
         WHERE c.request_id = r.id AND c.status = 'active'
       )
     ORDER BY r.created_at ASC
     FOR UPDATE OF r SKIP LOCKED
     LIMIT 1;
     ```
     If none available, release slot (`active_claim_id = NULL`) and return `{ success: false, error: 'NO_REQUEST_AVAILABLE' }`.
  6. **Deep Freshness Verification Under Parent Lock (`FOR SHARE`):**
     Lock parent listing: `SELECT revision, title, description, status FROM public.listings WHERE id = v_req.listing_id FOR SHARE;`
     If revision <> `v_req.listing_revision` OR title <> `v_req.original_title` OR description IS DISTINCT FROM `v_req.original_description` OR status <> 'pending_review':
       - Mark request `status = 'superseded'`, `updated_at = clock_timestamp()`.
       - Release slot and skip to next candidate.
  7. **Generate Claim Material & Fencing Token:**
     - Secret `v_claim_token := encode(gen_random_bytes(32), 'hex')`.
     - `v_token_hash := encode(sha256(convert_to(v_claim_token, 'UTF8')), 'hex')`.
     - Provisional lease: `clock_timestamp() + interval '30 seconds'`.
     - Provisional max renewal: `clock_timestamp() + interval '60 seconds'`.
  8. **Record Claim & Advance Request:**
     - Insert row into `app_moderation_v2.input_claims` (`slot_id = v_slot.slot_id`, `attempt_number = v_req.attempt_count + 1`).
     - Update slot with `active_claim_id = v_claim_id`, `slot_expires_at = v_lease_expires`.
     - Update request `status = 'claimed'`, `attempt_count = attempt_count + 1`, `updated_at = clock_timestamp()`.
  9. **Return Payload:**
     `{ success: true, request_id, attempt_id, attempt_number, claim_token, lease_expires_at, max_renewal_until, original_title, original_description, listing_revision, request_lane }`.

---

### 3.4 `heartbeat_moderation_v2_input(p_request_id uuid, p_attempt_id uuid, p_claim_token text)`

- **Universal Lock Hierarchy:**
  1. `app_moderation_v2.input_admission_slots` (via `slot_id` `FOR UPDATE`).
  2. `app_moderation_v2.input_claims` (`FOR UPDATE`).
- **Execution Flow:**
  1. Hash token: `v_hash := encode(sha256(convert_to(p_claim_token, 'UTF8')), 'hex')`.
  2. Select and lock claim:
     `SELECT id, slot_id, lease_expires_at, max_renewal_until, status FROM app_moderation_v2.input_claims WHERE request_id = p_request_id AND attempt_id = p_attempt_id FOR UPDATE;`
  3. Verify token: If hash does not match stored `claim_token_hash`, return `{ success: false, error: 'LEASE_TOKEN_MISMATCH' }`.
  4. Verify status: If `status <> 'active'`, return `{ success: false, error: 'LEASE_LOST' }`.
  5. Check expiration: If `lease_expires_at <= clock_timestamp()`, update claim `status = 'expired'`, clear slot, and return `{ success: false, error: 'LEASE_EXPIRED' }`.
  6. Check ceiling: If `clock_timestamp() >= max_renewal_until`, return `{ success: false, error: 'RENEWAL_CEILING_REACHED' }`.
  7. Extend lease:
     - `v_new_expiry := LEAST(clock_timestamp() + interval '30 seconds', max_renewal_until)`.
     - Update claim `lease_expires_at = v_new_expiry`, `updated_at = clock_timestamp()`.
     - Update slot `slot_expires_at = v_new_expiry`.
  8. Return `{ success: true, lease_expires_at: v_new_expiry }`.

---

### 3.5 `recover_expired_input_claims()`

- **Execution Flow:**
  1. Finds claims where `status = 'active'` AND `lease_expires_at <= clock_timestamp()`.
  2. Locks slot -> locks claim -> locks request (in universal hierarchy).
  3. Updates claim `status = 'expired'`.
  4. Clears admission slot (`active_claim_id = NULL`).
  5. Request Retry / Escalation Accounting:
     - If `attempt_count >= 3`: sets request `status = 'failed'` (retry exhausted; routes to Admin queue without auto-rejecting listing).
     - If `attempt_count < 3`: calculates retry backoff (`next_attempt_at := clock_timestamp() + interval '10 seconds' * attempt_count + (random() * interval '3 seconds')`), sets request `status = 'retry'`.

---

### 3.6 `finalize_moderation_v2_input(p_request_id uuid, p_attempt_id uuid, p_claim_token text, p_worker_secret text, p_payload jsonb)`

- **Universal Lock Hierarchy:**
  1. Parent listing: `SELECT revision, title, description, status FROM public.listings WHERE id = v_listing_id FOR UPDATE;`
  2. V2 Request: `SELECT listing_id, listing_revision, generation_id, policy_version, request_lane, original_title, original_description, status FROM app_moderation_v2.requests WHERE id = p_request_id FOR UPDATE;`
  3. Admission Slot: `SELECT slot_id FROM app_moderation_v2.input_admission_slots WHERE active_claim_id = v_claim.id FOR UPDATE;`
  4. Claim: `SELECT status, claim_token_hash, lease_expires_at, slot_id FROM app_moderation_v2.input_claims WHERE request_id = p_request_id AND attempt_id = p_attempt_id FOR UPDATE;`

- **Execution Flow:**
  1. **Pre-Queue Authentication:**
     Verify `app_security.verify_moderation_worker_secret(p_worker_secret)`. Fail closed if invalid (`28000`).
  2. **Canonical Hashing of Incoming Payload:**
     Compute `v_payload_digest := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex')`.
  3. **Authenticated Idempotent Replay Gate (Before Parent Locks):**
     Check `app_moderation_v2.input_results` for `(request_id, attempt_id)`:
     - If found:
       - Verify caller holds valid `claim_token_hash` matching the attempt.
       - If `payload_digest = v_payload_digest`: return recorded response immediately (`idempotent_replay: true`), applying **no changes** to database state. Matching replay may bypass current lease expiry, but **never** bypasses authentication or creates side effects.
       - If `payload_digest <> v_payload_digest`: raise exception `IDEMPOTENCY_CONFLICT`.
  4. **Acquire Locks in Universal Hierarchy:**
     Lock parent listing -> lock V2 request -> lock slot -> lock claim.
  5. **Recheck System Gates & Registry Approvals:**
     Verify `moderation_v2_enabled = 'true'`, `moderation_v2_mode IN ('shadow', 'enforce')`, and `policy_registry.is_approved = true`. Else fail closed.
  6. **Fencing & Lease Verification:**
     - Verify `claim_token_hash = sha256(p_claim_token)`. Else raise `LEASE_TOKEN_MISMATCH`.
     - Verify claim `status = 'active'` AND `lease_expires_at > clock_timestamp()`. Else raise `LEASE_EXPIRED`.
  7. **Deep Stale-Request Protection:**
     Verify all of the following under lock:
     - `v_listing.revision = v_request.listing_revision`
     - `v_listing.title = v_request.original_title`
     - `v_listing.description IS NOT DISTINCT FROM v_request.original_description`
     - `v_listing.status = 'pending_review'`
     If any check fails (seller edit, revision bump, Admin action race):
     - Mark request `status = 'superseded'`.
     - Mark claim `status = 'superseded'`.
     - Free admission slot.
     - Record result in `app_moderation_v2.input_results` (`decision = 'superseded'`).
     - Return recorded supersede response.
  8. **Independent Database Validation:**
     - Database recomputes validation: `v_db_eval := app_moderation_v2.validate_v2_stored_text(v_request.original_title, v_request.original_description)`.
     - Verify worker payload consistency with `v_db_eval->'validation_errors'`. Mismatch raises `VALIDATION_MISMATCH`.
  9. **State Transitions:**
     - **Branch A: Valid Text (`validation_errors = []`)**
       - Internal queue transition: `v_request.phase := 'preparation'`, `v_request.status := 'awaiting_media'`, `v_request.updated_at := clock_timestamp()`.
       - Claim updates: `status := 'completed'`.
       - Free admission slot.
       - Record in `app_moderation_v2.input_results` (`decision := 'valid'`).
       - Return `{ success: true, decision: 'valid', next_phase: 'preparation' }`.
       - *Invariant:* Listing remains `pending_review`. **Never approves or publishes.**
     - **Branch B: Invalid Text (`validation_errors.length >= 1`)**
       - Conforms to `EarlyInvalidResultV2Schema` (`outcome := 'invalid_input'`).
       - Request updates: `status := 'failed'`, `updated_at := clock_timestamp()`.
       - Claim updates: `status := 'completed'`.
       - Free admission slot.
       - Record in `app_moderation_v2.input_results` (`decision := 'rejected_invalid'`).
       - *Lane Handling:*
         - `shadow` mode: **Leaves `public.listings` completely untouched.** Listing remains in current state.
         - `enforce` mode: Deferred seller-facing transition is recorded; seller correction semantics mirror V1 `rejected` flow without unreviewed bypass.
       - Return `{ success: true, decision: 'rejected_invalid', validation_errors: v_db_eval->'validation_errors' }`.

---

## 4. Concurrency, Deadlock Prevention, and Race Matrix

| Scenario | Race Condition | Resolution Mechanism |
| :--- | :--- | :--- |
| **Worker Collision on Claim** | Competing workers attempt to claim the same request | `FOR UPDATE OF r SKIP LOCKED` guarantees exactly one worker acquires the row. |
| **Slot Exhaustion** | Workers burst beyond 2 concurrent slots | Admission slots locked `SKIP LOCKED`; 3rd worker receives `NO_ADMISSION_SLOT` and backs off. |
| **Seller Edit Race** | Seller edits listing while input validation is in flight | `listings.revision` increments; `finalize_moderation_v2_input` locks listing first, detects mismatch, marks request `superseded`. |
| **Admin Action Race** | Admin reviews or removes listing during validation | Listing status leaves `pending_review`; finalizer detects status mismatch and supersedes V2 request. |
| **Worker Crash / Timeout** | Worker crashes or hangs during scalar validation | Lease expires after 30s; `recover_expired_input_claims` frees slot and schedules retry up to 3 attempts. |
| **Zombie Worker Commit** | Expired worker attempts to finalize after lease expiry | Claim lock observes `lease_expires_at <= clock_timestamp()` or `status = 'expired'`; aborts with `LEASE_EXPIRED`. |
| **Duplicate Delivery** | Network drops response; worker replays finalization | Authenticated replay returns identical recorded response without re-executing transitions or locking parent rows. |
| **Tampered / Stolen Token** | Competing worker attempts heartbeat or finalization with forged token | Hash mismatch triggers immediate `LEASE_TOKEN_MISMATCH`. |
| **Deadlock Avoidance** | Cross-table locking across concurrent claims, heartbeats, and finalizers | Universal locking hierarchy strictly enforced: `listings` -> `requests` -> `admission_slots` -> `input_claims`. Deadlock-free guarantee. |

---

## 5. Security & Isolation Controls

1. **Role & Schema Isolation:**
   - Schema `app_moderation_v2` has `REVOKE ALL FROM PUBLIC, anon, authenticated`.
   - All newly added tables (`input_admission_slots`, `input_claims`, `input_results`) enable Row Level Security with zero client policies.
   - All RPCs granted exclusively to `service_role`.
2. **Definer & Search Path Hygiene:**
   - All routines are `SECURITY INVOKER` with explicit `SET search_path = ''`.
3. **Audit Trail & Privacy:**
   - No raw listing text stored in claim or result tables (text remains strictly bound in `app_moderation_v2.requests.original_title`).
   - Results store exact error codes (`TOO_SHORT`, `TOO_LONG`, `TYPE`) and SHA-256 byte digests only.

---

## 6. Comprehensive pgTAP Test Plan (`moderation_v2_input_lease.test.sql`)

Executed on disposable PG15 in forward test lane under `BEGIN ... ROLLBACK`:

1. **Structural & Security Assertions:**
   - Tables exist, columns match types, check constraints active, foreign keys present.
   - RLS enabled on `input_admission_slots`, `input_claims`, `input_results`.
   - `anon` and `authenticated` roles denied `SELECT`, `INSERT`, `UPDATE`, `DELETE` on all 3 tables.
   - `anon` and `authenticated` roles denied `EXECUTE` on all Slice C2b functions.
2. **Admission & Claim Assertions:**
   - Claim succeeds when gate is open (`moderation_v2_enabled = true`).
   - Claim rejected (`V2_DISABLED`) when gate is false or mode is disabled.
   - Claim rejected (`PROVIDER_AUTH`) when worker secret is invalid.
   - Claim succeeds for 2 concurrent slots; 3rd worker receives `NO_ADMISSION_SLOT`.
   - Candidate request transitions to `status = 'claimed'` and increments `attempt_count`.
3. **Heartbeat & Expiry Assertions:**
   - Valid heartbeat extends `lease_expires_at` within renewal ceiling.
   - Heartbeat rejected if `claim_token` does not match hash (`LEASE_TOKEN_MISMATCH`).
   - Heartbeat rejected if lease is already expired (`LEASE_EXPIRED`).
   - Heartbeat capped at `max_renewal_until` (`RENEWAL_CEILING_REACHED`).
4. **Recovery & Retry Exhaustion:**
   - Expired claim recovered, freeing admission slot and rescheduling request to `retry` with backoff.
   - Attempt count reaching 3 marks request `status = 'failed'` without further retries (escalated, not auto-rejected).
5. **Idempotency & Finalization Assertions:**
   - Valid text input transitions request to `phase = 'preparation'`, `status = 'awaiting_media'`.
   - Listing status remains `pending_review` (proves early input never approves).
   - Replay with identical payload returns `idempotent_replay = true` without modifying database state.
   - Replay with altered payload raises `IDEMPOTENCY_CONFLICT`.
6. **Stale Revision & Admin Race Fencing:**
   - Bumped `listings.revision` triggers clean `superseded` transition.
   - Altered listing title triggers clean `superseded` transition.
   - Listing status changing to `draft` / `active` triggers clean `superseded` transition.
7. **Shadow vs Enforce Mode Parity:**
   - Invalid text in `shadow` mode records failure in V2 without touching `public.listings`.
   - Invalid text in `enforce` mode triggers seller correction transition on `public.listings`.

---

## 7. Delivery Plan & Gates

1. **Step 1:** CTO review and sign-off on this consolidated design specification.
2. **Step 2:** Generate next forward migration timestamp using pinned Supabase CLI 2.117.0 on isolated branch `feat/moderation-v2-input-lease`.
3. **Step 3:** Implement SQL migration in `supabase/forward-migrations/moderation-v2/`.
4. **Step 4:** Implement pgTAP test suite in `supabase/tests/moderation_v2_input_lease.test.sql`.
5. **Step 5:** Append to `docs/moderation/V2_FORWARD_MANIFEST.json` and verify with offline verification script.
6. **Step 6:** Validate with GitHub Actions CI workflows (`Backend independent CI` and `Backend V2 forward migration PG15`).
7. **Step 7:** Report commit SHA and CI results for CTO review.
