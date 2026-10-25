-- Shared public-text validation (display name, bio) + avatar_path column.
-- Validation runs only when the value is inserted or changes, so legacy rows never
-- block unrelated updates. No bulk rewrite of existing data.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_path text;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS chk_profiles_avatar_path;
-- Column is NULL for every existing row; NOT VALID skips the scan but still applies to new writes.
ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_avatar_path
  CHECK (avatar_path IS NULL OR avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8,64}\.webp$') NOT VALID;

-- avatar_url / avatar_path become server-written only (service-role RPCs).
REVOKE UPDATE (avatar_url) ON TABLE public.profiles FROM authenticated;
REVOKE UPDATE (avatar_path) ON TABLE public.profiles FROM authenticated;

CREATE OR REPLACE FUNCTION app_security.normalize_public_text(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.translate(
      pg_catalog.regexp_replace(
        pg_catalog.normalize(COALESCE(p_text, ''), NFKC),
        '[​-‏‪-‮⁠-⁤﻿­]', '', 'g'),
      '०१२३४५६७८९', '0123456789')),
    '\s+', ' ', 'g'))
$$;

-- Returns NULL when valid, otherwise a reason code:
-- LENGTH | CONTROL_CHARS | CONTACT_INFO | PHONE_NUMBER | LINK | PAYMENT_INSTRUCTION | IMPERSONATION
CREATE OR REPLACE FUNCTION app_security.validate_public_text(p_text text, p_kind text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_trim text := pg_catalog.btrim(COALESCE(p_text, ''));
  v text;
  v_words text;
  v_compact text;
BEGIN
  IF p_kind NOT IN ('display_name', 'bio') THEN
    RAISE EXCEPTION 'unknown text kind';
  END IF;
  IF p_kind = 'display_name' AND pg_catalog.char_length(v_trim) NOT BETWEEN 2 AND 50 THEN
    RETURN 'LENGTH';
  END IF;
  IF p_kind = 'bio' AND pg_catalog.char_length(v_trim) > 500 THEN
    RETURN 'LENGTH';
  END IF;
  IF v_trim ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RETURN 'CONTROL_CHARS';
  END IF;

  v := app_security.normalize_public_text(v_trim);

  IF v ~ '@' OR v ~ '[\(\[\{]\s*at\s*[\)\]\}]' THEN
    RETURN 'CONTACT_INFO';
  END IF;
  IF v ~ '(?:\d[\s\-\.\(\)\+_/]*){8,}' THEN
    RETURN 'PHONE_NUMBER';
  END IF;
  IF v ~ '(https?:|ftp:|www\.)'
     OR v ~ '\.(com|in|org|net|co|io|me|ly|link|xyz|app|site|online|info|biz|page|store|shop|top|club)(\M|$)'
     OR v ~ '\s*[\(\[]?\s*dot\s*[\)\]]?\s*(com|in|org|net|co|io)(\M|$)'
     OR v ~ '(\mt\.me|\mwa\.me|bit\.ly|tinyurl|wa\.link)' THEN
    RETURN 'LINK';
  END IF;
  IF v ~ '(^|[^a-z])(upi|paytm|phonepe|phone pe|gpay|google pay|bhim|ifsc|neft|imps|rtgs|bank account|account number|advance payment|pay advance|send money|western union)([^a-z]|$)' THEN
    RETURN 'PAYMENT_INSTRUCTION';
  END IF;

  -- Impersonation: leet-speak folded, then token and compacted checks.
  v_words := pg_catalog.regexp_replace(
    pg_catalog.translate(v, '013457$!|', 'oleastsil'),
    '[^a-zऀ-ॿ]+', ' ', 'g');
  v_words := ' ' || pg_catalog.btrim(v_words) || ' ';
  v_compact := pg_catalog.replace(v_words, ' ', '');

  IF p_kind = 'display_name' THEN
    IF v_compact ~ 'fairswap' OR v_compact ~ 'customercare' THEN
      RETURN 'IMPERSONATION';
    END IF;
    IF v_words ~ ' (official|officials|support|helpdesk|helpline|admin|administrator|moderator|staff|verified|army|officer|major|colonel|brigadier|havildar|subedar|jawan|crpf|cisf|bsf|itbp|police|cbi|सेना|फौजी|मेजर|कर्नल|आधिकारिक|सपोर्ट) ' THEN
      RETURN 'IMPERSONATION';
    END IF;
  ELSE
    IF v_compact ~ 'fairswap(support|official|team|staff|admin|care|helpdesk)'
       OR v_compact ~ '(support|official|team|staff|admin)fairswap' THEN
      RETURN 'IMPERSONATION';
    END IF;
    IF v_words ~ ' (army|military|crpf|cisf|bsf|itbp|jawan|havildar|subedar|colonel|brigadier|सेना|फौजी) ' THEN
      RETURN 'IMPERSONATION';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_security.normalize_public_text(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_public_text(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.normalize_public_text(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_security.validate_public_text(text, text) TO authenticated, service_role;

-- Enforce on write only when the value is new or changed.
CREATE OR REPLACE FUNCTION public.enforce_profile_public_text()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_reason text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.display_name IS DISTINCT FROM OLD.display_name THEN
    v_reason := app_security.validate_public_text(NEW.display_name, 'display_name');
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_DISPLAY_NAME:%', v_reason USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NEW.bio IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.bio IS DISTINCT FROM OLD.bio) THEN
    v_reason := app_security.validate_public_text(NEW.bio, 'bio');
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_BIO:%', v_reason USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_public_text ON public.profiles;
CREATE TRIGGER trg_profiles_public_text
BEFORE INSERT OR UPDATE OF display_name, bio ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_public_text();

-- Trigger function: not callable by client roles (EXECUTE is checked only at CREATE TRIGGER).
REVOKE ALL ON FUNCTION public.enforce_profile_public_text() FROM PUBLIC, anon, authenticated;

-- Non-destructive remediation aid: lists legacy profiles that would fail validation.
-- Administrator (AAL2) only. Returns ids + reason codes, never rewrites data.
CREATE OR REPLACE FUNCTION app_security.impl_list_profile_text_violations(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator with AAL2';
  END IF;
  RETURN COALESCE((
    SELECT pg_catalog.jsonb_agg(r) FROM (
      SELECT p.id AS profile_id,
             app_security.validate_public_text(p.display_name, 'display_name') AS display_name_reason,
             CASE WHEN p.bio IS NULL THEN NULL ELSE app_security.validate_public_text(p.bio, 'bio') END AS bio_reason
      FROM public.profiles p
      WHERE app_security.validate_public_text(p.display_name, 'display_name') IS NOT NULL
         OR (p.bio IS NOT NULL AND app_security.validate_public_text(p.bio, 'bio') IS NOT NULL)
      ORDER BY p.created_at
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
    ) r
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_list_profile_text_violations(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_list_profile_text_violations(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_list_profile_text_violations(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_list_profile_text_violations(p_limit) $$;
REVOKE ALL ON FUNCTION public.admin_list_profile_text_violations(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_profile_text_violations(integer) TO authenticated, service_role;

commit;
