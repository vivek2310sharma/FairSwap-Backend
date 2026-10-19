-- FairSwap Moderation V2 / Slice C2b — DB-owned input-validation leases, atomic admission slots, attempt accounting, and early finalization.
-- Applied to the separate forward lane; never append to the sealed V1 manifest.
-- Private schema-qualified objects; REVOKE ALL from PUBLIC, anon, authenticated.

-- 1. Atomic Admission Slots (Pre-allocated concurrency pool; provisional 2 slots)
CREATE TABLE app_moderation_v2.input_admission_slots (
  slot_id smallint PRIMARY KEY CHECK (slot_id IN (1, 2)),
  active_claim_id uuid, -- FK added after input_claims creation
  slot_acquired_at timestamptz,
  slot_expires_at timestamptz
);

COMMENT ON TABLE app_moderation_v2.input_admission_slots IS
  'Pre-allocated admission slots guaranteeing atomic DB-owned worker concurrency limits';

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

COMMENT ON TABLE app_moderation_v2.input_claims IS
  'Durable input-validation attempt claims with cryptographic token hashing and lease fencing';

ALTER TABLE app_moderation_v2.input_admission_slots
  ADD CONSTRAINT fk_v2_admission_claim
  FOREIGN KEY (active_claim_id) REFERENCES app_moderation_v2.input_claims(id)
  ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_v2_input_claims_active_request
  ON app_moderation_v2.input_claims (request_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX uq_v2_input_claims_active_slot
  ON app_moderation_v2.input_claims (slot_id)
  WHERE status = 'active';

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

COMMENT ON TABLE app_moderation_v2.input_results IS
  'Immutable append-only idempotency ledger recording validated early results and payload digests';

CREATE INDEX idx_v2_input_results_request
  ON app_moderation_v2.input_results (request_id, recorded_at DESC);

-- Enable RLS on all C2b tables
ALTER TABLE app_moderation_v2.input_admission_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_moderation_v2.input_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_moderation_v2.input_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA app_moderation_v2
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON app_moderation_v2.input_admission_slots TO service_role;
GRANT SELECT, INSERT, UPDATE ON app_moderation_v2.input_claims TO service_role;
GRANT SELECT, INSERT ON app_moderation_v2.input_results TO service_role;

-- 4. Deterministic Compact Canonical JSON Serializer & Digest Generator
-- Authoritative full-envelope canonicalization binding all identity, attempt, timing, contract, evaluator, and payload fields.
CREATE OR REPLACE FUNCTION app_moderation_v2.canonical_early_result_json(
  p_contract_version text,
  p_policy_version text,
  p_evaluator_version text,
  p_request_id uuid,
  p_attempt_id uuid,
  p_evaluated_at text,
  p_phase text,
  p_outcome text,
  p_listing_id uuid,
  p_listing_revision integer,
  p_generation_id uuid,
  p_title_sha256 text,
  p_description_sha256 text,
  p_validation_errors jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $func$
DECLARE
  v_errs_str text := '[]';
  v_e record;
  v_first boolean := true;
BEGIN
  IF p_validation_errors IS NOT NULL AND jsonb_array_length(p_validation_errors) > 0 THEN
    v_errs_str := '[';
    FOR v_e IN
      SELECT e->>'code' AS code, e->>'field' AS field
      FROM jsonb_array_elements(p_validation_errors) AS e
      ORDER BY
        CASE e->>'field'
          WHEN 'title' THEN 1
          WHEN 'description' THEN 2
          ELSE 3
        END ASC,
        e->>'code' ASC
    LOOP
      IF NOT v_first THEN
        v_errs_str := v_errs_str || ',';
      END IF;
      v_first := false;
      v_errs_str := v_errs_str || '{"code":' || to_json(v_e.code)::text || ',"field":' || to_json(v_e.field)::text || '}';
    END LOOP;
    v_errs_str := v_errs_str || ']';
  END IF;

  RETURN '[' ||
    to_json('fairswap:v2:early_result_v2'::text)::text || ',' ||
    to_json(p_contract_version)::text || ',' ||
    to_json(p_policy_version)::text || ',' ||
    to_json(p_evaluator_version)::text || ',' ||
    to_json(p_request_id::text)::text || ',' ||
    to_json(p_attempt_id::text)::text || ',' ||
    to_json(p_evaluated_at)::text || ',' ||
    to_json(p_phase)::text || ',' ||
    to_json(p_outcome)::text || ',' ||
    to_json(p_listing_id::text)::text || ',' ||
    p_listing_revision::text || ',' ||
    to_json(p_generation_id::text)::text || ',' ||
    CASE WHEN p_title_sha256 IS NULL THEN 'null' ELSE to_json(p_title_sha256)::text END || ',' ||
    CASE WHEN p_description_sha256 IS NULL THEN 'null' ELSE to_json(p_description_sha256)::text END || ',' ||
    v_errs_str ||
  ']';
END;
$func$;
;

REVOKE ALL ON FUNCTION app_moderation_v2.canonical_early_result_json(text, text, text, uuid, uuid, text, text, text, uuid, integer, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_moderation_v2.canonical_early_result_json(text, text, text, uuid, uuid, text, text, text, uuid, integer, uuid, text, text, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION app_moderation_v2.canonical_early_result_digest(
  p_contract_version text,
  p_policy_version text,
  p_evaluator_version text,
  p_request_id uuid,
  p_attempt_id uuid,
  p_evaluated_at text,
  p_phase text,
  p_outcome text,
  p_listing_id uuid,
  p_listing_revision integer,
  p_generation_id uuid,
  p_title_sha256 text,
  p_description_sha256 text,
  p_validation_errors jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $func$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        app_moderation_v2.canonical_early_result_json(
          p_contract_version, p_policy_version, p_evaluator_version,
          p_request_id, p_attempt_id, p_evaluated_at,
          p_phase, p_outcome, p_listing_id, p_listing_revision, p_generation_id,
          p_title_sha256, p_description_sha256, p_validation_errors
        ),
        'UTF8'
      )
    ),
    'hex'
  );
$func$;
;

REVOKE ALL ON FUNCTION app_moderation_v2.canonical_early_result_digest(text, text, text, uuid, uuid, text, text, text, uuid, integer, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_moderation_v2.canonical_early_result_digest(text, text, text, uuid, uuid, text, text, text, uuid, integer, uuid, text, text, jsonb)
  TO service_role;

-- 5. Dedicated Recovery Transaction: recover_expired_input_claims
CREATE OR REPLACE FUNCTION app_moderation_v2.recover_expired_input_claims(
  p_worker_secret text,
  p_batch_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_recovered_count integer := 0;
  v_claim_id uuid;
  v_req_id uuid;
  v_listing_id uuid;
  v_slot_id smallint;
  v_attempt_cnt integer;
  v_c_status text;
  v_c_expiry timestamptz;
BEGIN
  IF NOT public.verify_moderation_worker_secret(p_worker_secret) THEN
    RAISE EXCEPTION 'Worker authentication failed' USING ERRCODE = '28000';
  END IF;

  FOR v_claim_id, v_req_id, v_listing_id, v_slot_id IN
    SELECT c.id, c.request_id, r.listing_id, c.slot_id
    FROM app_moderation_v2.input_claims c
    JOIN app_moderation_v2.requests r ON r.id = c.request_id
    WHERE c.status = 'active'
      AND c.lease_expires_at <= pg_catalog.clock_timestamp()
    ORDER BY c.lease_expires_at ASC
    LIMIT p_batch_limit
  LOOP
    -- Universal lock hierarchy: listings -> requests -> slots -> claims
    PERFORM 1 FROM public.listings WHERE id = v_listing_id FOR SHARE;
    SELECT attempt_count INTO v_attempt_cnt FROM app_moderation_v2.requests WHERE id = v_req_id FOR UPDATE;
    PERFORM 1 FROM app_moderation_v2.input_admission_slots WHERE slot_id = v_slot_id FOR UPDATE;
    SELECT status, lease_expires_at INTO v_c_status, v_c_expiry
    FROM app_moderation_v2.input_claims WHERE id = v_claim_id FOR UPDATE;

    -- Re-validate under locks
    IF v_c_status = 'active' AND v_c_expiry <= pg_catalog.clock_timestamp() THEN
      UPDATE app_moderation_v2.input_claims
      SET status = 'expired', updated_at = pg_catalog.clock_timestamp()
      WHERE id = v_claim_id;

      UPDATE app_moderation_v2.input_admission_slots
      SET active_claim_id = NULL, slot_acquired_at = NULL, slot_expires_at = NULL
      WHERE slot_id = v_slot_id AND active_claim_id = v_claim_id;

      IF v_attempt_cnt >= 3 THEN
        UPDATE app_moderation_v2.requests
        SET status = 'failed', updated_at = pg_catalog.clock_timestamp()
        WHERE id = v_req_id;
      ELSE
        UPDATE app_moderation_v2.requests
        SET status = 'retry',
            next_attempt_at = pg_catalog.clock_timestamp() + interval '5 seconds' * v_attempt_cnt,
            updated_at = pg_catalog.clock_timestamp()
        WHERE id = v_req_id;
      END IF;

      v_recovered_count := v_recovered_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'recovered_count', v_recovered_count
  );
END;
$$;
;

REVOKE ALL ON FUNCTION app_moderation_v2.recover_expired_input_claims(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_moderation_v2.recover_expired_input_claims(text, integer)
  TO service_role;

-- 6. Claim Input Request: claim_moderation_v2_input
CREATE OR REPLACE FUNCTION app_moderation_v2.claim_moderation_v2_input(
  p_worker_secret text,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_enabled text;
  v_mode text;
  v_policy_approved boolean;
  v_evaluator_build text;
  v_req record;
  v_listing record;
  v_slot_id smallint;
  v_claim_token text;
  v_token_hash text;
  v_claim_id uuid;
  v_attempt_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_bounded_lease integer;
  v_lease_expires timestamptz;
  v_max_renewal timestamptz;
BEGIN
  IF NOT public.verify_moderation_worker_secret(p_worker_secret) THEN
    RAISE EXCEPTION 'Worker authentication failed' USING ERRCODE = '28000';
  END IF;

  -- Bound worker-supplied lease: between 5s and 60s
  v_bounded_lease := GREATEST(5, LEAST(coalesce(p_lease_seconds, 30), 60));

  -- Recheck system gates & mode under lock (fail closed on missing/NULL)
  SELECT setting_value INTO v_enabled FROM public.app_system_settings WHERE setting_key = 'moderation_v2_enabled';
  SELECT setting_value INTO v_mode FROM public.app_system_settings WHERE setting_key = 'moderation_v2_mode';
  IF v_enabled IS DISTINCT FROM 'true' OR (v_mode IS DISTINCT FROM 'shadow' AND v_mode IS DISTINCT FROM 'enforce') THEN
    RETURN jsonb_build_object('success', false, 'error', 'V2_DISABLED');
  END IF;

  SELECT is_approved, approved_evaluator_build INTO v_policy_approved, v_evaluator_build
  FROM app_moderation_v2.policy_registry
  WHERE policy_version = 'fairswap_moderation_v2.0.0';
  IF v_policy_approved IS NOT TRUE OR v_evaluator_build IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'POLICY_DISAPPROVED');
  END IF;

  -- Discovery
  SELECT id, listing_id INTO v_req
  FROM app_moderation_v2.requests
  WHERE phase = 'input_validation'
    AND status IN ('pending_input', 'retry')
    AND next_attempt_at <= pg_catalog.clock_timestamp()
    AND attempt_count < 3
  ORDER BY next_attempt_at ASC, created_at ASC
  LIMIT 1;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_REQUEST_AVAILABLE');
  END IF;

  -- Universal lock hierarchy: listings (FOR SHARE) -> requests (FOR UPDATE) -> admission_slots (FOR UPDATE SKIP LOCKED)
  SELECT id, revision, title, description, status INTO v_listing
  FROM public.listings
  WHERE id = v_req.listing_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'LISTING_NOT_FOUND');
  END IF;

  SELECT id, listing_id, listing_revision, generation_id, policy_version, request_lane,
         original_title, original_description, attempt_count, status
  INTO v_req
  FROM app_moderation_v2.requests
  WHERE id = v_req.id
  FOR UPDATE;

  IF v_req.status NOT IN ('pending_input', 'retry') THEN
    RETURN jsonb_build_object('success', false, 'error', 'CONCURRENT_CLAIM');
  END IF;

  SELECT slot_id INTO v_slot_id
  FROM app_moderation_v2.input_admission_slots
  WHERE active_claim_id IS NULL
  ORDER BY slot_id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_slot_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_ADMISSION_SLOT');
  END IF;

  -- Deep freshness revalidation
  IF v_listing.revision <> v_req.listing_revision
     OR v_listing.title <> v_req.original_title
     OR v_listing.description IS DISTINCT FROM v_req.original_description
     OR v_listing.status <> 'pending_review' THEN
    UPDATE app_moderation_v2.requests
    SET status = 'superseded', updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_req.id;
    RETURN jsonb_build_object('success', false, 'error', 'STALE_REQUEST');
  END IF;

  v_claim_token := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text || pg_catalog.clock_timestamp()::text || pg_catalog.gen_random_uuid()::text, 'UTF8')), 'hex');
  v_token_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_claim_token, 'UTF8')), 'hex');
  v_attempt_id := gen_random_uuid();
  v_lease_expires := v_now + (interval '1 second' * v_bounded_lease);
  v_max_renewal := v_now + interval '60 seconds'; -- 60s max renewal ceiling

  INSERT INTO app_moderation_v2.input_claims (
    request_id, attempt_id, attempt_number, claim_token_hash,
    slot_id, worker_id, lease_expires_at, attempt_started_at,
    max_renewal_until, status
  ) VALUES (
    v_req.id, v_attempt_id, v_req.attempt_count + 1, v_token_hash,
    v_slot_id, p_worker_id, v_lease_expires, v_now,
    v_max_renewal, 'active'
  ) RETURNING id INTO v_claim_id;

  UPDATE app_moderation_v2.input_admission_slots
  SET active_claim_id = v_claim_id,
      slot_acquired_at = v_now,
      slot_expires_at = v_lease_expires
  WHERE slot_id = v_slot_id;

  UPDATE app_moderation_v2.requests
  SET status = 'claimed',
      attempt_count = attempt_count + 1,
      updated_at = v_now
  WHERE id = v_req.id;

  RETURN jsonb_build_object(
    'success', true,
    'request_id', v_req.id,
    'attempt_id', v_attempt_id,
    'attempt_number', v_req.attempt_count + 1,
    'claim_token', v_claim_token,
    'slot_id', v_slot_id,
    'lease_expires_at', v_lease_expires,
    'max_renewal_until', v_max_renewal,
    'listing_id', v_req.listing_id,
    'listing_revision', v_req.listing_revision,
    'generation_id', v_req.generation_id,
    'policy_version', v_req.policy_version,
    'request_lane', v_req.request_lane,
    'original_title', v_req.original_title,
    'original_description', v_req.original_description
  );
