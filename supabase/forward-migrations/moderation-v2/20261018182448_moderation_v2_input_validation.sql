-- FairSwap Moderation V2 / Slice C2a — private request-text binding & scalar validation.
-- Applied to the separate forward lane; never append to the sealed V1 manifest.
-- Private schema-qualified functions only; REVOKE ALL from PUBLIC, anon, authenticated.

-- 1. Add bounded, server/DB-owned original title and description to app_moderation_v2.requests
ALTER TABLE app_moderation_v2.requests
  ADD COLUMN original_title text NOT NULL,
  ADD COLUMN original_description text,
  ADD CONSTRAINT ck_v2_requests_title_bytes
    CHECK (pg_catalog.octet_length(original_title) <= 2000),
  ADD CONSTRAINT ck_v2_requests_description_bytes
    CHECK (original_description IS NULL OR pg_catalog.octet_length(original_description) <= 50000);

COMMENT ON COLUMN app_moderation_v2.requests.original_title IS
  'DB-owned immutable original listing title snapshot at V2 request creation';
COMMENT ON COLUMN app_moderation_v2.requests.original_description IS
  'DB-owned immutable original listing description snapshot (nullable) at V2 request creation';

-- Authoritative input binding & immutability guard trigger:
-- On INSERT: verifies listing exists, listing_revision matches locked listing,
-- and original_title/original_description match the locked listing row exactly.
-- On UPDATE: guards request association, scalar identity and original text against modification.
CREATE OR REPLACE FUNCTION app_moderation_v2.enforce_request_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_listing record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Verify and bind against the locked authoritative listing row
    SELECT title, description, revision
    INTO v_listing
    FROM public.listings
    WHERE id = NEW.listing_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced listing does not exist'
        USING ERRCODE = '23503'; -- foreign_key_violation
    END IF;

    IF NEW.listing_revision <> v_listing.revision THEN
      RAISE EXCEPTION 'Stale listing revision: request revision % does not match listing revision %',
        NEW.listing_revision, v_listing.revision
        USING ERRCODE = '23514'; -- check_violation
    END IF;

    IF NEW.original_title <> v_listing.title THEN
      RAISE EXCEPTION 'Request original_title does not match authoritative listing title'
        USING ERRCODE = '23514'; -- check_violation
    END IF;

    IF NEW.original_description IS DISTINCT FROM v_listing.description THEN
      RAISE EXCEPTION 'Request original_description does not match authoritative listing description'
        USING ERRCODE = '23514'; -- check_violation
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id
       OR NEW.listing_id <> OLD.listing_id
       OR NEW.listing_revision <> OLD.listing_revision
       OR NEW.generation_id <> OLD.generation_id
       OR NEW.protocol_version <> OLD.protocol_version
       OR NEW.policy_version <> OLD.policy_version
       OR NEW.request_lane <> OLD.request_lane
       OR NEW.original_title <> OLD.original_title
       OR NEW.original_description IS DISTINCT FROM OLD.original_description
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'app_moderation_v2.requests immutable fields cannot be modified'
        USING ERRCODE = '23514'; -- check_violation
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_moderation_v2.enforce_request_immutability()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_moderation_v2.enforce_request_immutability()
  TO service_role;

CREATE TRIGGER trg_v2_requests_immutable_fields
BEFORE INSERT OR UPDATE ON app_moderation_v2.requests
FOR EACH ROW
EXECUTE FUNCTION app_moderation_v2.enforce_request_immutability();

-- 2. Pure SQL Unicode / UTF-16 helpers matching ECMAScript String.prototype.trim() and .length

-- Trims ECMAScript whitespace: ASCII (\t\n\v\f\r space) + Unicode (\u00A0 \u1680 \u2000-\u200A \u2028 \u2029 \u202F \u205F \u3000 \uFEFF)
CREATE OR REPLACE FUNCTION app_moderation_v2.js_trim(val text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(
      val,
      E'^[\\x09\\x0A\\x0B\\x0C\\x0D\\x20\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+',
      '',
      'g'
    ),
    E'[\\x09\\x0A\\x0B\\x0C\\x0D\\x20\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+$',
    '',
    'g'
  );
$$;

