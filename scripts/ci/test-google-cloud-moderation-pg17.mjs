// scripts/ci/test-google-cloud-moderation-pg17.mjs
// Real PostgreSQL (PG17 via PGlite) disposable execution test for FairSwap Google Cloud Moderation V1
// Tests all four modes, expired leases, changed media, and in-flight switch races against the real forward migration.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

function computeDigest(items) {
  const lines = items.map(it => `${it.id}:${it.path}:${it.sha256}`).sort().join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

async function loadPglite() {
  const candidatePaths = [
    process.env.FSW_PGLITE_MODULE,
    resolve(root, 'tests/ratings/node_modules/@electric-sql/pglite/dist/index.js'),
    resolve(root, 'node_modules/@electric-sql/pglite/dist/index.js'),
    resolve(root, '../FairSwap-Backend/tests/ratings/node_modules/@electric-sql/pglite/dist/index.js'),
    resolve(root, '../FairSwap-Backend/node_modules/@electric-sql/pglite/dist/index.js'),
  ];
  for (const p of candidatePaths) {
    if (p && existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      return mod.PGlite;
    }
  }
  try {
    const mod = await import('@electric-sql/pglite');
    return mod.PGlite;
  } catch {}
  throw new Error('PGlite module not found in Backend test infrastructure');
}

const PGlite = await loadPglite();
const db = new PGlite();

console.log('--- Initializing PG17 Disposable Database Fixture ---');

await db.exec(`
  SET check_function_bodies = off;

  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE SCHEMA IF NOT EXISTS app_security;
  CREATE SCHEMA IF NOT EXISTS storage;
  CREATE SCHEMA IF NOT EXISTS vault;
  CREATE SCHEMA IF NOT EXISTS extensions;
  CREATE OR REPLACE FUNCTION extensions.digest(bytea, text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
    SELECT pg_catalog.sha256($1);
  $$;

  DO $$ BEGIN CREATE TYPE public.listing_status_enum AS ENUM('draft','pending_review','active','reserved','sold','rejected','paused','expired','removed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE public.moderation_outcome_enum AS ENUM('no_review_flags','needs_review','invalid_input','checks_incomplete'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE public.moderation_decision_state AS ENUM('auto_approved','routed_to_admin','awaiting_retry','escalated_to_admin','rejected_invalid'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE public.moderation_request_status AS ENUM('pending','claimed','completed','retry','superseded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE public.media_processing_status_enum AS ENUM('uploading','processing','ready','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid()
  );

  CREATE TABLE IF NOT EXISTS public.categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text UNIQUE NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true,
    macro_category text DEFAULT 'goods'
  );

  CREATE TABLE IF NOT EXISTS public.cities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text DEFAULT 'Bengaluru',
    is_active boolean DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS public.localities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id uuid REFERENCES public.cities(id),
    name text DEFAULT 'Koramangala',
    is_active boolean DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS public.listings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id uuid REFERENCES auth.users(id),
    category_id uuid REFERENCES public.categories(id),
    city_id uuid REFERENCES public.cities(id),
    locality_id uuid REFERENCES public.localities(id),
    title text,
    description text,
    status public.listing_status_enum DEFAULT 'pending_review',
    revision integer DEFAULT 1,
    cover_photo_id uuid,
    rejection_reason text,
    published_at timestamptz,
    expires_at timestamptz,
    updated_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.listing_media (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id uuid REFERENCES public.listings(id),
    original_storage_path text NOT NULL,
    processing_status public.media_processing_status_enum DEFAULT 'ready',
    display_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.listing_moderation_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id uuid REFERENCES public.listings(id),
    listing_revision integer DEFAULT 1,
    generation_id uuid DEFAULT gen_random_uuid(),
    status public.moderation_request_status DEFAULT 'claimed',
    claim_token uuid DEFAULT gen_random_uuid(),
    claim_expires_at timestamptz DEFAULT (now() + interval '5 minutes'),
    claimed_at timestamptz DEFAULT now(),
    evaluated_title text,
    evaluated_description text,
    attempt_count integer DEFAULT 0,
    max_attempts integer DEFAULT 5,
    next_attempt_at timestamptz,
    updated_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.listing_moderation_results (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    request_id uuid,
    listing_id uuid,
    listing_revision integer,
    generation_id uuid,
    outcome public.moderation_outcome_enum,
    ruleset_version text,
    scope text,
    completed_rules text[],
    failed_rules text[],
    flags jsonb,
    errors jsonb,
    decision public.moderation_decision_state,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS app_security.listing_moderation_scan_receipts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    request_id uuid NOT NULL,
    listing_id uuid NOT NULL,
    listing_revision integer NOT NULL,
    generation_id uuid NOT NULL,
    media_digest text NOT NULL,
    verdict text NOT NULL,
    ruleset_version text NOT NULL,
    scope text NOT NULL,
    completed_checks text[] NOT NULL,
    failed_checks text[] NOT NULL,
    flags jsonb NOT NULL DEFAULT '[]'::jsonb,
    model_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
    manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
    scanned_media_count integer NOT NULL DEFAULT 0,
    consumed boolean DEFAULT false,
    consumed_at timestamptz,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS app_security.listing_media_verified_hashes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    media_id uuid NOT NULL,
    listing_id uuid NOT NULL,
    original_storage_path text NOT NULL,
    content_sha256 text NOT NULL,
    generation_id uuid NOT NULL,
    verified_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.app_system_settings (
    setting_key text PRIMARY KEY,
    setting_value text NOT NULL,
    description text,
    updated_at timestamptz DEFAULT now()
  );

  INSERT INTO public.app_system_settings (setting_key, setting_value, description)
  VALUES ('moderation_automation_enabled', 'true', 'Master moderation kill switch')
  ON CONFLICT (setting_key) DO NOTHING;

  CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (
    name text PRIMARY KEY,
    decrypted_secret text NOT NULL
  );

  CREATE OR REPLACE FUNCTION app_security.get_account_status(uuid) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT 'active'::text;
  $$;

  CREATE OR REPLACE FUNCTION app_security.has_current_policy_acceptance(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT true;
  $$;

  CREATE OR REPLACE FUNCTION app_security.log_audit_event(text, text, uuid, jsonb) RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
  END;
  $$;
`);

console.log('--- Applying Real Forward Migration 20261120000000_google_cloud_moderation_v1.sql ---');
const migrationSql = readFileSync(
  resolve(root, 'supabase/forward-migrations/moderation-google-cloud-v1/20261120000000_google_cloud_moderation_v1.sql'),
  'utf8'
);
await db.exec(migrationSql);
console.log('Migration successfully applied in disposable PG17!');

// Helper setup functions
async function setupBaseFixture() {
  await db.exec(`
    DELETE FROM public.listing_moderation_results;
    DELETE FROM app_security.listing_moderation_scan_receipts;
    DELETE FROM app_security.listing_media_verified_hashes;
    DELETE FROM public.listing_media;
    DELETE FROM public.listing_moderation_requests;
    DELETE FROM public.listings;
    DELETE FROM public.categories;
    DELETE FROM public.localities;
    DELETE FROM public.cities;
    DELETE FROM auth.users;

    INSERT INTO auth.users (id) VALUES ('10000000-0000-0000-0000-000000000001');
    INSERT INTO public.categories (id, slug, name, is_active, macro_category)
      VALUES ('20000000-0000-0000-0000-000000000001', 'electronics', 'Electronics', true, 'goods');
    INSERT INTO public.cities (id, name, is_active)
      VALUES ('30000000-0000-0000-0000-000000000001', 'Bengaluru', true);
    INSERT INTO public.localities (id, city_id, name, is_active)
      VALUES ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Koramangala', true);
  `);
}

// -----------------------------------------------------------------------------
// Test 1: Mode 1 - Baseline (Supabase + OpenAI) Auto-Approval
// -----------------------------------------------------------------------------
console.log('Running Test 1: Baseline Mode Auto-Approval...');
await setupBaseFixture();
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Clean Baseline Title', 'Clean Description', 'pending_review', 1);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1,
          '70000000-0000-0000-0000-000000000001', 'claimed', '80000000-0000-0000-0000-000000000001',
          now() + interval '5 minutes', clock_timestamp() + interval '5 seconds', 'Clean Baseline Title', 'Clean Description');

  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000001'::uuid,
    '80000000-0000-0000-0000-000000000001'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    1,
    '70000000-0000-0000-0000-000000000001'::uuid,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  );
