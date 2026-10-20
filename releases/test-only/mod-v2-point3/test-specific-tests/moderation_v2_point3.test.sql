-- Execute only inside an operator-controlled transaction ending in ROLLBACK.
-- Real application tables, synthetic data, no provider/Storage/network work.
CREATE SCHEMA modv2_test;
REVOKE ALL ON SCHEMA modv2_test FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE modv2_test.results(n bigint GENERATED ALWAYS AS IDENTITY,label text NOT NULL,status text NOT NULL,sqlstate text,unexpected_success boolean NOT NULL DEFAULT false);
CREATE TABLE modv2_test.fixture_listings(id uuid PRIMARY KEY);
CREATE FUNCTION modv2_test.suppress_fixture_email() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM modv2_test.fixture_listings WHERE id=NEW.listing_id) THEN RETURN NULL;END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION modv2_test.suppress_fixture_email() FROM PUBLIC;
CREATE TRIGGER aaa_modv2_test_no_email BEFORE INSERT ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION modv2_test.suppress_fixture_email();
CREATE FUNCTION modv2_test.ok(label text,condition boolean) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$ BEGIN INSERT INTO modv2_test.results(label,status) VALUES(label,CASE WHEN condition IS TRUE THEN 'PASS' ELSE 'FAIL' END);RAISE NOTICE '# MODV2_CASE:%',json_build_object('name',label,'status',CASE WHEN condition IS TRUE THEN 'PASS' ELSE 'FAIL' END,'sqlstate',NULL);END $$;
CREATE FUNCTION modv2_test.deny(label text,actor text,statement text,expected text DEFAULT '42501') RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE observed text;was_allowed boolean:=false;BEGIN
 BEGIN
  EXECUTE format('SET LOCAL ROLE %I',actor);EXECUTE statement;EXECUTE 'RESET ROLE';was_allowed:=true;RAISE EXCEPTION USING ERRCODE='ZX001',MESSAGE='rollback unexpected success';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS observed=RETURNED_SQLSTATE;END;
 IF was_allowed THEN observed:=NULL;END IF;
 INSERT INTO modv2_test.results(label,status,sqlstate,unexpected_success) VALUES(label,CASE WHEN NOT was_allowed AND observed=expected THEN 'PASS' ELSE 'FAIL' END,observed,was_allowed);RAISE NOTICE '# MODV2_CASE:%',json_build_object('name',label,'status',CASE WHEN NOT was_allowed AND observed=expected THEN 'PASS' ELSE 'FAIL' END,'sqlstate',observed,'unexpected_success',was_allowed);END $$;
CREATE FUNCTION modv2_test.protected_fingerprint() RETURNS text LANGUAGE plpgsql SET search_path='' AS $$
DECLARE relation record;v_rows jsonb;v_state jsonb:='[]';BEGIN
 FOR relation IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='modv2_private' ORDER BY tablename LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text),''[]''::jsonb) FROM modv2_private.%I item',relation.tablename) INTO v_rows;
  v_state:=v_state||jsonb_build_array(jsonb_build_array(relation.tablename,v_rows));
 END LOOP;
 v_state:=jsonb_build_array(v_state,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.listings l JOIN modv2_test.fixture_listings f ON f.id=l.id),
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.listing_media m JOIN modv2_test.fixture_listings f ON f.id=m.listing_id),
  (SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='modv2_private' OR c.oid IN('public.listings'::regclass,'public.listing_media'::regclass)),
  (SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.proconfig,pg_get_functiondef(p.oid)) ORDER BY p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('modv2_private','modv2_api') AND p.prokind='f'),
  (SELECT jsonb_agg(jsonb_build_array(t.oid,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN('public.listings'::regclass,'public.listing_media'::regclass) AND NOT t.tgisinternal));
 RETURN encode(sha256(convert_to(v_state::text,'UTF8')),'hex');END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA modv2_test FROM PUBLIC;

INSERT INTO modv2_test.fixture_listings SELECT ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,5) n;
INSERT INTO auth.users(id,email,raw_user_meta_data,created_at,updated_at) VALUES('a3900000-0000-4000-8000-000000000001','modv2-synthetic@example.invalid','{"display_name":"Synthetic Point3 Test","terms_accepted":true,"terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":true}',clock_timestamp(),clock_timestamp());
INSERT INTO public.listings(id,seller_id,category_id,city_id,title,description,condition,price_type,pin_code)
SELECT f.id,'a3900000-0000-4000-8000-000000000001',
 (SELECT id FROM public.categories WHERE macro_category='goods' AND is_active AND new_listing_enabled ORDER BY id LIMIT 1),
 (SELECT id FROM public.cities ORDER BY id LIMIT 1),'Synthetic Point3 chair','Synthetic description भारत for database security validation','good','free','110001' FROM modv2_test.fixture_listings f;
