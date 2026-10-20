INSERT INTO public.categories(id,slug,name,macro_category,new_listing_enabled) VALUES('d1000000-0000-4000-8000-000000000001','p3-rollback-synthetic-goods','Synthetic Goods','goods',true);
INSERT INTO public.cities(id,name,state,slug) VALUES('d2000000-0000-4000-8000-000000000001','Synthetic City','Synthetic State','p3-rollback-synthetic-city');
-- Rollback-only synthetic finalizer fixtures. Controller execution is NOT genuine-login evidence.
CREATE SCHEMA p3_eval_test AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA p3_eval_test FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE p3_eval_test.fixture_listings(id uuid PRIMARY KEY);
CREATE FUNCTION p3_eval_test.no_email() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN IF EXISTS(SELECT 1 FROM p3_eval_test.fixture_listings WHERE id=NEW.listing_id) THEN RETURN NULL;END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION p3_eval_test.no_email() FROM PUBLIC;
CREATE TRIGGER aaa_p3_local_no_email BEFORE INSERT ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION p3_eval_test.no_email();
INSERT INTO auth.users(id,email,raw_user_meta_data,created_at,updated_at)
VALUES('d3900000-0000-4000-8000-000000000001','synthetic-c2-rollback@example.invalid','{"display_name":"Synthetic C2 local seller","terms_accepted":true,"terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":true}',clock_timestamp(),clock_timestamp());
CREATE FUNCTION p3_eval_test.fixture() RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE l uuid:=gen_random_uuid();m uuid;mids uuid[]:=ARRAY[]::uuid[];asset uuid;assets uuid[]:=ARRAY[]::uuid[];objs jsonb;allobjs jsonb:='[]';v text;req uuid;a uuid:=gen_random_uuid();claim uuid:=gen_random_uuid();token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');s jsonb;slot smallint;rev int;j int;BEGIN
 INSERT INTO p3_eval_test.fixture_listings VALUES(l);
 INSERT INTO public.listings(id,seller_id,category_id,city_id,title,description,condition,price_type,pin_code) VALUES(l,'d3900000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','Synthetic local chair','Synthetic security description भारत 😀 for local SQL proof','good','free','110001');
 FOR j IN 1..2 LOOP
  m:=gen_random_uuid();mids:=array_append(mids,m);
  INSERT INTO public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes,original_storage_path,thumbnail_storage_path,medium_storage_path,large_storage_path,display_order) VALUES(m,l,'d3900000-0000-4000-8000-000000000001','synthetic.jpg','image/jpeg',100,'synthetic/'||m||'/original.jpg','synthetic/'||m||'/thumb.webp','synthetic/'||m||'/medium.webp','synthetic/'||m||'/large.webp',j-1);
 END LOOP;
 UPDATE public.listing_media SET processing_status='ready',width=20,height=20 WHERE listing_id=l;
 UPDATE public.listings SET status='pending_review',cover_photo_id=mids[1] WHERE id=l RETURNING revision INTO rev;
 INSERT INTO app_moderation_v2.requests(listing_id,listing_revision,policy_version,request_lane,phase,status,original_title,original_description) SELECT id,revision,'fairswap_moderation_v2.0.0','enforce','preparation','awaiting_media',title,description FROM public.listings WHERE id=l RETURNING id INTO req;
 FOREACH m IN ARRAY mids LOOP
  asset:=gen_random_uuid();assets:=array_append(assets,asset);objs:='[]';
  FOREACH v IN ARRAY ARRAY['original','canonical','thumb','medium','large'] LOOP
   objs:=objs||jsonb_build_array(jsonb_build_object('object_id',gen_random_uuid(),'variant',v,'bucket',CASE WHEN v IN('original','canonical') THEN 'listing-originals' ELSE 'listing-derivatives' END,'logical_key',l||'/'||m||'/v2/'||asset||'/'||repeat('a',64)||'/'||v||CASE WHEN v='original' THEN '.jpg' ELSE '.webp' END,'sha256',repeat('a',64),'bytes',100,'width',20,'height',20));
  END LOOP;
  PERFORM app_moderation_v2.p3_register_bundle(l,m,rev,asset,repeat('a',64),objs);allobjs:=allobjs||jsonb_build_array(objs);
 END LOOP;
 s:=app_moderation_v2.p3_full_snapshot(req);
 SELECT slot_id INTO slot FROM app_moderation_v2.input_admission_slots WHERE active_claim_id IS NULL ORDER BY slot_id LIMIT 1 FOR UPDATE;
 IF slot IS NULL THEN RAISE EXCEPTION 'Local fixture slots exhausted';END IF;
 INSERT INTO app_moderation_v2.input_claims(id,request_id,attempt_id,attempt_number,claim_token_hash,slot_id,worker_id,lease_expires_at,attempt_started_at,max_renewal_until,status,phase) VALUES(claim,req,a,1,encode(sha256(convert_to(token,'UTF8')),'hex'),slot,'synthetic-local-fixture',clock_timestamp()+interval '120 seconds',clock_timestamp(),clock_timestamp()+interval '300 seconds','evaluation_active','evaluation');
 INSERT INTO app_moderation_v2.p3_evaluation_evidence(request_id,attempt_id,snapshot,source_manifest,evaluator_build) VALUES(req,a,s,app_moderation_v2.p3_manifest(l)::jsonb,repeat('b',64));
 UPDATE app_moderation_v2.input_admission_slots SET active_claim_id=claim,slot_acquired_at=clock_timestamp(),slot_expires_at=clock_timestamp()+interval '120 seconds' WHERE slot_id=slot;
 UPDATE app_moderation_v2.requests SET phase='evaluation',status='claimed',attempt_count=1 WHERE id=req;
 RETURN jsonb_build_object('listing',l,'media',to_jsonb(mids),'assets',to_jsonb(assets),'objects',allobjs,'request',req,'attempt',a,'claim',claim,'token',token,'revision',rev,'snapshot',s);