`);

const resBaseline = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000001'::uuid,
    '80000000-0000-0000-0000-000000000001'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation']
  ) AS res;
`)).rows[0].res;

assert.equal(resBaseline.success, true);
assert.equal(resBaseline.decision, 'auto_approved');
assert.equal(resBaseline.status, 'active');
const listingBaseline = (await db.query(`SELECT status FROM public.listings WHERE id = '50000000-0000-0000-0000-000000000001'`)).rows[0];
assert.equal(listingBaseline.status, 'active');
console.log('✓ Test 1 Passed: Baseline mode auto-approves correctly.');

// -----------------------------------------------------------------------------
// Test 2: Mode 2 - Azure Cloud Moderation Mode Auto-Approval
// -----------------------------------------------------------------------------
console.log('Running Test 2: Azure Moderation Mode Auto-Approval...');
await setupBaseFixture();
const digest2 = computeDigest([{ id: '90000000-0000-0000-0000-000000000001', path: 'listing-originals/photo1.jpg', sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Clean Azure Title', 'Clean Azure Description', 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES ('90000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 'listing-originals/photo1.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 1,
          '70000000-0000-0000-0000-000000000002', 'claimed', '80000000-0000-0000-0000-000000000002',
          now() + interval '5 minutes', clock_timestamp() + interval '5 seconds', 'Clean Azure Title', 'Clean Azure Description');

  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '80000000-0000-0000-0000-000000000002'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    1,
    '70000000-0000-0000-0000-000000000002'::uuid,
    '${digest2}',
    'APPROVE',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_azure_vision_nsfw', 'check_azure_vision_category', 'check_azure_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', '90000000-0000-0000-0000-000000000001', 'path', 'listing-originals/photo1.jpg', 'sha256', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
    1
  );
`);

const resAzure = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '80000000-0000-0000-0000-000000000002'::uuid,
    'no_review_flags',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_azure_vision_nsfw', 'check_azure_vision_category', 'check_azure_ocr_qr']
  ) AS res;
`)).rows[0].res;

