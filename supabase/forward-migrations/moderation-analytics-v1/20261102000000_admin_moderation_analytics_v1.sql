-- Forward Migration: Moderation Analytics V1 Authoritative RPC
-- File: supabase/forward-migrations/moderation-analytics-v1/20261102000000_admin_moderation_analytics_v1.sql
-- Name: admin_moderation_analytics_v1
-- Description: Authoritative Administrator-only RPC for Moderation Analytics V1.
-- Authorizes callers strictly via app_security.is_active_staff_aal2('administrator').
-- Evaluates windows strictly in Indian Standard Time (Asia/Kolkata, UTC+05:30).
-- Normalizes range parameter: 'today', 'yesterday', '7d', '30d' (defaults/normalizes to 'today').
-- Boundaries (calendar dates including today in IST):
--   'today': midnight IST of today (1 calendar day) to clock_timestamp()
--   'yesterday': midnight IST of yesterday to midnight IST of today (1 calendar day)
--   '7d': midnight IST of (today - 6 days) to clock_timestamp() (exactly 7 calendar dates: today + previous 6 days)
--   '30d': midnight IST of (today - 29 days) to clock_timestamp() (exactly 30 calendar dates: today + previous 29 days)
-- Image scan attempts: truthfully marked unavailable until genuine per-image attempt instrumentation exists.

BEGIN;

