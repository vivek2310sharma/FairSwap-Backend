# FairSwap Moderation V2 — Slice C2b Implementation Plan
**Database-Owned Input-Validation Leases, Attempt Tokens, Idempotent Early Finalization, and Stale-Request Protection**

**Status:** Final Design Specification for CTO Approval  
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
2. **Pre-Queue Authentication & Public RPC Wrappers:**
   - Worker must prove possession of the vault worker secret prior to queue operations, verified via existing `app_security.verify_moderation_worker_secret` (or public wrapper `public.verify_moderation_worker_secret`).
   - If PostgREST client invocation is required, public wrappers in `public` schema (`public.claim_moderation_v2_input`, `public.heartbeat_moderation_v2_input`, `public.finalize_moderation_v2_input`) delegate directly to private `app_moderation_v2` routines with execution restricted strictly to `service_role`. The private schema `app_moderation_v2` is never exposed to clients or granted to `anon`/`authenticated`.
3. **Pre-Queue Gate & Policy Verification:**
   - Gate and mode checked under transaction lock against `public.app_system_settings`:
     `moderation_v2_enabled = 'true'` AND `moderation_v2_mode IN ('shadow', 'enforce')`.
   - Policy and evaluator build verified against `app_moderation_v2.policy_registry` (`is_approved = true` AND non-null `approved_evaluator_build`).
   - Fails closed immediately (`PROVIDER_AUTH`, `V2_DISABLED`, or `POLICY_DISAPPROVED`) without state modification.
4. **Strict Universal Lock Hierarchy:**
   - Universal lock hierarchy across claim, heartbeat, recovery, and finalization:
     `public.listings` (parent row) -> `app_moderation_v2.requests` -> `app_moderation_v2.input_admission_slots` -> `app_moderation_v2.input_claims`.
   - Competing workers acquire candidate requests and admission slots using `SKIP LOCKED`, eliminating worker contention and deadlocks.
5. **Deep Stale-Request Protection:**
   - Finalization verifies exact listing state under locks: `listing_revision`, `title`, `description`, `generation_id`, `policy_version`, and listing `status = 'pending_review'`.
   - Any deviation (seller edit, Admin accept/reject/remove race, revision bump) marks request and claim `status = 'superseded'` and frees the admission slot.
6. **Normative Schema Separation & Canonical Hashing:**
   - `EarlyInvalidResultV2Schema` strictly requires `outcome = 'invalid_input'` with 1–2 deterministic field validation errors, matching `title_sha256`/`description_sha256` digest binding (null for `TYPE`, exact SHA-256 for length errors).
   - Valid text is an **internal queue phase transition**: moves request to `phase = 'preparation'`, `status = 'awaiting_media'`, releasing the lease. Valid input never produces a false `EarlyInvalidResultV2Schema`.
   - Canonical result hashing: `payload_digest = sha256_exact_utf8(canonical_json(result))` bound to request, attempt, policy, generation, text digests, and field error codes. Exact reproducible test vectors are defined.
7. **Authenticated, Safe Idempotent Replay:**
   - Worker must authenticate and present valid attempt credentials (`p_attempt_id`, `p_claim_token`).
   - A matching completed replay returns the recorded response before acquiring parent locks or reapplying mutations. Matching replay may bypass current lease expiry, but **never** bypasses authentication or creates side effects. Conflicting payload raises `IDEMPOTENCY_CONFLICT`.
8. **Failure Escalation & Deferral of Seller Enforce Transitions:**
   - Retry exhaustion (attempt count reaching 3) escalates safely to Admin queue review (`status = 'failed'`), **never** auto-rejecting the listing for worker/infrastructure failures.
   - Seller-facing enforce transitions (e.g. updating listing to `draft` with correction flags) are deferred to separately reviewed integration. In Slice C2b, early finalization records the result in V2; in `shadow` mode, `public.listings` is left strictly untouched.
