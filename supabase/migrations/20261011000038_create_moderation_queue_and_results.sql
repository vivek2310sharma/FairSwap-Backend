-- =============================================================================
-- Migration 38: Create Moderation Queue, Evidence Tables, and Service Gate
-- =============================================================================
-- Implements Task MOD-03A: Submission-Triggered Automatic Moderation.
-- Creates durable queue, attempt records, trigger enqueuing on pending_review,
-- lease-based claim RPC, atomic publication gate, and staff/seller read RPCs.
-- =============================================================================

-- 1. Create Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_request_status') THEN
    CREATE TYPE public.moderation_request_status AS ENUM (
      'pending',
      'claimed',
      'completed',
      'retry',
      'failed',
      'superseded'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_outcome_enum') THEN
    CREATE TYPE public.moderation_outcome_enum AS ENUM (
      'no_review_flags',
      'needs_review',
      'checks_incomplete',
      'invalid_input'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_decision_state') THEN
    CREATE TYPE public.moderation_decision_state AS ENUM (
      'auto_approved',
      'routed_to_admin',
      'awaiting_retry',
      'escalated_to_admin',
      'rejected_invalid'
    );
  END IF;
END $$;

-- 2. Create public.listing_moderation_requests
CREATE TABLE IF NOT EXISTS public.listing_moderation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_revision integer NOT NULL,
  generation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status public.moderation_request_status NOT NULL DEFAULT 'pending',
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evaluated_title text,
  evaluated_description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Partial index for fast worker claim of active pending/retry requests
CREATE INDEX IF NOT EXISTS idx_moderation_requests_claim
  ON public.listing_moderation_requests (status, next_attempt_at)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_moderation_requests_listing
  ON public.listing_moderation_requests (listing_id, created_at DESC);

-- Unique index ensuring at most one active (pending, claimed, retry) request per listing
CREATE UNIQUE INDEX IF NOT EXISTS uq_moderation_requests_active_listing
  ON public.listing_moderation_requests (listing_id)
  WHERE status IN ('pending', 'claimed', 'retry');

-- 3. Create public.listing_moderation_results
-- Append-only evidence log of moderation attempts and decisions
CREATE TABLE IF NOT EXISTS public.listing_moderation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.listing_moderation_requests(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_revision integer NOT NULL,
  generation_id uuid NOT NULL,
  outcome public.moderation_outcome_enum NOT NULL,
  ruleset_version text NOT NULL,
  scope text NOT NULL,
  completed_rules text[] NOT NULL DEFAULT ARRAY[]::text[],
  failed_rules text[] NOT NULL DEFAULT ARRAY[]::text[],
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision public.moderation_decision_state NOT NULL,
  actor_role text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_moderation_results_listing
  ON public.listing_moderation_results (listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_moderation_results_request
  ON public.listing_moderation_results (request_id);

-- 4. Enable RLS on both tables
ALTER TABLE public.listing_moderation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_moderation_results ENABLE ROW LEVEL SECURITY;

-- Deny all direct access to public, anon, and authenticated by default
-- Staff reads are mediated strictly by authorized SECURITY DEFINER functions.
REVOKE ALL ON public.listing_moderation_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.listing_moderation_results FROM PUBLIC, anon, authenticated;

-- Service role manages requests queue; results are strictly append-only (SELECT, INSERT)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.listing_moderation_requests TO service_role;
GRANT SELECT, INSERT ON public.listing_moderation_results TO service_role;
REVOKE UPDATE, DELETE ON public.listing_moderation_results FROM service_role;

-- =============================================================================
-- 5. Trigger Function: Enqueue Moderation Request on pending_review Transitions
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_listing_moderation_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_should_enqueue boolean := false;
  v_gen_id uuid := gen_random_uuid();
BEGIN
  -- We enqueue a new moderation request if:
  -- A. Listing transitions into 'pending_review' from another status
  -- B. Listing is already in 'pending_review' and revision increases (material change)
  IF (TG_OP = 'INSERT' AND NEW.status = 'pending_review'::public.listing_status_enum) THEN
    v_should_enqueue := true;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'pending_review'::public.listing_status_enum) THEN
      v_should_enqueue := true;
    ELSIF (NEW.status = 'pending_review'::public.listing_status_enum AND NEW.revision > OLD.revision) THEN
      v_should_enqueue := true;
    END IF;
  END IF;

  IF v_should_enqueue THEN
    -- 1. Mark any currently active request for this listing as superseded
    UPDATE public.listing_moderation_requests
    SET status = 'superseded'::public.moderation_request_status,
        updated_at = pg_catalog.clock_timestamp()
    WHERE listing_id = NEW.id
      AND status IN ('pending', 'claimed', 'retry');

    -- 2. Insert new pending request with fresh generation_id
    INSERT INTO public.listing_moderation_requests (
      listing_id,
      listing_revision,
      generation_id,
      status,
      evaluated_title,
      evaluated_description,
      created_at,
      updated_at
    ) VALUES (
      NEW.id,
      NEW.revision,
      v_gen_id,
      'pending'::public.moderation_request_status,
      NEW.title,
      NEW.description,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_listing_moderation_enqueue ON public.listings;
CREATE TRIGGER trg_listing_moderation_enqueue
AFTER INSERT OR UPDATE ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_moderation_enqueue();

DROP FUNCTION IF EXISTS public.claim_moderation_batch(integer, integer, uuid);
DROP FUNCTION IF EXISTS app_security.claim_moderation_batch(integer, integer, uuid);

CREATE OR REPLACE FUNCTION app_security.claim_moderation_batch(
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60,
  p_request_id uuid DEFAULT NULL
)
RETURNS TABLE (
  request_id uuid,
  listing_id uuid,
  listing_revision integer,
  generation_id uuid,
  claim_token uuid,
  attempt_count integer,
  title text,
  description text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expires_at timestamptz := v_now + (p_lease_seconds || ' seconds')::interval;
BEGIN
  -- 1. Recover expired leases: bound recovery by max_attempts
  -- For requests meeting or exceeding max_attempts, record terminal abandonment evidence and mark failed
  WITH expired_terminal AS (
    UPDATE public.listing_moderation_requests lmr
    SET status = 'failed'::public.moderation_request_status,
        claim_token = NULL,
        updated_at = v_now
    WHERE lmr.status = 'claimed'
      AND lmr.claim_expires_at < v_now
      AND lmr.attempt_count >= lmr.max_attempts
    RETURNING lmr.id, lmr.listing_id, lmr.listing_revision, lmr.generation_id, lmr.attempt_count
  )
  INSERT INTO public.listing_moderation_results (
    request_id, listing_id, listing_revision, generation_id, outcome,
    ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
  )
  SELECT
    et.id, et.listing_id, et.listing_revision, et.generation_id,
    'checks_incomplete'::public.moderation_outcome_enum,
    'prototype_v0.1.1', 'title_description', ARRAY[]::text[], ARRAY[]::text[],
    '[]'::jsonb, jsonb_build_array(jsonb_build_object('error', 'LEASE_EXPIRED_ABANDONED', 'attempts', et.attempt_count)),
    'escalated_to_admin'::public.moderation_decision_state
  FROM expired_terminal et;

  UPDATE public.listing_moderation_requests lmr
  SET status = 'retry'::public.moderation_request_status,
      claim_token = NULL,
      next_attempt_at = v_now + (POWER(2, lmr.attempt_count) * INTERVAL '5 seconds'),
      updated_at = v_now
  WHERE lmr.status = 'claimed'
    AND lmr.claim_expires_at < v_now
    AND lmr.attempt_count < lmr.max_attempts;

  -- 2. Atomically claim candidate requests with attempt_count < max_attempts
  RETURN QUERY
  WITH candidates AS (
    SELECT r.id
    FROM public.listing_moderation_requests r
    JOIN public.listings l ON l.id = r.listing_id
    WHERE (p_request_id IS NULL OR r.id = p_request_id)
      AND r.status IN ('pending', 'retry')
      AND r.attempt_count < r.max_attempts
      AND r.next_attempt_at <= v_now
      AND l.status = 'pending_review'::public.listing_status_enum
      AND l.revision = r.listing_revision
    ORDER BY r.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE OF r SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.listing_moderation_requests r
    SET status = 'claimed'::public.moderation_request_status,
        claim_token = v_token,
        claimed_at = v_now,
        claim_expires_at = v_expires_at,
        attempt_count = r.attempt_count + 1,
        updated_at = v_now
    FROM candidates c
    WHERE r.id = c.id
    RETURNING r.id AS req_id, r.listing_id AS list_id, r.listing_revision AS list_rev,
              r.generation_id AS gen_id, v_token AS c_token, r.attempt_count AS att_count,
              r.evaluated_title AS l_title, r.evaluated_description AS l_desc
  )
  SELECT c.req_id, c.list_id, c.list_rev, c.gen_id, c.c_token, c.att_count, c.l_title, c.l_desc
  FROM claimed c;
END;
$$;

REVOKE ALL ON FUNCTION app_security.claim_moderation_batch(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.claim_moderation_batch(integer, integer, uuid) TO service_role;

-- Public wrapper for service role access via Supabase Client Data API
CREATE OR REPLACE FUNCTION public.claim_moderation_batch(
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60,
  p_request_id uuid DEFAULT NULL
)
RETURNS TABLE (
  request_id uuid,
  listing_id uuid,
  listing_revision integer,
  generation_id uuid,
  claim_token uuid,
  attempt_count integer,
  title text,
  description text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT * FROM app_security.claim_moderation_batch(p_batch_size, p_lease_seconds, p_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_moderation_batch(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_moderation_batch(integer, integer, uuid) TO service_role;

-- =============================================================================
-- 7. Atomic Publication Gate: app_security.impl_finalize_moderation_result
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.impl_finalize_moderation_result(
  p_request_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_ruleset_version text,
  p_scope text,
  p_completed_rules text[],
  p_failed_rules text[],
  p_flags jsonb,
  p_errors jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req public.listing_moderation_requests%ROWTYPE;
  v_listing public.listings%ROWTYPE;
  v_target_listing_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_decision public.moderation_decision_state;
  v_media_count integer;
  v_unready_media_count integer;
  v_failed_media_count integer;
  v_cover_id uuid;
  v_account_status text;
  v_has_policy boolean;
  v_automation_enabled boolean := false;
  v_db_enabled boolean := false;
  v_vault_secret text;
  v_next_attempt timestamptz;
  v_mandatory_rules text[] := ARRAY['rule_prohibited_item_wording', 'rule_shortened_link', 'rule_payment_before_viewing']::text[];
BEGIN
  -- 1. Check automation kill switch (Authoritative Database Setting + Optional Secondary Vault Veto)
  -- The database setting is primary and authoritative: if false or missing, automation is strictly disabled.
  SELECT COALESCE(
    (SELECT (setting_value = 'true') FROM public.app_system_settings WHERE setting_key = 'moderation_automation_enabled' LIMIT 1),
    false
  ) INTO v_db_enabled;

  -- Optional secondary vault veto: if vault secret is explicitly present, it may veto (must be 'true' to allow)
  SELECT decrypted_secret INTO v_vault_secret
  FROM vault.decrypted_secrets
  WHERE name = 'moderation_automation_enabled'
  LIMIT 1;

  v_automation_enabled := v_db_enabled AND (v_vault_secret IS NULL OR v_vault_secret = 'true');

  -- 2. Validate input parameters contract
  IF p_ruleset_version IS DISTINCT FROM 'prototype_v0.1.1' THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_RULESET_VERSION');
  END IF;

  IF p_scope IS DISTINCT FROM 'title_description' THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_EVALUATION_SCOPE');
  END IF;

  -- 3. Non-locking lookup to determine parent listing ID
  SELECT listing_id INTO v_target_listing_id
  FROM public.listing_moderation_requests
  WHERE id = p_request_id;

  IF v_target_listing_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND');
  END IF;

  -- 4. Consistent Lock Ordering: Lock PARENT LISTING ROW FIRST
  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = v_target_listing_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'LISTING_NOT_FOUND');
  END IF;

  -- 5. Lock MODERATION REQUEST ROW SECOND
  SELECT * INTO v_req
  FROM public.listing_moderation_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND');
  END IF;

  -- Revalidate association under lock
  IF v_req.listing_id != v_listing.id THEN
    RETURN jsonb_build_object('success', false, 'error', 'LISTING_REQUEST_MISMATCH');
  END IF;

  -- Check if request is already superseded
  IF v_req.status = 'superseded' THEN
    RETURN jsonb_build_object('success', true, 'decision', 'superseded', 'reason', 'REQUEST_ALREADY_SUPERSEDED');
  END IF;

  -- Validate claim token identity
  IF v_req.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'error', 'LEASE_TOKEN_MISMATCH');
  END IF;

  IF v_req.status != 'claimed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_CLAIMED');
  END IF;

  -- Enforce Lease Expiry against current clock (clock_timestamp()) after lock acquisition
  v_now := pg_catalog.clock_timestamp();
  IF v_req.claim_expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'LEASE_EXPIRED');
  END IF;

  -- 6. Check listing freshness and status under lock
  -- If listing is no longer pending_review, or revision changed, or evaluated text changed: supersede
  IF v_listing.status != 'pending_review'::public.listing_status_enum
     OR v_listing.revision != v_req.listing_revision
     OR v_listing.title IS DISTINCT FROM v_req.evaluated_title
     OR v_listing.description IS DISTINCT FROM v_req.evaluated_description THEN
    UPDATE public.listing_moderation_requests
    SET status = 'superseded', updated_at = v_now
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true, 'decision', 'superseded', 'reason', 'LISTING_CONTENT_OR_STATE_CHANGED');
  END IF;

  -- Re-read automation kill switch under post-lock state to ensure fresh decision
  SELECT COALESCE(
    (SELECT (setting_value = 'true') FROM public.app_system_settings WHERE setting_key = 'moderation_automation_enabled' LIMIT 1),
    false
  ) INTO v_db_enabled;

  SELECT decrypted_secret INTO v_vault_secret
  FROM vault.decrypted_secrets
  WHERE name = 'moderation_automation_enabled'
  LIMIT 1;

  v_automation_enabled := v_db_enabled AND (v_vault_secret IS NULL OR v_vault_secret = 'true');

  -- 7. Validate contract consistency
  IF p_outcome = 'no_review_flags' THEN
    -- Verify exact required rules completed with 0 errors and 0 flags
    IF cardinality(p_completed_rules) != 3
       OR NOT (p_completed_rules @> v_mandatory_rules)
       OR cardinality(p_failed_rules) > 0
       OR jsonb_array_length(p_flags) > 0
       OR jsonb_array_length(p_errors) > 0 THEN
      -- Inconsistent clean outcome: downgrade to checks_incomplete
      p_outcome := 'checks_incomplete';
    END IF;
  END IF;

  -- 8. Branch based on evaluator outcome
  IF p_outcome = 'no_review_flags' THEN
    -- If automation kill switch is disabled, route to admin review
    IF NOT v_automation_enabled THEN
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'completed', updated_at = v_now
      WHERE id = p_request_id;

      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'no_review_flags'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
      );

      RETURN jsonb_build_object('success', true, 'decision', v_decision, 'reason', 'AUTOMATION_DISABLED_ROUTED_TO_ADMIN');
    END IF;

    -- Verify fundamental publication completeness requirements (category, city, required fields)
    IF v_listing.category_id IS NULL OR v_listing.city_id IS NULL THEN
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'completed', updated_at = v_now
      WHERE id = p_request_id;

      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'no_review_flags'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
      );

      RETURN jsonb_build_object('success', true, 'decision', v_decision, 'reason', 'LISTING_FIELDS_INCOMPLETE_ROUTED_TO_ADMIN');
    END IF;

    -- Full publication eligibility check
    v_account_status := app_security.get_account_status(v_listing.seller_id);
    v_has_policy := app_security.has_current_policy_acceptance(v_listing.seller_id);

    IF v_account_status != 'active' OR NOT v_has_policy THEN
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'completed', updated_at = v_now
      WHERE id = p_request_id;

      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'no_review_flags'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
      );

      RETURN jsonb_build_object('success', true, 'decision', v_decision, 'reason', 'SELLER_ELIGIBILITY_FAILED');
    END IF;

    -- Photos readiness check: count total media, unready media, and permanently failed media
    SELECT
      count(*),
      count(*) FILTER (WHERE processing_status != 'ready'),
      count(*) FILTER (WHERE processing_status = 'failed')
    INTO v_media_count, v_unready_media_count, v_failed_media_count
    FROM public.listing_media
    WHERE listing_id = v_listing.id;

    IF v_media_count < 1 THEN
      -- Incomplete listing: route to admin
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'completed', updated_at = v_now
      WHERE id = p_request_id;

      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'no_review_flags'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
      );

      RETURN jsonb_build_object('success', true, 'decision', v_decision, 'reason', 'ZERO_PHOTOS_ROUTED_TO_ADMIN');
    END IF;

    -- If any photo has permanently failed processing, route to admin review
    IF v_failed_media_count > 0 THEN
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'completed', updated_at = v_now
      WHERE id = p_request_id;

      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'no_review_flags'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags,
        jsonb_build_array(jsonb_build_object('error', 'MEDIA_PROCESSING_FAILED', 'failed_count', v_failed_media_count)),
        v_decision
      );

      RETURN jsonb_build_object('success', true, 'decision', v_decision, 'reason', 'MEDIA_PROCESSING_PERMANENTLY_FAILED');
    END IF;

    IF v_unready_media_count > 0 THEN
      -- Photos are still processing: keep unpublished, leave in retry state for automatic resumption
      -- Note: normal media wait resets attempt_count so evaluator crash limits are not consumed by photo transcoding
      v_next_attempt := v_now + INTERVAL '30 seconds';
      UPDATE public.listing_moderation_requests
      SET status = 'retry'::public.moderation_request_status,
          claim_token = NULL,
          attempt_count = GREATEST(0, attempt_count - 1),
          next_attempt_at = v_next_attempt,
          updated_at = v_now
      WHERE id = p_request_id;

      -- Persist attempt record documenting media processing wait
      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'no_review_flags'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags,
        jsonb_build_array(jsonb_build_object('info', 'unready_media_count: ' || v_unready_media_count)),
        'awaiting_retry'::public.moderation_decision_state
      );

      RETURN jsonb_build_object('success', true, 'decision', 'awaiting_media_processing', 'next_attempt_at', v_next_attempt);
    END IF;

    -- Determine cover photo
    v_cover_id := v_listing.cover_photo_id;
    IF v_cover_id IS NULL THEN
      SELECT id INTO v_cover_id
      FROM public.listing_media
      WHERE listing_id = v_listing.id AND processing_status = 'ready'
      ORDER BY display_order ASC, created_at ASC
      LIMIT 1;
    END IF;

    -- ATOMIC AUTO-APPROVAL & PUBLICATION (NO ADMIN VISIT)
    v_decision := 'auto_approved'::public.moderation_decision_state;

    UPDATE public.listings
    SET status = 'active'::public.listing_status_enum,
        published_at = v_now,
        expires_at = v_now + INTERVAL '30 days',
        rejection_reason = NULL,
        cover_photo_id = v_cover_id,
        updated_at = v_now
    WHERE id = v_listing.id;

    UPDATE public.listing_moderation_requests
    SET status = 'completed'::public.moderation_request_status,
        updated_at = v_now
    WHERE id = p_request_id;

    INSERT INTO public.listing_moderation_results (
      request_id, listing_id, listing_revision, generation_id, outcome,
      ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
    ) VALUES (
      p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
      'no_review_flags'::public.moderation_outcome_enum,
      p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
    );

    PERFORM app_security.log_audit_event(
      'listing.auto_approved',
      'listings',
      v_listing.id,
      jsonb_build_object(
        'revision', v_listing.revision,
        'request_id', p_request_id,
        'generation_id', v_req.generation_id,
        'ruleset_version', p_ruleset_version
      )
    );

    RETURN jsonb_build_object('success', true, 'decision', v_decision, 'status', 'active');

  ELSIF p_outcome = 'needs_review' THEN
    -- Flags found: terminal for this automatic request; route to admin queue with persisted findings
    v_decision := 'routed_to_admin'::public.moderation_decision_state;

    UPDATE public.listing_moderation_requests
    SET status = 'completed'::public.moderation_request_status,
        updated_at = v_now
    WHERE id = p_request_id;

    INSERT INTO public.listing_moderation_results (
      request_id, listing_id, listing_revision, generation_id, outcome,
      ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
    ) VALUES (
      p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
      'needs_review'::public.moderation_outcome_enum,
      p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
    );

    PERFORM app_security.log_audit_event(
      'moderation.routed_to_admin',
      'listings',
      v_listing.id,
      jsonb_build_object('request_id', p_request_id, 'flags_count', jsonb_array_length(p_flags))
    );

    RETURN jsonb_build_object('success', true, 'decision', v_decision, 'status', 'pending_review');

  ELSIF p_outcome = 'checks_incomplete' THEN
    -- Incomplete checks: retry up to max_attempts
    IF v_req.attempt_count >= v_req.max_attempts THEN
      v_decision := 'escalated_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'failed'::public.moderation_request_status,
          updated_at = v_now
      WHERE id = p_request_id;

      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'checks_incomplete'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
      );

      RETURN jsonb_build_object('success', true, 'decision', v_decision, 'status', 'pending_review');
    ELSE
      v_decision := 'awaiting_retry'::public.moderation_decision_state;
      v_next_attempt := v_now + (POWER(2, v_req.attempt_count) * INTERVAL '5 seconds');

      UPDATE public.listing_moderation_requests
      SET status = 'retry'::public.moderation_request_status,
          claim_token = NULL,
          next_attempt_at = v_next_attempt,
          updated_at = v_now
      WHERE id = p_request_id;

      -- Persist nonterminal attempt evidence
      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'checks_incomplete'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
      );

      RETURN jsonb_build_object('success', true, 'decision', v_decision, 'next_attempt_at', v_next_attempt);
    END IF;

  ELSIF p_outcome = 'invalid_input' THEN
    v_decision := 'rejected_invalid'::public.moderation_decision_state;

    -- Mark moderation request failed
    UPDATE public.listing_moderation_requests
    SET status = 'failed'::public.moderation_request_status,
        updated_at = v_now
    WHERE id = p_request_id;

    -- Set listing to rejected with actionable correction reason so seller can edit and resubmit
    UPDATE public.listings
    SET status = 'rejected'::public.listing_status_enum,
        rejection_reason = 'Invalid listing text: please review title and description length requirements.',
        updated_at = v_now
    WHERE id = v_listing.id;

    INSERT INTO public.listing_moderation_results (
      request_id, listing_id, listing_revision, generation_id, outcome,
      ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
    ) VALUES (
      p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
      'invalid_input'::public.moderation_outcome_enum,
      p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
    );

    PERFORM app_security.log_audit_event(
      'listing.rejected_invalid_input',
      'listings',
      v_listing.id,
      jsonb_build_object('request_id', p_request_id, 'errors', p_errors)
    );

    RETURN jsonb_build_object('success', true, 'decision', v_decision, 'status', 'rejected', 'errors', p_errors);
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'UNKNOWN_OUTCOME: ' || p_outcome);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_finalize_moderation_result FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_finalize_moderation_result TO service_role;