assert.equal(resAzure.success, true);
assert.equal(resAzure.decision, 'auto_approved');
assert.equal(resAzure.status, 'active');
console.log('✓ Test 2 Passed: Azure mode auto-approves correctly.');

// -----------------------------------------------------------------------------
// Test 3: Mode 3 - Google Cloud Moderation Mode Auto-Approval
// -----------------------------------------------------------------------------
console.log('Running Test 3: Google Cloud Moderation Mode Auto-Approval...');
await setupBaseFixture();
const digest3 = computeDigest([{ id: '90000000-0000-0000-0000-000000000002', path: 'listing-originals/photo2.jpg', sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }]);
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Clean Google Title', 'Clean Google Description', 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES ('90000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000003', 'listing-originals/photo2.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003', 1,
          '70000000-0000-0000-0000-000000000003', 'claimed', '80000000-0000-0000-0000-000000000003',
          now() + interval '5 minutes', clock_timestamp() + interval '5 seconds', 'Clean Google Title', 'Clean Google Description');

  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000003'::uuid,
    '80000000-0000-0000-0000-000000000003'::uuid,
    '50000000-0000-0000-0000-000000000003'::uuid,
    1,
    '70000000-0000-0000-0000-000000000003'::uuid,
    '${digest3}',
    'APPROVE',
    'india_google_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_google_vision_nsfw', 'check_google_vision_category', 'check_google_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', '90000000-0000-0000-0000-000000000002', 'path', 'listing-originals/photo2.jpg', 'sha256', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')),
    1
  );
`);

const resGoogle = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000003'::uuid,
    '80000000-0000-0000-0000-000000000003'::uuid,
    'no_review_flags',
    'india_google_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_google_vision_nsfw', 'check_google_vision_category', 'check_google_ocr_qr']
  ) AS res;
`)).rows[0].res;