END;
$$;
;

REVOKE ALL ON FUNCTION app_moderation_v2.claim_moderation_v2_input(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_moderation_v2.claim_moderation_v2_input(text, text, integer)
  TO service_role;

-- 7. Heartbeat Input Lease: heartbeat_moderation_v2_input
-- Follows strict universal hierarchy: listings -> requests -> slots -> claims
CREATE OR REPLACE FUNCTION app_moderation_v2.heartbeat_moderation_v2_input(
  p_worker_secret text,
  p_request_id uuid,
  p_attempt_id uuid,
  p_claim_token text,
  p_extension_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_req record;
  v_claim record;
  v_token_hash text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_bounded_ext integer;
  v_new_expires timestamptz;
  v_enabled text;
  v_mode text;
BEGIN
  IF NOT public.verify_moderation_worker_secret(p_worker_secret) THEN
    RAISE EXCEPTION 'Worker authentication failed' USING ERRCODE = '28000';
  END IF;

  v_token_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token, 'UTF8')), 'hex');
  v_bounded_ext := GREATEST(5, LEAST(coalesce(p_extension_seconds, 30), 60));

  SELECT listing_id INTO v_req FROM app_moderation_v2.requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND');
  END IF;

  SELECT id, slot_id, status, claim_token_hash, lease_expires_at, max_renewal_until
  INTO v_claim
  FROM app_moderation_v2.input_claims
  WHERE request_id = p_request_id AND attempt_id = p_attempt_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLAIM_NOT_FOUND');
  END IF;

  -- Universal lock hierarchy: listings -> requests -> slots -> claims
  PERFORM 1 FROM public.listings WHERE id = v_req.listing_id FOR SHARE;
  SELECT id, listing_id, status, phase, attempt_count INTO v_req
  FROM app_moderation_v2.requests WHERE id = p_request_id FOR UPDATE;

  -- Terminal state & phase guard: delayed heartbeat must never reopen or alter terminal requests
  IF v_req.status IN ('completed', 'failed', 'superseded') OR v_req.phase IS DISTINCT FROM 'input_validation' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_TERMINATED');
  END IF;

  PERFORM 1 FROM app_moderation_v2.input_admission_slots WHERE slot_id = v_claim.slot_id FOR UPDATE;
  SELECT * INTO v_claim FROM app_moderation_v2.input_claims WHERE id = v_claim.id FOR UPDATE;

  -- Token verification
  IF v_claim.claim_token_hash <> v_token_hash THEN
    RETURN jsonb_build_object('success', false, 'error', 'LEASE_TOKEN_MISMATCH');
  END IF;

  -- Active claim status and slot ownership verification
  IF v_claim.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLAIM_NOT_ACTIVE');
  END IF;

  PERFORM 1 FROM app_moderation_v2.input_admission_slots
  WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'SLOT_OWNERSHIP_LOST');
  END IF;

  -- System gate & mode check under lock (fail closed)
  SELECT setting_value INTO v_enabled FROM public.app_system_settings WHERE setting_key = 'moderation_v2_enabled';
  SELECT setting_value INTO v_mode FROM public.app_system_settings WHERE setting_key = 'moderation_v2_mode';
  IF v_enabled IS DISTINCT FROM 'true' OR (v_mode IS DISTINCT FROM 'shadow' AND v_mode IS DISTINCT FROM 'enforce') THEN
    UPDATE app_moderation_v2.input_claims
    SET status = 'abandoned', updated_at = v_now
    WHERE id = v_claim.id;

    UPDATE app_moderation_v2.input_admission_slots
    SET active_claim_id = NULL, slot_acquired_at = NULL, slot_expires_at = NULL
    WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;

    IF v_req.attempt_count >= 3 THEN
      UPDATE app_moderation_v2.requests
      SET status = 'failed', updated_at = v_now
      WHERE id = p_request_id;
    ELSE
      UPDATE app_moderation_v2.requests
      SET status = 'retry', updated_at = v_now
      WHERE id = p_request_id;
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'V2_DISABLED');
  END IF;

  IF v_claim.lease_expires_at <= v_now THEN
    UPDATE app_moderation_v2.input_claims
    SET status = 'expired', updated_at = v_now
    WHERE id = v_claim.id;

    UPDATE app_moderation_v2.input_admission_slots
    SET active_claim_id = NULL, slot_acquired_at = NULL, slot_expires_at = NULL
    WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;

    IF v_req.attempt_count >= 3 THEN
      UPDATE app_moderation_v2.requests
      SET status = 'failed', updated_at = v_now
      WHERE id = p_request_id;
    ELSE
      UPDATE app_moderation_v2.requests
      SET status = 'retry', updated_at = v_now
      WHERE id = p_request_id;
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'LEASE_EXPIRED');
  END IF;

  IF v_now >= v_claim.max_renewal_until THEN
    RETURN jsonb_build_object('success', false, 'error', 'RENEWAL_CEILING_REACHED');
  END IF;

  v_new_expires := LEAST(v_now + (interval '1 second' * v_bounded_ext), v_claim.max_renewal_until);

  UPDATE app_moderation_v2.input_claims
  SET lease_expires_at = v_new_expires, updated_at = v_now
  WHERE id = v_claim.id;

  UPDATE app_moderation_v2.input_admission_slots
  SET slot_expires_at = v_new_expires
  WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;

  RETURN jsonb_build_object(
    'success', true,
    'lease_expires_at', v_new_expires,
    'max_renewal_until', v_claim.max_renewal_until
  );