INSERT INTO public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes,original_storage_path,thumbnail_storage_path,medium_storage_path,large_storage_path)
SELECT ('a3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a3900000-0000-4000-8000-000000000001','synthetic.jpg','image/jpeg',100,'synthetic/'||n||'/original.jpg','synthetic/'||n||'/thumb.webp','synthetic/'||n||'/medium.webp','synthetic/'||n||'/large.webp' FROM generate_series(1,5) n;
UPDATE public.listing_media SET processing_status='ready',width=20,height=20 WHERE listing_id IN (SELECT id FROM modv2_test.fixture_listings);
DO $$ DECLARE l uuid;m uuid;asset uuid;objects jsonb;o jsonb;n integer;v text;j integer;BEGIN
 FOR n IN 1..5 LOOP
  l:=('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;m:=('a3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;asset:=('a3300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  UPDATE public.listings SET cover_photo_id=m WHERE id=l;
  SET LOCAL ROLE mv2_sealer;
  PERFORM modv2_api.enroll_moderation_v2(l,1);
  RESET ROLE;
  objects:='[]';j:=0;
  FOREACH v IN ARRAY ARRAY['original','canonical','thumb','medium','large'] LOOP
   o:=jsonb_build_object('object_id',('a3400000-0000-4000-8000-'||lpad((n*10+j)::text,12,'0'))::uuid,'variant',v,'bucket',CASE WHEN v IN ('original','canonical') THEN 'listing-originals' ELSE 'listing-derivatives' END,'logical_key',l||'/'||m||'/v2/'||asset||'/'||repeat('a',64)||'/'||v||CASE WHEN v='original' THEN '.jpg' ELSE '.webp' END,'sha256',repeat('a',64),'bytes',100+j,'width',20,'height',20);objects:=objects||jsonb_build_array(o);j:=j+1;
  END LOOP;
  SET LOCAL ROLE mv2_sealer;PERFORM modv2_api.register_moderation_media_bundle_v2(l,m,1,asset,repeat('a',64),objects);RESET ROLE;
 END LOOP;END $$;

CREATE FUNCTION modv2_test.payload(req uuid,a uuid,s jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE checks jsonb:='[]';c jsonb;field text;k text;cats jsonb;category text;media jsonb;app boolean;target jsonb;h text;BEGIN
 FOREACH field IN ARRAY ARRAY['title','description'] LOOP
  FOREACH k IN ARRAY ARRAY['rule_prohibited_item_wording','rule_shortened_link','rule_payment_before_viewing','openai_text_v2'] LOOP
   c:=jsonb_build_object('check_id',k,'target',jsonb_build_object('kind','text','field',field),'input_sha256',s->>(field||'_sha256'),'state','passed','reason_codes','[]'::jsonb,'retryable',false,'provider',NULL);
   IF k='openai_text_v2' THEN
    cats:='[]';FOREACH category IN ARRAY ARRAY['harassment','harassment/threatening','hate','hate/threatening','illicit','illicit/violent','sexual','sexual/minors','self-harm','self-harm/intent','self-harm/instructions','violence','violence/graphic'] LOOP cats:=cats||jsonb_build_array(jsonb_build_object('category',category,'applicability','evaluated','flagged',false,'score',0));END LOOP;
    c:=c||jsonb_build_object('provider',jsonb_build_object('name','openai','requested_model','omni-moderation-2024-09-26','returned_model','omni-moderation-2024-09-26','response_id','synthetic_response','request_id',NULL,'flagged',false,'categories',cats));
   END IF;checks:=checks||jsonb_build_array(c);
  END LOOP;
 END LOOP;
 FOR media IN SELECT value FROM jsonb_array_elements(s->'media') LOOP
  FOREACH k IN ARRAY ARRAY['image_integrity_v2','openai_image_v2'] LOOP
   c:=jsonb_build_object('check_id',k,'target',jsonb_build_object('kind','image','media_id',media->>'media_id'),'input_sha256',media#>>'{canonical,sha256}','state','passed','reason_codes','[]'::jsonb,'retryable',false,'provider',NULL);
   IF k='openai_image_v2' THEN
    cats:='[]';FOREACH category IN ARRAY ARRAY['harassment','harassment/threatening','hate','hate/threatening','illicit','illicit/violent','sexual','sexual/minors','self-harm','self-harm/intent','self-harm/instructions','violence','violence/graphic'] LOOP
     app:=category=ANY(ARRAY['sexual','self-harm','self-harm/intent','self-harm/instructions','violence','violence/graphic']);cats:=cats||jsonb_build_array(jsonb_build_object('category',category,'applicability',CASE WHEN app THEN 'evaluated' ELSE 'not_applicable' END,'flagged',CASE WHEN app THEN false ELSE NULL END,'score',CASE WHEN app THEN 0 ELSE NULL END));END LOOP;
    c:=c||jsonb_build_object('provider',jsonb_build_object('name','openai','requested_model','omni-moderation-2024-09-26','returned_model','omni-moderation-2024-09-26','response_id','synthetic_response','request_id',NULL,'flagged',false,'categories',cats));
   END IF;checks:=checks||jsonb_build_array(c);
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('contract_version','2.0.0','policy_version','fairswap_moderation_v2.0.0','evaluator_version','v2.0.0','request_id',req,'attempt_id',a,'evaluated_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'phase','evaluation','snapshot',s,'checks',checks,'outcome','no_review_flags');END $$;
REVOKE ALL ON FUNCTION modv2_test.payload(uuid,uuid,jsonb) FROM PUBLIC;

DO $$ DECLARE actor text;req uuid;a uuid:=gen_random_uuid();tok uuid:=gen_random_uuid();s jsonb;p jsonb;q jsonb;r jsonb;key text;mf json;before_fingerprint text;listing uuid:='a3000000-0000-4000-8000-000000000001';BEGIN
 PERFORM modv2_test.ok('private role boundaries',NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname LIKE 'mv2\_%' ESCAPE '\' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)));
 before_fingerprint:=modv2_test.protected_fingerprint();SET LOCAL ROLE service_role;PERFORM public.rls_auto_enable();RESET ROLE;
 PERFORM modv2_test.ok('legacy event routine direct call cannot alter protected facts or privileges',before_fingerprint=modv2_test.protected_fingerprint());
 PERFORM modv2_test.ok('service_role has no trusted SET paths',NOT EXISTS(SELECT 1 FROM unnest(ARRAY['mv2_owner','mv2_guard','mv2_register','mv2_queue','mv2_finalize','mv2_edit','mv2_retire','mv2_media_editor']) AS trusted(role_name) WHERE pg_has_role('service_role',trusted.role_name,'SET')));
 PERFORM modv2_test.ok('media owner has narrow identity-reader execution',has_function_privilege('mv2_edit','modv2_private.actor_uid()','EXECUTE'));
 PERFORM modv2_test.ok('ordinary roles cannot execute private identity reader',NOT has_function_privilege('service_role','modv2_private.actor_uid()','EXECUTE') AND NOT has_function_privilege('authenticated','modv2_private.actor_uid()','EXECUTE') AND NOT has_function_privilege('anon','modv2_private.actor_uid()','EXECUTE'));
 PERFORM modv2_test.ok('identity reader owner and search path are pinned',(SELECT pg_get_userbyid(proowner)='postgres' AND prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='modv2_private.actor_uid()'::regprocedure));
 PERFORM modv2_test.ok('runtime private schema CREATE revoked',NOT has_schema_privilege('mv2_finalize','modv2_private','CREATE') AND NOT has_schema_privilege('service_role','modv2_private','CREATE'));
 PERFORM modv2_test.ok('all five variants per bundle',(SELECT count(*)=25 AND count(DISTINCT logical_key)=25 FROM modv2_private.objects));
 PERFORM modv2_test.ok('ordinary role cannot truncate shared tables',NOT has_table_privilege('service_role','public.listings','TRUNCATE') AND NOT has_table_privilege('service_role','public.listing_media','TRIGGER'));
 PERFORM modv2_test.ok('V2 enqueue never enters V1 queue',NOT EXISTS(SELECT 1 FROM public.listing_moderation_requests WHERE listing_id IN(SELECT id FROM modv2_test.fixture_listings) AND status IN ('pending','claimed','retry')));
 PERFORM modv2_test.ok('release interlock prevents enable',NOT modv2_private.enabled());
 PERFORM modv2_test.ok('UTF16 text-length agreement',modv2_private.js_trimmed_length('😀😀')=4);
 PERFORM modv2_test.ok('ECMAScript Unicode trim agreement',modv2_private.js_trimmed_length(U&'\00A0\FEFFabc\3000')=3);
 PERFORM set_config('request.jwt.claims','{"sub":"a3900000-0000-4000-8000-000000000001","role":"authenticated"}',true);
 PERFORM modv2_test.ok('synthetic seller identity is established',auth.uid()='a3900000-0000-4000-8000-000000000001'::uuid);
 PERFORM modv2_test.ok('synthetic seller meets account and policy prerequisites',app_security.get_account_status(auth.uid())='active' AND app_security.has_current_policy_acceptance(auth.uid()));
 PERFORM modv2_test.deny('enrollment rejects null expected revision','mv2_sealer','SELECT modv2_api.enroll_moderation_v2('''||listing||''',NULL)','PT409');
 PERFORM modv2_test.deny('text edit rejects null expected revision','authenticated','SELECT modv2_api.edit_moderation_v2_text('''||listing||''',NULL,''Synthetic changed title'',''Synthetic changed description'')','PT409');
 FOREACH actor IN ARRAY ARRAY['service_role','authenticated'] LOOP
  PERFORM modv2_test.deny(actor||' registry replacement',actor,'UPDATE modv2_private.media_binding SET asset_version=gen_random_uuid()');
  PERFORM modv2_test.deny(actor||' path substitution',actor,'UPDATE public.listing_media SET medium_storage_path=''synthetic/substitute.webp'' WHERE listing_id='''||listing||'''');
  PERFORM modv2_test.deny(actor||' forged publication',actor,'UPDATE public.listings SET status=''active'' WHERE id='''||listing||'''');
  PERFORM modv2_test.deny(actor||' registry deletion',actor,'DELETE FROM modv2_private.objects');
  PERFORM modv2_test.deny(actor||' enrollment removal',actor,'DELETE FROM modv2_private.enrollment');
  PERFORM modv2_test.deny(actor||' finalizer evidence forgery',actor,'DELETE FROM modv2_private.finalizations');
  PERFORM modv2_test.deny(actor||' clear permanent reservations',actor,'TRUNCATE modv2_private.objects CASCADE');
  PERFORM modv2_test.deny(actor||' bypass row guard',actor,'ALTER TABLE public.listings DISABLE TRIGGER zzzz_modv2_guard');
  PERFORM modv2_test.deny(actor||' finalizer call forbidden',actor,'SELECT modv2_api.finalize_moderation_v2(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),''{}'')');
  PERFORM modv2_test.deny(actor||' private schema shadow',actor,'CREATE FUNCTION modv2_private.attack() RETURNS integer LANGUAGE sql AS ''SELECT 1''');
  PERFORM modv2_test.deny(actor||' forged internal GUC',actor,'SET fairswap.internal=''true''; SET request.jwt.claims=''{}''; UPDATE public.listings SET status=''active'' WHERE id='''||listing||'''');
 END LOOP;
 PERFORM modv2_test.deny('legacy owner approval trampoline','postgres','UPDATE public.listings SET status=''active'' WHERE id='''||listing||'''');
 PERFORM modv2_test.deny('owner evidence update still append-only','mv2_owner','UPDATE modv2_private.policy SET publication_verified=false');
 PERFORM modv2_test.deny('release interlock cannot be toggled','postgres','INSERT INTO modv2_private.policy VALUES(''other'',''2.0.0'',''omni-moderation-2024-09-26'',ARRAY[''v2.0.0''],''seal_v1'',true)','23514');
 SELECT request_id INTO req FROM modv2_private.requests WHERE listing_id=listing AND status='pending';
 s:=modv2_private.snapshot(listing);mf:=modv2_private.manifest(listing);p:=modv2_test.payload(req,a,s);
 PERFORM modv2_test.ok('complete contract result accepted',modv2_private.valid_evaluation(p,s,req,a));
 FOREACH key IN ARRAY ARRAY['contract_version','policy_version','evaluator_version','request_id','attempt_id','evaluated_at','phase','snapshot','checks','outcome'] LOOP
  PERFORM modv2_test.ok('reject missing top field '||key,modv2_private.valid_evaluation(p-key,s,req,a) IS DISTINCT FROM true);
  PERFORM modv2_test.ok('reject null top field '||key,modv2_private.valid_evaluation(jsonb_set(p,ARRAY[key],'null'),s,req,a) IS DISTINCT FROM true);
 END LOOP;
 PERFORM modv2_test.ok('reject unknown public envelope field',NOT modv2_private.valid_evaluation(p||'{"storage_url":"synthetic"}',s,req,a));
 PERFORM modv2_test.ok('reject extra text target',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks,0,target,field}','"other"'),s,req,a));
 PERFORM modv2_test.ok('reject duplicate check',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks}',p->'checks'||jsonb_build_array(p#>'{checks,0}')),s,req,a));
 PERFORM modv2_test.ok('reject incomplete clean result',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks}',(p->'checks')-0),s,req,a));
 PERFORM modv2_test.ok('reject wrong requested model',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks,3,provider,requested_model}','"omni-moderation-latest"'),s,req,a));
 PERFORM modv2_test.ok('reject wrong returned model',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks,3,provider,returned_model}','"omni-moderation-latest"'),s,req,a));
 PERFORM modv2_test.ok('reject unsupported image category false coverage',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks,9,provider,categories,0,flagged}','false'),s,req,a));
 PERFORM modv2_test.ok('reject provider flag contradiction',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks,3,provider,flagged}','true'),s,req,a));
 PERFORM modv2_test.ok('reject wrong input digest',NOT modv2_private.valid_evaluation(jsonb_set(p,'{checks,0,input_sha256}',to_jsonb(repeat('b',64))),s,req,a));
 PERFORM modv2_test.ok('reject source snapshot substitution',NOT modv2_private.valid_evaluation(jsonb_set(p,'{snapshot,listing_revision}','99'),s,req,a));
 INSERT INTO modv2_private.attempts VALUES(a,req,'evaluation',s,mf::jsonb,clock_timestamp());
 INSERT INTO modv2_private.leases VALUES(a,req,modv2_private.hash(tok::text),clock_timestamp()+interval '120 seconds',clock_timestamp()+interval '300 seconds',1);
 UPDATE modv2_private.requests SET stage='evaluation',status='claimed',attempt_count=1 WHERE request_id=req;
 SET LOCAL ROLE mv2_worker;r:=modv2_api.finalize_moderation_v2(req,a,tok,p);RESET ROLE;
 PERFORM modv2_test.ok('valid result records gated non-public decision',r='{"success":true,"decision":"routed_to_admin"}'::jsonb);
 PERFORM modv2_test.ok('gate-off never attaches sealed paths',(SELECT original_storage_path='synthetic/1/original.jpg' FROM public.listing_media WHERE listing_id=listing));
 PERFORM modv2_test.ok('gate-off never publishes',(SELECT status='pending_review' FROM public.listings WHERE id=listing));
 SET LOCAL ROLE mv2_worker;q:=modv2_api.finalize_moderation_v2(req,a,gen_random_uuid(),p);RESET ROLE;
 PERFORM modv2_test.ok('matching replay precedes live lease checks',q=r);
 SET LOCAL ROLE mv2_worker;q:=modv2_api.finalize_moderation_v2(req,a,tok,p||'{"extra":true}');RESET ROLE;
 PERFORM modv2_test.ok('changed replay rejected',q->>'error'='IDEMPOTENCY_CONFLICT');
 PERFORM modv2_test.ok('exactly one append-only finalization',(SELECT count(*)=1 FROM modv2_private.finalizations WHERE request_id=req AND attempt_id=a));
 PERFORM modv2_test.ok('no fixture emails admitted',NOT EXISTS(SELECT 1 FROM public.email_outbox WHERE listing_id IN(SELECT id FROM modv2_test.fixture_listings)));
END $$;
DO $$ DECLARE v_n integer;v_listing uuid;v_media uuid;v_asset uuid;v_req uuid;v_attempt uuid;v_token uuid;v_snapshot jsonb;v_payload jsonb;v_response jsonb;v_objects jsonb;v_object uuid;BEGIN
 FOR v_n IN 2..5 LOOP
  v_listing:=('a3000000-0000-4000-8000-'||lpad(v_n::text,12,'0'))::uuid;
  v_media:=('a3200000-0000-4000-8000-'||lpad(v_n::text,12,'0'))::uuid;
  v_asset:=('a3300000-0000-4000-8000-'||lpad(v_n::text,12,'0'))::uuid;
  SELECT request_id INTO STRICT v_req FROM modv2_private.requests WHERE listing_id=v_listing AND status='pending';
  v_attempt:=gen_random_uuid();v_token:=gen_random_uuid();v_snapshot:=modv2_private.snapshot(v_listing);v_payload:=modv2_test.payload(v_req,v_attempt,v_snapshot);
  INSERT INTO modv2_private.attempts VALUES(v_attempt,v_req,'evaluation',v_snapshot,modv2_private.manifest(v_listing)::jsonb,clock_timestamp());
  INSERT INTO modv2_private.leases VALUES(v_attempt,v_req,modv2_private.hash(v_token::text),clock_timestamp()+CASE WHEN v_n=5 THEN interval '-1 second' ELSE interval '120 seconds' END,clock_timestamp()+interval '300 seconds',1);
  UPDATE modv2_private.requests SET stage='evaluation',status='claimed',attempt_count=1 WHERE request_id=v_req;
  IF v_n=2 THEN
   SET LOCAL ROLE authenticated;v_response:=modv2_api.edit_moderation_v2_text(v_listing,1,'Synthetic seller edited chair','Synthetic edited description');RESET ROLE;
   PERFORM modv2_test.ok('authorized text edit advances exact revision',v_response->>'revision'='2' AND (SELECT revision=2 FROM public.listings WHERE id=v_listing));
   PERFORM modv2_test.ok('seller edit replaces generation',(SELECT generation_id::text IS DISTINCT FROM v_snapshot->>'generation_id' FROM modv2_private.listing_state WHERE listing_id=v_listing));
  ELSIF v_n=3 THEN
   SET LOCAL ROLE mv2_retirement;v_response:=modv2_api.retire_moderation_v2(v_asset);RESET ROLE;
   PERFORM modv2_test.ok('retirement withdraws before cleanup',(SELECT status='pending_review' AND revision=2 FROM public.listings WHERE id=v_listing));
   PERFORM modv2_test.ok('retirement reserves all five object identities',(SELECT cardinality(object_ids)=5 FROM modv2_private.gc_outbox WHERE retirement_id=v_asset));
   SELECT jsonb_agg(jsonb_build_object('object_id',o.object_id,'variant',o.variant,'bucket',o.bucket,'logical_key',o.logical_key,'sha256',o.sha256,'bytes',o.bytes,'width',o.width,'height',o.height) ORDER BY o.variant) INTO v_objects FROM modv2_private.objects o WHERE o.asset_version=v_asset;
   PERFORM modv2_test.deny('retired logical asset cannot be registered again','mv2_sealer',format('SELECT modv2_api.register_moderation_media_bundle_v2(%L,%L,2,%L,%L,%L::jsonb)',v_listing,v_media,v_asset,repeat('a',64),v_objects),'23505');
   SELECT object_id INTO v_object FROM modv2_private.objects WHERE asset_version=v_asset AND variant='original';
   PERFORM modv2_test.deny('cleanup receipt rejects substituted digest','mv2_retirement',format('SELECT modv2_api.acknowledge_moderation_v2_gc(%L,%L,%L)',v_asset,v_object,repeat('b',64)),'22023');
   SET LOCAL ROLE mv2_retirement;PERFORM modv2_api.acknowledge_moderation_v2_gc(v_asset,v_object,repeat('a',64));PERFORM modv2_api.acknowledge_moderation_v2_gc(v_asset,v_object,repeat('a',64));RESET ROLE;
   PERFORM modv2_test.ok('cleanup receipt replay preserves one immutable record',(SELECT count(*)=1 FROM modv2_private.gc_receipts WHERE retirement_id=v_asset AND object_id=v_object));
  ELSIF v_n=4 THEN
   -- Operator-only corruption fixture, not an application privilege exemption.
   SET LOCAL ROLE mv2_finalize;UPDATE public.listing_media SET original_storage_path='synthetic/substituted.jpg' WHERE id=v_media;RESET ROLE;
  END IF;
  SET LOCAL ROLE mv2_worker;v_response:=modv2_api.finalize_moderation_v2(v_req,v_attempt,v_token,v_payload);RESET ROLE;
  IF v_n=5 THEN
   PERFORM modv2_test.ok('expired lease cannot finalize',v_response->>'error'='LEASE_EXPIRED');
   PERFORM modv2_test.ok('expired lease creates no finalizer evidence',NOT EXISTS(SELECT 1 FROM modv2_private.finalizations WHERE request_id=v_req));
   DELETE FROM modv2_private.leases WHERE attempt_id=v_attempt;
  ELSE
   PERFORM modv2_test.ok(CASE v_n WHEN 2 THEN 'seller edit makes prior result stale' WHEN 3 THEN 'retirement makes prior result stale' ELSE 'changed media path makes prior result stale' END,v_response='{"success":true,"decision":"superseded"}'::jsonb);
   PERFORM modv2_test.ok('stale result never publishes fixture '||v_n,(SELECT status='pending_review' FROM public.listings WHERE id=v_listing));
  END IF;
 END LOOP;
 PERFORM modv2_test.ok('V2 edits and retirement never enqueue V1',NOT EXISTS(SELECT 1 FROM public.listing_moderation_requests WHERE listing_id IN(SELECT id FROM modv2_test.fixture_listings) AND status IN('pending','claimed','retry')));
END $$;
DO $$ DECLARE old_row jsonb;new_row jsonb;mutated jsonb;listing uuid:='a3000000-0000-4000-8000-000000000001';key text;used boolean;BEGIN
 SELECT to_jsonb(l) INTO old_row FROM public.listings l WHERE id=listing;
 INSERT INTO modv2_private.invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid(),listing,(old_row->>'revision')::integer,1,session_user,clock_timestamp());
 new_row:=jsonb_set(jsonb_set(old_row,'{revision}',to_jsonb((old_row->>'revision')::integer+1)),'{updated_at}',to_jsonb(clock_timestamp()));
 PERFORM modv2_test.ok('permit cannot change title',NOT modv2_private.consume_invalidation(old_row,jsonb_set(new_row,'{title}','"forged"')));
 PERFORM modv2_test.ok('permit cannot publish',NOT modv2_private.consume_invalidation(old_row,jsonb_set(new_row,'{status}','"active"')));
 PERFORM modv2_test.ok('permit cannot change cover',NOT modv2_private.consume_invalidation(old_row,jsonb_set(new_row,'{cover_photo_id}','"a3200000-0000-4000-8000-000000000002"')));
 PERFORM modv2_test.ok('permit cannot change owner',NOT modv2_private.consume_invalidation(old_row,jsonb_set(new_row,'{seller_id}','"a3900000-0000-4000-8000-000000000002"')));
 PERFORM modv2_test.ok('permit cannot add path fields',NOT modv2_private.consume_invalidation(old_row,new_row||'{"original_storage_path":"synthetic/forged"}'));
 PERFORM modv2_test.ok('permit cannot skip revision',NOT modv2_private.consume_invalidation(old_row,jsonb_set(new_row,'{revision}','999')));
 PERFORM modv2_test.ok('permit cannot null expected old revision',NOT modv2_private.consume_invalidation(jsonb_set(old_row,'{revision}','null'),new_row));
 PERFORM modv2_test.ok('permit cannot null new revision',NOT modv2_private.consume_invalidation(old_row,jsonb_set(new_row,'{revision}','null')));
 PERFORM modv2_test.ok('permit cannot null old status',NOT modv2_private.consume_invalidation(jsonb_set(old_row,'{status}','null'),new_row));
 PERFORM modv2_test.ok('permit cannot null updated timestamp',NOT modv2_private.consume_invalidation(old_row,jsonb_set(new_row,'{updated_at}','null')));
 PERFORM modv2_test.ok('permit cannot remove updated timestamp',NOT modv2_private.consume_invalidation(old_row,new_row-'updated_at'));
 PERFORM modv2_test.ok('exact permit consumed once',modv2_private.consume_invalidation(old_row,new_row));
 PERFORM modv2_test.ok('second permit use denied',NOT modv2_private.consume_invalidation(old_row,new_row));
 DELETE FROM modv2_private.invalidation_permits;
 INSERT INTO modv2_private.invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid()+1,listing,(old_row->>'revision')::integer,1,session_user,clock_timestamp());
 new_row:=jsonb_set(new_row,'{updated_at}',to_jsonb(clock_timestamp()));
 PERFORM modv2_test.ok('backend mismatch denied',NOT modv2_private.consume_invalidation(old_row,new_row));DELETE FROM modv2_private.invalidation_permits;
 INSERT INTO modv2_private.invalidation_permits VALUES(((pg_current_xact_id()::text::bigint+1)::text)::xid8,pg_backend_pid(),listing,(old_row->>'revision')::integer,1,session_user,clock_timestamp());
 PERFORM modv2_test.ok('transaction mismatch denied',NOT modv2_private.consume_invalidation(old_row,new_row));DELETE FROM modv2_private.invalidation_permits;
 INSERT INTO modv2_private.invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid(),'a3000000-0000-4000-8000-000000000002',(old_row->>'revision')::integer,1,session_user,clock_timestamp());
 PERFORM modv2_test.ok('listing mismatch denied',NOT modv2_private.consume_invalidation(old_row,new_row));DELETE FROM modv2_private.invalidation_permits;
 INSERT INTO modv2_private.invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid(),listing,(old_row->>'revision')::integer-1,1,session_user,clock_timestamp());
 PERFORM modv2_test.ok('stale permit revision denied',NOT modv2_private.consume_invalidation(old_row,new_row));DELETE FROM modv2_private.invalidation_permits;
 PERFORM modv2_test.deny('service_role cannot insert permit','service_role','INSERT INTO modv2_private.invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid(),gen_random_uuid(),1,1,session_user,clock_timestamp())');
 PERFORM modv2_test.deny('service_role cannot consume permit','service_role','SELECT modv2_private.consume_invalidation(''{}'',''{}'')');
 PERFORM modv2_test.deny('generic owner cannot invoke permit issuer','postgres','SELECT modv2_api.edit_moderation_v2_media('''||listing||''',1,''a3200000-0000-4000-8000-000000000001'',1,false,false)');
 BEGIN
  INSERT INTO modv2_private.invalidation_permits VALUES(pg_current_xact_id(),pg_backend_pid(),listing,(old_row->>'revision')::integer,1,session_user,clock_timestamp());
  RAISE EXCEPTION USING ERRCODE='P0004';
 EXCEPTION WHEN SQLSTATE 'P0004' THEN NULL;END;
 PERFORM modv2_test.ok('rollback leaves no usable permit',NOT EXISTS(SELECT 1 FROM modv2_private.invalidation_permits));
END $$;
SELECT (CASE WHEN status='PASS' THEN 'ok ' ELSE 'not ok ' END)||n||' - '||label FROM modv2_test.results ORDER BY n;
SELECT '1..'||count(*) FROM modv2_test.results;
SELECT '# MODV2_RESULTS:'||json_build_object('total',count(*),'pass',count(*) FILTER(WHERE status='PASS'),'fail',count(*) FILTER(WHERE status='FAIL'),'cases',json_agg(json_build_object('name',label,'status',status,'sqlstate',sqlstate,'unexpected_success',unexpected_success) ORDER BY n))::text FROM modv2_test.results;