assert.equal(resGoogle.success, true);
assert.equal(resGoogle.decision, 'auto_approved');
assert.equal(resGoogle.status, 'active');
console.log('✓ Test 3 Passed: Google Cloud mode auto-approves correctly.');

// -----------------------------------------------------------------------------
// Test 4: Mode 4 - Dual Cloud Moderation Mode Auto-Approval (Independent Dual Receipts)
// -----------------------------------------------------------------------------
console.log('Running Test 4: Dual Cloud Mode Auto-Approval (Independent Dual Receipts)...');
await setupBaseFixture();
const digest4 = computeDigest([{ id: '90000000-0000-0000-0000-000000000003', path: 'listing-originals/photo3.jpg', sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }]);
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Clean Dual Title', 'Clean Dual Description', 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES ('90000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000004', 'listing-originals/photo3.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000004', 1,
          '70000000-0000-0000-0000-000000000004', 'claimed', '80000000-0000-0000-0000-000000000004',
          now() + interval '5 minutes', clock_timestamp() + interval '5 seconds', 'Clean Dual Title', 'Clean Dual Description');

  -- 1. Register independent Azure scan receipt
  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000004'::uuid,
    '80000000-0000-0000-0000-000000000004'::uuid,
    '50000000-0000-0000-0000-000000000004'::uuid,
    1,
    '70000000-0000-0000-0000-000000000004'::uuid,
    '${digest4}',
    'APPROVE',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY[
      'check_india_fraud_rules',
      'check_openai_moderation',
      'check_azure_vision_nsfw',
      'check_azure_vision_category',
      'check_azure_ocr_qr'
    ],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', '90000000-0000-0000-0000-000000000003', 'path', 'listing-originals/photo3.jpg', 'sha256', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')),
    1
  );

  -- 2. Register independent Google Cloud scan receipt
  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000004'::uuid,
    '80000000-0000-0000-0000-000000000004'::uuid,
    '50000000-0000-0000-0000-000000000004'::uuid,
    1,
    '70000000-0000-0000-0000-000000000004'::uuid,
    '${digest4}',
    'APPROVE',
    'india_google_v1.0.0',
    'multimodal_five_check',
    ARRAY[
      'check_india_fraud_rules',
      'check_openai_moderation',
      'check_google_vision_nsfw',
      'check_google_vision_category',
      'check_google_ocr_qr'
    ],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', '90000000-0000-0000-0000-000000000003', 'path', 'listing-originals/photo3.jpg', 'sha256', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')),
    1
  );
`);

const resDual = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000004'::uuid,
    '80000000-0000-0000-0000-000000000004'::uuid,
    'no_review_flags',
    'india_dual_cloud_v1.0.0',
    'multimodal_eight_check',
    ARRAY[
      'check_india_fraud_rules',
      'check_openai_moderation',
      'check_azure_vision_nsfw',
      'check_azure_vision_category',
      'check_azure_ocr_qr',
      'check_google_vision_nsfw',
      'check_google_vision_category',
      'check_google_ocr_qr'
    ]
  ) AS res;
`)).rows[0].res;

assert.equal(resDual.success, true);
assert.equal(resDual.decision, 'auto_approved');
assert.equal(resDual.status, 'active');

// Verify 365-day validity policy
const validityCheck = (await db.query(`
  SELECT (expires_at - published_at = interval '365 days') AS is_365_days
  FROM public.listings WHERE id = '50000000-0000-0000-0000-000000000004'
`)).rows[0].is_365_days;
assert.equal(validityCheck, true);

// Verify BOTH receipts marked consumed
const consumedCount = Number((await db.query(`
  SELECT count(*) AS cnt FROM app_security.listing_moderation_scan_receipts
  WHERE request_id = '60000000-0000-0000-0000-000000000004' AND consumed = true
`)).rows[0].cnt);
assert.equal(consumedCount, 2);
console.log('✓ Test 4 Passed: Dual Cloud mode auto-approves with independent dual receipts & 365-day validity.');

