# FairSwap Moderation V2 — Slice C2b Implementation Plan
**Database-Owned Input-Validation Leases, Attempt Tokens, Idempotent Early Finalization, and Stale-Request Protection**

**Status:** Revised Design Proposal for CTO Sign-Off  
**Worktree:** `C:\Users\VivekKumar\OneDrive - Nobly A S\Documents\FairSwap-Backend-InputLease`  
**Branch:** `feat/moderation-v2-input-lease`  
**Base Commit:** `fc4dcedd7f039be70ddb1e9fee62491112a872cf` (Frozen Slice C2a)  
**Parent PR:** Draft PR #25 (`feat/moderation-v2-text-validation`, unmerged)  
**Target Migration Path:** Additive forward lane (`supabase/forward-migrations/moderation-v2/`)  
**Design Authority:**
- `docs/moderation/MODERATION_V2_CONTRACT.md` §§5–8
- `docs/moderation/MODERATION_V2_APPROVAL_IMPLEMENTATION.md` §4 Slice C/E/F
- `docs/moderation/MODERATION_V2_INPUT_VALIDATION_ANTIGRAVITY.md` §Follow-on Slice C2b

---

## 1. Scope, System Boundaries, and Strict Negative Invariants

Slice C2a established server/DB-owned immutable text binding on `app_moderation_v2.requests` and deterministic UTF-16 scalar validation (`app_moderation_v2.validate_v2_stored_text`).

Slice C2b introduces the database-owned lease and attempt lifecycle for the early `input_validation` phase:
1. **DB-Owned Input-Validation Processing Lease & Attempt Accounting:**
   - Dedicated private tables `app_moderation_v2.input_admission_slots` (atomic slots), `app_moderation_v2.input_claims` (fenced active claims), and `app_moderation_v2.input_results` (immutable idempotency ledger).
   - Candidate lease timing: 30s initial lease; renewal ceiling at attempt start + 60s. (Treated as provisional candidates subject to runtime measurement).
   - Cryptographically strong, DB-generated `claim_token` (32-byte hexadecimal random secret) and unique `attempt_id`.
2. **Pre-Queue Authentication & Gate Verification:**
   - Trusted-worker / Vault authentication verified before any queue claim or state modification.
   - Enforce/shadow gating checked under transaction lock against `public.app_system_settings`:
     `moderation_v2_enabled = 'true'` AND `moderation_v2_mode IN ('shadow', 'enforce')`.
   - Approved policy and approved evaluator build verified against `app_moderation_v2.policy_registry`.
   - Enforce mode allowlist checked before any seller-facing status side effect.
3. **Strict Lock Ordering Hierarchy:**
   - Universal lock sequence across claim, heartbeat, recovery, and finalization:
     `public.listings` (parent row) -> `app_moderation_v2.requests` -> `app_moderation_v2.input_claims`.
   - Fencing via single-use `claim_token` to prevent expired or zombie workers from committing.
4. **Stale-Request Protection:**
   - Deep verification of listing state: matches exact `listing_revision`, `title`, `description`, `generation_id`, `policy_version`, and listing `status` in addition to checking whether revision advanced.
5. **Normative Idempotency & Early Finalization:**
   - Conforms strictly to `EarlyInvalidResultV2Schema` and early phase contracts in `ModerationResultV2Schema`.
   - Idempotency bound to `(request_id, attempt_id, payload_digest)`. Replays return cached responses before re-acquiring locks or reapplying mutations; payload conflicts raise `IDEMPOTENCY_CONFLICT`.
6. **Strict Negative Invariants (Mandatory Stop Conditions):**
   - Early input validation **CAN NEVER APPROVE OR PUBLISH A LISTING**.
   - Zero interaction with media, image sealing, or provider dispatch.
   - Zero modifications to V1 historical migrations (all 58 files remain sealed).
   - Zero mutations to hosted Supabase Test/Production environments.
   - `moderation_v2_enabled` remains `false` in database defaults; no gates are enabled.

---

## 2. Database Schema Design

### 2.1 Atomic Concurrency & Admission Slot Table

To prevent race conditions inherent in non-atomic `COUNT(*)` queries across competing workers, global concurrency is enforced through a fixed, pre-allocated pool of admission slots:

