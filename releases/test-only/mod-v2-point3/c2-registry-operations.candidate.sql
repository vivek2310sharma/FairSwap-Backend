-- UNAPPLIED rollback-validation candidate; not a migration-history entry.
-- Extends the 69-version FairSwapTest foundation. Never run standalone on Prod.
BEGIN;
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
COMMIT;