// -----------------------------------------------------------------------------
// Test 4b: Dual Cloud Missing Azure Receipt Fails Closed (Never Approves)
// -----------------------------------------------------------------------------
console.log('Running Test 4b: Dual Cloud Missing Azure Receipt Guard...');
await setupBaseFixture();
const digest4b = computeDigest([{ id: '90000000-0000-0000-0000-00000000004b', path: 'listing-originals/photo4b.jpg', sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }]);
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-00000000004b', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Missing Azure Title', 'Desc', 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES ('90000000-0000-0000-0000-00000000004b', '50000000-0000-0000-0000-00000000004b', 'listing-originals/photo4b.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-00000000004b', '50000000-0000-0000-0000-00000000004b', 1,
          '70000000-0000-0000-0000-00000000004b', 'claimed', '80000000-0000-0000-0000-00000000004b',
          now() + interval '5 minutes', clock_timestamp() + interval '5 seconds', 'Missing Azure Title', 'Desc');

  -- ONLY Google receipt registered (no Azure receipt)
  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-00000000004b'::uuid,
    '80000000-0000-0000-0000-00000000004b'::uuid,
    '50000000-0000-0000-0000-00000000004b'::uuid,
    1,
    '70000000-0000-0000-0000-00000000004b'::uuid,
    '${digest4b}',
    'APPROVE',
    'india_google_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_google_vision_nsfw', 'check_google_vision_category', 'check_google_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', '90000000-0000-0000-0000-00000000004b', 'path', 'listing-originals/photo4b.jpg', 'sha256', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')),
    1
  );
`);

const resMissingAzure = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-00000000004b'::uuid,
    '80000000-0000-0000-0000-00000000004b'::uuid,
    'no_review_flags',
    'india_dual_cloud_v1.0.0',
    'multimodal_eight_check',
    ARRAY[
      'check_india_fraud_rules', 'check_openai_moderation',
      'check_azure_vision_nsfw', 'check_azure_vision_category', 'check_azure_ocr_qr',
      'check_google_vision_nsfw', 'check_google_vision_category', 'check_google_ocr_qr'
    ]
  ) AS res;
`)).rows[0].res;

assert.notEqual(resMissingAzure.decision, 'auto_approved');
console.log('✓ Test 4b Passed: Dual Cloud without Azure receipt fails closed (not auto-approved).');

// -----------------------------------------------------------------------------
// Test 5: Expired Lease Guard (Fails Closed with LEASE_EXPIRED)
// -----------------------------------------------------------------------------
console.log('Running Test 5: Expired Lease Guard...');
await setupBaseFixture();
await db.exec(`
  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Expired Title', 'Desc', 'pending_review', 1);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000005', 1,
          '70000000-0000-0000-0000-000000000005', 'claimed', '80000000-0000-0000-0000-000000000005',
          now() - interval '10 seconds', now() - interval '5 minutes', 'Expired Title', 'Desc');
`);

const resExpired = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000005'::uuid,
    '80000000-0000-0000-0000-000000000005'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check'
  ) AS res;
`)).rows[0].res;

assert.equal(resExpired.success, false);
assert.equal(resExpired.error, 'LEASE_EXPIRED');
console.log('✓ Test 5 Passed: Expired lease rejected.');

// -----------------------------------------------------------------------------
// Test 6: Changed Media / Manifest Tampering Guard (Fails Closed to awaiting_retry)
// -----------------------------------------------------------------------------
console.log('Running Test 6: Changed Media Guard...');
await setupBaseFixture();
const digest6 = computeDigest([{ id: '90000000-0000-0000-0000-000000000004', path: 'listing-originals/photo4.jpg', sha256: '2222222222222222222222222222222222222222222222222222222222222222' }]);
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Tampered Media Title', 'Desc', 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES ('90000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000006', 'listing-originals/photo4.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000006', '50000000-0000-0000-0000-000000000006', 1,
          '70000000-0000-0000-0000-000000000006', 'claimed', '80000000-0000-0000-0000-000000000006',
          now() + interval '5 minutes', clock_timestamp() + interval '5 seconds', 'Tampered Media Title', 'Desc');

  -- Register valid receipt for photo4.jpg
  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000006'::uuid,
    '80000000-0000-0000-0000-000000000006'::uuid,
    '50000000-0000-0000-0000-000000000006'::uuid,
    1,
    '70000000-0000-0000-0000-000000000006'::uuid,
    '${digest6}',
    'APPROVE',
    'india_google_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_google_vision_nsfw', 'check_google_vision_category', 'check_google_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', '90000000-0000-0000-0000-000000000004', 'path', 'listing-originals/photo4.jpg', 'sha256', '2222222222222222222222222222222222222222222222222222222222222222')),
    1
  );

  -- IN-FLIGHT MEDIA TAMPER: The listing photo is replaced or modified in the database after scan
  UPDATE public.listing_media
  SET original_storage_path = 'listing-originals/photo4_replaced.jpg'
  WHERE id = '90000000-0000-0000-0000-000000000004';
`);