```sql
CREATE TABLE app_moderation_v2.input_admission_slots (
  slot_id smallint PRIMARY KEY CHECK (slot_id BETWEEN 1 AND 5), -- provisional global concurrency cap: 5
  active_claim_id uuid REFERENCES app_moderation_v2.input_claims(id) ON DELETE SET NULL,
  slot_acquired_at timestamptz,
  slot_expires_at timestamptz
);

-- Pre-seed fixed admission slots (1..5)
INSERT INTO app_moderation_v2.input_admission_slots (slot_id)
SELECT generate_series(1, 5);
```

### 2.2 Durable Input Claims Table

```sql
CREATE TABLE app_moderation_v2.input_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id uuid NOT NULL
    REFERENCES app_moderation_v2.requests(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  claim_token_hash text NOT NULL, -- SHA-256 hex digest of secret claim_token
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

CREATE INDEX idx_v2_input_claims_active
  ON app_moderation_v2.input_claims (request_id, lease_expires_at)
  WHERE status = 'active';
```

### 2.3 Idempotent Early Results Ledger

```sql
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

```sql
-- Worker must prove possession of the vault worker secret prior to queue operations
-- Wrapper delegates to app_security.verify_moderation_worker_secret
```

### 3.2 `claim_moderation_v2_input(p_worker_id text, p_worker_secret text)`
- **Lock Ordering:**
  1. System gates & policy approval verification.
  2. `app_moderation_v2.input_admission_slots` (`FOR UPDATE SKIP LOCKED LIMIT 1`).
  3. `app_moderation_v2.requests` (`FOR UPDATE SKIP LOCKED LIMIT 1`).
  4. Parent `public.listings` (`FOR SHARE` to verify freshness during claim).
- **Execution Flow:**
  1. Authenticate worker: verify `p_worker_secret`. Fail closed with `PROVIDER_AUTH` / `UNAUTHORIZED` if invalid.
  2. Verify gates:
     - `moderation_v2_enabled = 'true'`
     - `moderation_v2_mode IN ('shadow', 'enforce')`
     - Fail closed (`V2_DISABLED`) if gates are not open.
  3. Verify policy & build:
     - Check `app_moderation_v2.policy_registry` for `is_approved = true` and non-null `approved_evaluator_build`.
  4. Acquire admission slot:
     - Select 1 slot where `active_claim_id IS NULL OR slot_expires_at <= clock_timestamp()` `FOR UPDATE SKIP LOCKED`.
     - If none available, return `{ success: false, error: 'NO_ADMISSION_SLOT' }`.
  5. Select candidate request:
     - `phase = 'input_validation'`, `status IN ('pending_input', 'retry')`, `next_attempt_at <= clock_timestamp()`, `attempt_count < 3`.
     - Lock candidate row `FOR UPDATE SKIP LOCKED`. If none available, release slot and return `{ success: false, error: 'NO_REQUEST_AVAILABLE' }`.
  6. Verify parent listing under `FOR SHARE`:
     - Confirm listing exists, revision equals `r.listing_revision`, title equals `r.original_title`, description IS NOT DISTINCT FROM `r.original_description`.
     - If stale or mismatched: mark request `superseded`, release slot, and skip to next candidate.
  7. Generate claim material:
     - Secret `v_claim_token := encode(gen_random_bytes(32), 'hex')`.
     - `v_token_hash := encode(sha256(convert_to(v_claim_token, 'UTF8')), 'hex')`.
     - Initial lease: `clock_timestamp() + interval '30 seconds'`.
     - Max renewal ceiling: `clock_timestamp() + interval '60 seconds'`.
  8. Insert claim row into `app_moderation_v2.input_claims`.
  9. Update slot with `active_claim_id` and expiry.
  10. Advance request: `attempt_count := attempt_count + 1`, `status := 'claimed'`, `updated_at := clock_timestamp()`.
  11. Return `{ success: true, request_id, attempt_id, attempt_number, claim_token, lease_expires_at, max_renewal_until, original_title, original_description, listing_revision, request_lane }`.

### 3.3 `heartbeat_moderation_v2_input(p_request_id uuid, p_attempt_id uuid, p_claim_token text)`
- **Lock Ordering:**
  1. Lock claim row: `SELECT ... FROM app_moderation_v2.input_claims WHERE request_id = p_request_id AND attempt_id = p_attempt_id FOR UPDATE;`
  2. Lock slot row: `SELECT ... FROM app_moderation_v2.input_admission_slots WHERE id = v_claim.slot_id FOR UPDATE;`
- **Execution Flow:**
  1. Verify claim exists, `status = 'active'`, and `claim_token_hash` matches `sha256(p_claim_token)`. If stolen or mismatched token, return `{ success: false, error: 'LEASE_TOKEN_MISMATCH' }`.
  2. Check expiry: if `lease_expires_at <= clock_timestamp()`, update claim `status = 'expired'`, clear slot, and return `{ success: false, error: 'LEASE_EXPIRED' }`.
  3. Check ceiling: if `clock_timestamp() >= max_renewal_until`, return `{ success: false, error: 'RENEWAL_CEILING_REACHED' }`.
  4. Extend lease: `lease_expires_at := LEAST(clock_timestamp() + interval '30 seconds', max_renewal_until)`.
  5. Update slot `slot_expires_at := lease_expires_at`.
  6. Return `{ success: true, lease_expires_at }`.

### 3.4 `recover_expired_input_claims()`
- **Execution Flow:**
  1. Identifies claims with `status = 'active'` AND `lease_expires_at < clock_timestamp()`.
  2. Under lock: marks claim `status = 'expired'`, clears admission slot.
  3. Inspects request:
     - If `attempt_count >= 3`: sets request `status = 'failed'`, records abandonment in audit.
     - If `attempt_count < 3`: calculates retry backoff (`next_attempt_at := clock_timestamp() + interval '10 seconds' * attempt_count + (random() * interval '3 seconds')`), sets request `status = 'retry'`.

### 3.5 `finalize_moderation_v2_input(p_request_id uuid, p_attempt_id uuid, p_claim_token text, p_payload jsonb)`
- **Input Payload Structure:**
  Must match `EarlyInvalidResultV2Schema` or valid input outcome:
  ```json
  {
    "phase": "input_validation",
    "outcome": "valid" | "invalid_input",
    "validation_errors": [
      { "field": "title" | "description", "code": "TYPE" | "TOO_SHORT" | "TOO_LONG" }
    ],
    "title_sha256": "...",
    "description_sha256": "..."
  }
  ```
- **Lock Hierarchy (Mandatory & Invariant):**
  1. Parent listing: `SELECT revision, title, description, status FROM public.listings WHERE id = v_listing_id FOR UPDATE;`
  2. V2 Request: `SELECT listing_id, listing_revision, generation_id, policy_version, request_lane, original_title, original_description, status FROM app_moderation_v2.requests WHERE id = p_request_id FOR UPDATE;`
  3. Claim: `SELECT status, claim_token_hash, lease_expires_at, slot_id FROM app_moderation_v2.input_claims WHERE request_id = p_request_id AND attempt_id = p_attempt_id FOR UPDATE;`
- **Replay & Idempotency Check:**
  - Compute payload digest: `v_payload_digest := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex')`.
  - Check `app_moderation_v2.input_results` for `(request_id, attempt_id)`:
    - If found AND `payload_digest = v_payload_digest`: return recorded response immediately (`idempotent_replay: true`), applying **no changes** to listing, request, or claim.
    - If found AND `payload_digest <> v_payload_digest`: raise exception `IDEMPOTENCY_CONFLICT`.