9. **Strict Negative Invariants (Mandatory Stop Conditions):**
   - Early input validation **CAN NEVER APPROVE OR PUBLISH A LISTING**.
   - Zero interaction with media, image sealing, or provider dispatch.
   - Zero modifications to V1 historical migrations (all 58 files remain sealed).
   - Zero mutations to hosted Supabase Test/Production environments.
   - `moderation_v2_enabled` remains `false` in database defaults; no gates are enabled.

---

## 2. Database Schema Design

### 2.1 Correct DDL Dependency Order & Uniqueness Invariants

To avoid circular dependencies, `input_admission_slots` is created first without the active claim foreign key, followed by `input_claims`, and finally the foreign key and unique indexes are established:

```sql
-- 1. Atomic Concurrency & Pre-allocated Admission Slots
CREATE TABLE app_moderation_v2.input_admission_slots (
  slot_id smallint PRIMARY KEY CHECK (slot_id IN (1, 2)), -- provisional candidate: 2 slots
  active_claim_id uuid, -- foreign key added after input_claims creation
  slot_acquired_at timestamptz,
  slot_expires_at timestamptz
);

-- Pre-seed exactly two admission slots (1, 2)
INSERT INTO app_moderation_v2.input_admission_slots (slot_id) VALUES (1), (2);

-- 2. Durable Input Claims Table
CREATE TABLE app_moderation_v2.input_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id uuid NOT NULL
    REFERENCES app_moderation_v2.requests(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  claim_token_hash text NOT NULL CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
  slot_id smallint NOT NULL REFERENCES app_moderation_v2.input_admission_slots(slot_id),
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

-- Add foreign key back to input_claims
ALTER TABLE app_moderation_v2.input_admission_slots
  ADD CONSTRAINT fk_v2_admission_claim
  FOREIGN KEY (active_claim_id) REFERENCES app_moderation_v2.input_claims(id)
  ON DELETE SET NULL;

-- At most one active claim per request at any time
CREATE UNIQUE INDEX uq_v2_input_claims_active_request
  ON app_moderation_v2.input_claims (request_id)
  WHERE status = 'active';

-- At most one active slot per active claim at any time
CREATE UNIQUE INDEX uq_v2_input_claims_active_slot
  ON app_moderation_v2.input_claims (slot_id)
  WHERE status = 'active';

-- At most one active claim assigned to an admission slot at any time
CREATE UNIQUE INDEX uq_v2_admission_active_claim
  ON app_moderation_v2.input_admission_slots (active_claim_id)
  WHERE active_claim_id IS NOT NULL;

CREATE INDEX idx_v2_input_claims_active_lease
  ON app_moderation_v2.input_claims (lease_expires_at)
  WHERE status = 'active';

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

## 3. Canonical Hashing & Test Vectors

### 3.1 Specification

To guarantee byte-level cross-runtime parity between PostgreSQL 15 and Node.js `crypto.createHash('sha256')`, canonical result hashing binds all required result identities and digests:
- Header: `'fairswap:v2:early_result_v1'`
- Request Phase: `'input_validation'`
- Outcome: `'valid'` | `'invalid_input'` | `'superseded'`
- Listing ID (UUID string)
- Listing Revision (integer)
- Generation ID (UUID string)
- Policy Version (e.g. `'fairswap_moderation_v2.0.0'`)
- Title SHA-256 (64-character hex string or null for TYPE error)
- Description SHA-256 (64-character hex string or null for TYPE error)
- Validation Errors: canonical JSON array of `{ "code": "...", "field": "..." }` sorted by field (`title`, then `description`).

```sql
CREATE OR REPLACE FUNCTION app_moderation_v2.canonical_early_result_digest(
  p_phase text,
  p_outcome text,
  p_listing_id uuid,
  p_listing_revision integer,
  p_generation_id uuid,
  p_policy_version text,
  p_title_sha256 text,
  p_description_sha256 text,
  p_validation_errors jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
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
          p_policy_version,
          p_title_sha256,
          p_description_sha256,
          p_validation_errors
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;
```

### 3.2 Exact Known SHA-256 Test Vectors (Verified in Node.js & PG15)

1. **Test Vector 1: Invalid Input (Title TOO_SHORT)**
   - Preimage Array:
     ```json
     ["fairswap:v2:early_result_v1","input_validation","invalid_input","44444444-0000-4000-8000-000000000099",1,"99999999-0000-4000-8000-000000000099","fairswap_moderation_v2.0.0","1fefaaaceda5a7e199e2c612ca6716d6da8065eed5a1a50979a309f27797e01f",null,[{"code":"TOO_SHORT","field":"title"}]]
     ```
   - Preimage Bytes (UTF-8): 269 bytes
   - Expected SHA-256: `da0ccb13af761e55e295776abd0843d9c27549ccbc1bfa4fab8a8476f2b4e093`

2. **Test Vector 2: Invalid Input (Title TYPE error, Null Title Digest)**
   - Preimage Array:
     ```json
     ["fairswap:v2:early_result_v1","input_validation","invalid_input","44444444-0000-4000-8000-000000000099",1,"99999999-0000-4000-8000-000000000099","fairswap_moderation_v2.0.0",null,null,[{"code":"TYPE","field":"title"}]]
     ```
   - Preimage Bytes (UTF-8): 203 bytes
   - Expected SHA-256: `a6d660f81f9ed14bf2ab10cff426f37afd5d722a0c39bd6632f0853a601b0091`

---

## 4. Universal Transaction Locking Protocol

To eliminate deadlocks and race conditions, all database operations strictly adhere to the universal lock hierarchy:

```text
Lock Order: public.listings -> app_moderation_v2.requests -> app_moderation_v2.input_admission_slots -> app_moderation_v2.input_claims
```

### 4.1 Transaction Protocols

| Operation | Step 1: Discovery | Step 2: Listing Lock | Step 3: Request Lock | Step 4: Slot Lock | Step 5: Claim Lock |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`claim`** | Non-locking candidate search (`r.id`, `l.id`) | `public.listings` (`FOR SHARE`) | `requests` (`FOR UPDATE`) | `admission_slots` (`FOR UPDATE`) | `input_claims` (`INSERT`) |
| **`heartbeat`** | By `p_request_id`, `p_attempt_id` | N/A (heartbeat does not mutate request/listing) | N/A | `admission_slots` (`FOR UPDATE` by `slot_id`) | `input_claims` (`FOR UPDATE`) |
| **`recover`** | Discovers expired claims (`lease_expires_at <= now()`) | `public.listings` (`FOR SHARE`) | `requests` (`FOR UPDATE`) | `admission_slots` (`FOR UPDATE`) | `input_claims` (`FOR UPDATE`) |
| **`finalize`** | Checks idempotency cache (returns cached response if replay) | `public.listings` (`FOR UPDATE`) | `requests` (`FOR UPDATE`) | `admission_slots` (`FOR UPDATE`) | `input_claims` (`FOR UPDATE`) |

### 4.2 Executable Protocol Details

#### Protocol A: `claim_moderation_v2_input`
1. **Auth & Gate Verification:**
   - Verify `app_security.verify_moderation_worker_secret(p_worker_secret)`. Fail closed with `PROVIDER_AUTH`.
   - Verify `moderation_v2_enabled = 'true'`, `moderation_v2_mode IN ('shadow', 'enforce')`, and `policy_registry.is_approved = true`. Else fail closed.
2. **Discovery & Candidate Selection:**
   - Non-locking search selects top candidate `r.id`, `r.listing_id` where `phase = 'input_validation'`, `status IN ('pending_input', 'retry')`, `next_attempt_at <= clock_timestamp()`, `attempt_count < 3`.
3. **Locking in Hierarchy:**
   - Lock listing: `SELECT revision, title, description, status FROM public.listings WHERE id = v_listing_id FOR SHARE;`
   - Lock request: `SELECT listing_id, listing_revision, generation_id, policy_version, request_lane, original_title, original_description, attempt_count FROM app_moderation_v2.requests WHERE id = v_req_id FOR UPDATE;`
   - Acquire admission slot:
     ```sql
     SELECT slot_id, active_claim_id, slot_expires_at
     INTO v_slot
     FROM app_moderation_v2.input_admission_slots
     WHERE active_claim_id IS NULL OR slot_expires_at <= clock_timestamp()
     ORDER BY slot_id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1;
     ```
     If none available, abort with `NO_ADMISSION_SLOT`.
     *Atomic Invalidation:* If `v_slot.active_claim_id IS NOT NULL`, lock old claim, mark `status = 'expired'`, and update its request to `status = 'retry'` (or `failed` if exhausted) before reassigning.
4. **Deep Freshness Revalidation:**
   - Confirm under lock: `listing.revision = r.listing_revision`, `listing.title = r.original_title`, `listing.description IS NOT DISTINCT FROM r.original_description`, and `listing.status = 'pending_review'`.
   - If stale or mismatched: mark request `status = 'superseded'`, release slot, and skip to next candidate.
5. **Issue Fenced Claim:**
   - Generate secret `v_claim_token` and hash `v_token_hash`.
   - Insert into `app_moderation_v2.input_claims` (`slot_id = v_slot.slot_id`, `status = 'active'`, `attempt_number = r.attempt_count + 1`).
   - Update slot: `active_claim_id = v_claim_id`, `slot_acquired_at = clock_timestamp()`, `slot_expires_at = clock_timestamp() + interval '30 seconds'`.
   - Advance request: `status = 'claimed'`, `attempt_count = attempt_count + 1`, `updated_at = clock_timestamp()`.
6. **Return Payload:**
   `{ success: true, request_id, attempt_id, attempt_number, claim_token, lease_expires_at, max_renewal_until, original_title, original_description, listing_revision, request_lane }`.

#### Protocol B: `heartbeat_moderation_v2_input`
1. Lock slot -> lock claim:
   `SELECT slot_id FROM app_moderation_v2.input_admission_slots WHERE id = v_claim.slot_id FOR UPDATE;`
   `SELECT status, claim_token_hash, lease_expires_at, max_renewal_until FROM app_moderation_v2.input_claims WHERE request_id = p_request_id AND attempt_id = p_attempt_id FOR UPDATE;`
2. Gate recheck: verify `moderation_v2_enabled = 'true'`. If disabled, mark claim `status = 'abandoned'`, clear slot, and return `{ success: false, error: 'V2_DISABLED' }`. Heartbeats must not extend disabled work.
3. Verify token: If `v_token_hash <> claim_token_hash`, return `{ success: false, error: 'LEASE_TOKEN_MISMATCH' }`.
4. Verify expiry: If `lease_expires_at <= clock_timestamp()`, update claim `status = 'expired'`, clear slot, and return `{ success: false, error: 'LEASE_EXPIRED' }`.
5. Verify ceiling: If `clock_timestamp() >= max_renewal_until`, return `{ success: false, error: 'RENEWAL_CEILING_REACHED' }`.
6. Extend lease: `lease_expires_at := LEAST(clock_timestamp() + interval '30 seconds', max_renewal_until)`. Update slot and claim. Return `{ success: true, lease_expires_at }`.

#### Protocol C: `recover_expired_input_claims`
1. Discovers claims where `status = 'active'` AND `lease_expires_at <= clock_timestamp()`.
2. Follows lock hierarchy: lock parent listing -> lock request -> lock slot -> lock claim.
3. Marks claim `status = 'expired'`, clears slot (`active_claim_id = NULL`).
4. Request escalation:
   - If `attempt_count >= 3`: sets request `status = 'failed'` (retry exhausted; recorded in audit without auto-rejecting listing).
   - If `attempt_count < 3`: calculates retry backoff (`next_attempt_at := clock_timestamp() + interval '10 seconds' * attempt_count + (random() * interval '3 seconds')`), sets request `status = 'retry'`.

#### Protocol D: `finalize_moderation_v2_input`
1. **Pre-Queue Authentication:**
   Verify `app_security.verify_moderation_worker_secret(p_worker_secret)`. Fail closed if invalid (`28000`).
2. **Canonical Payload Hashing:**
   Compute `v_payload_digest := app_moderation_v2.canonical_early_result_digest(...)`.
3. **Pre-Lock Authenticated Replay Check:**
   Check `app_moderation_v2.input_results` for `(request_id, attempt_id)`:
   - If found:
     - Verify attempt token hash matches.
     - If `payload_digest = v_payload_digest`: return recorded response immediately (`idempotent_replay: true`), applying **no changes** to database state. Matching replay may bypass current lease expiry, but **never** bypasses authentication or creates side effects.
     - If `payload_digest <> v_payload_digest`: raise exception `IDEMPOTENCY_CONFLICT`.
4. **Acquire Locks in Hierarchy:**
   Lock parent listing (`FOR UPDATE`) -> lock request (`FOR UPDATE`) -> lock slot (`FOR UPDATE`) -> lock claim (`FOR UPDATE`).
5. **Re-check Result Ledger Under Locks:**
   Verify no concurrent finalization occurred between pre-check and lock acquisition. If recorded, perform safe replay return.
6. **Recheck System Gates & Registry Approvals:**
   Verify `moderation_v2_enabled = 'true'`, `moderation_v2_mode IN ('shadow', 'enforce')`, and `policy_registry.is_approved = true`. Else fail closed.
7. **Fencing & Lease Verification:**
   - Verify `claim_token_hash = sha256(p_claim_token)`. Else raise `LEASE_TOKEN_MISMATCH`.
   - Verify claim `status = 'active'` AND `lease_expires_at > clock_timestamp()`. Else raise `LEASE_EXPIRED`.
8. **Deep Stale-Request Protection:**
   Verify under lock:
   - `listing.revision = r.listing_revision`
   - `listing.title = r.original_title`
   - `listing.description IS NOT DISTINCT FROM r.original_description`
   - `listing.status = 'pending_review'`
   If any check fails:
   - Mark request `status = 'superseded'`.
   - Mark claim `status = 'superseded'`.
   - Clear admission slot.
   - Record result `decision = 'superseded'`.
   - Return `{ success: true, decision: 'superseded', reason: 'STALE_REQUEST' }`.
9. **Independent Database Validation:**
   Recompute `v_db_eval := app_moderation_v2.validate_v2_stored_text(r.original_title, r.original_description)`.
   Worker payload must match `v_db_eval->'validation_errors'`. Mismatch raises `VALIDATION_MISMATCH`.
10. **State Transitions:**
    - **Branch 1: Valid Text (`validation_errors = []`)**
      - Internal queue transition: `r.phase := 'preparation'`, `r.status := 'awaiting_media'`, `r.updated_at := clock_timestamp()`.
      - Claim updates: `status := 'completed'`.
      - Free admission slot.
      - Record in `app_moderation_v2.input_results` (`decision := 'valid'`).
      - Return `{ success: true, decision: 'valid', next_phase: 'preparation' }`.
      - *Invariant:* Listing remains `pending_review`. **Never approves or publishes.**
    - **Branch 2: Invalid Text (`validation_errors.length >= 1`)**
      - Conforms to `EarlyInvalidResultV2Schema` (`outcome := 'invalid_input'`).
      - Request updates: `status := 'failed'`, `updated_at := clock_timestamp()`.
      - Claim updates: `status := 'completed'`.
      - Free admission slot.
      - Record in `app_moderation_v2.input_results` (`decision := 'rejected_invalid'`).
      - *Lane Isolation:*
        - `shadow` mode: **Leaves `public.listings` completely untouched.** Listing remains in current state.
        - `enforce` mode: Deferred seller-facing transition is recorded; seller correction semantics mirror V1 `rejected` flow without unreviewed bypass.
      - Return `{ success: true, decision: 'rejected_invalid', validation_errors: v_db_eval->'validation_errors' }`.

---

## 5. Security & Isolation Controls

1. **Role & Schema Isolation:**
   - Schema `app_moderation_v2` has `REVOKE ALL FROM PUBLIC, anon, authenticated`.
   - Tables (`input_admission_slots`, `input_claims`, `input_results`) enable Row Level Security with zero client policies.
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
2. **Pre-Queue Authentication & Gate Assertions:**
   - Claim rejected (`PROVIDER_AUTH`) when worker secret is invalid or missing.
   - Claim rejected (`V2_DISABLED`) when `moderation_v2_enabled = false` or mode is `disabled`.
   - Claim rejected (`POLICY_DISAPPROVED`) when policy is not approved in registry.
3. **Two-Session Deterministic Concurrency & Deadlock Tests:**
   - Session A claims request 1; Session B claims request 2 concurrently. Verifies zero deadlocks and correct slot assignment (slots 1 and 2).
   - Session C attempts 3rd concurrent claim: receives `NO_ADMISSION_SLOT`.
   - Expired slot recovery: Session A allows lease to expire; Session C acquires expired slot, atomically fencing Session A's claim.
4. **Heartbeat & Expiry Assertions:**
   - Valid heartbeat extends `lease_expires_at` within renewal ceiling.
   - Heartbeat rejected if `claim_token` does not match hash (`LEASE_TOKEN_MISMATCH`).
   - Heartbeat rejected if lease is already expired (`LEASE_EXPIRED`).
   - Heartbeat capped at `max_renewal_until` (`RENEWAL_CEILING_REACHED`).
   - Heartbeat rejected if V2 gate is disabled during processing (`V2_DISABLED`).
5. **Recovery & Retry Exhaustion:**
   - Expired claim recovered, freeing admission slot and rescheduling request to `retry` with backoff.
   - Attempt count reaching 3 marks request `status = 'failed'` without further retries (escalated safely, never auto-rejecting listing).
6. **Idempotency & Finalization Assertions:**
   - Valid text input transitions request to `phase = 'preparation'`, `status = 'awaiting_media'`.
   - Listing status remains `pending_review` (proves early input never approves).
   - Authenticated replay with identical payload returns `idempotent_replay = true` without modifying database state.
   - Replay with altered payload raises `IDEMPOTENCY_CONFLICT`.
7. **Stale Revision & Admin Race Fencing:**
   - Bumped `listings.revision` triggers clean `superseded` transition.
   - Altered listing title triggers clean `superseded` transition.
   - Listing status changing to `draft` / `active` triggers clean `superseded` transition.
8. **Shadow vs Enforce Mode Parity:**
   - Invalid text in `shadow` mode records failure in V2 without touching `public.listings`.
   - Invalid text in `enforce` mode triggers seller correction transition on `public.listings`.

---

## 7. Delivery Plan & Gates

1. **Step 1:** CTO review and sign-off on this final design specification.
2. **Step 2:** Generate next forward migration timestamp using pinned Supabase CLI 2.117.0 on isolated branch `feat/moderation-v2-input-lease`.
3. **Step 3:** Implement SQL migration in `supabase/forward-migrations/moderation-v2/`.
4. **Step 4:** Implement pgTAP test suite in `supabase/tests/moderation_v2_input_lease.test.sql`.
5. **Step 5:** Append to `docs/moderation/V2_FORWARD_MANIFEST.json` and verify with offline verification script.
6. **Step 6:** Validate with GitHub Actions CI workflows (`Backend independent CI` and `Backend V2 forward migration PG15`).
7. **Step 7:** Report commit SHA and CI results for CTO review.
