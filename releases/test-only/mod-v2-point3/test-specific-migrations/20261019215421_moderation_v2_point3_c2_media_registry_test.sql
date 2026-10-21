-- FairSwapTest-only forward Point 3 protected media registry; C2 queue reused.
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='30s';
SELECT pg_catalog.pg_advisory_xact_lock(20261019,3);
DO $baseline$
BEGIN
 IF current_database()<>'postgres' OR session_user<>'postgres'
 OR current_setting('server_version_num')::integer/10000<>17
 OR to_regnamespace('app_moderation_v2') IS NULL
 OR to_regnamespace('modv2_private') IS NOT NULL
 OR (SELECT count(*) FROM supabase_migrations.schema_migrations)<>67
 OR (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name IN
 ('moderation_v2_c2a_private_foundation','moderation_v2_c2a_input_validation','moderation_v2_c2b_input_lease'))<>3
 OR to_regclass('app_moderation_v2.seal_bundles') IS NOT NULL
 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FairSwapTest C2 baseline mismatch; registry not applied'; END IF;
 IF EXISTS(SELECT 1 FROM public.app_system_settings
 WHERE (setting_key='moderation_v2_enabled' AND setting_value<>'false')
 OR (setting_key='moderation_v2_mode' AND setting_value<>'disabled'))
 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Moderation V2 must remain disabled'; END IF;
END $baseline$;
CREATE ROLE mv2_p3_registry_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT mv2_p3_registry_owner TO postgres WITH SET TRUE;
GRANT CREATE ON SCHEMA app_moderation_v2 TO mv2_p3_registry_owner;
CREATE TABLE app_moderation_v2.seal_bundles (
 asset_version uuid PRIMARY KEY,
 listing_id uuid NOT NULL,
 media_id uuid NOT NULL,
 seller_id uuid NOT NULL,
 policy_version text NOT NULL REFERENCES app_moderation_v2.policy_registry(policy_version) ON DELETE RESTRICT,
 source_revision integer NOT NULL CHECK(source_revision>0),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 source_paths jsonb NOT NULL CHECK(jsonb_typeof(source_paths)='array' AND jsonb_array_length(source_paths)=4),
 recipe text NOT NULL DEFAULT 'seal_v1' CHECK(recipe='seal_v1'),
 created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
 UNIQUE(listing_id,media_id,asset_version)
);
CREATE TABLE app_moderation_v2.seal_objects (
 object_id uuid PRIMARY KEY,
 asset_version uuid NOT NULL REFERENCES app_moderation_v2.seal_bundles(asset_version) ON DELETE RESTRICT,
 variant text NOT NULL CHECK(variant IN ('original','canonical','thumb','medium','large')),
 bucket text NOT NULL CHECK(
 (variant IN ('original','canonical') AND bucket='listing-originals') OR
 (variant IN ('thumb','medium','large') AND bucket='listing-derivatives')),
 logical_key text NOT NULL UNIQUE,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 bytes bigint NOT NULL CHECK(bytes>0),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 8000),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 8000),
 created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
 CONSTRAINT seal_object_pixel_bounds CHECK(width::bigint*height::bigint<=64000000),
 UNIQUE(asset_version,variant)
);
CREATE TABLE app_moderation_v2.seal_media_bindings (
 media_id uuid PRIMARY KEY,
 listing_id uuid NOT NULL,
 asset_version uuid NOT NULL UNIQUE REFERENCES app_moderation_v2.seal_bundles(asset_version) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE app_moderation_v2.seal_retirements (
 asset_version uuid PRIMARY KEY REFERENCES app_moderation_v2.seal_bundles(asset_version) ON DELETE RESTRICT,
 listing_id uuid NOT NULL,
 retired_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE app_moderation_v2.seal_bundles OWNER TO mv2_p3_registry_owner;
ALTER TABLE app_moderation_v2.seal_objects OWNER TO mv2_p3_registry_owner;
ALTER TABLE app_moderation_v2.seal_media_bindings OWNER TO mv2_p3_registry_owner;
ALTER TABLE app_moderation_v2.seal_retirements OWNER TO mv2_p3_registry_owner;
REVOKE ALL ON app_moderation_v2.seal_bundles,
app_moderation_v2.seal_objects,
app_moderation_v2.seal_media_bindings,
app_moderation_v2.seal_retirements FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE app_moderation_v2.seal_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_moderation_v2.seal_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_moderation_v2.seal_media_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_moderation_v2.seal_retirements ENABLE ROW LEVEL SECURITY;
REVOKE CREATE ON SCHEMA app_moderation_v2 FROM mv2_p3_registry_owner;
COMMENT ON TABLE app_moderation_v2.seal_bundles IS
'TEST ONLY: inert Point 3 five-object source identity registry; C2 requests remain authoritative; no publication API';
COMMENT ON TABLE app_moderation_v2.seal_media_bindings IS
'TEST ONLY: no binder/finalizer is yet authorized; all application writes denied';
COMMIT;