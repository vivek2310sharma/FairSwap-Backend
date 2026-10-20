-- FairSwapTest ONLY: CTO-authorized forward-only Point 3 correction.
-- CLI 2.117.0 generated version; no fixtures, historical reapplication or activation.
-- Tested candidate SHA256 f38a365aba3674133f05681912296bf068499736146231c7e6d6a6ec3be5ee93
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(3020261019);
DO $$ BEGIN
 IF current_database()<>'postgres' OR session_user<>'postgres'
 OR (SELECT count(*) FROM supabase_migrations.schema_migrations)<>69
 OR to_regnamespace('modv2_private') IS NOT NULL
 OR (SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_v2_enabled') IS DISTINCT FROM 'false'
 OR (SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_v2_mode') IS DISTINCT FROM 'disabled'
 THEN RAISE EXCEPTION 'Reviewed Test baseline required';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.listings'::regclass AND attname='search_vector' AND attgenerated='s' AND NOT attisdropped) THEN RAISE EXCEPTION 'Pinned generated listing vector required';END IF;
END $$;
CREATE ROLE mv2_p3_register NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_retire NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_guard NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_edit NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_registrar NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_retirement NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_media_editor NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT mv2_p3_register,mv2_p3_retire,mv2_p3_guard,mv2_p3_edit,mv2_p3_registrar,mv2_p3_retirement,mv2_p3_media_editor TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA app_moderation_v2,public,app_security TO mv2_p3_register,mv2_p3_retire,mv2_p3_guard,mv2_p3_edit;
GRANT USAGE ON SCHEMA app_moderation_v2 TO mv2_p3_registrar,mv2_p3_retirement,mv2_p3_media_editor;
REVOKE USAGE ON SCHEMA app_moderation_v2 FROM PUBLIC,anon,authenticated;
-- Only for ownership transfer, revoked at end. No application CREATE authority.
GRANT CREATE ON SCHEMA app_moderation_v2 TO mv2_p3_registry_owner,mv2_p3_guard,mv2_p3_register,mv2_p3_retire,mv2_p3_edit;
CREATE TABLE app_moderation_v2.p3_invalidation_permits(
 transaction_id xid8 NOT NULL,backend_pid integer NOT NULL,listing_id uuid NOT NULL,
 expected_revision integer NOT NULL,remaining integer NOT NULL CHECK(remaining BETWEEN 0 AND 1),
 issued_by name NOT NULL,issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(transaction_id,backend_pid,listing_id));
ALTER TABLE app_moderation_v2.p3_invalidation_permits OWNER TO mv2_p3_registry_owner;
ALTER TABLE app_moderation_v2.p3_invalidation_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_moderation_v2.p3_invalidation_permits FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app_moderation_v2.seal_bundles,app_moderation_v2.seal_objects,app_moderation_v2.seal_media_bindings,app_moderation_v2.seal_retirements,app_moderation_v2.p3_invalidation_permits TO mv2_p3_guard,mv2_p3_register,mv2_p3_retire,mv2_p3_edit;
GRANT INSERT ON app_moderation_v2.seal_bundles,app_moderation_v2.seal_objects,app_moderation_v2.seal_media_bindings TO mv2_p3_register;
GRANT INSERT ON app_moderation_v2.seal_retirements TO mv2_p3_retire;
GRANT INSERT,DELETE ON app_moderation_v2.p3_invalidation_permits TO mv2_p3_edit;
GRANT UPDATE(remaining) ON app_moderation_v2.p3_invalidation_permits TO mv2_p3_guard;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['seal_bundles','seal_objects','seal_media_bindings','seal_retirements','p3_invalidation_permits'] LOOP
  EXECUTE format('CREATE POLICY p3_trusted_read ON app_moderation_v2.%I FOR SELECT TO mv2_p3_guard,mv2_p3_register,mv2_p3_retire,mv2_p3_edit USING(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['seal_bundles','seal_objects','seal_media_bindings'] LOOP
  EXECUTE format('CREATE POLICY p3_register_insert ON app_moderation_v2.%I FOR INSERT TO mv2_p3_register WITH CHECK(true)',t);
 END LOOP;
END $$;
CREATE POLICY p3_retire_insert ON app_moderation_v2.seal_retirements FOR INSERT TO mv2_p3_retire WITH CHECK(true);
CREATE POLICY p3_permit_edit ON app_moderation_v2.p3_invalidation_permits TO mv2_p3_edit USING(true) WITH CHECK(true);
CREATE POLICY p3_permit_consume ON app_moderation_v2.p3_invalidation_permits FOR UPDATE TO mv2_p3_guard USING(true) WITH CHECK(remaining=0);
GRANT SELECT ON public.listings,public.listing_media TO mv2_p3_guard,mv2_p3_register,mv2_p3_retire,mv2_p3_edit;
-- Row locks need UPDATE privilege; no-op only via reviewed functions and row guard.
GRANT UPDATE(id) ON public.listings,public.listing_media TO mv2_p3_register,mv2_p3_retire;
GRANT UPDATE ON public.listings TO mv2_p3_edit;
GRANT UPDATE(display_order),DELETE ON public.listing_media TO mv2_p3_edit;
GRANT SELECT ON app_moderation_v2.policy_registry TO mv2_p3_register;
GRANT SELECT ON app_moderation_v2.requests TO mv2_p3_register;
CREATE POLICY p3_registration_request_read ON app_moderation_v2.requests FOR SELECT TO mv2_p3_register USING(true);
GRANT SELECT,UPDATE ON app_moderation_v2.requests TO mv2_p3_retire,mv2_p3_edit;
CREATE POLICY p3_request_invalidation ON app_moderation_v2.requests TO mv2_p3_retire,mv2_p3_edit USING(true) WITH CHECK(true);
GRANT SELECT ON app_moderation_v2.requests TO mv2_p3_guard;
CREATE POLICY p3_request_guard_read ON app_moderation_v2.requests FOR SELECT TO mv2_p3_guard USING(true);
CREATE POLICY p3_policy_read ON app_moderation_v2.policy_registry FOR SELECT TO mv2_p3_register USING(true);
CREATE POLICY p3_listing_internal ON public.listings TO mv2_p3_register,mv2_p3_retire,mv2_p3_edit USING(true) WITH CHECK(true);
CREATE POLICY p3_media_internal ON public.listing_media TO mv2_p3_register,mv2_p3_retire,mv2_p3_edit USING(true) WITH CHECK(true);

-- Private lookup: no application EXECUTE or schema USAGE is required.
CREATE FUNCTION app_moderation_v2.p3_protected(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM app_moderation_v2.seal_bundles WHERE listing_id=p)
 OR EXISTS(SELECT 1 FROM app_moderation_v2.requests WHERE listing_id=p AND request_lane='enforce') $$;
ALTER FUNCTION app_moderation_v2.p3_protected(uuid) OWNER TO mv2_p3_guard;
CREATE FUNCTION app_moderation_v2.p3_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
 BEGIN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Permanent sealed identity';END $$;
ALTER FUNCTION app_moderation_v2.p3_append_only() OWNER TO mv2_p3_guard;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['seal_bundles','seal_objects','seal_media_bindings','seal_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER p3_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON app_moderation_v2.%I FOR EACH STATEMENT EXECUTE FUNCTION app_moderation_v2.p3_append_only()',t);
END LOOP;END $$;
-- Database-owned actor handoff, NOT a caller identity parameter or media permit.
-- Only non-login trusted owners can INSERT; the invoker trigger records actual
-- current_user before the enforcing trigger changes its effective identity.
CREATE TABLE app_moderation_v2.p3_actor_context(
 transaction_id xid8 NOT NULL,backend_pid integer NOT NULL,relation_id oid NOT NULL,
 operation text NOT NULL CHECK(operation IN('INSERT','UPDATE','DELETE')),
 old_sha256 text NOT NULL,new_sha256 text NOT NULL,actor name NOT NULL,
 PRIMARY KEY(transaction_id,backend_pid,relation_id,operation,old_sha256,new_sha256));
ALTER TABLE app_moderation_v2.p3_actor_context OWNER TO mv2_p3_registry_owner;
ALTER TABLE app_moderation_v2.p3_actor_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_moderation_v2.p3_actor_context FROM PUBLIC,anon,authenticated,service_role;
GRANT INSERT ON app_moderation_v2.p3_actor_context TO postgres,mv2_p3_register,mv2_p3_retire,mv2_p3_edit;
GRANT SELECT,DELETE ON app_moderation_v2.p3_actor_context TO mv2_p3_guard;
CREATE POLICY p3_actor_insert ON app_moderation_v2.p3_actor_context FOR INSERT TO mv2_p3_register,mv2_p3_retire,mv2_p3_edit WITH CHECK(actor=current_user);
CREATE POLICY p3_actor_consume ON app_moderation_v2.p3_actor_context TO mv2_p3_guard USING(true) WITH CHECK(false);
CREATE FUNCTION app_moderation_v2.p3_capture_actor() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF current_user IN('postgres','mv2_p3_register','mv2_p3_retire','mv2_p3_edit','mv2_p3_text','mv2_p3_lease','mv2_p3_finalize') THEN
  INSERT INTO app_moderation_v2.p3_actor_context VALUES(pg_current_xact_id(),pg_backend_pid(),TG_RELID,TG_OP,encode(sha256(convert_to(coalesce(to_jsonb(OLD)::text,'null'),'UTF8')),'hex'),encode(sha256(convert_to(coalesce(to_jsonb(NEW)::text,'null'),'UTF8')),'hex'),current_user);
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
ALTER FUNCTION app_moderation_v2.p3_capture_actor() OWNER TO mv2_p3_guard;
REVOKE ALL ON FUNCTION app_moderation_v2.p3_capture_actor() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app_moderation_v2.p3_take_actor(rel oid,op text,old_row jsonb,new_row jsonb) RETURNS name LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result name;BEGIN
 DELETE FROM app_moderation_v2.p3_actor_context WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND relation_id=rel AND operation=op AND old_sha256=encode(sha256(convert_to(coalesce(old_row::text,'null'),'UTF8')),'hex') AND new_sha256=encode(sha256(convert_to(coalesce(new_row::text,'null'),'UTF8')),'hex') RETURNING actor INTO result;
 RETURN result;
END $$;
ALTER FUNCTION app_moderation_v2.p3_take_actor(oid,text,jsonb,jsonb) OWNER TO mv2_p3_guard;
REVOKE ALL ON FUNCTION app_moderation_v2.p3_take_actor(oid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Pure read-only identity adapter. It does not authorize a trusted operation.
CREATE FUNCTION app_moderation_v2.p3_actor_uid() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN app_security.get_account_status(auth.uid())='active' AND app_security.has_current_policy_acceptance(auth.uid()) THEN auth.uid() END $$;
REVOKE ALL ON FUNCTION app_moderation_v2.p3_actor_uid() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_actor_uid() TO mv2_p3_edit;

CREATE FUNCTION app_moderation_v2.p3_consume_invalidation(old_row jsonb,new_row jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE permit app_moderation_v2.p3_invalidation_permits;used integer;BEGIN
 SELECT * INTO permit FROM app_moderation_v2.p3_invalidation_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND listing_id=(old_row->>'id')::uuid AND issued_by=session_user AND remaining=1 FOR UPDATE;
 IF NOT FOUND OR old_row->>'revision' IS NULL OR new_row->>'revision' IS NULL OR old_row->>'status' IS NULL OR (old_row->>'revision')::integer<>permit.expected_revision OR (new_row->>'revision')::integer<>permit.expected_revision+1 OR new_row->>'status' IS DISTINCT FROM 'pending_review' OR old_row->>'status' NOT IN ('pending_review','active','reserved','paused') THEN RETURN false;END IF;
 IF (old_row-ARRAY['revision','status','updated_at','submitted_at']) IS DISTINCT FROM (new_row-ARRAY['revision','status','updated_at','submitted_at']) THEN RETURN false;END IF;
 IF old_row->>'status'='pending_review' AND old_row->'submitted_at' IS DISTINCT FROM new_row->'submitted_at' THEN RETURN false;END IF;
 IF new_row->>'updated_at' IS NULL OR (new_row->>'updated_at')::timestamptz<permit.issued_at OR (new_row->>'updated_at')::timestamptz>clock_timestamp()+interval '1 second' THEN RETURN false;END IF;
 IF old_row->>'status'<>'pending_review' AND (new_row->>'submitted_at' IS NULL OR (new_row->>'submitted_at')::timestamptz<permit.issued_at OR (new_row->>'submitted_at')::timestamptz>clock_timestamp()+interval '1 second') THEN RETURN false;END IF;
 UPDATE app_moderation_v2.p3_invalidation_permits SET remaining=0 WHERE transaction_id=permit.transaction_id AND backend_pid=permit.backend_pid AND listing_id=permit.listing_id AND remaining=1 RETURNING 1 INTO used;RETURN used=1;
END $$;
ALTER FUNCTION app_moderation_v2.p3_consume_invalidation(jsonb,jsonb) OWNER TO mv2_p3_guard;
CREATE FUNCTION app_moderation_v2.p3_row_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor name;a uuid;b uuid;old_doc jsonb;new_doc jsonb;BEGIN
 IF TG_TABLE_NAME='listings' THEN a:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;b:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE a:=CASE WHEN TG_OP='INSERT' THEN NEW.listing_id ELSE OLD.listing_id END;b:=CASE WHEN TG_OP='DELETE' THEN OLD.listing_id ELSE NEW.listing_id END;END IF;
 old_doc:=to_jsonb(OLD);new_doc:=to_jsonb(NEW);
 actor:=app_moderation_v2.p3_take_actor(TG_RELID,TG_OP,old_doc,new_doc);
 IF TG_TABLE_NAME='listings' AND TG_OP='UPDATE' THEN
  -- Stored GENERATED fields are deferred during BEFORE triggers. Normalize only
  -- that engine NULL, only when its source text is unchanged. Raw consumer JSON
  -- still compares every field and cannot supply an arbitrary vector change.
  IF new_doc->'search_vector'='null'::jsonb AND NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.description IS NOT DISTINCT FROM OLD.description THEN new_doc:=jsonb_set(new_doc,'{search_vector}',old_doc->'search_vector');END IF;
 END IF;
 IF app_moderation_v2.p3_protected(a) OR app_moderation_v2.p3_protected(b) THEN
  IF actor='mv2_p3_finalize' AND TG_OP='UPDATE' AND a=b AND NEW.id=OLD.id THEN
   IF TG_TABLE_NAME='listing_media' THEN
    IF (to_jsonb(NEW)-ARRAY['original_storage_path','thumbnail_storage_path','medium_storage_path','large_storage_path','width','height'])=(to_jsonb(OLD)-ARRAY['original_storage_path','thumbnail_storage_path','medium_storage_path','large_storage_path','width','height']) THEN RETURN NEW;END IF;
   ELSIF TG_TABLE_NAME='listings' THEN
    IF OLD.status='pending_review' AND NEW.status='active' AND (new_doc-ARRAY['status','published_at','expires_at','rejection_reason','updated_at'])=(old_doc-ARRAY['status','published_at','expires_at','rejection_reason','updated_at']) THEN RETURN NEW;END IF;
   END IF;
  END IF;
  IF TG_TABLE_NAME='listings' THEN
   IF actor='mv2_p3_text' AND TG_OP='UPDATE' AND NEW.status='pending_review' AND NEW.revision=OLD.revision+1 AND (new_doc-ARRAY['title','description','status','revision','submitted_at','updated_at','search_vector'])=(old_doc-ARRAY['title','description','status','revision','submitted_at','updated_at','search_vector']) THEN RETURN NEW;END IF;
  END IF;
  -- Keep the restricted consumer in a separate expression: PostgreSQL checks
  -- function EXECUTE while initializing an expression, before AND short-circuit.
  IF TG_TABLE_NAME='listings' AND TG_OP='UPDATE' AND actor='postgres' THEN
   IF app_moderation_v2.p3_consume_invalidation(old_doc,new_doc) THEN RETURN NEW;END IF;
  END IF;
  IF actor IS DISTINCT FROM 'mv2_p3_edit' OR a IS DISTINCT FROM b OR TG_OP='INSERT' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Trusted registry transition required';END IF;
  IF TG_TABLE_NAME='listings' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Parent changes require exact internal invalidation';END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
ALTER FUNCTION app_moderation_v2.p3_row_guard() OWNER TO mv2_p3_guard;
CREATE TRIGGER zzzy_p3_capture_actor BEFORE INSERT OR UPDATE OR DELETE ON public.listings FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_capture_actor();
CREATE TRIGGER zzzz_p3_registry_guard BEFORE INSERT OR UPDATE OR DELETE ON public.listings FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_row_guard();
CREATE TRIGGER zzzy_p3_capture_actor BEFORE INSERT OR UPDATE OR DELETE ON public.listing_media FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_capture_actor();
CREATE TRIGGER zzzz_p3_registry_guard BEFORE INSERT OR UPDATE OR DELETE ON public.listing_media FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_row_guard();
-- V1 function bodies/triggers stay byte-identical. Exclusion applies only to registry-protected listings.
CREATE FUNCTION app_moderation_v2.p3_exclude_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
 BEGIN IF app_moderation_v2.p3_protected(NEW.listing_id) THEN RETURN NULL;END IF;RETURN NEW;END $$;
ALTER FUNCTION app_moderation_v2.p3_exclude_v1() OWNER TO mv2_p3_guard;
CREATE TRIGGER aaa_p3_exclude_v1 BEFORE INSERT ON public.listing_moderation_requests FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_exclude_v1();
REVOKE TRUNCATE,TRIGGER,REFERENCES,MAINTAIN ON public.listings,public.listing_media,public.listing_status_transitions FROM service_role,authenticated,anon;
CREATE FUNCTION app_moderation_v2.p3_request_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE lid uuid;actor name;BEGIN
 actor:=app_moderation_v2.p3_take_actor(TG_RELID,TG_OP,to_jsonb(OLD),to_jsonb(NEW));
 lid:=CASE WHEN TG_OP='DELETE' THEN OLD.listing_id ELSE NEW.listing_id END;
 -- Existing C2 owner functions retain their input-only authority. Ordinary DML
 -- cannot delete/reinsert a protected generation or reset its lifecycle.
 IF app_moderation_v2.p3_protected(lid) AND (actor IS NULL OR actor NOT IN ('postgres','mv2_p3_retire','mv2_p3_edit','mv2_p3_text','mv2_p3_lease','mv2_p3_finalize')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Protected C2 lifecycle';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
ALTER FUNCTION app_moderation_v2.p3_request_guard() OWNER TO mv2_p3_guard;
CREATE TRIGGER zzzy_p3_capture_actor BEFORE INSERT OR UPDATE OR DELETE ON app_moderation_v2.requests FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_capture_actor();
CREATE TRIGGER zzzz_p3_request_guard BEFORE INSERT OR UPDATE OR DELETE ON app_moderation_v2.requests FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_request_guard();
REVOKE TRUNCATE,TRIGGER,REFERENCES,MAINTAIN ON app_moderation_v2.requests FROM service_role,authenticated,anon;
REVOKE ALL ON FUNCTION app_moderation_v2.p3_request_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_moderation_v2.p3_register_bundle(p_listing uuid,p_media uuid,p_revision integer,p_asset uuid,p_source_sha256 text,p_objects jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings;m public.listing_media;o jsonb;v text;k text;b text;paths jsonb;payload jsonb;BEGIN
 SELECT * INTO STRICT l FROM public.listings WHERE id=p_listing FOR UPDATE;
 IF l.revision IS DISTINCT FROM p_revision OR l.status<>'pending_review' THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Registration revision conflict';END IF;
 IF EXISTS(SELECT 1 FROM app_moderation_v2.seal_retirements WHERE asset_version=p_asset) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Retired identity reserved';END IF;
 SELECT * INTO STRICT m FROM public.listing_media WHERE id=p_media AND listing_id=l.id FOR UPDATE;
 IF m.uploader_id<>l.seller_id OR m.processing_status<>'ready' OR p_asset IS NULL OR p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$' OR p_objects IS NULL OR jsonb_typeof(p_objects) IS DISTINCT FROM 'array' OR jsonb_array_length(p_objects)<>5 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid sealed bundle';END IF;
 paths:=jsonb_build_array(m.original_storage_path,m.thumbnail_storage_path,m.medium_storage_path,m.large_storage_path);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(paths) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete source paths required';END IF;
 IF EXISTS(SELECT 1 FROM app_moderation_v2.seal_bundles WHERE asset_version=p_asset) THEN
  SELECT jsonb_agg(jsonb_build_object('object_id',object_id,'variant',variant,'bucket',bucket,'logical_key',logical_key,'sha256',sha256,'bytes',bytes,'width',width,'height',height) ORDER BY variant) INTO payload FROM app_moderation_v2.seal_objects WHERE asset_version=p_asset;
  IF NOT EXISTS(SELECT 1 FROM app_moderation_v2.seal_bundles WHERE asset_version=p_asset AND listing_id=l.id AND media_id=m.id AND source_sha256=p_source_sha256 AND source_revision=p_revision AND source_paths=paths AND seller_id=l.seller_id AND policy_version='fairswap_moderation_v2.0.0') OR payload IS DISTINCT FROM (SELECT jsonb_agg(value ORDER BY value->>'variant') FROM jsonb_array_elements(p_objects)) THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Idempotency conflict';END IF;RETURN p_asset;
 END IF;
 -- No rebinding: reprocessing requires a new media identity and explicit retirement.
 IF EXISTS(SELECT 1 FROM app_moderation_v2.seal_media_bindings WHERE media_id=m.id) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Media identity reserved';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_moderation_v2.requests WHERE listing_id=l.id AND listing_revision=l.revision AND original_title=l.title AND original_description IS NOT DISTINCT FROM l.description AND request_lane='enforce' AND policy_version='fairswap_moderation_v2.0.0' AND phase='preparation' AND status='awaiting_media') THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Current C2 preparation identity required';END IF;
 INSERT INTO app_moderation_v2.seal_bundles(asset_version,listing_id,media_id,seller_id,policy_version,source_revision,source_sha256,source_paths) VALUES(p_asset,l.id,m.id,l.seller_id,'fairswap_moderation_v2.0.0',p_revision,p_source_sha256,paths);
 FOR o IN SELECT value FROM jsonb_array_elements(p_objects) LOOP
  IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(o))<>8 OR NOT(o ?& ARRAY['object_id','variant','bucket','logical_key','sha256','bytes','width','height']) OR EXISTS(SELECT 1 FROM unnest(ARRAY['object_id','variant','bucket','logical_key','sha256']) key WHERE jsonb_typeof(o->key) IS DISTINCT FROM 'string') OR jsonb_typeof(o->'bytes') IS DISTINCT FROM 'number' OR jsonb_typeof(o->'width') IS DISTINCT FROM 'number' OR jsonb_typeof(o->'height') IS DISTINCT FROM 'number' OR o->>'bytes' !~ '^[0-9]+$' OR o->>'width' !~ '^[0-9]+$' OR o->>'height' !~ '^[0-9]+$' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid object fields';END IF;
  v:=o->>'variant';b:=o->>'bucket';k:=o->>'logical_key';
  IF v NOT IN ('original','canonical','thumb','medium','large') OR b IS DISTINCT FROM (CASE WHEN v IN ('original','canonical') THEN 'listing-originals' ELSE 'listing-derivatives' END) OR o->>'sha256' !~ '^[0-9a-f]{64}$' OR k !~ ('^'||l.id||'/'||m.id||'/v2/'||p_asset||'/'||(o->>'sha256')||'/'||v||(CASE WHEN v='original' THEN '\.(jpg|png|webp)$' ELSE '\.webp$' END)) OR (v='original' AND o->>'sha256' IS DISTINCT FROM p_source_sha256) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Object identity binding';END IF;
  -- Raw upload and all ObjectIdentity variants currently share the 5 MiB cap.
  -- Raw dimensions remain independent of orientation-corrected canonical dimensions.
  IF (o->>'bytes')::numeric NOT BETWEEN 1 AND 5242880 OR (o->>'width')::numeric NOT BETWEEN 1 AND 8000 OR (o->>'height')::numeric NOT BETWEEN 1 AND 8000 OR (o->>'width')::numeric*(o->>'height')::numeric>64000000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Approved image bounds';END IF;
  INSERT INTO app_moderation_v2.seal_objects(object_id,asset_version,variant,bucket,logical_key,sha256,bytes,width,height) VALUES((o->>'object_id')::uuid,p_asset,v,b,k,o->>'sha256',(o->>'bytes')::bigint,(o->>'width')::integer,(o->>'height')::integer);
 END LOOP;
 INSERT INTO app_moderation_v2.seal_media_bindings(media_id,listing_id,asset_version) VALUES(m.id,l.id,p_asset);
 RETURN p_asset;
END $$;
ALTER FUNCTION app_moderation_v2.p3_register_bundle(uuid,uuid,integer,uuid,text,jsonb) OWNER TO mv2_p3_register;

CREATE FUNCTION app_moderation_v2.p3_retire_bundle(p_asset uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b app_moderation_v2.seal_bundles;l public.listings;BEGIN
 SELECT * INTO STRICT b FROM app_moderation_v2.seal_bundles WHERE asset_version=p_asset;
 SELECT * INTO STRICT l FROM public.listings WHERE id=b.listing_id FOR UPDATE;
 IF l.status<>'pending_review' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Visibility withdrawal requires separate reviewed capability';END IF;
 INSERT INTO app_moderation_v2.seal_retirements(asset_version,listing_id) VALUES(b.asset_version,b.listing_id) ON CONFLICT DO NOTHING;
 UPDATE app_moderation_v2.requests SET status='superseded',updated_at=clock_timestamp() WHERE listing_id=l.id AND status NOT IN ('completed','failed','superseded');
END $$;
ALTER FUNCTION app_moderation_v2.p3_retire_bundle(uuid) OWNER TO mv2_p3_retire;

CREATE FUNCTION app_moderation_v2.p3_edit_media(p_listing uuid,p_revision integer,p_media uuid,p_order integer DEFAULT NULL,p_cover boolean DEFAULT false,p_delete boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings;m public.listing_media;BEGIN
 IF session_user='postgres' OR NOT pg_has_role(session_user,'mv2_p3_media_editor','SET') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('mv2_p3_registrar','mv2_p3_retirement','mv2_p3_worker','mv2_p3_register','mv2_p3_retire','mv2_p3_guard','mv2_p3_edit','mv2_p3_text','mv2_p3_lease','mv2_p3_finalize','mv2_p3_registry_owner') AND pg_has_role(session_user,oid,'SET')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent media authority required';END IF;
 IF p_cover IS DISTINCT FROM false OR p_delete IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Cover capability not approved';END IF;
 IF app_moderation_v2.p3_actor_uid() IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Owner authorization required';END IF;
 SELECT * INTO STRICT l FROM public.listings WHERE id=p_listing FOR UPDATE;
 IF l.seller_id IS DISTINCT FROM app_moderation_v2.p3_actor_uid() OR NOT app_moderation_v2.p3_protected(l.id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Listing unavailable';END IF;
 IF l.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Revision conflict';END IF;
 IF l.status NOT IN ('pending_review','active','reserved','paused') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Invalidation unavailable';END IF;
 SELECT * INTO STRICT m FROM public.listing_media WHERE id=p_media AND listing_id=l.id FOR UPDATE;
 IF NOT p_delete AND (p_order IS NULL OR p_order=m.display_order OR p_order<0) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Changed nonnegative order required';END IF;
 IF p_delete AND p_order IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Ambiguous operation';END IF;
 IF p_delete AND l.cover_photo_id=m.id THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Cover deletion capability not approved';END IF;
 IF p_delete AND EXISTS(SELECT 1 FROM app_moderation_v2.seal_media_bindings b WHERE b.media_id=m.id AND NOT EXISTS(SELECT 1 FROM app_moderation_v2.seal_retirements WHERE asset_version=b.asset_version)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Retirement required';END IF;
 INSERT INTO app_moderation_v2.p3_invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid(),l.id,l.revision,1,session_user,clock_timestamp());
 IF p_delete THEN DELETE FROM public.listing_media WHERE id=m.id;ELSE UPDATE public.listing_media SET display_order=p_order WHERE id=m.id;END IF;
 IF NOT EXISTS(SELECT 1 FROM app_moderation_v2.p3_invalidation_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND listing_id=l.id AND remaining=0) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Historical invalidation did not consume permit';END IF;
 DELETE FROM app_moderation_v2.p3_invalidation_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND listing_id=l.id;
 UPDATE app_moderation_v2.requests SET status='superseded',updated_at=clock_timestamp() WHERE listing_id=l.id AND status NOT IN ('completed','failed','superseded');
 PERFORM app_moderation_v2.p3_requeue(l.id);
 RETURN jsonb_build_object('success',true);
END $$;
ALTER FUNCTION app_moderation_v2.p3_edit_media(uuid,integer,uuid,integer,boolean,boolean) OWNER TO mv2_p3_edit;

CREATE FUNCTION app_moderation_v2.p3_compact(p json) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
DECLARE r text;BEGIN CASE json_typeof(p) WHEN 'array' THEN SELECT '['||coalesce(string_agg(app_moderation_v2.p3_compact(value),',' ORDER BY ordinality),'')||']' INTO r FROM json_array_elements(p) WITH ORDINALITY;WHEN 'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Array canonicalization only';ELSE r:=p::text;END CASE;RETURN r;END $$;
ALTER FUNCTION app_moderation_v2.p3_compact(json) OWNER TO mv2_p3_guard;
CREATE FUNCTION app_moderation_v2.p3_manifest(p_listing uuid) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings;m record;a json;all_rows json[]:=ARRAY[]::json[];cnt integer:=0;v text;obj json[];BEGIN
 SELECT * INTO STRICT l FROM public.listings WHERE id=p_listing FOR UPDATE;
 FOR m IN SELECT x.*,b.asset_version,b.source_sha256,b.recipe,b.source_paths,b.seller_id AS bound_seller FROM public.listing_media x LEFT JOIN app_moderation_v2.seal_media_bindings s ON s.media_id=x.id AND s.listing_id=x.listing_id LEFT JOIN app_moderation_v2.seal_bundles b ON b.asset_version=s.asset_version AND b.media_id=x.id AND b.listing_id=x.listing_id WHERE x.listing_id=l.id ORDER BY x.display_order,x.id FOR UPDATE OF x LOOP
  cnt:=cnt+1;
  IF m.processing_status<>'ready' OR m.asset_version IS NULL OR m.bound_seller<>l.seller_id OR EXISTS(SELECT 1 FROM app_moderation_v2.seal_retirements WHERE asset_version=m.asset_version) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Incomplete or retired manifest';END IF;
  IF m.source_paths IS DISTINCT FROM jsonb_build_array(m.original_storage_path,m.thumbnail_storage_path,m.medium_storage_path,m.large_storage_path) THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Source paths changed';END IF;
  obj:=ARRAY[]::json[];
  FOREACH v IN ARRAY ARRAY['original','canonical','thumb','medium','large'] LOOP
   SELECT json_build_array(object_id,sha256,bytes,width,height) INTO a FROM app_moderation_v2.seal_objects WHERE asset_version=m.asset_version AND variant=v;
   IF a IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Missing sealed variant';END IF;obj:=array_append(obj,a);
  END LOOP;
  all_rows:=array_append(all_rows,json_build_array(m.id,m.display_order,m.processing_status,m.source_paths->>0,m.source_paths->>1,m.source_paths->>2,m.source_paths->>3,m.source_sha256,m.asset_version,'seal_v1',obj[1],obj[2],obj[3],obj[4],obj[5]));
 END LOOP;
 IF cnt NOT BETWEEN 1 AND 8 OR NOT EXISTS(SELECT 1 FROM public.listing_media WHERE id=l.cover_photo_id AND listing_id=l.id AND processing_status='ready') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete cover membership required';END IF;
 RETURN json_build_array('fairswap:v2:manifest_v1',l.id,l.cover_photo_id,array_to_json(all_rows));END $$;
ALTER FUNCTION app_moderation_v2.p3_manifest(uuid) OWNER TO mv2_p3_register;
-- C2 request id resolves revision/generation/policy; no second lifecycle table.
CREATE FUNCTION app_moderation_v2.p3_snapshot_digest(p_request uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r app_moderation_v2.requests;l public.listings;manifest json;md text;BEGIN
 SELECT * INTO STRICT r FROM app_moderation_v2.requests WHERE id=p_request;
 SELECT * INTO STRICT l FROM public.listings WHERE id=r.listing_id FOR UPDATE;
 SELECT * INTO STRICT r FROM app_moderation_v2.requests WHERE id=p_request FOR UPDATE;
 IF l.revision IS DISTINCT FROM r.listing_revision OR l.title IS DISTINCT FROM r.original_title OR l.description IS DISTINCT FROM r.original_description OR l.status<>'pending_review' OR r.phase<>'preparation' OR r.status<>'awaiting_media' THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Stale C2 request';END IF;
 manifest:=app_moderation_v2.p3_manifest(l.id);
 md:=encode(sha256(convert_to(app_moderation_v2.p3_compact(manifest),'UTF8')),'hex');
 RETURN encode(sha256(convert_to(app_moderation_v2.p3_compact(json_build_array('fairswap:v2:snapshot_v1','2.0.0',r.policy_version,l.id,l.revision,r.generation_id,encode(sha256(convert_to(l.title,'UTF8')),'hex'),encode(sha256(convert_to(coalesce(l.description,''),'UTF8')),'hex'),md)),'UTF8')),'hex');
END $$;
ALTER FUNCTION app_moderation_v2.p3_snapshot_digest(uuid) OWNER TO mv2_p3_register;
GRANT SELECT,UPDATE(id) ON app_moderation_v2.requests TO mv2_p3_register;
CREATE POLICY p3_request_snapshot ON app_moderation_v2.requests TO mv2_p3_register USING(true) WITH CHECK(true);
-- No new lease, queue, policy or generation authority. No publishing function.
REVOKE ALL ON FUNCTION app_moderation_v2.p3_protected(uuid),app_moderation_v2.p3_append_only(),app_moderation_v2.p3_consume_invalidation(jsonb,jsonb),app_moderation_v2.p3_row_guard(),app_moderation_v2.p3_exclude_v1(),app_moderation_v2.p3_register_bundle(uuid,uuid,integer,uuid,text,jsonb),app_moderation_v2.p3_retire_bundle(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_protected(uuid) TO postgres,mv2_p3_register,mv2_p3_retire,mv2_p3_edit;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_consume_invalidation(jsonb,jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_register_bundle(uuid,uuid,integer,uuid,text,jsonb) TO mv2_p3_registrar;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_retire_bundle(uuid) TO mv2_p3_retirement;
REVOKE ALL ON FUNCTION app_moderation_v2.p3_edit_media(uuid,integer,uuid,integer,boolean,boolean),app_moderation_v2.p3_compact(json),app_moderation_v2.p3_manifest(uuid),app_moderation_v2.p3_snapshot_digest(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_edit_media(uuid,integer,uuid,integer,boolean,boolean) TO mv2_p3_media_editor;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_compact(json) TO mv2_p3_register;
REVOKE CREATE ON SCHEMA app_moderation_v2 FROM mv2_p3_registry_owner,mv2_p3_guard,mv2_p3_register,mv2_p3_retire,mv2_p3_edit;
-- UNAPPLIED continuation, composed inside the registry candidate transaction.
-- No BEGIN/COMMIT, settings writes, dispatcher, provider or Storage operations.
CREATE ROLE mv2_p3_lease NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_finalize NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_text NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mv2_p3_worker NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT mv2_p3_lease,mv2_p3_finalize,mv2_p3_text,mv2_p3_worker TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA app_moderation_v2,public TO mv2_p3_lease,mv2_p3_finalize,mv2_p3_text;
GRANT USAGE ON SCHEMA app_moderation_v2 TO mv2_p3_worker;
GRANT CREATE ON SCHEMA app_moderation_v2 TO mv2_p3_lease,mv2_p3_finalize,mv2_p3_text,mv2_p3_guard,mv2_p3_retire,mv2_p3_registry_owner;

-- ONE lease ledger and ONE pair of admission slots, extended by phase.
-- Old input recovery/heartbeat see only their original status='active'.
GRANT INSERT ON app_moderation_v2.p3_actor_context TO mv2_p3_text,mv2_p3_lease,mv2_p3_finalize;
CREATE POLICY p3_actor_evaluation_insert ON app_moderation_v2.p3_actor_context FOR INSERT TO mv2_p3_text,mv2_p3_lease,mv2_p3_finalize WITH CHECK(actor=current_user);
ALTER TABLE app_moderation_v2.input_claims ADD COLUMN phase text NOT NULL DEFAULT 'input_validation' CHECK(phase IN('input_validation','evaluation'));
ALTER TABLE app_moderation_v2.input_claims DROP CONSTRAINT input_claims_status_check;
ALTER TABLE app_moderation_v2.input_claims ADD CONSTRAINT input_claims_status_check CHECK(status IN('active','completed','abandoned','expired','superseded','evaluation_active','evaluation_completed','evaluation_expired','evaluation_superseded'));
ALTER TABLE app_moderation_v2.input_claims ADD CONSTRAINT p3_claim_phase_status CHECK((phase='input_validation' AND status IN('active','completed','abandoned','expired','superseded')) OR (phase='evaluation' AND status IN('evaluation_active','evaluation_completed','evaluation_expired','evaluation_superseded')));
CREATE UNIQUE INDEX p3_one_active_evaluation ON app_moderation_v2.input_claims(request_id) WHERE status='evaluation_active';
ALTER TABLE app_moderation_v2.requests ADD COLUMN preparation_started_at timestamptz;

CREATE TABLE app_moderation_v2.p3_evaluation_evidence(
 request_id uuid NOT NULL,attempt_id uuid NOT NULL,snapshot jsonb NOT NULL,
 source_manifest jsonb NOT NULL,evaluator_build text NOT NULL CHECK(evaluator_build ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(request_id,attempt_id),
 FOREIGN KEY(request_id,attempt_id) REFERENCES app_moderation_v2.input_claims(request_id,attempt_id) ON DELETE RESTRICT);
CREATE TABLE app_moderation_v2.p3_evaluation_results(
 request_id uuid NOT NULL,attempt_id uuid NOT NULL,payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL,response jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,attempt_id),FOREIGN KEY(request_id,attempt_id) REFERENCES app_moderation_v2.p3_evaluation_evidence(request_id,attempt_id) ON DELETE RESTRICT);
CREATE TABLE app_moderation_v2.p3_call_starts(
 request_id uuid NOT NULL,attempt_id uuid NOT NULL,check_key text NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
 start_number int NOT NULL CHECK(start_number BETWEEN 1 AND 3),deadline timestamptz NOT NULL,
 PRIMARY KEY(request_id,check_key,start_number),FOREIGN KEY(request_id,attempt_id) REFERENCES app_moderation_v2.p3_evaluation_evidence(request_id,attempt_id) ON DELETE RESTRICT);
CREATE TABLE app_moderation_v2.p3_checkpoints(
 request_id uuid NOT NULL,attempt_id uuid NOT NULL,check_key text NOT NULL,payload jsonb NOT NULL,
 retry_after_seconds integer CHECK(retry_after_seconds BETWEEN 0 AND 86400),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,attempt_id,check_key),FOREIGN KEY(request_id,attempt_id) REFERENCES app_moderation_v2.p3_evaluation_evidence(request_id,attempt_id) ON DELETE RESTRICT);
CREATE TABLE app_moderation_v2.p3_circuit_events(
 policy_version text PRIMARY KEY REFERENCES app_moderation_v2.policy_registry(policy_version),
 reason text NOT NULL CHECK(reason IN('PROVIDER_AUTH','PROVIDER_INPUT')),opened_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE app_moderation_v2.p3_cleanup_receipts(
 asset_version uuid NOT NULL REFERENCES app_moderation_v2.seal_retirements(asset_version),
 object_id uuid NOT NULL REFERENCES app_moderation_v2.seal_objects(object_id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(asset_version,object_id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['p3_evaluation_evidence','p3_evaluation_results','p3_call_starts','p3_checkpoints','p3_circuit_events','p3_cleanup_receipts'] LOOP
 EXECUTE format('ALTER TABLE app_moderation_v2.%I OWNER TO mv2_p3_registry_owner',t);
 EXECUTE format('ALTER TABLE app_moderation_v2.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON app_moderation_v2.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('CREATE POLICY p3_evidence_read ON app_moderation_v2.%I FOR SELECT TO mv2_p3_lease,mv2_p3_finalize,mv2_p3_retire USING(true)',t);
 EXECUTE format('CREATE TRIGGER p3_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON app_moderation_v2.%I FOR EACH STATEMENT EXECUTE FUNCTION app_moderation_v2.p3_append_only()',t);
END LOOP;END $$;
GRANT SELECT ON app_moderation_v2.p3_evaluation_evidence,app_moderation_v2.p3_evaluation_results,app_moderation_v2.p3_call_starts,app_moderation_v2.p3_checkpoints,app_moderation_v2.p3_circuit_events,app_moderation_v2.p3_cleanup_receipts TO mv2_p3_lease,mv2_p3_finalize,mv2_p3_retire;
GRANT INSERT ON app_moderation_v2.p3_evaluation_evidence,app_moderation_v2.p3_call_starts,app_moderation_v2.p3_checkpoints TO mv2_p3_lease;
GRANT INSERT ON app_moderation_v2.p3_evaluation_results,app_moderation_v2.p3_circuit_events TO mv2_p3_finalize;
GRANT INSERT ON app_moderation_v2.p3_cleanup_receipts TO mv2_p3_retire;
CREATE POLICY p3_evidence_insert ON app_moderation_v2.p3_evaluation_evidence FOR INSERT TO mv2_p3_lease WITH CHECK(true);
CREATE POLICY p3_call_insert ON app_moderation_v2.p3_call_starts FOR INSERT TO mv2_p3_lease WITH CHECK(true);
CREATE POLICY p3_checkpoint_insert ON app_moderation_v2.p3_checkpoints FOR INSERT TO mv2_p3_lease WITH CHECK(true);
CREATE POLICY p3_result_insert ON app_moderation_v2.p3_evaluation_results FOR INSERT TO mv2_p3_finalize WITH CHECK(true);
CREATE POLICY p3_circuit_insert ON app_moderation_v2.p3_circuit_events FOR INSERT TO mv2_p3_finalize WITH CHECK(true);
CREATE POLICY p3_cleanup_insert ON app_moderation_v2.p3_cleanup_receipts FOR INSERT TO mv2_p3_retire WITH CHECK(true);
GRANT SELECT,UPDATE ON app_moderation_v2.requests,app_moderation_v2.input_claims,app_moderation_v2.input_admission_slots TO mv2_p3_lease,mv2_p3_finalize;
GRANT INSERT ON app_moderation_v2.input_claims TO mv2_p3_lease;
GRANT INSERT ON app_moderation_v2.requests TO mv2_p3_lease;
GRANT SELECT ON app_moderation_v2.policy_registry,app_moderation_v2.seal_bundles,app_moderation_v2.seal_objects,app_moderation_v2.seal_media_bindings,app_moderation_v2.seal_retirements TO mv2_p3_lease,mv2_p3_finalize;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['requests','input_claims','input_admission_slots'] LOOP EXECUTE format('CREATE POLICY p3_evaluation_lifecycle ON app_moderation_v2.%I TO mv2_p3_lease,mv2_p3_finalize USING(true) WITH CHECK(true)',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['policy_registry','seal_bundles','seal_objects','seal_media_bindings','seal_retirements'] LOOP EXECUTE format('CREATE POLICY p3_evaluation_read ON app_moderation_v2.%I FOR SELECT TO mv2_p3_lease,mv2_p3_finalize USING(true)',t);END LOOP;
END $$;
GRANT SELECT ON public.listings,public.listing_media,public.app_system_settings TO mv2_p3_lease,mv2_p3_finalize,mv2_p3_text;
GRANT UPDATE(id) ON public.listings,public.listing_media TO mv2_p3_lease;
GRANT UPDATE(original_storage_path,thumbnail_storage_path,medium_storage_path,large_storage_path,width,height) ON public.listing_media TO mv2_p3_finalize;
GRANT UPDATE(status,published_at,expires_at,rejection_reason) ON public.listings TO mv2_p3_finalize;
GRANT UPDATE(title,description,status,revision,submitted_at) ON public.listings TO mv2_p3_text;
GRANT UPDATE(id) ON public.listing_media TO mv2_p3_finalize;
CREATE POLICY p3_evaluation_listing ON public.listings TO mv2_p3_lease,mv2_p3_finalize,mv2_p3_text USING(true) WITH CHECK(true);
CREATE POLICY p3_evaluation_media ON public.listing_media TO mv2_p3_lease,mv2_p3_finalize USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE(status,updated_at) ON public.listing_moderation_requests TO mv2_p3_lease;
CREATE POLICY p3_protocol_handoff ON public.listing_moderation_requests TO mv2_p3_lease USING(true) WITH CHECK(true);
CREATE FUNCTION app_moderation_v2.p3_route_enforce() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF NEW.request_lane='enforce' THEN UPDATE public.listing_moderation_requests SET status='superseded',updated_at=clock_timestamp() WHERE listing_id=NEW.listing_id AND status IN('pending','claimed','retry');END IF;RETURN NEW;END $$;
ALTER FUNCTION app_moderation_v2.p3_route_enforce() OWNER TO mv2_p3_lease;
CREATE TRIGGER p3_protocol_handoff AFTER INSERT ON app_moderation_v2.requests FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_route_enforce();
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_protected(uuid),app_moderation_v2.p3_compact(json) TO mv2_p3_lease,mv2_p3_finalize,mv2_p3_text;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_actor_uid() TO mv2_p3_text;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_manifest(uuid) TO mv2_p3_lease,mv2_p3_finalize;

-- Read-only operator-owned adapters: no runtime role gets Vault/Auth table access
-- and no existing C2 or V1 function needs a new EXECUTE grant or body change.
CREATE FUNCTION app_moderation_v2.p3_worker_authorized(p_secret text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT session_user<>'postgres' AND pg_has_role(session_user,'mv2_p3_worker','SET') AND public.verify_moderation_worker_secret(p_secret) $$;
CREATE FUNCTION app_moderation_v2.p3_runtime_gate(p_lane text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_lane IN('shadow','enforce') AND coalesce((SELECT setting_value='true' FROM public.app_system_settings WHERE setting_key='moderation_v2_enabled'),false) AND coalesce((SELECT setting_value=p_lane FROM public.app_system_settings WHERE setting_key='moderation_v2_mode'),false) $$;
CREATE FUNCTION app_moderation_v2.p3_publication_boundary_verified() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT false $$;
-- Deliberately immutable release interlock. B2/B4 are NOT verified by SQL tests.
CREATE FUNCTION app_moderation_v2.p3_automation_allowed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT setting_value='true' FROM public.app_system_settings WHERE setting_key='moderation_automation_enabled'),false) AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='moderation_automation_enabled' AND decrypted_secret='true') AND NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='moderation_automation_enabled' AND decrypted_secret IS DISTINCT FROM 'true') $$;
CREATE FUNCTION app_moderation_v2.p3_text_valid(p_title text,p_description text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(app_moderation_v2.validate_v2_stored_text(p_title,p_description)->'validation_errors'='[]'::jsonb,false) $$;
CREATE FUNCTION app_moderation_v2.p3_policy_lock(p_policy text,p_exclusive boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.app_system_settings WHERE setting_key IN('moderation_v2_enabled','moderation_v2_mode','moderation_automation_enabled') ORDER BY setting_key FOR SHARE;
 IF p_exclusive THEN PERFORM 1 FROM app_moderation_v2.policy_registry WHERE policy_version=p_policy FOR UPDATE;
 ELSE PERFORM 1 FROM app_moderation_v2.policy_registry WHERE policy_version=p_policy FOR SHARE;END IF;
END $$;
CREATE FUNCTION app_moderation_v2.p3_eligible(p_listing uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings;BEGIN
 SELECT * INTO l FROM public.listings WHERE id=p_listing;
 IF NOT FOUND OR l.status<>'pending_review' OR app_security.get_account_status(l.seller_id) IS DISTINCT FROM 'active' OR NOT app_security.has_current_policy_acceptance(l.seller_id) OR NOT app_moderation_v2.p3_text_valid(l.title,l.description) OR l.category_id IS NULL OR l.city_id IS NULL OR l.condition IS NULL OR l.price_type IS NULL OR (l.price_type<>'free' AND coalesce(l.price_paise,0)<=0) OR l.pin_code IS NULL OR l.pin_code !~ '^[0-9]{6}$' THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.categories WHERE id=l.category_id AND is_active AND new_listing_enabled AND macro_category='goods') OR app_security.submission_family(l.id,l.category_id) IS NOT NULL THEN RETURN false;END IF;
 IF l.locality_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM public.localities WHERE id=l.locality_id AND city_id=l.city_id) OR NOT EXISTS(SELECT 1 FROM public.postal_pincode_localities WHERE pincode=l.pin_code AND locality_id=l.locality_id)) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM public.category_attributes WHERE category_id=l.category_id AND is_required AND coalesce(length(btrim(l.category_attributes->>name)),0)=0) THEN RETURN false;END IF;
 RETURN true;END $$;

CREATE FUNCTION app_moderation_v2.p3_full_snapshot(p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r app_moderation_v2.requests;l public.listings;mf json;md text;td text;dd text;s text;media jsonb;BEGIN
 SELECT * INTO STRICT r FROM app_moderation_v2.requests WHERE id=p_request;
 SELECT * INTO STRICT l FROM public.listings WHERE id=r.listing_id FOR UPDATE;
 SELECT * INTO STRICT r FROM app_moderation_v2.requests WHERE id=p_request FOR UPDATE;
 IF l.revision IS DISTINCT FROM r.listing_revision OR l.title IS DISTINCT FROM r.original_title OR l.description IS DISTINCT FROM r.original_description OR l.status<>'pending_review' THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Stale C2 identity';END IF;
 mf:=app_moderation_v2.p3_manifest(l.id);
 IF EXISTS(SELECT 1 FROM public.listing_media m JOIN app_moderation_v2.seal_media_bindings x ON x.media_id=m.id JOIN app_moderation_v2.seal_bundles b ON b.asset_version=x.asset_version WHERE m.listing_id=l.id AND (b.policy_version IS DISTINCT FROM r.policy_version OR b.source_revision>r.listing_revision OR b.recipe<>'seal_v1')) THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Registry policy or source revision mismatch';END IF;
 md:=encode(sha256(convert_to(app_moderation_v2.p3_compact(mf),'UTF8')),'hex');td:=encode(sha256(convert_to(l.title,'UTF8')),'hex');dd:=encode(sha256(convert_to(coalesce(l.description,''),'UTF8')),'hex');
 s:=encode(sha256(convert_to(app_moderation_v2.p3_compact(json_build_array('fairswap:v2:snapshot_v1','2.0.0',r.policy_version,l.id,l.revision,r.generation_id,td,dd,md)),'UTF8')),'hex');
 SELECT jsonb_agg(jsonb_build_object('media_id',m.id,'asset_version',b.asset_version,'display_order',m.display_order,'source_sha256',b.source_sha256,'recipe','seal_v1')||(SELECT jsonb_object_agg(o.variant,jsonb_build_object('object_id',o.object_id,'sha256',o.sha256,'bytes',o.bytes,'width',o.width,'height',o.height)) FROM app_moderation_v2.seal_objects o WHERE o.asset_version=b.asset_version) ORDER BY m.display_order,m.id) INTO media FROM public.listing_media m JOIN app_moderation_v2.seal_media_bindings x ON x.media_id=m.id AND x.listing_id=m.listing_id JOIN app_moderation_v2.seal_bundles b ON b.asset_version=x.asset_version WHERE m.listing_id=l.id;
 RETURN jsonb_build_object('listing_id',l.id,'listing_revision',l.revision,'generation_id',r.generation_id,'canonicalization','snapshot_v1','title_sha256',td,'description_sha256',dd,'media_manifest_sha256',md,'snapshot_sha256',s,'cover_media_id',l.cover_photo_id,'media',media);
END $$;
ALTER FUNCTION app_moderation_v2.p3_full_snapshot(uuid) OWNER TO mv2_p3_lease;
CREATE FUNCTION app_moderation_v2.p3_keys(p jsonb,expected text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(CASE WHEN jsonb_typeof(p)='object' THEN (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)=(SELECT array_agg(k ORDER BY k) FROM unnest(expected) k) ELSE false END,false) $$;
ALTER FUNCTION app_moderation_v2.p3_keys(jsonb,text[]) OWNER TO mv2_p3_finalize;

CREATE FUNCTION app_moderation_v2.p3_valid_evaluation(p jsonb,s jsonb,req uuid,attempt uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE c jsonb;t jsonb;pr jsonb;cat jsonb;image jsonb;key text;expected text[]:=ARRAY[]::text[];seen text[]:=ARRAY[]::text[];reasons text[];allowed text[];category_names text[];field text;check_id text;is_provider boolean;flag boolean;applicable boolean;failed boolean:=false;flagged boolean:=false;
cats constant text[]:=ARRAY['harassment','harassment/threatening','hate','hate/threatening','illicit','illicit/violent','sexual','sexual/minors','self-harm','self-harm/intent','self-harm/instructions','violence','violence/graphic'];
image_cats constant text[]:=ARRAY['sexual','self-harm','self-harm/intent','self-harm/instructions','violence','violence/graphic'];
failures constant text[]:=ARRAY['UNSUPPORTED_MEDIA','DIGEST_MISMATCH','SEAL_INVALID','TIMEOUT','RATE_LIMIT','PROVIDER_5XX','TRANSPORT','PROVIDER_SCHEMA','PROVIDER_AUTH','PROVIDER_INPUT','LEASE_LOST'];
transient constant text[]:=ARRAY['TIMEOUT','RATE_LIMIT','PROVIDER_5XX','TRANSPORT','PROVIDER_SCHEMA'];
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['contract_version','policy_version','evaluator_version','request_id','attempt_id','evaluated_at','phase','outcome']) k WHERE jsonb_typeof(p->k) IS DISTINCT FROM 'string') THEN RETURN false;END IF;
 IF NOT app_moderation_v2.p3_keys(p,ARRAY['contract_version','policy_version','evaluator_version','request_id','attempt_id','evaluated_at','phase','snapshot','checks','outcome']) OR p->>'contract_version'<>'2.0.0' OR p->>'policy_version'<>'fairswap_moderation_v2.0.0' OR p->>'phase'<>'evaluation' OR p->>'request_id'<>req::text OR p->>'attempt_id'<>attempt::text OR p->'snapshot' IS DISTINCT FROM s OR p->>'evaluator_version' !~ '^v2\.[0-9]+\.[0-9]+$' OR p->>'evaluated_at' !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' OR jsonb_typeof(p->'checks')<>'array' OR jsonb_array_length(p->'checks')>24 THEN RETURN false;END IF;
 PERFORM (p->>'evaluated_at')::timestamptz;
 FOREACH field IN ARRAY ARRAY['title','description'] LOOP FOREACH check_id IN ARRAY ARRAY['rule_prohibited_item_wording','rule_shortened_link','rule_payment_before_viewing','openai_text_v2'] LOOP expected:=array_append(expected,check_id||':text:'||field);END LOOP;END LOOP;
 FOR image IN SELECT value FROM jsonb_array_elements(s->'media') LOOP expected:=array_append(expected,'image_integrity_v2:image:'||(image->>'media_id'));expected:=array_append(expected,'openai_image_v2:image:'||(image->>'media_id'));END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(p->'checks') LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['check_id','input_sha256','state']) k WHERE jsonb_typeof(c->k) IS DISTINCT FROM 'string') THEN RETURN false;END IF;
  IF NOT app_moderation_v2.p3_keys(c,ARRAY['check_id','target','input_sha256','state','reason_codes','retryable','provider']) OR jsonb_typeof(c->'retryable')<>'boolean' OR c->>'state' NOT IN ('passed','flagged','failed') OR jsonb_typeof(c->'reason_codes')<>'array' OR jsonb_array_length(c->'reason_codes')>20 THEN RETURN false;END IF;
  t:=c->'target';check_id:=c->>'check_id';is_provider:=check_id IN ('openai_text_v2','openai_image_v2');
  IF t->>'kind'='text' THEN
   IF NOT app_moderation_v2.p3_keys(t,ARRAY['kind','field']) OR t->>'field' NOT IN ('title','description') OR c->>'input_sha256' IS DISTINCT FROM s->>((t->>'field')||'_sha256') THEN RETURN false;END IF;key:=check_id||':text:'||(t->>'field');
  ELSIF t->>'kind'='image' THEN
   IF NOT app_moderation_v2.p3_keys(t,ARRAY['kind','media_id']) THEN RETURN false;END IF;
   SELECT value INTO image FROM jsonb_array_elements(s->'media') WHERE value->>'media_id'=t->>'media_id';
   IF image IS NULL OR c->>'input_sha256' IS DISTINCT FROM image#>>'{canonical,sha256}' THEN RETURN false;END IF;key:=check_id||':image:'||(t->>'media_id');
  ELSE RETURN false;END IF;
  IF NOT(key=ANY(expected)) OR key=ANY(seen) THEN RETURN false;END IF;seen:=array_append(seen,key);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'reason_codes') x WHERE jsonb_typeof(x)<>'string') THEN RETURN false;END IF;
  SELECT coalesce(array_agg(value),ARRAY[]::text[]) INTO reasons FROM jsonb_array_elements_text(c->'reason_codes');
  IF cardinality(reasons)<>(SELECT count(DISTINCT x) FROM unnest(reasons) x) THEN RETURN false;END IF;
  allowed:=CASE check_id WHEN 'rule_prohibited_item_wording' THEN ARRAY['PROHIBITED_WORDING'] WHEN 'rule_shortened_link' THEN ARRAY['SHORTENED_LINK'] WHEN 'rule_payment_before_viewing' THEN ARRAY['PAYMENT_BEFORE_VIEWING'] WHEN 'image_integrity_v2' THEN ARRAY[]::text[] ELSE ARRAY['PROVIDER_FLAG'] END;
  IF c->>'state'='passed' AND (cardinality(reasons)<>0 OR (c->>'retryable')::boolean) OR c->>'state'<>'passed' AND cardinality(reasons)=0 OR c->>'state'<>'failed' AND (c->>'retryable')::boolean THEN RETURN false;END IF;
  IF c->>'state'='flagged' AND NOT(reasons<@allowed) OR c->>'state'='failed' AND (NOT reasons&&(failures) OR NOT reasons<@(failures||allowed)) OR (c->>'retryable')::boolean AND NOT(reasons<@(transient||ARRAY['PROVIDER_FLAG'])) THEN RETURN false;END IF;
  pr:=c->'provider';
  IF NOT is_provider AND pr<>'null'::jsonb OR is_provider AND c->>'state'<>'failed' AND pr='null'::jsonb THEN RETURN false;END IF;
  IF pr<>'null'::jsonb THEN
   IF EXISTS(SELECT 1 FROM unnest(ARRAY['name','requested_model','returned_model','response_id']) k WHERE jsonb_typeof(pr->k) IS DISTINCT FROM 'string') THEN RETURN false;END IF;
   IF NOT app_moderation_v2.p3_keys(pr,ARRAY['name','requested_model','returned_model','response_id','request_id','flagged','categories']) OR pr->>'name'<>'openai' OR pr->>'requested_model'<>'omni-moderation-2024-09-26' OR pr->>'returned_model'<>'omni-moderation-2024-09-26' OR pr->>'response_id' !~ '^[A-Za-z0-9_-]{1,200}$' OR NOT(pr->'request_id'='null'::jsonb OR jsonb_typeof(pr->'request_id')='string' AND pr->>'request_id' ~ '^[A-Za-z0-9_-]{1,200}$') OR jsonb_typeof(pr->'flagged')<>'boolean' OR jsonb_typeof(pr->'categories')<>'array' OR jsonb_array_length(pr->'categories')<>13 THEN RETURN false;END IF;
   category_names:=ARRAY[]::text[];flag:=false;
   FOR cat IN SELECT value FROM jsonb_array_elements(pr->'categories') LOOP
    IF jsonb_typeof(cat->'category') IS DISTINCT FROM 'string' OR jsonb_typeof(cat->'applicability') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
    IF NOT app_moderation_v2.p3_keys(cat,ARRAY['category','applicability','flagged','score']) OR NOT(cat->>'category'=ANY(cats)) OR cat->>'category'=ANY(category_names) THEN RETURN false;END IF;category_names:=array_append(category_names,cat->>'category');applicable:=t->>'kind'='text' OR cat->>'category'=ANY(image_cats);
    IF applicable THEN
     IF cat->>'applicability'<>'evaluated' OR jsonb_typeof(cat->'flagged')<>'boolean' OR jsonb_typeof(cat->'score')<>'number' OR (cat->>'score')::numeric NOT BETWEEN 0 AND 1 THEN RETURN false;END IF;flag:=flag OR (cat->>'flagged')::boolean;
    ELSIF cat->>'applicability'<>'not_applicable' OR cat->'flagged'<>'null'::jsonb OR cat->'score'<>'null'::jsonb THEN RETURN false;END IF;
   END LOOP;
   IF (pr->>'flagged')::boolean<>flag OR c->>'state'<>'failed' AND (c->>'state'='flagged')<>flag THEN RETURN false;END IF;
  END IF;
  failed:=failed OR c->>'state'='failed';flagged:=flagged OR c->>'state'='flagged';
 END LOOP;
 RETURN p->>'outcome'=CASE WHEN cardinality(seen)<>cardinality(expected) OR failed THEN 'checks_incomplete' WHEN flagged THEN 'needs_review' ELSE 'no_review_flags' END;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
ALTER FUNCTION app_moderation_v2.p3_valid_evaluation(jsonb,jsonb,uuid,uuid) OWNER TO mv2_p3_finalize;

GRANT SELECT ON app_moderation_v2.input_claims,app_moderation_v2.input_admission_slots TO mv2_p3_guard;
CREATE POLICY p3_guard_claim_read ON app_moderation_v2.input_claims FOR SELECT TO mv2_p3_guard USING(true);
CREATE POLICY p3_guard_slot_read ON app_moderation_v2.input_admission_slots FOR SELECT TO mv2_p3_guard USING(true);
CREATE FUNCTION app_moderation_v2.p3_lease_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor name;req uuid;protected boolean:=false;BEGIN
 actor:=app_moderation_v2.p3_take_actor(TG_RELID,TG_OP,to_jsonb(OLD),to_jsonb(NEW));
 IF TG_TABLE_NAME='input_admission_slots' THEN
  SELECT coalesce(bool_or(c.phase='evaluation' OR app_moderation_v2.p3_protected(r.listing_id)),false) INTO protected FROM app_moderation_v2.input_claims c JOIN app_moderation_v2.requests r ON r.id=c.request_id WHERE c.id IN(OLD.active_claim_id,NEW.active_claim_id);
 ELSE req:=CASE WHEN TG_OP='DELETE' THEN OLD.request_id ELSE NEW.request_id END;
  SELECT app_moderation_v2.p3_protected(listing_id) INTO protected FROM app_moderation_v2.requests WHERE id=req;
  IF TG_TABLE_NAME='input_claims' THEN IF TG_OP<>'DELETE' AND NEW.phase='evaluation' THEN protected:=true;END IF;END IF;
 END IF;
 IF protected AND (actor IS NULL OR actor NOT IN('postgres','mv2_p3_lease','mv2_p3_finalize')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Trusted C2 lease transition required';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
ALTER FUNCTION app_moderation_v2.p3_lease_guard() OWNER TO mv2_p3_guard;
CREATE TRIGGER zzzy_p3_capture_actor BEFORE INSERT OR UPDATE OR DELETE ON app_moderation_v2.input_claims FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_capture_actor();
CREATE TRIGGER zzzz_p3_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON app_moderation_v2.input_claims FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_lease_guard();
CREATE TRIGGER zzzy_p3_capture_actor BEFORE INSERT OR UPDATE OR DELETE ON app_moderation_v2.input_results FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_capture_actor();
CREATE TRIGGER zzzz_p3_input_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON app_moderation_v2.input_results FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_lease_guard();
CREATE TRIGGER zzzy_p3_capture_actor BEFORE UPDATE ON app_moderation_v2.input_admission_slots FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_capture_actor();
CREATE TRIGGER zzzz_p3_slot_guard BEFORE UPDATE ON app_moderation_v2.input_admission_slots FOR EACH ROW EXECUTE FUNCTION app_moderation_v2.p3_lease_guard();

-- Lock hierarchy shared with C2: parent -> request -> policy (new evaluation
-- circuit serialization only) -> existing admission slot -> existing claim.
CREATE FUNCTION app_moderation_v2.p3_lock_attempt(req uuid,a uuid,token text,terminal_ok boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r app_moderation_v2.requests;c app_moderation_v2.input_claims;BEGIN
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req;IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','REQUEST_NOT_FOUND');END IF;
 PERFORM 1 FROM public.listings WHERE id=r.listing_id FOR UPDATE;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req FOR UPDATE;
 PERFORM app_moderation_v2.p3_policy_lock(r.policy_version,false);
 SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;
 IF NOT FOUND OR c.phase<>'evaluation' OR c.claim_token_hash IS DISTINCT FROM encode(sha256(convert_to(token,'UTF8')),'hex') THEN RETURN jsonb_build_object('success',false,'error','LEASE_TOKEN_MISMATCH');END IF;
 PERFORM 1 FROM app_moderation_v2.input_admission_slots WHERE slot_id=c.slot_id FOR UPDATE;
 SELECT * INTO c FROM app_moderation_v2.input_claims WHERE id=c.id FOR UPDATE;
 IF c.claim_token_hash IS DISTINCT FROM encode(sha256(convert_to(token,'UTF8')),'hex') THEN RETURN jsonb_build_object('success',false,'error','LEASE_TOKEN_MISMATCH');END IF;
 IF c.status<>'evaluation_active' OR c.lease_expires_at<=clock_timestamp() OR c.max_renewal_until<=clock_timestamp() OR c.attempt_started_at+interval '240 seconds'<=clock_timestamp() OR r.phase<>'evaluation' OR (r.status<>'claimed' AND NOT(terminal_ok AND r.status='superseded')) OR NOT EXISTS(SELECT 1 FROM app_moderation_v2.input_admission_slots WHERE slot_id=c.slot_id AND active_claim_id=c.id AND slot_expires_at>clock_timestamp()) THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END IF;
 RETURN jsonb_build_object('success',true);END $$;
ALTER FUNCTION app_moderation_v2.p3_lock_attempt(uuid,uuid,text,boolean) OWNER TO mv2_p3_lease;

CREATE FUNCTION app_moderation_v2.p3_claim_evaluation(p_secret text,req uuid,p_worker text,p_build text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r app_moderation_v2.requests;p app_moderation_v2.policy_registry;slot smallint;a uuid;token text;s jsonb;mf jsonb;c uuid;now_time timestamptz;n integer;BEGIN
 IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req;IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','REQUEST_NOT_FOUND');END IF;
 IF NOT app_moderation_v2.p3_runtime_gate(r.request_lane) THEN RETURN NULL;END IF;
 PERFORM 1 FROM public.listings WHERE id=r.listing_id FOR UPDATE;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req FOR UPDATE;
 PERFORM app_moderation_v2.p3_policy_lock(r.policy_version,false);
 SELECT * INTO p FROM app_moderation_v2.policy_registry WHERE policy_version=r.policy_version;
 IF NOT app_moderation_v2.p3_runtime_gate(r.request_lane) OR p.is_approved IS DISTINCT FROM true OR p.approved_evaluator_build IS DISTINCT FROM p_build OR p_build IS NULL OR EXISTS(SELECT 1 FROM app_moderation_v2.p3_circuit_events WHERE policy_version=r.policy_version) THEN RETURN NULL;END IF;
 IF r.next_attempt_at>clock_timestamp() OR NOT((r.phase='preparation' AND r.status='awaiting_media') OR (r.phase='evaluation' AND r.status IN('prepared','retry'))) OR (r.phase='evaluation' AND r.attempt_count>=3) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM app_moderation_v2.input_claims WHERE request_id=req AND status IN('active','evaluation_active')) THEN RETURN NULL;END IF;
 IF NOT app_moderation_v2.p3_text_valid(r.original_title,r.original_description) THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
 SELECT slot_id INTO slot FROM app_moderation_v2.input_admission_slots WHERE active_claim_id IS NULL ORDER BY slot_id FOR UPDATE SKIP LOCKED LIMIT 1;IF slot IS NULL THEN RETURN NULL;END IF;
 BEGIN s:=app_moderation_v2.p3_full_snapshot(req);mf:=app_moderation_v2.p3_manifest(r.listing_id)::jsonb;
 EXCEPTION WHEN SQLSTATE '22023' THEN
  UPDATE app_moderation_v2.requests SET preparation_started_at=coalesce(preparation_started_at,clock_timestamp()),status=CASE WHEN coalesce(preparation_started_at,clock_timestamp())+interval '15 minutes'<=clock_timestamp() THEN 'failed' ELSE 'awaiting_media' END,phase='preparation',updated_at=clock_timestamp() WHERE id=req;
  RETURN jsonb_build_object('success',true,'decision',CASE WHEN coalesce(r.preparation_started_at,clock_timestamp())+interval '15 minutes'<=clock_timestamp() THEN 'escalated_to_admin' ELSE 'awaiting_media_processing' END);
 WHEN SQLSTATE 'PT409' THEN UPDATE app_moderation_v2.requests SET status='superseded',updated_at=clock_timestamp() WHERE id=req;RETURN jsonb_build_object('success',true,'decision','superseded');END;
 a:=gen_random_uuid();c:=gen_random_uuid();token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');now_time:=clock_timestamp();n:=CASE WHEN r.phase='preparation' THEN 1 ELSE r.attempt_count+1 END;
 INSERT INTO app_moderation_v2.input_claims(id,request_id,attempt_id,attempt_number,claim_token_hash,slot_id,worker_id,lease_expires_at,attempt_started_at,max_renewal_until,status,phase) VALUES(c,req,a,n,encode(sha256(convert_to(token,'UTF8')),'hex'),slot,p_worker,now_time+interval '120 seconds',now_time,now_time+interval '300 seconds','evaluation_active','evaluation');
 INSERT INTO app_moderation_v2.p3_evaluation_evidence(request_id,attempt_id,snapshot,source_manifest,evaluator_build) VALUES(req,a,s,mf,p_build);
 UPDATE app_moderation_v2.input_admission_slots SET active_claim_id=c,slot_acquired_at=now_time,slot_expires_at=now_time+interval '120 seconds' WHERE slot_id=slot;
 UPDATE app_moderation_v2.requests SET phase='evaluation',status='claimed',attempt_count=n,updated_at=now_time WHERE id=req;
 RETURN jsonb_build_object('request_id',req,'attempt_id',a,'claim_token',token,'snapshot',s,'source_manifest',mf,'original_title',r.original_title,'original_description',r.original_description,'evaluator_build',p_build,'lease_expires_at',now_time+interval '120 seconds','attempt_number',n);
END $$;
ALTER FUNCTION app_moderation_v2.p3_claim_evaluation(text,uuid,text,text) OWNER TO mv2_p3_lease;

CREATE FUNCTION app_moderation_v2.p3_heartbeat_evaluation(p_secret text,req uuid,a uuid,token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r app_moderation_v2.requests;c app_moderation_v2.input_claims;f jsonb;expiry timestamptz;BEGIN
 IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;
 f:=app_moderation_v2.p3_lock_attempt(req,a,token);IF f->>'success'<>'true' THEN RETURN f;END IF;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req;SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;
 IF NOT app_moderation_v2.p3_runtime_gate(r.request_lane) OR EXISTS(SELECT 1 FROM app_moderation_v2.p3_circuit_events WHERE policy_version=r.policy_version) OR NOT EXISTS(SELECT 1 FROM public.listings WHERE id=r.listing_id AND revision=r.listing_revision AND title=r.original_title AND description IS NOT DISTINCT FROM r.original_description AND status='pending_review') THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END IF;
 expiry:=least(clock_timestamp()+interval '120 seconds',c.max_renewal_until,c.attempt_started_at+interval '240 seconds');
 UPDATE app_moderation_v2.input_claims SET lease_expires_at=expiry,updated_at=clock_timestamp() WHERE id=c.id;
 UPDATE app_moderation_v2.input_admission_slots SET slot_expires_at=expiry WHERE slot_id=c.slot_id AND active_claim_id=c.id;
 RETURN jsonb_build_object('success',true,'lease_expires_at',expiry);END $$;
ALTER FUNCTION app_moderation_v2.p3_heartbeat_evaluation(text,uuid,uuid,text) OWNER TO mv2_p3_lease;

CREATE FUNCTION app_moderation_v2.p3_reserve_call(p_secret text,req uuid,a uuid,token text,p_check text,p_target jsonb,p_sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE f jsonb;s jsonb;r app_moderation_v2.requests;c app_moderation_v2.input_claims;expected text;key text;n int;BEGIN
 IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;
 f:=app_moderation_v2.p3_lock_attempt(req,a,token);IF f->>'success'<>'true' THEN RETURN f;END IF;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req;SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;SELECT snapshot INTO s FROM app_moderation_v2.p3_evaluation_evidence WHERE request_id=req AND attempt_id=a;
 IF NOT app_moderation_v2.p3_runtime_gate(r.request_lane) OR EXISTS(SELECT 1 FROM app_moderation_v2.p3_circuit_events WHERE policy_version=r.policy_version) THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END IF;
 IF s IS DISTINCT FROM app_moderation_v2.p3_full_snapshot(req) THEN RETURN jsonb_build_object('success',false,'error','SNAPSHOT_MISMATCH');END IF;
 IF p_check='openai_text_v2' AND app_moderation_v2.p3_keys(p_target,ARRAY['kind','field']) AND p_target->>'kind'='text' AND p_target->>'field' IN('title','description') THEN expected:=s->>((p_target->>'field')||'_sha256');
 ELSIF p_check='openai_image_v2' AND app_moderation_v2.p3_keys(p_target,ARRAY['kind','media_id']) AND p_target->>'kind'='image' THEN SELECT value#>>'{canonical,sha256}' INTO expected FROM jsonb_array_elements(s->'media') WHERE value->>'media_id'=p_target->>'media_id';END IF;
 IF expected IS NULL OR expected IS DISTINCT FROM p_sha THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
 key:=p_check||':'||p_target::text;
 IF EXISTS(SELECT 1 FROM app_moderation_v2.p3_checkpoints WHERE request_id=req AND check_key=key AND (payload->>'state'='flagged' OR payload#>>'{provider,flagged}'='true')) THEN RETURN jsonb_build_object('success',false,'error','IDEMPOTENCY_CONFLICT');END IF;
 IF c.lease_expires_at<clock_timestamp()+interval '20 seconds' OR c.attempt_started_at+interval '210 seconds'<clock_timestamp()+interval '20 seconds' THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END IF;
 SELECT coalesce(max(start_number),0)+1 INTO n FROM app_moderation_v2.p3_call_starts WHERE request_id=req AND check_key=key;
 IF n>3 THEN RETURN jsonb_build_object('success',false,'error','IDEMPOTENCY_CONFLICT');END IF;
 INSERT INTO app_moderation_v2.p3_call_starts VALUES(req,a,key,p_sha,n,clock_timestamp()+interval '15 seconds');RETURN jsonb_build_object('success',true,'start_number',n);END $$;
ALTER FUNCTION app_moderation_v2.p3_reserve_call(text,uuid,uuid,text,text,jsonb,text) OWNER TO mv2_p3_lease;

CREATE FUNCTION app_moderation_v2.p3_checkpoint_evaluation(p_secret text,req uuid,a uuid,token text,p_check jsonb,p_retry_after_seconds integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE f jsonb;s jsonb;p jsonb;key text;old_row app_moderation_v2.p3_checkpoints;BEGIN
 IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;
 f:=app_moderation_v2.p3_lock_attempt(req,a,token);IF f->>'success'<>'true' THEN RETURN f;END IF;
 SELECT snapshot INTO s FROM app_moderation_v2.p3_evaluation_evidence WHERE request_id=req AND attempt_id=a;
 p:=jsonb_build_object('contract_version','2.0.0','policy_version','fairswap_moderation_v2.0.0','evaluator_version','v2.0.0','request_id',req,'attempt_id',a,'evaluated_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'phase','evaluation','snapshot',s,'checks',jsonb_build_array(p_check),'outcome','checks_incomplete');
 IF NOT app_moderation_v2.p3_valid_evaluation(p,s,req,a) OR p_retry_after_seconds IS NOT NULL AND (p_retry_after_seconds NOT BETWEEN 0 AND 86400 OR NOT(p_check->'reason_codes' ? 'RATE_LIMIT')) THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
 key:=p_check->>'check_id'||':'||(p_check->'target')::text;
 SELECT * INTO old_row FROM app_moderation_v2.p3_checkpoints WHERE request_id=req AND attempt_id=a AND check_key=key;
 IF FOUND THEN IF old_row.payload IS DISTINCT FROM p_check OR old_row.retry_after_seconds IS DISTINCT FROM p_retry_after_seconds THEN RETURN jsonb_build_object('success',false,'error','IDEMPOTENCY_CONFLICT');END IF;RETURN jsonb_build_object('success',true);END IF;
 INSERT INTO app_moderation_v2.p3_checkpoints(request_id,attempt_id,check_key,payload,retry_after_seconds) VALUES(req,a,key,p_check,p_retry_after_seconds);RETURN jsonb_build_object('success',true);END $$;
ALTER FUNCTION app_moderation_v2.p3_checkpoint_evaluation(text,uuid,uuid,text,jsonb,integer) OWNER TO mv2_p3_lease;

CREATE FUNCTION app_moderation_v2.p3_recover_evaluation(p_secret text,req uuid,a uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r app_moderation_v2.requests;c app_moderation_v2.input_claims;BEGIN
 IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req;IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','REQUEST_NOT_FOUND');END IF;
 PERFORM 1 FROM public.listings WHERE id=r.listing_id FOR UPDATE;SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req FOR UPDATE;
 SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a AND phase='evaluation';IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END IF;
 PERFORM 1 FROM app_moderation_v2.input_admission_slots WHERE slot_id=c.slot_id FOR UPDATE;SELECT * INTO c FROM app_moderation_v2.input_claims WHERE id=c.id FOR UPDATE;
 IF c.status<>'evaluation_active' OR c.lease_expires_at>clock_timestamp() OR EXISTS(SELECT 1 FROM app_moderation_v2.p3_call_starts WHERE request_id=req AND attempt_id=a AND deadline>=clock_timestamp()) THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END IF;
 UPDATE app_moderation_v2.input_claims SET status='evaluation_expired',updated_at=clock_timestamp() WHERE id=c.id;
 UPDATE app_moderation_v2.input_admission_slots SET active_claim_id=NULL,slot_acquired_at=NULL,slot_expires_at=NULL WHERE slot_id=c.slot_id AND active_claim_id=c.id;
 IF r.status='claimed' THEN UPDATE app_moderation_v2.requests SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'retry' END,next_attempt_at=clock_timestamp()+make_interval(secs=>CASE WHEN attempt_count<=1 THEN 10 ELSE 20 END),updated_at=clock_timestamp() WHERE id=req;END IF;
 RETURN jsonb_build_object('success',true);END $$;
ALTER FUNCTION app_moderation_v2.p3_recover_evaluation(text,uuid,uuid) OWNER TO mv2_p3_lease;

CREATE FUNCTION app_moderation_v2.p3_finish_evaluation(req uuid,a uuid,token text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r app_moderation_v2.requests;l public.listings;c app_moderation_v2.input_claims;e app_moderation_v2.p3_evaluation_evidence;prior app_moderation_v2.p3_evaluation_results;policy app_moderation_v2.policy_registry;f jsonb;s jsonb;response jsonb;decision text;payload_hash text;check_row jsonb;checkpoint record;current_check jsonb;cat jsonb;retryable boolean;has_failure boolean;config_failure boolean:=false;schema_first int;next_time timestamptz;provider_delay int;provider_until timestamptz;attached int;BEGIN
 IF p IS NULL OR octet_length(p::text)>262144 THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
 payload_hash:=encode(sha256(convert_to('fairswap:v2:result_v1:'||p::text,'UTF8')),'hex');
 -- Authenticated wrapper precedes this private engine. Matching replay is checked
 -- both before AND after parent/request locks, before any live lease/state check.
 SELECT * INTO prior FROM app_moderation_v2.p3_evaluation_results WHERE request_id=req AND attempt_id=a;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a AND phase='evaluation' AND claim_token_hash=encode(sha256(convert_to(token,'UTF8')),'hex')) THEN RETURN jsonb_build_object('success',false,'error','LEASE_TOKEN_MISMATCH');END IF;
  IF prior.payload_digest IS DISTINCT FROM payload_hash THEN RETURN jsonb_build_object('success',false,'error','IDEMPOTENCY_CONFLICT');END IF;RETURN prior.response;
 END IF;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req;IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','REQUEST_NOT_FOUND');END IF;
 SELECT * INTO l FROM public.listings WHERE id=r.listing_id FOR UPDATE;
 SELECT * INTO r FROM app_moderation_v2.requests WHERE id=req FOR UPDATE;
 SELECT * INTO prior FROM app_moderation_v2.p3_evaluation_results WHERE request_id=req AND attempt_id=a;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a AND phase='evaluation' AND claim_token_hash=encode(sha256(convert_to(token,'UTF8')),'hex')) THEN RETURN jsonb_build_object('success',false,'error','LEASE_TOKEN_MISMATCH');END IF;
  IF prior.payload_digest IS DISTINCT FROM payload_hash THEN RETURN jsonb_build_object('success',false,'error','IDEMPOTENCY_CONFLICT');END IF;RETURN prior.response;
 END IF;
 PERFORM app_moderation_v2.p3_policy_lock(r.policy_version,true);
 SELECT * INTO policy FROM app_moderation_v2.policy_registry WHERE policy_version=r.policy_version;
 IF NOT FOUND OR r.protocol_version<>2 OR policy.contract_version<>'2.0.0' OR policy.provider_model<>'omni-moderation-2024-09-26' OR policy.seal_recipe<>'seal_v1' THEN RETURN jsonb_build_object('success',false,'error','UNSUPPORTED_POLICY');END IF;
 f:=app_moderation_v2.p3_lock_attempt(req,a,token,true);IF f->>'success'<>'true' THEN RETURN f;END IF;
 SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;
 SELECT * INTO e FROM app_moderation_v2.p3_evaluation_evidence WHERE request_id=req AND attempt_id=a;
 -- No input-result ledger, scalar-only envelope, fake phase or absent media can
 -- authorize this path. Stored evidence must belong to THIS C2 evaluation claim.
 IF NOT FOUND OR e.evaluator_build IS NULL OR NOT app_moderation_v2.p3_valid_evaluation(p,e.snapshot,req,a) THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
 IF policy.approved_evaluator_build IS NOT NULL AND policy.approved_evaluator_build IS DISTINCT FROM e.evaluator_build THEN RETURN jsonb_build_object('success',false,'error','UNSUPPORTED_POLICY');END IF;
 IF r.status='superseded' OR l.revision IS DISTINCT FROM r.listing_revision OR l.title IS DISTINCT FROM r.original_title OR l.description IS DISTINCT FROM r.original_description OR l.status<>'pending_review' THEN decision:='superseded';END IF;
 IF decision IS NULL THEN
  BEGIN s:=app_moderation_v2.p3_full_snapshot(req);
   IF s IS DISTINCT FROM e.snapshot OR app_moderation_v2.p3_manifest(l.id)::jsonb IS DISTINCT FROM e.source_manifest THEN decision:='superseded';END IF;
  EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'PT409' THEN decision:='superseded';END;
 END IF;
 IF decision IS NULL THEN
  -- Successful/flagged provider observations need a prior reserved call on the
  -- SAME request, policy and snapshot; same-generation verified reuse is allowed.
  FOR check_row IN SELECT value FROM jsonb_array_elements(p->'checks') LOOP
   IF check_row->'provider'<>'null'::jsonb AND NOT EXISTS(
    SELECT 1 FROM app_moderation_v2.p3_call_starts st JOIN app_moderation_v2.p3_evaluation_evidence ev ON ev.request_id=st.request_id AND ev.attempt_id=st.attempt_id
    WHERE st.request_id=req AND st.check_key=check_row->>'check_id'||':'||(check_row->'target')::text AND st.input_sha256=check_row->>'input_sha256' AND ev.snapshot=e.snapshot AND ev.evaluator_build=e.evaluator_build
   ) THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
  END LOOP;
  -- Never erase collected local/provider flags, including a flag accompanying a
  -- failed check. Failed checks may retry; flagged inputs may not seek a clean run.
  FOR checkpoint IN SELECT x.* FROM app_moderation_v2.p3_checkpoints x JOIN app_moderation_v2.p3_evaluation_evidence ev USING(request_id,attempt_id) WHERE x.request_id=req AND ev.snapshot=e.snapshot AND (x.payload->>'state'='flagged' OR x.payload#>>'{provider,flagged}'='true') LOOP
   SELECT value INTO current_check FROM jsonb_array_elements(p->'checks') WHERE value->>'check_id'=checkpoint.payload->>'check_id' AND value->'target'=checkpoint.payload->'target';
   IF current_check IS NULL OR current_check->>'state'='passed' OR current_check->>'input_sha256' IS DISTINCT FROM checkpoint.payload->>'input_sha256' THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
   IF checkpoint.payload#>>'{provider,flagged}'='true' THEN
    FOR cat IN SELECT value FROM jsonb_array_elements(checkpoint.payload#>'{provider,categories}') WHERE value->>'flagged'='true' LOOP
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current_check#>'{provider,categories}') x WHERE x->>'category'=cat->>'category' AND x->>'flagged'='true') THEN RETURN jsonb_build_object('success',false,'error','INVALID_RESULT');END IF;
    END LOOP;
   END IF;
  END LOOP;
  config_failure:=EXISTS(SELECT 1 FROM jsonb_array_elements(p->'checks') x WHERE x->'reason_codes' ?| ARRAY['PROVIDER_AUTH','PROVIDER_INPUT']);
  IF NOT app_moderation_v2.p3_runtime_gate(r.request_lane) OR r.request_lane<>'enforce' OR policy.is_approved IS DISTINCT FROM true OR policy.approved_evaluator_build IS DISTINCT FROM e.evaluator_build OR NOT app_moderation_v2.p3_publication_boundary_verified() OR NOT app_moderation_v2.p3_automation_allowed() THEN decision:='routed_to_admin';
  ELSIF p->>'outcome'='no_review_flags' THEN decision:=CASE WHEN app_moderation_v2.p3_eligible(l.id) THEN 'auto_approved' ELSE 'routed_to_admin' END;
  ELSIF p->>'outcome'='needs_review' THEN decision:='routed_to_admin';
  ELSE
   SELECT bool_or(x->>'state'='failed'),bool_and(CASE WHEN x->>'state'='failed' THEN (x->>'retryable')::boolean ELSE true END) INTO has_failure,retryable FROM jsonb_array_elements(p->'checks') x;
   SELECT min(cl.attempt_number) INTO schema_first FROM app_moderation_v2.p3_evaluation_results z JOIN app_moderation_v2.input_claims cl USING(request_id,attempt_id) WHERE z.request_id=req AND EXISTS(SELECT 1 FROM jsonb_array_elements(z.payload->'checks') x WHERE x->'reason_codes' ? 'PROVIDER_SCHEMA');
   IF schema_first IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(p->'checks') x WHERE x->'reason_codes' ? 'PROVIDER_SCHEMA') THEN schema_first:=c.attempt_number;END IF;
   SELECT max(retry_after_seconds),max(recorded_at+make_interval(secs=>retry_after_seconds)) INTO provider_delay,provider_until FROM app_moderation_v2.p3_checkpoints WHERE request_id=req AND attempt_id=a;
   IF has_failure IS TRUE AND retryable IS TRUE AND NOT config_failure AND r.attempt_count<3 AND (schema_first IS NULL OR c.attempt_number<schema_first+1) AND coalesce(provider_delay,0)<=900 AND NOT EXISTS(SELECT 1 FROM app_moderation_v2.p3_circuit_events WHERE policy_version=r.policy_version) THEN
    decision:='awaiting_retry';next_time:=greatest(clock_timestamp()+make_interval(secs=>CASE WHEN r.attempt_count<=1 THEN 10 ELSE 20 END+floor(random()*6)::int),provider_until);
   ELSE decision:='escalated_to_admin';END IF;
  END IF;
 END IF;
 -- Read the clock AFTER every lock/manifest/schema check, never a pre-lock now().
 IF c.lease_expires_at<=clock_timestamp() OR c.max_renewal_until<=clock_timestamp() OR c.attempt_started_at+interval '240 seconds'<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM app_moderation_v2.input_admission_slots WHERE slot_id=c.slot_id AND active_claim_id=c.id AND slot_expires_at>clock_timestamp()) THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END IF;
 response:=jsonb_build_object('success',true,'decision',decision);IF next_time IS NOT NULL THEN response:=response||jsonb_build_object('next_attempt_at',next_time);END IF;
 BEGIN
 IF config_failure AND decision<>'superseded' THEN INSERT INTO app_moderation_v2.p3_circuit_events(policy_version,reason) VALUES(r.policy_version,CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p->'checks') x WHERE x->'reason_codes' ? 'PROVIDER_AUTH') THEN 'PROVIDER_AUTH' ELSE 'PROVIDER_INPUT' END) ON CONFLICT DO NOTHING;END IF;
 INSERT INTO app_moderation_v2.p3_evaluation_results(request_id,attempt_id,payload_digest,payload,response) VALUES(req,a,payload_hash,p,response);
 IF decision='auto_approved' THEN
  -- This branch has no activation permission: the explicit B2/B4 interlock is
  -- false in this candidate. Never use the invalidation permit for attachment.
  UPDATE public.listing_media m SET original_storage_path=o.logical_key,thumbnail_storage_path=t.logical_key,medium_storage_path=d.logical_key,large_storage_path=g.logical_key,width=canon.width,height=canon.height
  FROM app_moderation_v2.seal_media_bindings b JOIN app_moderation_v2.seal_objects o ON o.asset_version=b.asset_version AND o.variant='original' JOIN app_moderation_v2.seal_objects t ON t.asset_version=b.asset_version AND t.variant='thumb' JOIN app_moderation_v2.seal_objects d ON d.asset_version=b.asset_version AND d.variant='medium' JOIN app_moderation_v2.seal_objects g ON g.asset_version=b.asset_version AND g.variant='large' JOIN app_moderation_v2.seal_objects canon ON canon.asset_version=b.asset_version AND canon.variant='canonical'
  WHERE m.id=b.media_id AND m.listing_id=l.id AND b.listing_id=l.id;
  GET DIAGNOSTICS attached=ROW_COUNT;
  IF attached<>jsonb_array_length(e.snapshot->'media') THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Atomic attachment membership conflict';END IF;
  UPDATE public.listings SET status='active',published_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 days',rejection_reason=NULL WHERE id=l.id;
 END IF;
 UPDATE app_moderation_v2.requests SET status=CASE WHEN decision='superseded' THEN 'superseded' WHEN decision='awaiting_retry' THEN 'retry' ELSE 'completed' END,phase=CASE WHEN decision='awaiting_retry' THEN 'evaluation' ELSE 'complete' END,next_attempt_at=coalesce(next_time,next_attempt_at),updated_at=clock_timestamp() WHERE id=req;
 UPDATE app_moderation_v2.input_claims SET status=CASE WHEN decision='superseded' THEN 'evaluation_superseded' ELSE 'evaluation_completed' END,updated_at=clock_timestamp() WHERE id=c.id;
 UPDATE app_moderation_v2.input_admission_slots SET active_claim_id=NULL,slot_acquired_at=NULL,slot_expires_at=NULL WHERE slot_id=c.slot_id AND active_claim_id=c.id;
 IF c.lease_expires_at<=clock_timestamp() OR c.attempt_started_at+interval '240 seconds'<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P3L01',MESSAGE='Finalization deadline exceeded';END IF;
 EXCEPTION WHEN SQLSTATE 'P3L01' THEN RETURN jsonb_build_object('success',false,'error','LEASE_EXPIRED');END;
 RETURN response;
END $$;
ALTER FUNCTION app_moderation_v2.p3_finish_evaluation(uuid,uuid,text,jsonb) OWNER TO mv2_p3_finalize;
CREATE FUNCTION app_moderation_v2.p3_finalize_evaluation(p_secret text,req uuid,a uuid,token text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;RETURN app_moderation_v2.p3_finish_evaluation(req,a,token,p);END $$;
ALTER FUNCTION app_moderation_v2.p3_finalize_evaluation(text,uuid,uuid,text,jsonb) OWNER TO mv2_p3_finalize;
CREATE FUNCTION app_moderation_v2.p3_get_attempt(p_secret text,req uuid,a uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE response jsonb;BEGIN IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;SELECT z.response INTO response FROM app_moderation_v2.p3_evaluation_results z WHERE request_id=req AND attempt_id=a;RETURN response;END $$;
ALTER FUNCTION app_moderation_v2.p3_get_attempt(text,uuid,uuid) OWNER TO mv2_p3_finalize;

-- Seller text edits have their OWN narrow function owner and row-guard rule.
-- The media invalidation permit still cannot change a single text/path field.
CREATE FUNCTION app_moderation_v2.p3_requeue(req_listing uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings;old_request app_moderation_v2.requests;id uuid;BEGIN
 SELECT * INTO STRICT l FROM public.listings WHERE listings.id=req_listing FOR UPDATE;
 SELECT q.* INTO old_request FROM app_moderation_v2.requests q WHERE q.listing_id=l.id AND q.request_lane='enforce' ORDER BY q.listing_revision DESC,q.created_at DESC,q.id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Existing server-selected V2 generation required';END IF;
 UPDATE app_moderation_v2.requests SET status='superseded',updated_at=clock_timestamp() WHERE listing_id=l.id AND status NOT IN('completed','failed','superseded');
 INSERT INTO app_moderation_v2.requests(listing_id,listing_revision,protocol_version,policy_version,request_lane,original_title,original_description) VALUES(l.id,l.revision,2,old_request.policy_version,old_request.request_lane,l.title,l.description) RETURNING requests.id INTO id;RETURN id;END $$;
ALTER FUNCTION app_moderation_v2.p3_requeue(uuid) OWNER TO mv2_p3_lease;
CREATE FUNCTION app_moderation_v2.p3_edit_text(p_listing uuid,p_revision int,p_title text,p_description text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings;id uuid;BEGIN
 IF session_user='postgres' OR NOT pg_has_role(session_user,'mv2_p3_media_editor','SET') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('mv2_p3_registrar','mv2_p3_retirement','mv2_p3_worker','mv2_p3_register','mv2_p3_retire','mv2_p3_guard','mv2_p3_edit','mv2_p3_text','mv2_p3_lease','mv2_p3_finalize','mv2_p3_registry_owner') AND pg_has_role(session_user,oid,'SET')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent edit authority required';END IF;
 SELECT * INTO STRICT l FROM public.listings WHERE listings.id=p_listing FOR UPDATE;
 IF l.seller_id IS DISTINCT FROM app_moderation_v2.p3_actor_uid() OR NOT app_moderation_v2.p3_protected(l.id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Owner authorization required';END IF;
 IF l.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Revision conflict';END IF;
 IF l.status NOT IN('pending_review','active','reserved','paused') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Text edit unavailable';END IF;
 UPDATE public.listings SET title=p_title,description=p_description,status='pending_review',revision=l.revision+1,submitted_at=CASE WHEN l.status='pending_review' THEN submitted_at ELSE clock_timestamp() END WHERE listings.id=l.id;
 id:=app_moderation_v2.p3_requeue(l.id);RETURN jsonb_build_object('success',true,'listing_id',l.id,'revision',l.revision+1,'request_id',id);END $$;
ALTER FUNCTION app_moderation_v2.p3_edit_text(uuid,integer,text,text) OWNER TO mv2_p3_text;
CREATE FUNCTION app_moderation_v2.p3_ack_cleanup(p_asset uuid,p_object uuid,p_sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE lid uuid;BEGIN
 SELECT listing_id INTO lid FROM app_moderation_v2.seal_retirements WHERE asset_version=p_asset;IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Committed logical retirement required';END IF;
 PERFORM 1 FROM public.listings WHERE id=lid FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM app_moderation_v2.seal_objects o JOIN app_moderation_v2.seal_bundles b USING(asset_version) WHERE o.asset_version=p_asset AND o.object_id=p_object AND o.sha256=p_sha AND b.listing_id=lid) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Cleanup identity mismatch';END IF;
 INSERT INTO app_moderation_v2.p3_cleanup_receipts(asset_version,object_id,sha256) VALUES(p_asset,p_object,p_sha) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('success',true);END $$;
ALTER FUNCTION app_moderation_v2.p3_ack_cleanup(uuid,uuid,text) OWNER TO mv2_p3_retire;

-- All creator defaults hardened together; only specifically named new functions.
DO $$ DECLARE f record;BEGIN FOR f IN SELECT p.oid::regprocedure AS identity FROM pg_proc p WHERE p.pronamespace='app_moderation_v2'::regnamespace AND p.proname LIKE 'p3_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.identity);
END LOOP;END $$;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_protected(uuid) TO mv2_p3_register,mv2_p3_retire,mv2_p3_edit,mv2_p3_text,mv2_p3_lease,mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_compact(json) TO mv2_p3_register,mv2_p3_lease,mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_worker_authorized(text),app_moderation_v2.p3_runtime_gate(text),app_moderation_v2.p3_text_valid(text,text) TO mv2_p3_lease,mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_eligible(uuid),app_moderation_v2.p3_automation_allowed(),app_moderation_v2.p3_publication_boundary_verified() TO mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_manifest(uuid) TO mv2_p3_lease,mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_full_snapshot(uuid) TO mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_actor_uid() TO mv2_p3_edit,mv2_p3_text;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_keys(jsonb,text[]) TO mv2_p3_lease;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_policy_lock(text,boolean) TO mv2_p3_lease,mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_valid_evaluation(jsonb,jsonb,uuid,uuid) TO mv2_p3_lease;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_lock_attempt(uuid,uuid,text,boolean) TO mv2_p3_finalize;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_requeue(uuid) TO mv2_p3_edit,mv2_p3_text;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_claim_evaluation(text,uuid,text,text),app_moderation_v2.p3_heartbeat_evaluation(text,uuid,uuid,text),app_moderation_v2.p3_reserve_call(text,uuid,uuid,text,text,jsonb,text),app_moderation_v2.p3_checkpoint_evaluation(text,uuid,uuid,text,jsonb,integer),app_moderation_v2.p3_recover_evaluation(text,uuid,uuid),app_moderation_v2.p3_finalize_evaluation(text,uuid,uuid,text,jsonb),app_moderation_v2.p3_get_attempt(text,uuid,uuid) TO mv2_p3_worker;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_register_bundle(uuid,uuid,integer,uuid,text,jsonb) TO mv2_p3_registrar;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_retire_bundle(uuid),app_moderation_v2.p3_ack_cleanup(uuid,uuid,text) TO mv2_p3_retirement;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_edit_media(uuid,integer,uuid,integer,boolean,boolean),app_moderation_v2.p3_edit_text(uuid,integer,text,text) TO mv2_p3_media_editor;
REVOKE CREATE ON SCHEMA app_moderation_v2 FROM mv2_p3_lease,mv2_p3_finalize,mv2_p3_text,mv2_p3_guard,mv2_p3_retire,mv2_p3_registry_owner;


DO $$ BEGIN
 IF (SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_v2_enabled') IS DISTINCT FROM 'false' OR (SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_v2_mode') IS DISTINCT FROM 'disabled' OR app_moderation_v2.p3_publication_boundary_verified() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Publication boundary changed';END IF;
 IF has_schema_privilege('authenticated','app_moderation_v2','USAGE') OR has_schema_privilege('anon','app_moderation_v2','USAGE') OR has_function_privilege('service_role','app_moderation_v2.p3_protected(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected application privilege';END IF;
END $$;