END;
$$;
;

REVOKE ALL ON FUNCTION app_moderation_v2.heartbeat_moderation_v2_input(text, uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_moderation_v2.heartbeat_moderation_v2_input(text, uuid, uuid, text, integer)
  TO service_role;

-- 8. Finalize Input Validation: finalize_moderation_v2_input
CREATE OR REPLACE FUNCTION app_moderation_v2.finalize_moderation_v2_input(
  p_worker_secret text,
  p_request_id uuid,
  p_attempt_id uuid,
  p_claim_token text,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_req record;
  v_listing record;
  v_claim record;
  v_existing_res record;
  v_token_hash text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_payload_digest text;
  v_db_eval jsonb;
  v_outcome text;
  v_phase text;
  v_contract_version text;
  v_policy_version text;
  v_evaluator_version text;
  v_request_id uuid;
  v_attempt_id uuid;
  v_evaluated_at text;
  v_listing_id uuid;
  v_listing_revision integer;
  v_generation_id uuid;
  v_title_sha256 text;
  v_desc_sha256 text;
  v_validation_errors jsonb;
  v_decision text;
  v_final_response jsonb;
  v_enabled text;
  v_mode text;
  v_policy_approved boolean;
  v_evaluator_build text;
  v_incoming_keys text[];
  v_k text;
  v_err_count integer;
  v_db_err_count integer;
  v_e record;
BEGIN
  IF NOT public.verify_moderation_worker_secret(p_worker_secret) THEN
    RAISE EXCEPTION 'Worker authentication failed' USING ERRCODE = '28000';
  END IF;

  v_token_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token, 'UTF8')), 'hex');

  -- Extract envelope fields
  v_contract_version := p_result->>'contract_version';
  v_policy_version := p_result->>'policy_version';
  v_evaluator_version := p_result->>'evaluator_version';
  v_request_id := (p_result->>'request_id')::uuid;
  v_attempt_id := (p_result->>'attempt_id')::uuid;
  v_evaluated_at := p_result->>'evaluated_at';
  v_phase := p_result->>'phase';
  v_outcome := p_result->>'outcome';
  v_listing_id := (p_result->>'listing_id')::uuid;
  v_listing_revision := (p_result->>'listing_revision')::integer;
  v_generation_id := (p_result->>'generation_id')::uuid;
  v_title_sha256 := p_result->>'title_sha256';
  v_desc_sha256 := p_result->>'description_sha256';
  v_validation_errors := p_result->'validation_errors';

  -- Strict validation of incoming envelope against EarlyInvalidResultV2Schema:
  SELECT array_agg(k) INTO v_incoming_keys FROM jsonb_object_keys(p_result) AS k;
  FOREACH v_k IN ARRAY v_incoming_keys LOOP
    IF v_k NOT IN ('contract_version', 'policy_version', 'evaluator_version', 'request_id', 'attempt_id', 'evaluated_at', 'phase', 'outcome', 'listing_id', 'listing_revision', 'generation_id', 'title_sha256', 'description_sha256', 'validation_errors') THEN
      RAISE EXCEPTION 'EarlyInvalidResultV2Schema: forbidden field %', v_k USING ERRCODE = '22000';
    END IF;
  END LOOP;

  IF v_contract_version IS DISTINCT FROM '2.0.0'
     OR v_policy_version IS DISTINCT FROM 'fairswap_moderation_v2.0.0'
     OR v_evaluator_version IS NULL
     OR v_evaluator_version !~ '^v2\.[0-9]+\.[0-9]+$'
     OR v_request_id IS DISTINCT FROM p_request_id
     OR v_attempt_id IS DISTINCT FROM p_attempt_id
     OR v_evaluated_at IS NULL
     OR v_evaluated_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR v_phase IS DISTINCT FROM 'input_validation'
     OR v_outcome NOT IN ('valid', 'invalid_input')
     OR v_listing_id IS NULL
     OR v_listing_revision IS NULL OR v_listing_revision < 0
     OR v_generation_id IS NULL
     OR (v_title_sha256 IS NOT NULL AND v_title_sha256 !~ '^[0-9a-f]{64}$')
     OR (v_desc_sha256 IS NOT NULL AND v_desc_sha256 !~ '^[0-9a-f]{64}$')
     OR v_validation_errors IS NULL OR jsonb_typeof(v_validation_errors) <> 'array' THEN
    RAISE EXCEPTION 'Envelope does not conform to contract identity schema' USING ERRCODE = '22000';
  END IF;

  v_err_count := jsonb_array_length(v_validation_errors);

  -- Invariants for outcome
  IF v_outcome = 'valid' THEN
    IF v_err_count <> 0 THEN
      RAISE EXCEPTION 'Outcome valid cannot have validation errors' USING ERRCODE = '22000';
    END IF;
  ELSE -- outcome = 'invalid_input'
    IF v_err_count < 1 OR v_err_count > 2 THEN
      RAISE EXCEPTION 'Outcome invalid_input must have 1 or 2 validation errors' USING ERRCODE = '22000';
    END IF;
    -- Check error fields, error codes, and digest binding
    FOR v_e IN SELECT e->>'field' AS field, e->>'code' AS code FROM jsonb_array_elements(v_validation_errors) AS e LOOP
      IF v_e.field NOT IN ('title', 'description') OR v_e.code NOT IN ('TYPE', 'TOO_SHORT', 'TOO_LONG') THEN
        RAISE EXCEPTION 'Invalid validation error field or code' USING ERRCODE = '22000';
      END IF;
      IF v_e.field = 'title' THEN
        IF (v_e.code = 'TYPE') <> (v_title_sha256 IS NULL) THEN
          RAISE EXCEPTION 'VALIDATION_DIGEST_BINDING title violation' USING ERRCODE = '22000';
        END IF;
      ELSIF v_e.field = 'description' THEN
        IF (v_e.code = 'TYPE') <> (v_desc_sha256 IS NULL) THEN
          RAISE EXCEPTION 'VALIDATION_DIGEST_BINDING description violation' USING ERRCODE = '22000';
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Compute incoming canonical digest for idempotent replay check
  v_payload_digest := app_moderation_v2.canonical_early_result_digest(
    v_contract_version,
    v_policy_version,
    v_evaluator_version,
    v_request_id,
    v_attempt_id,
    v_evaluated_at,
    v_phase,
    v_outcome,
    v_listing_id,
    v_listing_revision,
    v_generation_id,
    v_title_sha256,
    v_desc_sha256,
    v_validation_errors
  );

  -- Pre-lock authenticated replay check
  SELECT * INTO v_existing_res
  FROM app_moderation_v2.input_results
  WHERE request_id = p_request_id AND attempt_id = p_attempt_id;

  IF FOUND THEN
    SELECT claim_token_hash INTO v_claim
    FROM app_moderation_v2.input_claims
    WHERE request_id = p_request_id AND attempt_id = p_attempt_id;

    IF v_claim.claim_token_hash <> v_token_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'LEASE_TOKEN_MISMATCH');
    END IF;

    IF v_existing_res.payload_digest IS DISTINCT FROM v_payload_digest THEN
      RAISE EXCEPTION 'Idempotency conflict: payload does not match recorded attempt'
        USING ERRCODE = '23505'; -- unique_violation / conflict
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'decision', v_existing_res.decision,
      'payload_digest', v_existing_res.payload_digest,
      'recorded_response', v_existing_res.recorded_response
    );
  END IF;

  -- Universal lock hierarchy:
  -- listings (FOR UPDATE) -> requests (FOR UPDATE) -> admission_slots (FOR UPDATE) -> input_claims (FOR UPDATE)
  SELECT listing_id INTO v_req FROM app_moderation_v2.requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND');
  END IF;

  SELECT id, revision, title, description, status INTO v_listing
  FROM public.listings WHERE id = v_req.listing_id FOR UPDATE;

  SELECT id, listing_id, listing_revision, generation_id, policy_version, request_lane,
         original_title, original_description, attempt_count, status, phase
  INTO v_req
  FROM app_moderation_v2.requests WHERE id = p_request_id FOR UPDATE;

  SELECT id, slot_id, status, claim_token_hash, lease_expires_at, attempt_number
  INTO v_claim
  FROM app_moderation_v2.input_claims
  WHERE request_id = p_request_id AND attempt_id = p_attempt_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLAIM_NOT_FOUND');
  END IF;

  PERFORM 1 FROM app_moderation_v2.input_admission_slots WHERE slot_id = v_claim.slot_id FOR UPDATE;
  SELECT * INTO v_claim FROM app_moderation_v2.input_claims WHERE id = v_claim.id FOR UPDATE;

  -- Verify token first
  IF v_claim.claim_token_hash <> v_token_hash THEN
    RETURN jsonb_build_object('success', false, 'error', 'LEASE_TOKEN_MISMATCH');
  END IF;

  -- Enforce system gates and mode under lock (fail closed on missing/NULL)
  SELECT setting_value INTO v_enabled FROM public.app_system_settings WHERE setting_key = 'moderation_v2_enabled';
  SELECT setting_value INTO v_mode FROM public.app_system_settings WHERE setting_key = 'moderation_v2_mode';
  IF v_enabled IS DISTINCT FROM 'true' OR (v_mode IS DISTINCT FROM 'shadow' AND v_mode IS DISTINCT FROM 'enforce') THEN
    RETURN jsonb_build_object('success', false, 'error', 'V2_DISABLED');
  END IF;

  -- Complete claim fencing under locks
  IF v_req.phase IS DISTINCT FROM 'input_validation' OR v_req.status IS DISTINCT FROM 'claimed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_REQUEST_STATE');
  END IF;

  IF v_req.request_lane IS DISTINCT FROM v_mode THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_REQUEST_LANE');
  END IF;

  -- Verify active admission slot ownership
  PERFORM 1 FROM app_moderation_v2.input_admission_slots
  WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'SLOT_OWNERSHIP_LOST');
  END IF;

  -- Re-check ledger under locks
  SELECT * INTO v_existing_res
  FROM app_moderation_v2.input_results
  WHERE request_id = p_request_id AND attempt_id = p_attempt_id;

  IF FOUND THEN
    IF v_existing_res.payload_digest IS DISTINCT FROM v_payload_digest THEN
      RAISE EXCEPTION 'Idempotency conflict: payload does not match recorded attempt'
        USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'decision', v_existing_res.decision,
      'payload_digest', v_existing_res.payload_digest,
      'recorded_response', v_existing_res.recorded_response
    );
  END IF;

  IF v_claim.status <> 'active' OR v_claim.lease_expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'LEASE_EXPIRED');
  END IF;

  SELECT is_approved, approved_evaluator_build INTO v_policy_approved, v_evaluator_build
  FROM app_moderation_v2.policy_registry
  WHERE policy_version = v_req.policy_version;
  IF v_policy_approved IS NOT TRUE OR v_evaluator_build IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'POLICY_DISAPPROVED');
  END IF;

  -- Deep Stale-Request Protection
  IF v_listing.revision <> v_req.listing_revision
     OR v_listing.title <> v_req.original_title
     OR v_listing.description IS DISTINCT FROM v_req.original_description
     OR v_listing.status <> 'pending_review'
     OR v_listing_id <> v_req.listing_id
     OR v_listing_revision <> v_req.listing_revision
     OR v_generation_id <> v_req.generation_id THEN
    UPDATE app_moderation_v2.requests
    SET status = 'superseded', updated_at = v_now
    WHERE id = v_req.id;

    UPDATE app_moderation_v2.input_claims
    SET status = 'superseded', updated_at = v_now
    WHERE id = v_claim.id;

    UPDATE app_moderation_v2.input_admission_slots
    SET active_claim_id = NULL, slot_acquired_at = NULL, slot_expires_at = NULL
    WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;

    v_final_response := jsonb_build_object(
      'success', true,
      'decision', 'superseded',
      'reason', 'STALE_REQUEST'
    );

    INSERT INTO app_moderation_v2.input_results (
      request_id, attempt_id, attempt_number, payload_digest,
      decision, validation_errors, recorded_response
    ) VALUES (
      v_req.id, p_attempt_id, v_claim.attempt_number,
      v_payload_digest,
      'superseded', '[]'::jsonb, v_final_response
    );

    RETURN v_final_response;
  END IF;

  -- Independent DB validation recomputation
  v_db_eval := app_moderation_v2.validate_v2_stored_text(v_req.original_title, v_req.original_description);
  v_db_err_count := jsonb_array_length(v_db_eval->'validation_errors');

  -- Compare worker's incoming outcome, validation_errors, and digests with DB validation
  -- Symmetric verification: independently verify title and description hashes for BOTH valid and invalid text
  IF v_title_sha256 IS DISTINCT FROM (v_db_eval->>'title_sha256')
     OR v_desc_sha256 IS DISTINCT FROM (v_db_eval->>'description_sha256') THEN
    RAISE EXCEPTION 'VALIDATION_MISMATCH: worker text digests do not match database recomputation' USING ERRCODE = '22000';
  END IF;

  IF v_db_err_count = 0 THEN
    IF v_outcome <> 'valid' OR v_err_count <> 0 THEN
      RAISE EXCEPTION 'VALIDATION_MISMATCH: worker reported invalid for valid text' USING ERRCODE = '22000';
    END IF;
  ELSE
    IF v_outcome <> 'invalid_input' THEN
      RAISE EXCEPTION 'VALIDATION_MISMATCH: worker reported valid for invalid text' USING ERRCODE = '22000';
    END IF;
    IF (v_db_eval->'validation_errors')::text IS DISTINCT FROM v_validation_errors::text THEN
      RAISE EXCEPTION 'VALIDATION_MISMATCH: worker validation_errors do not match database recomputation' USING ERRCODE = '22000';
    END IF;
  END IF;

  -- State Transitions
  IF v_db_err_count = 0 THEN
    v_decision := 'valid';
    UPDATE app_moderation_v2.requests
    SET phase = 'preparation',
        status = 'awaiting_media',
        updated_at = v_now
    WHERE id = v_req.id;

    UPDATE app_moderation_v2.input_claims
    SET status = 'completed', updated_at = v_now
    WHERE id = v_claim.id;

    UPDATE app_moderation_v2.input_admission_slots
    SET active_claim_id = NULL, slot_acquired_at = NULL, slot_expires_at = NULL
    WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;

    v_final_response := jsonb_build_object(
      'success', true,
      'decision', 'valid',
      'next_phase', 'preparation',
      'payload_digest', v_payload_digest
    );
  ELSE
    v_decision := 'rejected_invalid';
    UPDATE app_moderation_v2.requests
    SET status = 'failed',
        updated_at = v_now
    WHERE id = v_req.id;

    UPDATE app_moderation_v2.input_claims
    SET status = 'completed', updated_at = v_now
    WHERE id = v_claim.id;

    UPDATE app_moderation_v2.input_admission_slots
    SET active_claim_id = NULL, slot_acquired_at = NULL, slot_expires_at = NULL
    WHERE slot_id = v_claim.slot_id AND active_claim_id = v_claim.id;

    v_final_response := jsonb_build_object(
      'success', true,
      'decision', 'rejected_invalid',
      'outcome', 'invalid_input',
      'validation_errors', v_db_eval->'validation_errors',
      'payload_digest', v_payload_digest
    );
  END IF;

  INSERT INTO app_moderation_v2.input_results (
    request_id, attempt_id, attempt_number, payload_digest,
    decision, validation_errors, recorded_response
  ) VALUES (
    v_req.id, p_attempt_id, v_claim.attempt_number,
    v_payload_digest, v_decision, v_db_eval->'validation_errors', v_final_response
  );

  RETURN v_final_response;
