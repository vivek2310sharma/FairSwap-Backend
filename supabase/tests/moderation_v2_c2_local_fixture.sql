-- LOCAL disposable schema clone ONLY. Synthetic fixtures, never hosted seed data.
CREATE SCHEMA p3_local_test AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA p3_local_test FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE p3_local_test.fixture_listings(id uuid PRIMARY KEY);
CREATE FUNCTION p3_local_test.no_email() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN IF EXISTS(SELECT 1 FROM p3_local_test.fixture_listings WHERE id=NEW.listing_id) THEN RETURN NULL;END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION p3_local_test.no_email() FROM PUBLIC;
CREATE TRIGGER aaa_p3_local_no_email BEFORE INSERT ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION p3_local_test.no_email();
INSERT INTO auth.users(id,email,raw_user_meta_data,created_at,updated_at)
VALUES('c3900000-0000-4000-8000-000000000001','synthetic-c2-local@example.invalid','{"display_name":"Synthetic C2 local seller","terms_accepted":true,"terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":true}',clock_timestamp(),clock_timestamp());
CREATE FUNCTION p3_local_test.fixture() RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE l uuid:=gen_random_uuid();m uuid;mids uuid[]:=ARRAY[]::uuid[];asset uuid;assets uuid[]:=ARRAY[]::uuid[];objs jsonb;allobjs jsonb:='[]';v text;req uuid;a uuid:=gen_random_uuid();claim uuid:=gen_random_uuid();token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');s jsonb;slot smallint;rev int;j int;BEGIN
 INSERT INTO p3_local_test.fixture_listings VALUES(l);
 INSERT INTO public.listings(id,seller_id,category_id,city_id,title,description,condition,price_type,pin_code) VALUES(l,'c3900000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','Synthetic local chair','Synthetic security description भारत 😀 for local SQL proof','good','free','110001');
 FOR j IN 1..2 LOOP
  m:=gen_random_uuid();mids:=array_append(mids,m);
  INSERT INTO public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes,original_storage_path,thumbnail_storage_path,medium_storage_path,large_storage_path,display_order) VALUES(m,l,'c3900000-0000-4000-8000-000000000001','synthetic.jpg','image/jpeg',100,'synthetic/'||m||'/original.jpg','synthetic/'||m||'/thumb.webp','synthetic/'||m||'/medium.webp','synthetic/'||m||'/large.webp',j-1);
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
REVOKE ALL ON FUNCTION p3_local_test.fixture() FROM PUBLIC;
CREATE FUNCTION p3_local_test.drop_lease(req uuid,a uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c app_moderation_v2.input_claims;BEGIN SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;UPDATE app_moderation_v2.input_admission_slots SET active_claim_id=NULL,slot_acquired_at=NULL,slot_expires_at=NULL WHERE slot_id=c.slot_id AND active_claim_id=c.id;UPDATE app_moderation_v2.input_claims SET status='evaluation_expired' WHERE id=c.id AND status='evaluation_active';END $$;
REVOKE ALL ON FUNCTION p3_local_test.drop_lease(uuid,uuid) FROM PUBLIC;