-- Calculates JavaScript UTF-16 code units length: codepoints in [U+10000..U+10FFFF] count as 2 UTF-16 code units
CREATE OR REPLACE FUNCTION app_moderation_v2.js_utf16_length(val text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.length(val) + pg_catalog.regexp_count(val, E'[\\U00010000-\\U0010FFFF]');
$$;

-- Computes SHA-256 hex digest over exact unmodified UTF-8 bytes
CREATE OR REPLACE FUNCTION app_moderation_v2.sha256_exact_utf8(val text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(val, 'UTF8')), 'hex');
$$;

-- Validates a single scalar text field against JSON input or raw scalar
CREATE OR REPLACE FUNCTION app_moderation_v2.validate_text_field(
  field_name text,
  field_value jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_raw text;
  v_trimmed text;
  v_len integer;
  v_min integer;
  v_max integer;
  v_sha text;
  v_error jsonb := NULL;
BEGIN
  IF field_name = 'title' THEN
    v_min := 3;
    v_max := 150;
  ELSIF field_name = 'description' THEN
    v_min := 10;
    v_max := 5000;
  ELSE
    RAISE EXCEPTION 'Unknown field name: %', field_name;
  END IF;

  -- 1. TYPE check before length: must be a JSON string scalar
  IF field_value IS NULL OR pg_catalog.jsonb_typeof(field_value) <> 'string' THEN
    RETURN pg_catalog.jsonb_build_object(
      'sha256', NULL,
      'error', pg_catalog.jsonb_build_object('field', field_name, 'code', 'TYPE')
    );
  END IF;

  v_raw := field_value #>> '{}';
  v_sha := app_moderation_v2.sha256_exact_utf8(v_raw);

  v_trimmed := app_moderation_v2.js_trim(v_raw);
  v_len := app_moderation_v2.js_utf16_length(v_trimmed);

  IF v_len < v_min THEN
    v_error := pg_catalog.jsonb_build_object('field', field_name, 'code', 'TOO_SHORT');
  ELSIF v_len > v_max THEN
    v_error := pg_catalog.jsonb_build_object('field', field_name, 'code', 'TOO_LONG');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'sha256', v_sha,
    'error', v_error
  );
END;
$$;

-- Primary deterministic text validator matching validateV2TextFields
CREATE OR REPLACE FUNCTION app_moderation_v2.validate_v2_text_fields(
  title_val jsonb,
  desc_val jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_title_res jsonb;
  v_desc_res jsonb;
  v_errors jsonb := '[]'::jsonb;
BEGIN
  v_title_res := app_moderation_v2.validate_text_field('title', title_val);
  v_desc_res := app_moderation_v2.validate_text_field('description', desc_val);

  IF pg_catalog.jsonb_typeof(v_title_res->'error') = 'object' THEN
    v_errors := v_errors || pg_catalog.jsonb_build_array(v_title_res->'error');
  END IF;

  IF pg_catalog.jsonb_typeof(v_desc_res->'error') = 'object' THEN
    v_errors := v_errors || pg_catalog.jsonb_build_array(v_desc_res->'error');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN pg_catalog.jsonb_array_length(v_errors) = 0 THEN 'valid' ELSE 'invalid' END,
    'title_sha256', v_title_res->'sha256',
    'description_sha256', v_desc_res->'sha256',
    'validation_errors', v_errors
  );
END;
$$;

-- Overload for direct text scalars (as stored authoritatively in DB)
CREATE OR REPLACE FUNCTION app_moderation_v2.validate_v2_stored_text(
  p_title text,
  p_description text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT app_moderation_v2.validate_v2_text_fields(
    CASE WHEN p_title IS NULL THEN 'null'::jsonb ELSE pg_catalog.to_jsonb(p_title) END,
    CASE WHEN p_description IS NULL THEN 'null'::jsonb ELSE pg_catalog.to_jsonb(p_description) END
  );
$$;

-- Revoke all execute permissions from PUBLIC, anon, and authenticated
REVOKE ALL ON FUNCTION app_moderation_v2.js_trim(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_moderation_v2.js_utf16_length(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_moderation_v2.sha256_exact_utf8(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_moderation_v2.validate_text_field(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_moderation_v2.validate_v2_text_fields(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_moderation_v2.validate_v2_stored_text(text, text) FROM PUBLIC, anon, authenticated;

-- Explicitly grant execute only to service_role
GRANT EXECUTE ON FUNCTION app_moderation_v2.js_trim(text) TO service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.js_utf16_length(text) TO service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.sha256_exact_utf8(text) TO service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.validate_text_field(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.validate_v2_text_fields(jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.validate_v2_stored_text(text, text) TO service_role;