CREATE OR REPLACE FUNCTION app_security.get_admin_moderation_analytics(
  p_filter_range text DEFAULT 'today'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_range text;
  v_start_tz timestamptz;
  v_end_tz timestamptz;
  v_now_ist timestamptz;
  v_today_start_ist timestamptz;
  v_metrics jsonb;
  v_five_checks jsonb;
  v_decisions jsonb;
  v_history jsonb;
BEGIN
  -- 1. Authorization: Administrator with AAL2 and current policy acceptance
  IF v_caller_id IS NULL
     OR NOT app_security.is_active_staff_aal2('administrator'::public.staff_role_enum)
     OR NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator authorization required';
  END IF;

  -- 2. Normalize filter range
  IF p_filter_range IN ('today', 'yesterday', '7d', '30d') THEN
    v_range := p_filter_range;
  ELSE
    v_range := 'today';
  END IF;

  -- 3. Compute IST Boundaries (Asia/Kolkata: UTC+05:30)
  v_now_ist := pg_catalog.clock_timestamp();
  v_today_start_ist := (pg_catalog.date_trunc('day', v_now_ist AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata';

  IF v_range = 'yesterday' THEN
    v_start_tz := v_today_start_ist - INTERVAL '1 day';
    v_end_tz := v_today_start_ist;
  ELSIF v_range = '7d' THEN
    -- Exactly 7 calendar dates including today: today + 6 preceding days
    v_start_tz := v_today_start_ist - INTERVAL '6 days';
    v_end_tz := v_now_ist;
  ELSIF v_range = '30d' THEN
    -- Exactly 30 calendar dates including today: today + 29 preceding days
    v_start_tz := v_today_start_ist - INTERVAL '29 days';
    v_end_tz := v_now_ist;
  ELSE
    v_start_tz := v_today_start_ist;
    v_end_tz := v_now_ist;
  END IF;

  -- 4. Aggregate Listings & Media Counts
  -- Avoid counting retries or edits as new listings:
  -- - listings_submitted: initial submissions where submitted_at falls within window
  -- - listings_evaluated: distinct listings evaluated by moderation results in window
  -- - images_uploaded: unique media rows created in window
  WITH submitted_window AS (
    SELECT count(DISTINCT id) AS count
    FROM public.listings
    WHERE submitted_at >= v_start_tz AND submitted_at < v_end_tz
  ),
  media_window AS (
    SELECT
      count(DISTINCT id) AS total_uploaded,
      count(DISTINCT id) FILTER (WHERE processing_status = 'ready') AS ready_count,
      count(DISTINCT id) FILTER (WHERE processing_status = 'failed') AS failed_count
    FROM public.listing_media
    WHERE created_at >= v_start_tz AND created_at < v_end_tz
  ),
  mod_results_window AS (
    SELECT
      count(*) AS total_evaluations,
      count(DISTINCT listing_id) AS distinct_listings_evaluated,
      count(*) FILTER (WHERE decision = 'auto_approved') AS auto_approved_count,
      count(*) FILTER (WHERE decision = 'routed_to_admin') AS routed_to_admin_count,
      count(*) FILTER (WHERE decision = 'escalated_to_admin') AS escalated_to_admin_count,
      count(*) FILTER (WHERE decision = 'rejected_invalid') AS rejected_invalid_count
    FROM public.listing_moderation_results
    WHERE created_at >= v_start_tz AND created_at < v_end_tz
  )
  SELECT jsonb_build_object(
    'listings_submitted', COALESCE((SELECT count FROM submitted_window), 0),
    'listings_evaluated', COALESCE((SELECT distinct_listings_evaluated FROM mod_results_window), 0),
    'total_evaluations', COALESCE((SELECT total_evaluations FROM mod_results_window), 0),
    'images_uploaded', COALESCE((SELECT total_uploaded FROM media_window), 0),
    'images_ready', COALESCE((SELECT ready_count FROM media_window), 0),
    'images_failed', COALESCE((SELECT failed_count FROM media_window), 0)
  ) INTO v_metrics;

  -- 5. Decisions Summary
  SELECT jsonb_build_object(
    'auto_approved', COALESCE((SELECT count(*) FROM public.listing_moderation_results WHERE created_at >= v_start_tz AND created_at < v_end_tz AND decision = 'auto_approved'), 0),
    'routed_to_admin', COALESCE((SELECT count(*) FROM public.listing_moderation_results WHERE created_at >= v_start_tz AND created_at < v_end_tz AND decision = 'routed_to_admin'), 0),
    'escalated_to_admin', COALESCE((SELECT count(*) FROM public.listing_moderation_results WHERE created_at >= v_start_tz AND created_at < v_end_tz AND decision = 'escalated_to_admin'), 0),
    'rejected_invalid', COALESCE((SELECT count(*) FROM public.listing_moderation_results WHERE created_at >= v_start_tz AND created_at < v_end_tz AND decision = 'rejected_invalid'), 0)
  ) INTO v_decisions;

  -- 6. Five Moderation Checks Aggregate
  WITH checks_unrolled AS (
    SELECT
      r.id AS result_id,
      comp.chk AS check_name,
      'passed' AS status
    FROM public.listing_moderation_results r,
         LATERAL unnest(r.completed_rules) AS comp(chk)
    WHERE r.created_at >= v_start_tz AND r.created_at < v_end_tz
    UNION ALL
    SELECT
      r.id AS result_id,
      fail.chk AS check_name,
      'failed' AS status
    FROM public.listing_moderation_results r,
         LATERAL unnest(r.failed_rules) AS fail(chk)
    WHERE r.created_at >= v_start_tz AND r.created_at < v_end_tz
  ),
  checks_summary AS (
    SELECT
      c.name AS check_name,
      COALESCE(count(*) FILTER (WHERE u.status = 'passed'), 0) AS passed_count,
      COALESCE(count(*) FILTER (WHERE u.status = 'failed'), 0) AS failed_count,
      COALESCE(count(u.result_id), 0) AS total_runs
    FROM (VALUES
      ('check_india_fraud_rules'),
      ('check_openai_moderation'),
      ('check_vision_nsfw'),
      ('check_vision_category'),
      ('check_ocr_qr')
    ) AS c(name)
    LEFT JOIN checks_unrolled u ON u.check_name = c.name
    GROUP BY c.name
  )
  SELECT jsonb_object_agg(
    check_name,
    jsonb_build_object(
      'passed', passed_count,
      'failed', failed_count,
      'total', total_runs
    )
  ) INTO v_five_checks
  FROM checks_summary;

  -- 7. Compact Processing History (Recent 50 executions in window)
  SELECT COALESCE(jsonb_agg(h), '[]'::jsonb)
  INTO v_history
  FROM (
    SELECT
      r.id,
      r.request_id,
      r.listing_id,
      l.title AS listing_title,
      r.listing_revision,
      r.ruleset_version,
      r.scope,
      r.outcome,
      r.decision,
      r.completed_rules,
      r.failed_rules,
      jsonb_array_length(r.flags) AS flags_count,
      r.created_at
    FROM public.listing_moderation_results r
    LEFT JOIN public.listings l ON l.id = r.listing_id
    WHERE r.created_at >= v_start_tz AND r.created_at < v_end_tz
    ORDER BY r.created_at DESC
    LIMIT 50
  ) h;

  -- 8. Return consolidated payload
  -- Image scan attempts truthfully marked unavailable until per-image scan attempt telemetry exists
  RETURN jsonb_build_object(
    'range', v_range,
    'window_start', v_start_tz,
    'window_end', v_end_tz,
    'generated_at_ist', v_now_ist,
    'metrics', v_metrics,
    'five_checks', v_five_checks,
    'decisions', v_decisions,
    'image_scans', jsonb_build_object(
      'available', false,
      'count', 0,
      'status', 'unavailable',
      'label', 'Per-image scan attempts unavailable until telemetry is deployed'
    ),
    'costs', jsonb_build_object(
      'azure', 'Not connected',
      'openai', 'Not connected',
      'status', 'not_connected'
    ),
    'history', v_history
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.get_admin_moderation_analytics(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.get_admin_moderation_analytics(text) TO authenticated;

-- Public schema wrapper
CREATE OR REPLACE FUNCTION public.get_admin_moderation_analytics(
  filter_range text DEFAULT 'today'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.get_admin_moderation_analytics(filter_range);
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_moderation_analytics(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_moderation_analytics(text) TO authenticated;

COMMIT;