- **Fencing & Lease Verification:**
  - Verify `claim_token_hash = sha256(p_claim_token)`. Else raise `LEASE_TOKEN_MISMATCH`.
  - Verify claim `status = 'active'` AND `lease_expires_at > clock_timestamp()`. Else raise `LEASE_EXPIRED`.
- **Deep Stale-Request Verification:**
  - Check `v_listing.revision = v_request.listing_revision`.
  - Check `v_listing.title = v_request.original_title`.
  - Check `v_listing.description IS NOT DISTINCT FROM v_request.original_description`.
  - Check `v_listing.status = 'pending_review'`.
  - If any check fails (e.g. revision bumped, title edited, status cancelled/approved by admin race):
    - Request is marked `status = 'superseded'`.
    - Claim is marked `status = 'superseded'`.
    - Clear admission slot.
    - Record result `decision = 'superseded'`.
    - Return recorded supersede response.
- **Independent Database Validation:**
  - Database re-evaluates text: `v_db_eval := app_moderation_v2.validate_v2_stored_text(v_request.original_title, v_request.original_description)`.
  - Verify payload consistency: worker's `validation_errors` must match `v_db_eval->'validation_errors'`. Mismatch raises `VALIDATION_MISMATCH`.
- **State Transitions:**
  - **Branch 1: Valid Text (`validation_errors = []`)**
    - Request updates: `phase := 'preparation'`, `status := 'awaiting_media'`, `updated_at := clock_timestamp()`.
    - Claim updates: `status := 'completed'`.
    - Free admission slot.
    - Record in `app_moderation_v2.input_results` (`decision := 'valid'`).
    - Return `{ success: true, decision: 'valid', next_phase: 'preparation' }`.
    - *Note:* Listing status remains `pending_review`. **Never approves or publishes.**
  - **Branch 2: Invalid Text (`validation_errors.length >= 1`)**
    - Request updates: `status := 'failed'`, `updated_at := clock_timestamp()`.
    - Claim updates: `status := 'completed'`.
    - Free admission slot.
    - Record in `app_moderation_v2.input_results` (`decision := 'rejected_invalid'`).
    - *Lane Handling:*
      - If `request_lane = 'enforce'`: verify listing ID is on server enforce allowlist; transition listing status to seller correction state via standard status machine.
      - If `request_lane = 'shadow'`: **do not touch `public.listings`**. Listing remains in its current state.
    - Return `{ success: true, decision: 'rejected_invalid', validation_errors: v_db_eval->'validation_errors' }`.