-- Public wrapper for service role access via Supabase Client Data API
CREATE OR REPLACE FUNCTION public.impl_finalize_moderation_result(
  p_request_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_ruleset_version text,
  p_scope text,
  p_completed_rules text[],
  p_failed_rules text[],
  p_flags jsonb,
  p_errors jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_finalize_moderation_result(
    p_request_id,
    p_claim_token,
    p_outcome,
    p_ruleset_version,
    p_scope,
    p_completed_rules,
    p_failed_rules,
    p_flags,
    p_errors
  );
END;
$$;

REVOKE ALL ON FUNCTION public.impl_finalize_moderation_result FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.impl_finalize_moderation_result TO service_role;

-- =============================================================================
-- 8. Staff Read Contract: app_security.get_listing_moderation_findings
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.get_listing_moderation_findings(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_gen_id uuid;
  v_res record;
  v_history jsonb;
BEGIN
  -- Requires active staff with moderator or administrator role and AAL2
  IF auth.uid() IS NULL
     OR NOT (app_security.is_active_staff_aal2('moderator'::public.staff_role_enum)
             OR app_security.is_active_staff_aal2('administrator'::public.staff_role_enum))
     OR NOT app_security.has_current_policy_acceptance(auth.uid()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Staff authorization required';
  END IF;

  -- 1. Identify generation_id of the current request
  SELECT generation_id INTO v_current_gen_id
  FROM public.listing_moderation_requests
  WHERE listing_id = p_listing_id
  ORDER BY created_at DESC
  LIMIT 1;

  -- 2. Fetch latest result for the current generation
  SELECT * INTO v_res
  FROM public.listing_moderation_results
  WHERE listing_id = p_listing_id
    AND (v_current_gen_id IS NULL OR generation_id = v_current_gen_id)
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_res.id IS NULL THEN
    RETURN jsonb_build_object(
      'has_findings', false,
      'listing_id', p_listing_id,
      'message', 'No automatic moderation findings recorded for current request generation'
    );
  END IF;

  -- 3. Fetch attempt history strictly bound to the current generation
  SELECT jsonb_agg(jsonb_build_object(
    'result_id', r.id,
    'outcome', r.outcome,
    'decision', r.decision,
    'ruleset_version', r.ruleset_version,
    'completed_rules', r.completed_rules,
    'failed_rules', r.failed_rules,
    'flags', r.flags,
    'errors', r.errors,
    'created_at', r.created_at
  ) ORDER BY r.created_at DESC)
  INTO v_history
  FROM public.listing_moderation_results r
  WHERE r.listing_id = p_listing_id
    AND r.generation_id = v_current_gen_id;

  RETURN jsonb_build_object(
    'has_findings', true,
    'listing_id', p_listing_id,
    'generation_id', v_current_gen_id,
    'latest', jsonb_build_object(
      'result_id', v_res.id,
      'request_id', v_res.request_id,
      'listing_revision', v_res.listing_revision,
      'generation_id', v_res.generation_id,
      'outcome', v_res.outcome,
      'decision', v_res.decision,
      'ruleset_version', v_res.ruleset_version,
      'scope', v_res.scope,
      'completed_rules', v_res.completed_rules,
      'failed_rules', v_res.failed_rules,
      'flags', v_res.flags,
      'errors', v_res.errors,
      'created_at', v_res.created_at
    ),
    'history', COALESCE(v_history, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.get_listing_moderation_findings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.get_listing_moderation_findings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_listing_moderation_findings(listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.get_listing_moderation_findings(listing_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_listing_moderation_findings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_listing_moderation_findings(uuid) TO authenticated;

-- =============================================================================
-- 9. Seller Safe Workflow Status RPC: app_security.get_seller_moderation_workflow_status
-- =============================================================================
CREATE OR REPLACE FUNCTION app_security.get_seller_moderation_workflow_status(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_listing record;
  v_req record;
  v_res record;
  v_workflow_status text;
  v_message text;
  v_provenance text := 'unknown';
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Authentication required';
  END IF;

  SELECT id, seller_id, status, revision, rejection_reason INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id;

  IF NOT FOUND OR v_listing.seller_id != v_caller THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Listing not found';
  END IF;

  IF v_listing.status = 'active' THEN
    -- Check if active was from auto-approval for current revision/generation
    SELECT decision, listing_revision INTO v_res
    FROM public.listing_moderation_results
    WHERE listing_id = p_listing_id
      AND listing_revision = v_listing.revision
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_res IS NOT NULL AND v_res.decision = 'auto_approved' THEN
      v_provenance := 'automatic';
    ELSE
      v_provenance := 'manual';
    END IF;

    RETURN jsonb_build_object(
      'listing_id', p_listing_id,
      'listing_status', 'active',
      'workflow_state', 'published',
      'provenance', v_provenance,
      'message', 'Your ad is live.'
    );
  END IF;

  IF v_listing.status = 'rejected' THEN
    RETURN jsonb_build_object(
      'listing_id', p_listing_id,
      'listing_status', 'rejected',
      'workflow_state', 'rejected',
      'message', COALESCE(v_listing.rejection_reason, 'Your listing requires changes before submission.')
    );
  END IF;

  IF v_listing.status != 'pending_review' THEN
    RETURN jsonb_build_object(
      'listing_id', p_listing_id,
      'listing_status', v_listing.status,
      'workflow_state', 'idle',
      'message', NULL
    );
  END IF;

  -- Listing is in pending_review. Check latest request & result bound to current generation
  SELECT id, status, attempt_count, max_attempts, generation_id INTO v_req
  FROM public.listing_moderation_requests
  WHERE listing_id = p_listing_id
  ORDER BY created_at DESC
  LIMIT 1;

  SELECT outcome, decision, errors INTO v_res
  FROM public.listing_moderation_results
  WHERE listing_id = p_listing_id
    AND (v_req.generation_id IS NULL OR generation_id = v_req.generation_id)
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_req.status IN ('pending', 'claimed') THEN
    v_workflow_status := 'running';
    v_message := 'Your ad is being checked automatically.';
  ELSIF v_req.status = 'retry' THEN
    v_workflow_status := 'retrying';
    v_message := 'Checks could not finish yet. Your ad is not live; we will retry.';
  ELSIF v_res.decision = 'routed_to_admin' THEN
    v_workflow_status := 'flagged';
    v_message := 'Your ad needs review. Our moderation team will check it.';
  ELSIF v_res.decision = 'escalated_to_admin' THEN
    v_workflow_status := 'escalated';
    v_message := 'Checks could not finish after multiple attempts. Our team will review your ad.';
  ELSIF v_res.decision = 'rejected_invalid' THEN
    v_workflow_status := 'invalid_input';
    v_message := 'Your listing text requires correction before it can be published.';
  ELSE
    v_workflow_status := 'pending_review';
    v_message := 'Your ad is being processed by our system.';
  END IF;

  RETURN jsonb_build_object(
    'listing_id', p_listing_id,
    'listing_status', 'pending_review',
    'workflow_state', v_workflow_status,
    'message', v_message
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.get_seller_moderation_workflow_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.get_seller_moderation_workflow_status(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_seller_moderation_workflow_status(listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.get_seller_moderation_workflow_status(listing_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_seller_moderation_workflow_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_seller_moderation_workflow_status(uuid) TO authenticated;
