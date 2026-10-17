-- Historical FairSwapTest-only repair receipt (applied: 20261017172840).
-- This is NOT a canonical migration and MUST NOT be run on FairSwapProd.
-- Reconstructed guarded SQL from the reviewed staging restoration operation.
-- Supabase-Test project: wpppxlnbzqynvhpeuavd. No secret values are recorded.
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';
DO $staging_only$
BEGIN
  IF (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_automation_enabled') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FairSwapTest automation switch is not explicitly enabled; refusing trigger activation';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.listings'::regclass
      AND tgname = 'trg_listing_moderation_enqueue' AND tgenabled = 'D') <> 1 THEN
    RAISE EXCEPTION 'Expected disabled moderation enqueue trigger not found';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.listings'::regclass
      AND tgname IN ('z_0_test_submission_lifecycle', 'z_vehicle_listing_guard', 'zz_car_listing_guard', 'zzz_property_listing_guard')
      AND tgenabled = 'O') <> 4 THEN
    RAISE EXCEPTION 'Experimental publication guards are not fully active';
  END IF;
  IF (SELECT count(*) FROM app_security.test_submission_policies
      WHERE family IN ('cars','two-wheelers','property') AND enabled = true
        AND maintenance = false AND requirements->>'publication' = 'blocked') <> 3 THEN
    RAISE EXCEPTION 'Experimental publication policy not fully blocked';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.listing_moderation_requests'::regclass
      AND tgname='trg_moderation_request_immediate_dispatch' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Moderation worker dispatch is not enabled';
  END IF;
  IF (SELECT count(*) FROM vault.decrypted_secrets WHERE name='moderation_worker_url'
      AND decrypted_secret='https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-listing-moderation') <> 1
   OR (SELECT count(*) FROM vault.decrypted_secrets WHERE name='moderation_worker_secret'
      AND decrypted_secret ~ '^[0-9a-f]{64}$') <> 1 THEN
    RAISE EXCEPTION 'Staging moderation worker credentials unavailable';
  END IF;
  ALTER TABLE public.listings ENABLE TRIGGER trg_listing_moderation_enqueue;
END;
$staging_only$;
COMMIT;