const resTampered = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000006'::uuid,
    '80000000-0000-0000-0000-000000000006'::uuid,
    'no_review_flags',
    'india_google_v1.0.0',
    'multimodal_five_check'
  ) AS res;
`)).rows[0].res;

assert.equal(resTampered.decision, 'awaiting_retry');
const listingTampered = (await db.query(`SELECT status FROM public.listings WHERE id = '50000000-0000-0000-0000-000000000006'`)).rows[0];
assert.equal(listingTampered.status, 'pending_review'); // Not auto-approved!
console.log('✓ Test 6 Passed: Changed media fails closed to awaiting_retry.');

// -----------------------------------------------------------------------------
// Test 7: In-Flight Provider Switch Race Guard (FOR SHARE lock detects toggle)
// -----------------------------------------------------------------------------
console.log('Running Test 7: In-Flight Provider Switch Race Guard...');
await setupBaseFixture();
const digest7 = computeDigest([{ id: '90000000-0000-0000-0000-000000000005', path: 'listing-originals/photo5.jpg', sha256: '5555555555555555555555555555555555555555555555555555555555555555' }]);
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Race Title', 'Desc', 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES ('90000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000007', 'listing-originals/photo5.jpg', 'ready', 0);

  -- Request claimed at t1 (e.g. 10 seconds ago)
  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000007', 1,
          '70000000-0000-0000-0000-000000000007', 'claimed', '80000000-0000-0000-0000-000000000007',
          now() + interval '5 minutes', now() - interval '10 seconds', 'Race Title', 'Desc');

  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000007'::uuid,
    '80000000-0000-0000-0000-000000000007'::uuid,
    '50000000-0000-0000-0000-000000000007'::uuid,
    1,
    '70000000-0000-0000-0000-000000000007'::uuid,
    '${digest7}',
    'APPROVE',
    'india_google_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_google_vision_nsfw', 'check_google_vision_category', 'check_google_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', '90000000-0000-0000-0000-000000000005', 'path', 'listing-originals/photo5.jpg', 'sha256', '5555555555555555555555555555555555555555555555555555555555555555')),
    1
  );

  -- IN-FLIGHT SWITCH: An admin toggles a setting at t2 (now) after claimed_at
  UPDATE public.app_system_settings
  SET setting_value = 'true', updated_at = now()
  WHERE setting_key = 'moderation_google_cloud_enabled';
`);

const resRace = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000007'::uuid,
    '80000000-0000-0000-0000-000000000007'::uuid,
    'no_review_flags',
    'india_google_v1.0.0',
    'multimodal_five_check'
  ) AS res;
`)).rows[0].res;

assert.equal(resRace.success, true);
assert.equal(resRace.decision, 'routed_to_admin'); // Overridden to needs_review -> routed_to_admin
const listingRace = (await db.query(`SELECT status FROM public.listings WHERE id = '50000000-0000-0000-0000-000000000007'`)).rows[0];
assert.equal(listingRace.status, 'pending_review'); // Fails closed!
console.log('✓ Test 7 Passed: In-flight setting change forces routed_to_admin.');

// -----------------------------------------------------------------------------
// Test 8: Mode Mismatch Guard (Baseline result evaluated when Google is enabled)
// -----------------------------------------------------------------------------
console.log('Running Test 8: Mode Mismatch Guard...');
await setupBaseFixture();
await db.exec(`
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Mismatch Title', 'Desc', 'pending_review', 1);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-000000000008', 1,
          '70000000-0000-0000-0000-000000000008', 'claimed', '80000000-0000-0000-0000-000000000008',
          now() + interval '5 minutes', now() + interval '1 minute', 'Mismatch Title', 'Desc');

  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000008'::uuid,
    '80000000-0000-0000-0000-000000000008'::uuid,
    '50000000-0000-0000-0000-000000000008'::uuid,
    1,
    '70000000-0000-0000-0000-000000000008'::uuid,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  );
