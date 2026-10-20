-- Synthetic fixtures only. Operator composes after candidate DDL; always ROLLBACK.
CREATE SCHEMA p3_test;
REVOKE ALL ON SCHEMA p3_test FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE p3_test.results(n bigint GENERATED ALWAYS AS IDENTITY,name text,status text,sqlstate text);
CREATE TABLE p3_test.baseline AS SELECT * FROM p3_function_baseline;
CREATE FUNCTION p3_test.ok(label text,value boolean) RETURNS void LANGUAGE sql SET search_path='' AS $$ INSERT INTO p3_test.results(name,status) VALUES(label,CASE WHEN value IS TRUE THEN 'PASS' ELSE 'FAIL' END) $$;
CREATE FUNCTION p3_test.deny(label text,actor text,statement text,expected text DEFAULT '42501') RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE observed text;allowed boolean:=false;BEGIN
 BEGIN EXECUTE format('SET LOCAL ROLE %I',actor);EXECUTE statement;EXECUTE 'RESET ROLE';allowed:=true;RAISE EXCEPTION USING ERRCODE='ZX001',MESSAGE='Rollback unexpected success';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS observed=RETURNED_SQLSTATE;END;
 IF allowed THEN observed:=NULL;END IF;
 INSERT INTO p3_test.results(name,status,sqlstate) VALUES(label,CASE WHEN NOT allowed AND observed=expected THEN 'PASS' ELSE 'FAIL' END,observed);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA p3_test FROM PUBLIC;
CREATE FUNCTION p3_test.security_fingerprint() RETURNS text LANGUAGE sql SET search_path='' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(
  (SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app_moderation_v2' OR c.oid IN('public.listings'::regclass,'public.listing_media'::regclass)),
  (SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.proconfig,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('app_moderation_v2','app_security','public') AND p.prokind='f'),
  (SELECT jsonb_agg(to_jsonb(b) ORDER BY asset_version) FROM app_moderation_v2.seal_bundles b WHERE listing_id='b3000000-0000-4000-8000-000000000001')
 )::text,'UTF8')),'hex') $$;
