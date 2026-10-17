-- STEP 1Q PROPOSAL ONLY. Not admitted to canonical migrations or manifest.
-- Future forward-only replacement AFTER the unchanged 58-migration baseline.
-- No execution, publication, deployment or hosted authorization is implied.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $proposal_preconditions$
DECLARE
  target oid := to_regprocedure('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)');
BEGIN
  IF target IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = target AND prosecdef)
     OR has_function_privilege('anon', target, 'EXECUTE')
     OR has_function_privilege('authenticated', target, 'EXECUTE')
     OR NOT has_function_privilege('service_role', target, 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_proc AS p,
       LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
       WHERE p.oid = target AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
     )
     OR (SELECT count(*) FROM pg_trigger
         WHERE tgrelid = 'public.listings'::regclass
           AND tgname = 'z_0_test_submission_lifecycle' AND tgenabled = 'O') <> 1
  THEN
    RAISE EXCEPTION 'Unapproved finalizer ACL or experimental guard state';
  END IF;
END;
$proposal_preconditions$;

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
  -- BEGIN Step 1Q classification variables
  v_category_family text;
  v_context_family text;
  v_category_family_count integer;
  v_context_family_count integer;
  v_macro_category text;
  v_context jsonb;
  v_contract jsonb;
  v_definition jsonb;
  v_policy app_security.test_submission_policies%ROWTYPE;
  -- END Step 1Q classification variables
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

  -- BEGIN Step 1Q authoritative classification
  -- Parent and request are already locked; canonical child guards lock the parent.
  -- Never trust caller family labels, slugs, JWT metadata, or precedence-only inference.
  IF p_outcome IN ('no_review_flags', 'invalid_input', 'needs_review', 'checks_incomplete') THEN
    SELECT c.macro_category INTO v_macro_category
    FROM public.categories AS c WHERE c.id = v_listing.category_id;

    SELECT count(*), min(f.family) INTO v_category_family_count, v_category_family
    FROM (
      SELECT 'cars'::text AS family
      WHERE EXISTS (SELECT 1 FROM public.car_category_contracts WHERE category_id = v_listing.category_id)
      UNION ALL SELECT 'two-wheelers'
      WHERE EXISTS (SELECT 1 FROM public.vehicle_category_contracts WHERE category_id = v_listing.category_id)
      UNION ALL SELECT 'property'
      WHERE EXISTS (SELECT 1 FROM public.property_category_contracts WHERE category_id = v_listing.category_id)
    ) AS f;
    SELECT count(*), min(f.family) INTO v_context_family_count, v_context_family
    FROM (
      SELECT 'cars'::text AS family
      WHERE EXISTS (SELECT 1 FROM public.listing_car_contexts WHERE listing_id = v_listing.id)
      UNION ALL SELECT 'two-wheelers'
      WHERE EXISTS (SELECT 1 FROM public.listing_vehicle_contexts WHERE listing_id = v_listing.id)
      UNION ALL SELECT 'property'
      WHERE EXISTS (SELECT 1 FROM public.listing_property_contexts WHERE listing_id = v_listing.id)
    ) AS f;

    IF v_category_family_count = 0 AND v_context_family_count = 0 AND v_macro_category = 'goods' THEN
      -- Authoritative Goods identity: continue the original function unchanged.
      v_category_family := NULL;
    ELSIF v_category_family_count = 1 AND v_context_family_count = 1
          AND v_category_family = v_context_family
          AND v_macro_category = (CASE WHEN v_category_family = 'property' THEN 'property' ELSE 'vehicles' END) THEN
      SELECT * INTO v_policy FROM app_security.test_submission_policies
      WHERE family = v_category_family;
      IF NOT FOUND OR v_policy.policy_key IS DISTINCT FROM 'test-submission-v1'
         OR v_policy.requirements->>'publication' IS DISTINCT FROM 'blocked' THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_MODERATION_CATEGORY');
      END IF;
      -- The version is taken from the immutable saved context, not a worker parameter.
      IF v_category_family = 'cars' THEN
        SELECT to_jsonb(c) INTO v_context FROM public.listing_car_contexts AS c WHERE listing_id = v_listing.id;
        SELECT to_jsonb(c), v.definition INTO v_contract, v_definition
        FROM public.car_category_contracts AS c JOIN public.car_contract_versions AS v ON v.id = c.version_id
        WHERE c.category_id = v_listing.category_id AND c.version_id = (v_context->>'version_id')::uuid
          AND v.contract_key = v_policy.contract_key;
      ELSIF v_category_family = 'two-wheelers' THEN
        SELECT to_jsonb(c) INTO v_context FROM public.listing_vehicle_contexts AS c WHERE listing_id = v_listing.id;
        SELECT to_jsonb(c), v.definition INTO v_contract, v_definition
        FROM public.vehicle_category_contracts AS c JOIN public.vehicle_contract_versions AS v ON v.id = c.version_id
        WHERE c.category_id = v_listing.category_id AND c.version_id = (v_context->>'version_id')::uuid
          AND v.contract_key = v_policy.contract_key;
      ELSE
        SELECT to_jsonb(c) INTO v_context FROM public.listing_property_contexts AS c WHERE listing_id = v_listing.id;
        SELECT to_jsonb(c), v.definition INTO v_contract, v_definition
        FROM public.property_category_contracts AS c JOIN public.property_contract_versions AS v ON v.id = c.version_id
        WHERE c.category_id = v_listing.category_id AND c.version_id = (v_context->>'version_id')::uuid
          AND v.contract_key = v_policy.contract_key;
      END IF;
      IF v_context IS NULL OR v_contract IS NULL OR v_definition IS NULL
         OR v_context->>'category_id' IS DISTINCT FROM v_listing.category_id::text
         OR pg_catalog.md5(v_definition::text) IS DISTINCT FROM v_policy.definition_hash
         OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_definition->'paths') AS path(value)
           WHERE path.value->'path' = v_contract->'source_path'
             AND path.value->'fields' = v_contract->'fields'
             AND (v_category_family <> 'property' OR path.value = v_contract->'definition')
         ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_MODERATION_CATEGORY');
      END IF;
    ELSE
      -- Unknown, missing, cross-family or ambiguous metadata cannot reach a status write.
      RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_MODERATION_CATEGORY');
    END IF;
  END IF;
  -- END Step 1Q authoritative classification

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

    -- BEGIN Step 1Q clean non-publication
    -- All original eligibility/media/retry checks above have already run.
    IF v_category_family IS NOT NULL THEN
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'completed'::public.moderation_request_status, updated_at = v_now
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
        'moderation.experimental_publication_disabled', 'listings', v_listing.id,
        jsonb_build_object('request_id', p_request_id, 'generation_id', v_req.generation_id,
          'revision', v_listing.revision, 'family', v_category_family,
          'outcome', p_outcome, 'decision', v_decision,
          'reason', 'EXPERIMENTAL_PUBLICATION_DISABLED', 'ruleset_version', p_ruleset_version)
      );
      RETURN jsonb_build_object('success', true, 'decision', v_decision,
        'status', 'pending_review', 'reason', 'EXPERIMENTAL_PUBLICATION_DISABLED');
    END IF;
    -- END Step 1Q clean non-publication

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
    -- BEGIN Step 1Q invalid-input manual intervention
    IF v_category_family IS NOT NULL THEN
      v_decision := 'escalated_to_admin'::public.moderation_decision_state;
      UPDATE public.listing_moderation_requests
      SET status = 'failed'::public.moderation_request_status, updated_at = v_now
      WHERE id = p_request_id;

      INSERT INTO public.listing_moderation_results (
        request_id, listing_id, listing_revision, generation_id, outcome,
        ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
      ) VALUES (
        p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
        'invalid_input'::public.moderation_outcome_enum,
        p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
      );
      PERFORM app_security.log_audit_event(
        'moderation.experimental_invalid_input', 'listings', v_listing.id,
        jsonb_build_object('request_id', p_request_id, 'generation_id', v_req.generation_id,
          'revision', v_listing.revision, 'family', v_category_family,
          'outcome', p_outcome, 'decision', v_decision,
          'reason', 'EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED', 'ruleset_version', p_ruleset_version)
      );
      RETURN jsonb_build_object('success', true, 'decision', v_decision,
        'status', 'pending_review', 'reason', 'EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED',
        'errors', p_errors);
    END IF;
    -- END Step 1Q invalid-input manual intervention
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

COMMIT;