`);

const resMismatch = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000008'::uuid,
    '80000000-0000-0000-0000-000000000008'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check'
  ) AS res;
`)).rows[0].res;

assert.equal(resMismatch.decision, 'routed_to_admin');
console.log('✓ Test 8 Passed: Mode mismatch fails closed to routed_to_admin.');

// -----------------------------------------------------------------------------
// Test 9: Restricted Category Guard
// -----------------------------------------------------------------------------
console.log('Running Test 9: Restricted Category Guard...');
await db.exec(`
  CREATE TABLE IF NOT EXISTS public.car_category_contracts (
    category_id uuid PRIMARY KEY REFERENCES public.categories(id)
  );

  INSERT INTO public.car_category_contracts (category_id)
  VALUES ('20000000-0000-0000-0000-000000000001')
  ON CONFLICT DO NOTHING;

  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_azure_enabled';
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_google_cloud_enabled';
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Car Listing Title', 'Desc', 'pending_review', 1);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000009', '50000000-0000-0000-0000-000000000009', 1,
          '70000000-0000-0000-0000-000000000009', 'claimed', '80000000-0000-0000-0000-000000000009',
          now() + interval '5 minutes', now() + interval '1 minute', 'Car Listing Title', 'Desc');

  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000009'::uuid,
    '80000000-0000-0000-0000-000000000009'::uuid,
    '50000000-0000-0000-0000-000000000009'::uuid,
    1,
    '70000000-0000-0000-0000-000000000009'::uuid,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  );
`);

const resRestricted = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000009'::uuid,
    '80000000-0000-0000-0000-000000000009'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check'
  ) AS res;
`)).rows[0].res;

assert.equal(resRestricted.decision, 'routed_to_admin');
console.log('✓ Test 9 Passed: Restricted category routed to admin.');

// -----------------------------------------------------------------------------
// Test 10: Master Killswitch Guard (moderation_automation_enabled = false)
// -----------------------------------------------------------------------------
console.log('Running Test 10: Master Killswitch Guard...');
await db.exec(`
  DROP TABLE IF EXISTS public.car_category_contracts;
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_automation_enabled';

  INSERT INTO public.listings (id, seller_id, category_id, city_id, locality_id, title, description, status, revision)
  VALUES ('50000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
          '40000000-0000-0000-0000-000000000001', 'Killswitch Title', 'Desc', 'pending_review', 1);

  INSERT INTO public.listing_moderation_requests (id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at, claimed_at, evaluated_title, evaluated_description)
  VALUES ('60000000-0000-0000-0000-000000000010', '50000000-0000-0000-0000-000000000010', 1,
          '70000000-0000-0000-0000-000000000010', 'claimed', '80000000-0000-0000-0000-000000000010',
          now() + interval '5 minutes', now() + interval '1 minute', 'Killswitch Title', 'Desc');

  SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000010'::uuid,
    '80000000-0000-0000-0000-000000000010'::uuid,
    '50000000-0000-0000-0000-000000000010'::uuid,
    1,
    '70000000-0000-0000-0000-000000000010'::uuid,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  );
`);

const resKillswitch = (await db.query(`
  SELECT app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000010'::uuid,
    '80000000-0000-0000-0000-000000000010'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check'
  ) AS res;
`)).rows[0].res;

assert.equal(resKillswitch.decision, 'routed_to_admin');
console.log('✓ Test 10 Passed: Master killswitch forces routed_to_admin.');

console.log('\n======================================================');
console.log('ALL 10 DISPOSABLE POSTGRESQL FINALIZER TESTS PASSED!');
console.log('======================================================\n');