REVOKE ALL ON FUNCTION p3_test.security_fingerprint() FROM PUBLIC;
CREATE FUNCTION p3_test.no_email() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN IF NEW.listing_id IN ('b3000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002') THEN RETURN NULL;END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION p3_test.no_email() FROM PUBLIC;
CREATE TRIGGER aaa_p3_no_email BEFORE INSERT ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION p3_test.no_email();
INSERT INTO auth.users(id,email,raw_user_meta_data,created_at,updated_at) VALUES('b3900000-0000-4000-8000-000000000001','synthetic-p3-c2@example.invalid','{"display_name":"Synthetic C2 Registry","terms_accepted":true,"terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":true}',clock_timestamp(),clock_timestamp());
INSERT INTO public.listings(id,seller_id,category_id,city_id,title,description,condition,price_type,pin_code)
SELECT ('b3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'b3900000-0000-4000-8000-000000000001',(SELECT id FROM public.categories WHERE macro_category='goods' AND is_active AND new_listing_enabled ORDER BY id LIMIT 1),(SELECT id FROM public.cities ORDER BY id LIMIT 1),'Synthetic C2 chair','Synthetic C2 security description भारत','good','free','110001' FROM generate_series(1,2) n;
INSERT INTO public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes,original_storage_path,thumbnail_storage_path,medium_storage_path,large_storage_path)
SELECT ('b3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'b3000000-0000-4000-8000-000000000001','b3900000-0000-4000-8000-000000000001','synthetic.jpg','image/jpeg',100,'synthetic/'||n||'/original.jpg','synthetic/'||n||'/thumb.webp','synthetic/'||n||'/medium.webp','synthetic/'||n||'/large.webp' FROM generate_series(1,2) n;
UPDATE public.listing_media SET processing_status='ready',width=20,height=20 WHERE listing_id='b3000000-0000-4000-8000-000000000001';
UPDATE public.listings SET status='pending_review',cover_photo_id='b3200000-0000-4000-8000-000000000001' WHERE id='b3000000-0000-4000-8000-000000000001';
INSERT INTO app_moderation_v2.requests(listing_id,listing_revision,policy_version,request_lane,phase,status,original_title,original_description)
SELECT id,revision,'fairswap_moderation_v2.0.0','enforce','preparation','awaiting_media',title,description FROM public.listings WHERE id='b3000000-0000-4000-8000-000000000001';
CREATE TABLE p3_test.objects(n int PRIMARY KEY,payload jsonb);
DO $$ DECLARE n int;j int;v text;a uuid;o jsonb;BEGIN FOR n IN 1..2 LOOP
 a:=('b3300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;j:=0;o:='[]';
 FOREACH v IN ARRAY ARRAY['original','canonical','thumb','medium','large'] LOOP
 o:=o||jsonb_build_array(jsonb_build_object('object_id',('b3400000-0000-4000-8000-'||lpad((n*10+j)::text,12,'0'))::uuid,'variant',v,'bucket',CASE WHEN v IN('original','canonical') THEN 'listing-originals' ELSE 'listing-derivatives' END,'logical_key','b3000000-0000-4000-8000-000000000001/b3200000-0000-4000-8000-'||lpad(n::text,12,'0')||'/v2/'||a||'/'||repeat('a',64)||'/'||v||CASE WHEN v='original' THEN '.jpg' ELSE '.webp' END,'sha256',repeat('a',64),'bytes',100,'width',20,'height',20));j:=j+1;
 END LOOP;INSERT INTO p3_test.objects VALUES(n,o);
 PERFORM app_moderation_v2.p3_register_bundle('b3000000-0000-4000-8000-000000000001',('b3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,(SELECT revision FROM public.listings WHERE id='b3000000-0000-4000-8000-000000000001'),a,repeat('a',64),o);
 END LOOP;END $$;
DO $$ DECLARE actor text;t text;r record;before_rows text;event_state text;v text;req uuid;dg text;BEGIN
 PERFORM p3_test.ok('all five registered variants',(SELECT count(*)=10 AND count(DISTINCT logical_key)=10 FROM app_moderation_v2.seal_objects WHERE asset_version IN('b3300000-0000-4000-8000-000000000001','b3300000-0000-4000-8000-000000000002')));
 FOREACH actor IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH t IN ARRAY ARRAY['seal_bundles','seal_objects','seal_media_bindings','seal_retirements','p3_invalidation_permits'] LOOP
   PERFORM p3_test.deny(actor||' cannot delete '||t,actor,format('DELETE FROM app_moderation_v2.%I',t));
   PERFORM p3_test.deny(actor||' cannot truncate '||t,actor,format('TRUNCATE app_moderation_v2.%I CASCADE',t));
   PERFORM p3_test.deny(actor||' cannot mutate '||t,actor,format('UPDATE app_moderation_v2.%I SET %I=%I',t,CASE WHEN t='p3_invalidation_permits' THEN 'remaining' WHEN t='seal_media_bindings' THEN 'media_id' WHEN t='seal_objects' THEN 'object_id' ELSE 'asset_version' END,CASE WHEN t='p3_invalidation_permits' THEN 'remaining' WHEN t='seal_media_bindings' THEN 'media_id' WHEN t='seal_objects' THEN 'object_id' ELSE 'asset_version' END));
  END LOOP;
  PERFORM p3_test.deny(actor||' cannot forge approval',actor,$q$UPDATE public.listings SET status='active' WHERE id='b3000000-0000-4000-8000-000000000001'$q$);
  PERFORM p3_test.deny(actor||' cannot substitute path',actor,$q$UPDATE public.listing_media SET original_storage_path='substitution' WHERE id='b3200000-0000-4000-8000-000000000001'$q$);
  PERFORM p3_test.deny(actor||' cannot invoke registration',actor,$q$SELECT app_moderation_v2.p3_register_bundle(NULL,NULL,NULL,NULL,NULL,NULL)$q$);
  PERFORM p3_test.deny(actor||' cannot invoke retirement',actor,$q$SELECT app_moderation_v2.p3_retire_bundle('b3300000-0000-4000-8000-000000000001')$q$);
  PERFORM p3_test.deny(actor||' cannot invoke media editor',actor,$q$SELECT app_moderation_v2.p3_edit_media(NULL,NULL,NULL)$q$);
  PERFORM p3_test.ok(actor||' cannot SET trusted owners',NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname LIKE 'mv2_p3_%' AND pg_has_role(actor,oid,'SET')));
 END LOOP;
 FOREACH t IN ARRAY ARRAY['seal_bundles','seal_objects','seal_media_bindings','seal_retirements'] LOOP
  PERFORM p3_test.deny('owner cannot delete permanent '||t,'mv2_p3_registry_owner',format('DELETE FROM app_moderation_v2.%I',t));
  PERFORM p3_test.deny('owner cannot truncate permanent '||t,'mv2_p3_registry_owner',format('TRUNCATE app_moderation_v2.%I CASCADE',t));
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'mv2_p3_%' LOOP
  PERFORM p3_test.ok(r.rolname||' has no LOGIN or bypass',(SELECT NOT(rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) FROM pg_roles WHERE rolname=r.rolname));
  PERFORM p3_test.ok(r.rolname||' has no schema CREATE',NOT has_schema_privilege(r.rolname,'app_moderation_v2','CREATE'));
 END LOOP;
 PERFORM p3_test.ok('Auth identity helper narrowly granted',has_function_privilege('mv2_p3_edit','app_moderation_v2.p3_actor_uid()','EXECUTE') AND NOT has_function_privilege('service_role','app_moderation_v2.p3_actor_uid()','EXECUTE'));
 PERFORM p3_test.ok('Auth identity helper safe owner',(SELECT proowner='postgres'::regrole AND prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='app_moderation_v2.p3_actor_uid()'::regprocedure));
 before_rows:=p3_test.security_fingerprint();
 BEGIN SET LOCAL ROLE service_role;PERFORM public.rls_auto_enable();RESET ROLE;EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS event_state=RETURNED_SQLSTATE;END;
 PERFORM p3_test.ok('legacy event call leaves protected evidence unchanged',before_rows=p3_test.security_fingerprint());
 UPDATE p3_test.results SET sqlstate=event_state WHERE n=(SELECT max(n) FROM p3_test.results);
 PERFORM p3_test.ok('manifest includes two source rows',json_array_length(app_moderation_v2.p3_manifest('b3000000-0000-4000-8000-000000000001')->3)=2);
 INSERT INTO app_moderation_v2.requests(listing_id,listing_revision,policy_version,request_lane,phase,status,original_title,original_description)
 SELECT id,revision,'fairswap_moderation_v2.0.0','shadow','preparation','awaiting_media',title,description FROM public.listings WHERE id='b3000000-0000-4000-8000-000000000001' RETURNING id INTO req;
 dg:=app_moderation_v2.p3_snapshot_digest(req);
 PERFORM p3_test.ok('snapshot bound to sole C2 request',dg ~ '^[0-9a-f]{64}$');
 UPDATE app_moderation_v2.requests SET status='superseded' WHERE id=req;
 PERFORM p3_test.deny('superseded C2 request cannot prepare','postgres',format('SELECT app_moderation_v2.p3_snapshot_digest(%L)',req),'PT409');
 PERFORM p3_test.deny('wrong registration revision','postgres',$q$SELECT app_moderation_v2.p3_register_bundle('b3000000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000001',NULL,NULL,NULL,NULL)$q$,'PT409');
 PERFORM p3_test.deny('operator cannot mint media permit','postgres',$q$SELECT app_moderation_v2.p3_edit_media('b3000000-0000-4000-8000-000000000001',NULL,'b3200000-0000-4000-8000-000000000001',1)$q$);
 PERFORM p3_test.ok('no leaked permit',(SELECT count(*)=0 FROM app_moderation_v2.p3_invalidation_permits));
 PERFORM app_moderation_v2.p3_retire_bundle('b3300000-0000-4000-8000-000000000002');
 PERFORM app_moderation_v2.p3_retire_bundle('b3300000-0000-4000-8000-000000000002');
 PERFORM p3_test.ok('idempotent permanent retirement',(SELECT count(*)=1 FROM app_moderation_v2.seal_retirements WHERE asset_version='b3300000-0000-4000-8000-000000000002'));
 PERFORM p3_test.deny('retired bundle prevents manifest','postgres',$q$SELECT app_moderation_v2.p3_manifest('b3000000-0000-4000-8000-000000000001')$q$,'22023');
 PERFORM p3_test.deny('retired identity cannot register','postgres',$q$SELECT app_moderation_v2.p3_register_bundle('b3000000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000002',(SELECT revision FROM public.listings WHERE id='b3000000-0000-4000-8000-000000000001'),'b3300000-0000-4000-8000-000000000002',repeat('a',64),(SELECT payload FROM p3_test.objects WHERE n=2))$q$,'23505');
 PERFORM p3_test.ok('V1 and C2 function bodies and permissions unchanged',NOT EXISTS(SELECT 1 FROM p3_test.baseline b JOIN pg_proc p ON p.oid=b.oid WHERE pg_get_functiondef(p.oid) IS DISTINCT FROM b.definition OR p.proowner IS DISTINCT FROM b.proowner OR p.proacl IS DISTINCT FROM b.proacl OR p.proconfig IS DISTINCT FROM b.proconfig));
 PERFORM p3_test.ok('publication disabled',(SELECT setting_value='false' FROM public.app_system_settings WHERE setting_key='moderation_v2_enabled') AND (SELECT setting_value='disabled' FROM public.app_system_settings WHERE setting_key='moderation_v2_mode'));
END $$;
-- Consumer unit attacks with a harness-inserted permit, not proof of trusted issuance.
DO $$ DECLARE old_row jsonb;new_row jsonb;v jsonb;BEGIN
 SELECT to_jsonb(l) INTO old_row FROM public.listings l WHERE id='b3000000-0000-4000-8000-000000000001';
 new_row:=old_row||jsonb_build_object('revision',(old_row->>'revision')::int+1,'status','pending_review','updated_at',clock_timestamp());
 INSERT INTO app_moderation_v2.p3_invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid(),(old_row->>'id')::uuid,(old_row->>'revision')::int,1,session_user,clock_timestamp()-interval '1 second');
 PERFORM p3_test.ok('consumer rejects publication',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row||'{"status":"active"}'::jsonb));
 PERFORM p3_test.ok('consumer rejects title edits',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row||'{"title":"Substitution"}'::jsonb));
 PERFORM p3_test.ok('consumer rejects cover edits',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row||'{"cover_photo_id":null}'::jsonb));
 PERFORM p3_test.ok('consumer rejects raw generated-vector substitution',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row||'{"search_vector":"untrusted"}'::jsonb));
 PERFORM p3_test.ok('consumer rejects null revision',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row||'{"revision":null}'::jsonb));
 PERFORM p3_test.ok('consumer rejects stale revision',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row||jsonb_build_object('revision',(old_row->>'revision')::int+2)));
 PERFORM p3_test.ok('consumer rejects wrong listing',NOT app_moderation_v2.p3_consume_invalidation(old_row||'{"id":"b3000000-0000-4000-8000-000000000002"}'::jsonb,new_row));
 UPDATE app_moderation_v2.p3_invalidation_permits SET backend_pid=pg_backend_pid()+1;
 PERFORM p3_test.ok('consumer rejects wrong backend',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row));
 UPDATE app_moderation_v2.p3_invalidation_permits SET backend_pid=pg_backend_pid(),transaction_id='1'::xid8;
 PERFORM p3_test.ok('consumer rejects wrong transaction',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row));
 UPDATE app_moderation_v2.p3_invalidation_permits SET transaction_id=pg_current_xact_id(),issued_by='untrusted_synthetic_session';
 PERFORM p3_test.ok('consumer rejects wrong issuer session',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row));
 UPDATE app_moderation_v2.p3_invalidation_permits SET issued_by=session_user;
 PERFORM p3_test.ok('consumer accepts exact one-use transition',app_moderation_v2.p3_consume_invalidation(old_row,new_row));
 PERFORM p3_test.ok('consumer rejects replay',NOT app_moderation_v2.p3_consume_invalidation(old_row,new_row));
 DELETE FROM app_moderation_v2.p3_invalidation_permits;
 -- Actual read-only Auth adapter execution under its intended function owner.
 PERFORM set_config('request.jwt.claim.sub','b3900000-0000-4000-8000-000000000001',true);
 SET LOCAL ROLE mv2_p3_edit;v:=to_jsonb(app_moderation_v2.p3_actor_uid());RESET ROLE;
 PERFORM p3_test.ok('Auth adapter resolves eligible synthetic seller without auth schema grant',v=to_jsonb('b3900000-0000-4000-8000-000000000001'::uuid));
 -- Unprotected synthetic V1 listing: actual write and historical enqueue path.
 SET LOCAL ROLE service_role;UPDATE public.listings SET status='pending_review' WHERE id='b3000000-0000-4000-8000-000000000002';RESET ROLE;
 PERFORM p3_test.ok('unprotected V1 submission still enqueues',EXISTS(SELECT 1 FROM public.listing_moderation_requests WHERE listing_id='b3000000-0000-4000-8000-000000000002' AND status='pending'));
 PERFORM p3_test.ok('registry protection prevents V1 enqueue for protected listing',NOT EXISTS(SELECT 1 FROM public.listing_moderation_requests WHERE listing_id='b3000000-0000-4000-8000-000000000001' AND status='pending' AND created_at>(SELECT min(created_at) FROM app_moderation_v2.seal_bundles WHERE listing_id='b3000000-0000-4000-8000-000000000001')));
END $$;
SELECT json_build_object('cases',(SELECT json_agg(json_build_object('name',name,'status',status,'sqlstate',sqlstate) ORDER BY n) FROM p3_test.results),'executed',(SELECT count(*) FROM p3_test.results),'passed',(SELECT count(*) FROM p3_test.results WHERE status='PASS'),'failed',(SELECT count(*) FROM p3_test.results WHERE status='FAIL'),'transaction','ROLLBACK_REQUIRED') AS report;
