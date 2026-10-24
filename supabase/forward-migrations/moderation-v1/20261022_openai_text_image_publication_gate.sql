BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Private, append-only OpenAI-clean evidence. No anonymous/client access.
CREATE TABLE IF NOT EXISTS app_security.moderation_openai_clear_evidence (
  request_id uuid PRIMARY KEY REFERENCES public.listing_moderation_requests(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_revision integer NOT NULL,
  generation_id uuid NOT NULL,
  claim_token uuid NOT NULL,
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  media_manifest jsonb NOT NULL,
  media_digests jsonb NOT NULL,
  provider_policy text NOT NULL DEFAULT 'openai_moderation_marketplace_v1',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE app_security.moderation_openai_clear_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security.moderation_openai_clear_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_security.moderation_openai_clear_evidence FROM PUBLIC, anon, authenticated, service_role;

-- Preserve each environment's exact previous finalizer for a reviewed rollback.
CREATE TABLE IF NOT EXISTS app_security.moderation_ai_gate_release_backup (
  release_name text PRIMARY KEY,
  prior_finalizer_ddl text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE app_security.moderation_ai_gate_release_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security.moderation_ai_gate_release_backup FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_security.moderation_ai_gate_release_backup FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_security.impl_moderation_current_media_manifest(p_listing_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $body$
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',m.id,'medium',m.medium_storage_path,'original',m.original_storage_path,
    'thumb',m.thumbnail_storage_path,'large',m.large_storage_path,
    'order',m.display_order,'processing_status',m.processing_status::text,
    'created_at',m.created_at,'bytes',m.file_size_bytes,'mime',m.content_type
  ) ORDER BY m.display_order,m.id),'[]'::jsonb)
  FROM public.listing_media m WHERE m.listing_id=p_listing_id;
$body$;
REVOKE ALL ON FUNCTION app_security.impl_moderation_current_media_manifest(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Called only through the service_role-only public RPC after ALL OpenAI checks.
CREATE OR REPLACE FUNCTION app_security.impl_record_listing_openai_clear_evidence(
  p_request_id uuid,p_claim_token uuid,p_media_digests jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE
  v_listing_id uuid;
  v_listing public.listings%ROWTYPE;
  v_req public.listing_moderation_requests%ROWTYPE;
  v_manifest jsonb;
  v_image_count integer;
  v_digest_count integer;
  v_distinct integer;
  v_text_hash text;
  v_existing app_security.moderation_openai_clear_evidence%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_claim_token IS NULL
    OR pg_catalog.jsonb_typeof(p_media_digests) IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','INVALID_EVIDENCE');
  END IF;
  v_digest_count:=pg_catalog.jsonb_array_length(p_media_digests);
  IF v_digest_count NOT BETWEEN 1 AND 8 THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','MEDIA_COUNT_INVALID');
  END IF;
  SELECT r.listing_id INTO v_listing_id FROM public.listing_moderation_requests r WHERE r.id=p_request_id;
  IF v_listing_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','REQUEST_NOT_FOUND');
  END IF;
  -- Lock order must match authoritative finalizer.
  SELECT * INTO v_listing FROM public.listings WHERE id=v_listing_id FOR UPDATE;
  SELECT * INTO v_req FROM public.listing_moderation_requests WHERE id=p_request_id FOR UPDATE;
  IF v_listing.id IS NULL OR v_req.id IS NULL
    OR v_req.listing_id IS DISTINCT FROM v_listing.id
    OR v_req.status::text IS DISTINCT FROM 'claimed'
    OR v_req.claim_token IS DISTINCT FROM p_claim_token
    OR v_req.claim_expires_at IS NULL
    OR v_req.claim_expires_at<=pg_catalog.clock_timestamp()
    OR v_listing.status::text IS DISTINCT FROM 'pending_review'
    OR v_listing.revision IS DISTINCT FROM v_req.listing_revision
    OR v_listing.title IS DISTINCT FROM v_req.evaluated_title
    OR v_listing.description IS DISTINCT FROM v_req.evaluated_description THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','STALE_OR_UNCLAIMED_REQUEST');
  END IF;
  PERFORM 1 FROM public.listing_media m WHERE m.listing_id=v_listing.id FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_image_count FROM public.listing_media m WHERE m.listing_id=v_listing.id;
  IF v_image_count IS DISTINCT FROM v_digest_count THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','MEDIA_COUNT_MISMATCH');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.listing_media m WHERE m.listing_id=v_listing.id
      AND (m.processing_status::text IS DISTINCT FROM 'ready'
        OR m.medium_storage_path IS DISTINCT FROM v_listing.id::text||'/'||m.id::text||'/medium.webp')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','MEDIA_NOT_READY_OR_INVALID');
  END IF;
  SELECT pg_catalog.count(DISTINCT item->>'id') INTO v_distinct
    FROM pg_catalog.jsonb_array_elements(p_media_digests) AS item;
  IF v_distinct IS DISTINCT FROM v_image_count
    OR EXISTS (
      SELECT 1 FROM public.listing_media m WHERE m.listing_id=v_listing.id
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(p_media_digests) AS item
          WHERE item->>'id'=m.id::text
            AND item->>'medium_storage_path'=m.medium_storage_path
            AND item->>'sha256' ~ '^[0-9a-f]{64}$'
        )
    ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','DIGEST_MANIFEST_MISMATCH');
  END IF;
  v_manifest:=app_security.impl_moderation_current_media_manifest(v_listing.id);
  v_text_hash:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(v_listing.title,v_listing.description)::text,'UTF8'),'sha256'),'hex');
  INSERT INTO app_security.moderation_openai_clear_evidence(
    request_id,listing_id,listing_revision,generation_id,claim_token,
    text_sha256,media_manifest,media_digests
  ) VALUES (
    v_req.id,v_listing.id,v_listing.revision,v_req.generation_id,
    v_req.claim_token,v_text_hash,v_manifest,p_media_digests
  ) ON CONFLICT (request_id) DO NOTHING;
  SELECT * INTO v_existing FROM app_security.moderation_openai_clear_evidence
    WHERE request_id=p_request_id;
  IF v_existing.request_id IS NULL
    OR v_existing.claim_token IS DISTINCT FROM p_claim_token
    OR v_existing.generation_id IS DISTINCT FROM v_req.generation_id
    OR v_existing.listing_revision IS DISTINCT FROM v_listing.revision
    OR v_existing.text_sha256 IS DISTINCT FROM v_text_hash
    OR v_existing.media_manifest IS DISTINCT FROM v_manifest
    OR v_existing.media_digests IS DISTINCT FROM p_media_digests THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'error','EVIDENCE_ALREADY_EXISTS_DIFFERENT');
  END IF;
  RETURN pg_catalog.jsonb_build_object('success',true,'image_count',v_image_count);