---

## 4. Concurrency, Race Conditions, and Edge Cases

| Scenario | Race Condition | Resolution Mechanism |
| :--- | :--- | :--- |
| **Worker Collision** | Multiple workers attempt to claim the same request | `FOR UPDATE OF r SKIP LOCKED` guarantees exactly one worker acquires the row. |
| **Slot Exhaustion** | Workers burst beyond global cap | Pre-seeded admission slots locked `SKIP LOCKED`; workers receive `NO_ADMISSION_SLOT` and back off without spinning. |
| **Seller Edit Race** | Seller edits listing while input validation is in flight | `listings.revision` increments; `finalize_moderation_v2_input` locks listing first, detects mismatch, marks request `superseded`. |
| **Admin Action Race** | Admin reviews or removes listing during validation | Listing status leaves `pending_review`; finalizer detects status mismatch and supersedes V2 request. |
| **Worker Crash / Timeout** | Worker crashes or hangs during scalar validation | Lease expires after 30s; `recover_expired_input_claims` frees slot and schedules retry up to 3 attempts. |
| **Zombie Worker Commit** | Expired worker attempts to finalize after lease expiry | Claim lock observes `lease_expires_at <= clock_timestamp()` or `status = 'expired'`; aborts with `LEASE_EXPIRED`. |
| **Duplicate Delivery** | Network drops response; worker replays finalization | Idempotency ledger returns identical recorded response without re-executing transitions or locking parent rows. |
| **Tampered / Stolen Token** | Competing worker attempts heartbeat or finalization with forged token | Hash mismatch triggers immediate `LEASE_TOKEN_MISMATCH`. |

---

## 5. Security & Isolation Controls

1. **Schema & Role Isolation:**
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
   - Claim succeeds up to 5 concurrent slots; 6th worker receives `NO_ADMISSION_SLOT`.
   - Candidate request transitions to `status = 'claimed'` and increments `attempt_count`.
3. **Heartbeat & Expiry Assertions:**
   - Valid heartbeat extends `lease_expires_at` within renewal ceiling.
   - Heartbeat rejected if `claim_token` does not match hash (`LEASE_TOKEN_MISMATCH`).
   - Heartbeat rejected if lease is already expired (`LEASE_EXPIRED`).
   - Heartbeat capped at `max_renewal_until` (`RENEWAL_CEILING_REACHED`).
4. **Recovery & Retry Exhaustion:**
   - Expired claim recovered, freeing admission slot and rescheduling request to `retry` with backoff.
   - Attempt count reaching 3 marks request `status = 'failed'` without further retries.
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

## 7. Open Architectural Questions for CTO Sign-Off

1. **Concurrency Cap:** Is the provisional global concurrency cap of 5 concurrent input validation claims appropriate for initial rollout, or should it be configurable via `app_system_settings`?
2. **Renewal Limits:** Are 30s initial lease and 60s max renewal ceiling acceptable for Edge-worker scalar validation latency profiles, or should they be aligned with a different timeout envelope?
3. **Enforce Mode Correction Transition:** When invalid text is finalized in `enforce` mode, should the listing status transition directly to `draft` with correction flags, or route through a specific versioned transition trigger?