END $$;
REVOKE ALL ON FUNCTION p3_eval_test.fixture() FROM PUBLIC;
CREATE FUNCTION p3_eval_test.drop_lease(req uuid,a uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c app_moderation_v2.input_claims;BEGIN SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;UPDATE app_moderation_v2.input_admission_slots SET active_claim_id=NULL,slot_acquired_at=NULL,slot_expires_at=NULL WHERE slot_id=c.slot_id AND active_claim_id=c.id;UPDATE app_moderation_v2.input_claims SET status='evaluation_expired' WHERE id=c.id AND status='evaluation_active';END $$;
REVOKE ALL ON FUNCTION p3_eval_test.drop_lease(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION p3_eval_test.provider(image boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT CASE WHEN image THEN '{"name":"openai","requested_model":"omni-moderation-2024-09-26","returned_model":"omni-moderation-2024-09-26","response_id":"synthetic_rollback","request_id":null,"flagged":false,"categories":[{"category":"harassment","applicability":"not_applicable","flagged":null,"score":null},{"category":"harassment/threatening","applicability":"not_applicable","flagged":null,"score":null},{"category":"hate","applicability":"not_applicable","flagged":null,"score":null},{"category":"hate/threatening","applicability":"not_applicable","flagged":null,"score":null},{"category":"illicit","applicability":"not_applicable","flagged":null,"score":null},{"category":"illicit/violent","applicability":"not_applicable","flagged":null,"score":null},{"category":"sexual","applicability":"evaluated","flagged":false,"score":0},{"category":"sexual/minors","applicability":"not_applicable","flagged":null,"score":null},{"category":"self-harm","applicability":"evaluated","flagged":false,"score":0},{"category":"self-harm/intent","applicability":"evaluated","flagged":false,"score":0},{"category":"self-harm/instructions","applicability":"evaluated","flagged":false,"score":0},{"category":"violence","applicability":"evaluated","flagged":false,"score":0},{"category":"violence/graphic","applicability":"evaluated","flagged":false,"score":0}]}'::jsonb ELSE '{"name":"openai","requested_model":"omni-moderation-2024-09-26","returned_model":"omni-moderation-2024-09-26","response_id":"synthetic_rollback","request_id":null,"flagged":false,"categories":[{"category":"harassment","applicability":"evaluated","flagged":false,"score":0},{"category":"harassment/threatening","applicability":"evaluated","flagged":false,"score":0},{"category":"hate","applicability":"evaluated","flagged":false,"score":0},{"category":"hate/threatening","applicability":"evaluated","flagged":false,"score":0},{"category":"illicit","applicability":"evaluated","flagged":false,"score":0},{"category":"illicit/violent","applicability":"evaluated","flagged":false,"score":0},{"category":"sexual","applicability":"evaluated","flagged":false,"score":0},{"category":"sexual/minors","applicability":"evaluated","flagged":false,"score":0},{"category":"self-harm","applicability":"evaluated","flagged":false,"score":0},{"category":"self-harm/intent","applicability":"evaluated","flagged":false,"score":0},{"category":"self-harm/instructions","applicability":"evaluated","flagged":false,"score":0},{"category":"violence","applicability":"evaluated","flagged":false,"score":0},{"category":"violence/graphic","applicability":"evaluated","flagged":false,"score":0}]}'::jsonb END $$;
REVOKE ALL ON FUNCTION p3_eval_test.provider(boolean) FROM PUBLIC;

CREATE FUNCTION p3_eval_test.payload(f jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE checks jsonb:='[]';field text;id text;m jsonb;BEGIN
 FOREACH field IN ARRAY ARRAY['title','description'] LOOP
  FOREACH id IN ARRAY ARRAY['rule_prohibited_item_wording','rule_shortened_link','rule_payment_before_viewing','openai_text_v2'] LOOP
   checks:=checks||jsonb_build_array(jsonb_build_object('check_id',id,'target',jsonb_build_object('kind','text','field',field),'input_sha256',f#>>ARRAY['snapshot',field||'_sha256'],'state','passed','reason_codes','[]'::jsonb,'retryable',false,'provider',CASE WHEN id='openai_text_v2' THEN p3_eval_test.provider(false) ELSE NULL END));
  END LOOP;
 END LOOP;
 FOR m IN SELECT value FROM jsonb_array_elements(f#>'{snapshot,media}') LOOP
  FOREACH id IN ARRAY ARRAY['image_integrity_v2','openai_image_v2'] LOOP
   checks:=checks||jsonb_build_array(jsonb_build_object('check_id',id,'target',jsonb_build_object('kind','image','media_id',m->>'media_id'),'input_sha256',m#>>'{canonical,sha256}','state','passed','reason_codes','[]'::jsonb,'retryable',false,'provider',CASE WHEN id='openai_image_v2' THEN p3_eval_test.provider(true) ELSE NULL END));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('contract_version','2.0.0','policy_version','fairswap_moderation_v2.0.0','evaluator_version','v2.0.0','request_id',f->>'request','attempt_id',f->>'attempt','evaluated_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'phase','evaluation','snapshot',f->'snapshot','checks',checks,'outcome','no_review_flags');
END $$;
REVOKE ALL ON FUNCTION p3_eval_test.payload(jsonb) FROM PUBLIC;
CREATE FUNCTION p3_eval_test.calls(f jsonb,p jsonb) RETURNS void LANGUAGE sql SET search_path='' AS $$
 INSERT INTO app_moderation_v2.p3_call_starts(request_id,attempt_id,check_key,input_sha256,start_number,deadline) SELECT (f->>'request')::uuid,(f->>'attempt')::uuid,(c->>'check_id')||':'||(c->'target')::text,c->>'input_sha256',1,clock_timestamp()-interval '1 second' FROM jsonb_array_elements(p->'checks') c WHERE c->'provider'<>'null'::jsonb $$;
REVOKE ALL ON FUNCTION p3_eval_test.calls(jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION p3_eval_test.finish(f jsonb,p jsonb) RETURNS jsonb LANGUAGE sql SET search_path='' AS $$ SELECT app_moderation_v2.p3_finish_evaluation((f->>'request')::uuid,(f->>'attempt')::uuid,f->>'token',p) $$;
REVOKE ALL ON FUNCTION p3_eval_test.finish(jsonb,jsonb) FROM PUBLIC;
DO $$ DECLARE f jsonb;p jsonb;z jsonb;k text;BEGIN
 f:=p3_eval_test.fixture();p:=p3_eval_test.payload(f);
 PERFORM p3_test.ok('evaluation: complete canonical envelope accepted',app_moderation_v2.p3_valid_evaluation(p,f->'snapshot',(f->>'request')::uuid,(f->>'attempt')::uuid));
 FOREACH k IN ARRAY ARRAY['contract_version','policy_version','evaluator_version','request_id','attempt_id','evaluated_at','phase','snapshot','checks','outcome'] LOOP
  PERFORM p3_test.ok('evaluation: missing '||k||' rejected',NOT app_moderation_v2.p3_valid_evaluation(p-k,f->'snapshot',(f->>'request')::uuid,(f->>'attempt')::uuid));
 END LOOP;
 PERFORM p3_test.ok('evaluation: input-only result cannot authorize',NOT app_moderation_v2.p3_valid_evaluation(p||'{"phase":"input_validation"}'::jsonb,f->'snapshot',(f->>'request')::uuid,(f->>'attempt')::uuid));
 PERFORM p3_test.ok('evaluation: call-start evidence required',p3_eval_test.finish(f,p)->>'error'='INVALID_RESULT');
 PERFORM p3_eval_test.calls(f,p);
 z:=p3_eval_test.finish(f,p);
 PERFORM p3_test.ok('evaluation: disabled finalizer routes to admin',z->>'decision'='routed_to_admin');
 PERFORM p3_test.ok('evaluation: disabled finalizer cannot publish',EXISTS(SELECT 1 FROM public.listings WHERE id=(f->>'listing')::uuid AND status='pending_review'));
 PERFORM p3_test.ok('evaluation: original paths remain attached',EXISTS(SELECT 1 FROM public.listing_media WHERE id=(f#>>'{media,0}')::uuid AND original_storage_path LIKE 'synthetic/%'));
 PERFORM p3_test.ok('evaluation: matching terminal replay',p3_eval_test.finish(f,p)=z);
 PERFORM p3_test.ok('evaluation: changed replay conflicts',p3_eval_test.finish(f,p||'{"evaluated_at":"2026-10-20T00:00:00Z"}'::jsonb)->>'error'='IDEMPOTENCY_CONFLICT');
 PERFORM p3_test.ok('evaluation: wrong token rejected',p3_eval_test.finish(f||'{"token":"invalid"}'::jsonb,p)->>'error'='LEASE_TOKEN_MISMATCH');
 PERFORM p3_test.ok('evaluation: exactly one result',(SELECT count(*)=1 FROM app_moderation_v2.p3_evaluation_results WHERE request_id=(f->>'request')::uuid));
 PERFORM p3_test.deny('evaluation: service role cannot forge ledger','service_role','INSERT INTO app_moderation_v2.p3_evaluation_results DEFAULT VALUES');
 PERFORM p3_test.deny('evaluation: service role cannot call inner finalizer','service_role','SELECT app_moderation_v2.p3_finish_evaluation(NULL,NULL,NULL,NULL)');
 PERFORM p3_test.ok('evaluation: B2/B4 boundary remains false',NOT app_moderation_v2.p3_publication_boundary_verified());
 PERFORM p3_test.ok('evaluation: all existing function bodies and ACL preserved',NOT EXISTS(SELECT 1 FROM p3_test.baseline b JOIN pg_proc p ON p.oid=b.oid WHERE pg_get_functiondef(p.oid) IS DISTINCT FROM b.definition OR p.proowner IS DISTINCT FROM b.proowner OR p.proacl IS DISTINCT FROM b.proacl OR p.proconfig IS DISTINCT FROM b.proconfig));
END $$;
