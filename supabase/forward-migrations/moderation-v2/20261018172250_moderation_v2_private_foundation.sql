-- FairSwap Moderation V2 / Slice B — private, disabled foundation only.
-- Timestamp generated with SHA-pinned Supabase CLI 2.117.0 in GH Actions run
-- 39149299010. Separate forward lane; never append to the sealed V1 manifest.
-- No triggers, public RPCs, dispatch, service credentials or publication path.

CREATE SCHEMA app_moderation_v2;
REVOKE ALL ON SCHEMA app_moderation_v2 FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app_moderation_v2 TO service_role;

-- Protocol/policy and evaluator build must be explicitly approved by a
-- separately reviewed migration. A version-shaped string is NOT approval.
CREATE TABLE app_moderation_v2.policy_registry (
  policy_version text PRIMARY KEY
    CHECK (policy_version ~ '^fairswap_moderation_v[0-9]+[.][0-9]+[.][0-9]+$'),
  protocol_version smallint NOT NULL DEFAULT 2 CHECK (protocol_version = 2),
  contract_version text NOT NULL CHECK (contract_version = '2.0.0'),
  provider_model text NOT NULL CHECK (provider_model = 'omni-moderation-2024-09-26'),
  seal_recipe text NOT NULL CHECK (seal_recipe = 'seal_v1'),
  approved_evaluator_build text
    CHECK (approved_evaluator_build IS NULL
      OR approved_evaluator_build ~ '^[0-9a-f]{64}$'),
  is_approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (NOT is_approved OR approved_evaluator_build IS NOT NULL)
);
COMMENT ON TABLE app_moderation_v2.policy_registry IS
  'Service-readable, migration-managed V2 policy/build approvals; all approvals off at creation';

INSERT INTO app_moderation_v2.policy_registry (
  policy_version, protocol_version, contract_version,
  provider_model, seal_recipe, approved_evaluator_build, is_approved
) VALUES (
  'fairswap_moderation_v2.0.0', 2, '2.0.0',
  'omni-moderation-2024-09-26', 'seal_v1', NULL, false
);

-- This is a durable request envelope, not a claim/dispatch engine.
-- The server will choose protocol/lane in a later independently reviewed
-- routing migration; callers cannot use this foundation to publish listings.
CREATE TABLE app_moderation_v2.requests (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_revision integer NOT NULL CHECK (listing_revision > 0),
  generation_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  protocol_version smallint NOT NULL DEFAULT 2 CHECK (protocol_version = 2),
  policy_version text NOT NULL
    REFERENCES app_moderation_v2.policy_registry(policy_version) ON DELETE RESTRICT,
  request_lane text NOT NULL CHECK (request_lane IN ('shadow', 'enforce')),
  phase text NOT NULL DEFAULT 'input_validation'
    CHECK (phase IN ('input_validation', 'preparation', 'evaluation', 'complete')),
  status text NOT NULL DEFAULT 'pending_input'
    CHECK (status IN (
      'pending_input', 'awaiting_media', 'prepared', 'claimed',
      'retry', 'completed', 'failed', 'superseded'
    )),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT uq_v2_request_generation UNIQUE (listing_id, listing_revision, generation_id),
  CONSTRAINT ck_v2_pending_input_phase
    CHECK (status <> 'pending_input' OR phase = 'input_validation'),
  CONSTRAINT ck_v2_awaiting_media_phase
    CHECK (status <> 'awaiting_media' OR phase = 'preparation')
);
COMMENT ON TABLE app_moderation_v2.requests IS
  'Service-only V2 request identity and future lifecycle. No V1 fallback or claim worker';

CREATE INDEX idx_v2_requests_due
  ON app_moderation_v2.requests (status, next_attempt_at, created_at)
  WHERE status IN ('pending_input', 'prepared', 'retry');

CREATE INDEX idx_v2_requests_listing
  ON app_moderation_v2.requests (listing_id, created_at DESC);

CREATE UNIQUE INDEX uq_v2_enforce_active_listing
  ON app_moderation_v2.requests (listing_id)
  WHERE request_lane = 'enforce' AND status IN (
    'pending_input', 'awaiting_media', 'prepared', 'claimed', 'retry'
  );

-- Two independent layers: schema ACL plus RLS. No client policies.
ALTER TABLE app_moderation_v2.policy_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_moderation_v2.requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA app_moderation_v2
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON app_moderation_v2.policy_registry TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_moderation_v2.requests TO service_role;

-- No permissive default-function grants are introduced, and this migration
-- creates no SECURITY DEFINER or exposed public RPC.

-- V2 has a DISTINCT kill switch and mode. Both remain disabled at creation;
-- missing values are also interpreted as disabled by future workers.
INSERT INTO public.app_system_settings (
  setting_key, setting_value, description
) VALUES
  ('moderation_v2_enabled', 'false',
    'Independent V2 kill switch; missing or false is disabled'),
  ('moderation_v2_mode', 'disabled',
    'V2 mode: disabled, shadow, enforce; default disabled')
ON CONFLICT (setting_key) DO NOTHING;

DO $v2_default_off$
BEGIN
  IF (SELECT setting_value FROM public.app_system_settings
      WHERE setting_key = 'moderation_v2_enabled') IS DISTINCT FROM 'false'
  OR (SELECT setting_value FROM public.app_system_settings
      WHERE setting_key = 'moderation_v2_mode') IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'Moderation V2 foundation requires independently disabled gates';
  END IF;
END;
$v2_default_off$;