END;
$$;
;

REVOKE ALL ON FUNCTION app_moderation_v2.finalize_moderation_v2_input(text, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_moderation_v2.finalize_moderation_v2_input(text, uuid, uuid, text, jsonb)
  TO service_role;

-- 9. Service-Role-Only Public RPC Wrappers for PostgREST Integration
CREATE OR REPLACE FUNCTION public.claim_moderation_v2_input(
  p_worker_secret text,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_moderation_v2.claim_moderation_v2_input(p_worker_secret, p_worker_id, p_lease_seconds);
END;
$$;
;

REVOKE ALL ON FUNCTION public.claim_moderation_v2_input(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_moderation_v2_input(text, text, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.heartbeat_moderation_v2_input(
  p_worker_secret text,
  p_request_id uuid,
  p_attempt_id uuid,
  p_claim_token text,
  p_extension_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_moderation_v2.heartbeat_moderation_v2_input(p_worker_secret, p_request_id, p_attempt_id, p_claim_token, p_extension_seconds);
END;
$$;
;

REVOKE ALL ON FUNCTION public.heartbeat_moderation_v2_input(text, uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_moderation_v2_input(text, uuid, uuid, text, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_moderation_v2_input(
  p_worker_secret text,
  p_request_id uuid,
  p_attempt_id uuid,
  p_claim_token text,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_moderation_v2.finalize_moderation_v2_input(p_worker_secret, p_request_id, p_attempt_id, p_claim_token, p_result);
END;
$$;
;

REVOKE ALL ON FUNCTION public.finalize_moderation_v2_input(text, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_moderation_v2_input(text, uuid, uuid, text, jsonb)
  TO service_role;