END;
$body$;
REVOKE ALL ON FUNCTION app_security.impl_record_listing_openai_clear_evidence(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_record_listing_openai_clear_evidence(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_listing_openai_clear_evidence(
  p_request_id uuid,p_claim_token uuid,p_media_digests jsonb
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=''
AS $body$
  SELECT app_security.impl_record_listing_openai_clear_evidence(p_request_id,p_claim_token,p_media_digests);
$body$;
REVOKE ALL ON FUNCTION public.record_listing_openai_clear_evidence(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_listing_openai_clear_evidence(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION app_security.impl_has_current_openai_clear_evidence(
  p_request_id uuid,p_claim_token uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $body$
  SELECT EXISTS(
    SELECT 1 FROM app_security.moderation_openai_clear_evidence e
    JOIN public.listing_moderation_requests r ON r.id=e.request_id
    JOIN public.listings l ON l.id=e.listing_id
    WHERE e.request_id=p_request_id AND e.claim_token=p_claim_token
      AND r.id=p_request_id AND r.claim_token=p_claim_token
      AND r.status::text='claimed' AND l.status::text='pending_review'
      AND e.generation_id=r.generation_id
      AND e.listing_revision=r.listing_revision
      AND e.listing_revision=l.revision
      AND r.evaluated_title=l.title AND r.evaluated_description=l.description
      AND e.text_sha256=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(l.title,l.description)::text,'UTF8'),'sha256'),'hex')
      AND e.media_manifest=app_security.impl_moderation_current_media_manifest(l.id)
      AND pg_catalog.jsonb_array_length(e.media_digests)=(
        SELECT pg_catalog.count(*) FROM public.listing_media m WHERE m.listing_id=l.id)
      AND e.created_at>=pg_catalog.clock_timestamp()-INTERVAL '20 minutes'
  );
$body$;
REVOKE ALL ON FUNCTION app_security.impl_has_current_openai_clear_evidence(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Insert the SQL evidence requirement in the original finalizer. Test and
-- Production have DIFFERENT guarded function bodies, so patch each in place.
DO $body$
DECLARE
  v_def text;
  v_from constant text:='IF NOT v_automation_enabled THEN';
  v_to constant text:='IF NOT v_automation_enabled OR NOT app_security.impl_has_current_openai_clear_evidence(p_request_id, p_claim_token) THEN';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(p.oid) INTO v_def
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_security' AND p.proname='impl_finalize_moderation_result'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid)=
      'p_request_id uuid, p_claim_token uuid, p_outcome text, p_ruleset_version text, p_scope text, p_completed_rules text[], p_failed_rules text[], p_flags jsonb, p_errors jsonb';
  IF v_def IS NULL OR
    (pg_catalog.length(v_def)-pg_catalog.length(pg_catalog.replace(v_def,v_from,'')))<>pg_catalog.length(v_from) THEN
    RAISE EXCEPTION 'FINALIZER_PATCH_ANCHOR_INVALID';
  END IF;
  INSERT INTO app_security.moderation_ai_gate_release_backup(release_name,prior_finalizer_ddl)
    VALUES ('moderation_openai_evidence_gate_v1',v_def) ON CONFLICT (release_name) DO NOTHING;
  v_def:=pg_catalog.replace(v_def,v_from,v_to);
  v_def:=pg_catalog.replace(v_def,
    '''AUTOMATION_DISABLED_ROUTED_TO_ADMIN''',
    '''AUTOMATION_DISABLED_OR_OPENAI_EVIDENCE_MISSING''');
  EXECUTE v_def;
END;
$body$;
COMMIT;
