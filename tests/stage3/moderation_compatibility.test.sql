-- AUTHORED ONLY; future approved isolated PG17 CI. Never shared/hosted databases.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public,extensions;
SELECT plan(74);
DO $$ BEGIN
 IF current_setting('server_version_num')::integer<>170006
   OR EXISTS(SELECT 1 FROM vault.secrets)
   OR (SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_automation_enabled') IS DISTINCT FROM 'false'
   OR current_setting('cron.launch_active_jobs') IS DISTINCT FROM 'off'
 THEN RAISE EXCEPTION 'Unsafe rehearsal database'; END IF;
END $$;
-- Owner-authorized transaction-only exception; empty Vault, no endpoints; ROLLBACK.
UPDATE public.app_system_settings SET setting_value='true'
WHERE setting_key='moderation_automation_enabled';
CREATE TEMP TABLE s3_ids AS SELECT gen_random_uuid() owner_id,gen_random_uuid() other_id,
 gen_random_uuid() city_id,gen_random_uuid() category_id;
GRANT SELECT ON s3_ids TO authenticated,service_role,anon;
INSERT INTO auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
SELECT id,'stage3-'||id||'@example.invalid',
'{"display_name":"Synthetic Stage 3","terms_accepted":"true","terms_version":"2026-09-18","privacy_policy_version":"2026-09-18","acceptable_use_version":"2026-09-18","age_confirmed":"true"}'::jsonb,
'{}'::jsonb,now(),now() FROM s3_ids CROSS JOIN LATERAL(VALUES(owner_id),(other_id)) u(id);
INSERT INTO public.policy_acceptance_records(user_id,terms_version,privacy_policy_version,acceptable_use_version,minimum_age_confirmed)
SELECT id,'2026-09-18','2026-09-18','2026-09-18',18 FROM s3_ids CROSS JOIN LATERAL(VALUES(owner_id),(other_id)) u(id);
INSERT INTO public.cities(id,name,state,slug) SELECT city_id,'Synthetic Stage 3','Synthetic','stage3-'||city_id FROM s3_ids;
INSERT INTO public.categories(id,name,slug,is_active,macro_category,new_listing_enabled)
SELECT category_id,'Synthetic Stage 3 Goods','stage3-'||category_id,true,'goods',true FROM s3_ids;
CREATE TEMP TABLE s3_cases(label text PRIMARY KEY,family text,lid uuid,mid uuid,
 claim jsonb,result jsonb,old_claim jsonb);
GRANT SELECT,INSERT,UPDATE ON s3_cases TO authenticated,service_role;
GRANT SELECT ON s3_cases TO anon;
CREATE FUNCTION pg_temp.make_case(p_label text,p_family text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE payload jsonb; c uuid;v uuid;fields jsonb;definition jsonb;lid uuid;attrs jsonb;
BEGIN
 payload:=jsonb_build_object('title','Synthetic Stage 3 '||p_label,
 'description','Synthetic compatibility description with no private data',
 'city_id',(SELECT city_id FROM s3_ids),'pin_code','560001',
 'condition','good','price_type','fixed','price_paise',10000,'category_attributes','{}'::jsonb);
 IF p_family='goods' THEN
   INSERT INTO public.listings(title,description,category_id,city_id,pin_code,condition,price_type,price_paise)
   SELECT payload->>'title',payload->>'description',category_id,city_id,'560001','good','fixed',10000 FROM s3_ids
   RETURNING id INTO lid;
 ELSIF p_family='property' THEN
   SELECT p.category_id,p.version_id,p.definition INTO STRICT c,v,definition
   FROM public.property_category_contracts p JOIN public.categories t ON t.id=p.category_id
   JOIN public.property_contract_versions cv ON cv.id=p.version_id
   WHERE t.is_active AND t.new_listing_enabled AND cv.new_assignment_enabled
   AND p.definition->>'basis' IS NOT NULL ORDER BY p.category_id LIMIT 1;
   payload:=payload||jsonb_build_object('category_id',c,'condition',null,'price_type',null,'price_paise',null);
   lid:=public.save_property_draft(null,payload,v,
     jsonb_build_object('currency','INR','period','month','basis',definition->>'basis',
     'rent',jsonb_build_object('state','known','amount_paise',100000)),null);
 ELSE
   IF p_family='cars' THEN
     SELECT p.category_id,p.version_id,p.fields INTO STRICT c,v,fields
     FROM public.car_category_contracts p JOIN public.categories t ON t.id=p.category_id
     JOIN public.car_contract_versions cv ON cv.id=p.version_id
     WHERE t.is_active AND t.new_listing_enabled AND cv.new_assignment_enabled ORDER BY p.category_id LIMIT 1;
   ELSE
     SELECT p.category_id,p.version_id,p.fields INTO STRICT c,v,fields
     FROM public.vehicle_category_contracts p JOIN public.categories t ON t.id=p.category_id
     JOIN public.vehicle_contract_versions cv ON cv.id=p.version_id
     WHERE t.is_active AND t.new_listing_enabled AND cv.new_assignment_enabled ORDER BY p.category_id LIMIT 1;
   END IF;
   attrs:='{"year":{"state":"unknown"},"km_driven":{"state":"unknown"}}'::jsonb;
   IF p_family='cars' THEN
     SELECT attrs||coalesce(jsonb_object_agg(k,jsonb_build_object('state','unknown')),'{}'::jsonb)
     INTO attrs FROM jsonb_array_elements_text(fields) k WHERE k IN ('fuel_type','transmission','powertrain');
     IF fields ? 'battery_capacity_kwh' THEN attrs:=attrs||'{"powertrain":{"state":"unknown"}}'::jsonb; END IF;
   END IF;
   payload:=payload||jsonb_build_object('category_id',c,'category_attributes',attrs);
   IF p_family='cars' THEN
     lid:=public.save_car_draft(null,payload,v,'{"mode":"not_listed","brand_text":"Synthetic Stage3 Uncatalogued","model_text":"Synthetic Isolated Model"}');
   ELSE
     lid:=public.save_two_wheeler_draft(null,payload,v,'{"mode":"not_listed","brand_text":"Synthetic Stage3 Uncatalogued","model_text":"Synthetic Isolated Model"}');
   END IF;
 END IF;
 INSERT INTO s3_cases(label,family,lid) VALUES(p_label,p_family,lid);
 RETURN lid;
END $$;
CREATE FUNCTION pg_temp.finalize(c jsonb,outcome text,token uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE response jsonb;
BEGIN
 response:=public.impl_finalize_moderation_result((c->>'request_id')::uuid,
 coalesce(token,(c->>'claim_token')::uuid),outcome,'prototype_v0.1.1','title_description',
 ARRAY['rule_prohibited_item_wording','rule_shortened_link','rule_payment_before_viewing'],
 ARRAY[]::text[],'[]'::jsonb,'[]'::jsonb);
 RETURN jsonb_build_object('sqlstate','00000','response',response);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('sqlstate',SQLSTATE);
END $$;
CREATE FUNCTION pg_temp.attempt(sql text) RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN EXECUTE sql; RETURN '00000'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $$;
SELECT set_config('request.jwt.claim.sub',owner_id::text,true),
 set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated','aal','aal1')::text,true) FROM s3_ids;
SET LOCAL ROLE authenticated;
SELECT pg_temp.make_case('goods','goods');
SELECT pg_temp.make_case('cars','cars');
SELECT pg_temp.make_case('two-wheelers','two-wheelers');
SELECT pg_temp.make_case('property','property');
SELECT pg_temp.make_case('revision','goods');
SELECT pg_temp.make_case('needs_review','goods');
SELECT pg_temp.make_case('invalid_input','goods');
SELECT pg_temp.make_case('checks_incomplete','goods');
SELECT pg_temp.make_case('expired','goods');
SELECT pg_temp.make_case('media_wait','goods');
SELECT ok(((SELECT count(*)=10 FROM s3_cases)), 'all ten synthetic drafts created through canonical interfaces');
INSERT INTO public.listing_media(listing_id,original_filename,content_type,file_size_bytes)
SELECT lid,'synthetic.jpg','image/jpeg',100 FROM s3_cases;
RESET ROLE;
UPDATE s3_cases c SET mid=m.id FROM public.listing_media m WHERE m.listing_id=c.lid;
SET LOCAL ROLE service_role;
SELECT public.record_media_processing_result(mid,
 jsonb_build_object('original',lid||'/'||mid||'/original','thumbnail',lid||'/'||mid||'/thumbnail',
 'medium',lid||'/'||mid||'/medium','large',lid||'/'||mid||'/large'),
 '{"width":500,"height":500}','ready',null) FROM s3_cases;
SET LOCAL ROLE authenticated;
UPDATE s3_cases c SET result=CASE WHEN family='goods' THEN public.seller_submit_listing(lid)
 ELSE public.seller_submit_listing(lid,(SELECT revision FROM public.listings WHERE id=c.lid)) END;
RESET ROLE;
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='goods')), 'goods: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='goods')), 'goods: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='cars')), 'cars: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='cars')), 'cars: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='two-wheelers')), 'two-wheelers: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='two-wheelers')), 'two-wheelers: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='property')), 'property: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='property')), 'property: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='revision')), 'revision: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='revision')), 'revision: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='needs_review')), 'needs_review: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='needs_review')), 'needs_review: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='invalid_input')), 'invalid_input: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='invalid_input')), 'invalid_input: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='checks_incomplete')), 'checks_incomplete: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='checks_incomplete')), 'checks_incomplete: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='expired')), 'expired: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='expired')), 'expired: exactly one queue generation');
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='media_wait')), 'media_wait: valid owner submission succeeds');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='media_wait')), 'media_wait: exactly one queue generation');
SET LOCAL ROLE service_role;
UPDATE s3_cases c SET claim=(SELECT to_jsonb(q) FROM public.claim_moderation_batch(1,60,
 (SELECT id FROM public.listing_moderation_requests WHERE listing_id=c.lid)) q);
RESET ROLE;
SELECT ok(((SELECT claim->>'claim_token' IS NOT NULL AND (claim->>'listing_revision')::integer=l.revision AND (claim->>'attempt_count')::integer=1 FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='goods')), 'goods: lease revision and attempt identity');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='goods';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' FROM s3_cases WHERE label='goods')), 'goods: compatibility requires successful clean finalization');
SELECT ok(((SELECT l.status::text='active' FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='goods')), 'goods: publication boundary preserved');
SELECT ok(((SELECT r.status<>'claimed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='goods')), 'goods: compatibility requires terminal or retry state, not stranded lease');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='goods')), 'goods: exactly one finalization evidence row');
SELECT ok(((SELECT claim->>'claim_token' IS NOT NULL AND (claim->>'listing_revision')::integer=l.revision AND (claim->>'attempt_count')::integer=1 FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='cars')), 'cars: lease revision and attempt identity');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='cars';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' FROM s3_cases WHERE label='cars')), 'cars: compatibility requires successful clean finalization');
SELECT ok(((SELECT l.status::text='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='cars')), 'cars: publication boundary preserved');
SELECT ok(((SELECT r.status<>'claimed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='cars')), 'cars: compatibility requires terminal or retry state, not stranded lease');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='cars')), 'cars: exactly one finalization evidence row');
SELECT ok(((SELECT result->>'sqlstate' IN ('42501','22023') FROM s3_cases WHERE label='cars')), 'cars: baseline reproduction records guard SQLSTATE');
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))<>'00000' FROM s3_cases WHERE label='cars')), 'cars: elevated publication still denied by guards');
SELECT ok(((SELECT claim->>'claim_token' IS NOT NULL AND (claim->>'listing_revision')::integer=l.revision AND (claim->>'attempt_count')::integer=1 FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='two-wheelers')), 'two-wheelers: lease revision and attempt identity');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='two-wheelers';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' FROM s3_cases WHERE label='two-wheelers')), 'two-wheelers: compatibility requires successful clean finalization');
SELECT ok(((SELECT l.status::text='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='two-wheelers')), 'two-wheelers: publication boundary preserved');
SELECT ok(((SELECT r.status<>'claimed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='two-wheelers')), 'two-wheelers: compatibility requires terminal or retry state, not stranded lease');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='two-wheelers')), 'two-wheelers: exactly one finalization evidence row');
SELECT ok(((SELECT result->>'sqlstate' IN ('42501','22023') FROM s3_cases WHERE label='two-wheelers')), 'two-wheelers: baseline reproduction records guard SQLSTATE');
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))<>'00000' FROM s3_cases WHERE label='two-wheelers')), 'two-wheelers: elevated publication still denied by guards');
SELECT ok(((SELECT claim->>'claim_token' IS NOT NULL AND (claim->>'listing_revision')::integer=l.revision AND (claim->>'attempt_count')::integer=1 FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='property')), 'property: lease revision and attempt identity');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='property';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' FROM s3_cases WHERE label='property')), 'property: compatibility requires successful clean finalization');
SELECT ok(((SELECT l.status::text='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid WHERE c.label='property')), 'property: publication boundary preserved');
SELECT ok(((SELECT r.status<>'claimed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='property')), 'property: compatibility requires terminal or retry state, not stranded lease');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='property')), 'property: exactly one finalization evidence row');
SELECT ok(((SELECT result->>'sqlstate' IN ('42501','22023') FROM s3_cases WHERE label='property')), 'property: baseline reproduction records guard SQLSTATE');
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))<>'00000' FROM s3_cases WHERE label='property')), 'property: elevated publication still denied by guards');
SET LOCAL ROLE service_role;
SELECT pg_temp.finalize(claim,'no_review_flags') FROM s3_cases WHERE label='goods';
RESET ROLE;
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='goods')), 'Goods: repeated finalization creates no duplicate evidence');
SELECT ok(((SELECT count(*)=1 FROM public.audit_logs a JOIN s3_cases c ON a.target_id=c.lid WHERE c.label='goods' AND a.action='listing.auto_approved')), 'Goods: one publication audit');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'needs_review') WHERE label='needs_review';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' FROM s3_cases WHERE label='needs_review')), 'needs_review: finalizer accepts outcome');
SELECT ok(((SELECT r.status::text='completed' FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='needs_review')), 'needs_review: request state');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='invalid_input';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' FROM s3_cases WHERE label='invalid_input')), 'invalid_input: finalizer accepts outcome');
SELECT ok(((SELECT r.status::text='failed' FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='invalid_input')), 'invalid_input: request state');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'checks_incomplete') WHERE label='checks_incomplete';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' FROM s3_cases WHERE label='checks_incomplete')), 'checks_incomplete: finalizer accepts outcome');
SELECT ok(((SELECT r.status::text='retry' FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='checks_incomplete')), 'checks_incomplete: request state');
-- Queue timing/counters below are explicit elevated test fixtures, not guard bypasses.
-- Recover an expired lease below the retry limit, then prove old-token rejection.
UPDATE public.listing_moderation_requests r SET claim_expires_at=clock_timestamp()-interval '1 minute'
FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='expired';
SET LOCAL ROLE service_role;
SELECT count(*) FROM public.claim_moderation_batch(1,60,(SELECT (claim->>'request_id')::uuid FROM s3_cases WHERE label='expired'));
RESET ROLE;
SELECT ok(((SELECT r.status='retry' AND r.claim_token IS NULL AND r.attempt_count=1
 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='expired')),
 'expired lease below limit: delayed retry retains attempt count');
UPDATE s3_cases SET old_claim=claim WHERE label='expired';
UPDATE public.listing_moderation_requests r SET next_attempt_at=clock_timestamp()-interval '1 second'
FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='expired';
SET LOCAL ROLE service_role;
UPDATE s3_cases c SET claim=(SELECT to_jsonb(q) FROM public.claim_moderation_batch(1,60,(c.claim->>'request_id')::uuid) q)
 WHERE label='expired';
UPDATE s3_cases SET result=pg_temp.finalize(old_claim,'no_review_flags') WHERE label='expired';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_TOKEN_MISMATCH'
 AND (claim->>'attempt_count')::integer=2 FROM s3_cases WHERE label='expired')),
 'expired lease reclaimed: stale token denied and attempts advance');
UPDATE public.listing_moderation_requests r SET claim_expires_at=clock_timestamp()-interval '1 minute',attempt_count=max_attempts
FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='expired';
SET LOCAL ROLE service_role;
SELECT count(*) FROM public.claim_moderation_batch(1,60,(SELECT (claim->>'request_id')::uuid FROM s3_cases WHERE label='expired'));
RESET ROLE;
SELECT ok(((SELECT r.status='failed' AND r.claim_token IS NULL FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='expired')), 'expired lease: bounded terminal recovery');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='expired')), 'expired lease: one abandonment result');
UPDATE public.listing_moderation_requests r SET attempt_count=max_attempts,status='claimed',
claim_token=(c.claim->>'claim_token')::uuid,claim_expires_at=clock_timestamp()+interval '1 minute'
FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='checks_incomplete';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'checks_incomplete') WHERE label='checks_incomplete';
RESET ROLE;
SELECT ok(((SELECT r.status='failed' FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='checks_incomplete')), 'checks incomplete: max attempts terminal');
-- Goods pending media only; experimental child guards remain unchanged.
UPDATE public.listing_media m SET processing_status='processing' FROM s3_cases c WHERE c.mid=m.id AND c.label='media_wait';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='media_wait';
RESET ROLE;
SELECT ok(((SELECT r.status='retry' AND r.attempt_count=0 AND r.claim_token IS NULL FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='media_wait')), 'media wait: attempt reset observed');
UPDATE public.listing_moderation_requests r SET next_attempt_at=clock_timestamp()-interval '1 second'
FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='media_wait';
SET LOCAL ROLE service_role;
UPDATE s3_cases c SET claim=(SELECT to_jsonb(q) FROM public.claim_moderation_batch(1,60,(c.claim->>'request_id')::uuid) q) WHERE label='media_wait';
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='media_wait';
RESET ROLE;
SELECT ok(((SELECT count(*)=2 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='media_wait')), 'media wait: repeated evidence growth without unbounded loop');
UPDATE s3_cases SET old_claim=claim WHERE label='revision';
SET LOCAL ROLE service_role;
-- Exercise the canonical service-only revision invalidation helper; no revision/permit forgery.
SELECT app_security.trigger_listing_media_rereview(lid) FROM s3_cases WHERE label='revision';
RESET ROLE;
SELECT ok(((SELECT r.status='superseded' FROM public.listing_moderation_requests r JOIN s3_cases c ON r.id=(c.old_claim->>'request_id')::uuid WHERE c.label='revision')), 'revision edit supersedes prior generation');
SELECT ok(((SELECT count(*)=1 FROM public.listing_moderation_requests r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.label='revision' AND r.status IN ('pending','retry','claimed'))), 'revision: only one active generation');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(old_claim,'no_review_flags') WHERE label='revision';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'decision'='superseded' FROM s3_cases WHERE label='revision')), 'revision: old claim cannot publish');
SET LOCAL ROLE service_role;
UPDATE s3_cases c SET claim=(SELECT to_jsonb(q) FROM public.claim_moderation_batch(1,60,
 (SELECT id FROM public.listing_moderation_requests WHERE listing_id=c.lid AND status='pending')) q) WHERE label='revision';
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags',gen_random_uuid()) WHERE label='revision';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_TOKEN_MISMATCH' FROM s3_cases WHERE label='revision')), 'revision: stale token rejected');
SELECT ok(((SELECT claim->>'generation_id'<>old_claim->>'generation_id' FROM s3_cases WHERE label='revision')), 'revision: distinct generation identity');
SELECT set_config('request.jwt.claim.sub',other_id::text,true),
set_config('request.jwt.claims',jsonb_build_object('sub',other_id,'role','authenticated','aal','aal1')::text,true) FROM s3_ids;
SET LOCAL ROLE authenticated;
SELECT ok(((SELECT count(*)=0 FROM public.listings WHERE id IN (SELECT lid FROM s3_cases WHERE family<>'goods'))), 'security: unrelated seller cannot see experimental pending listings');
SELECT ok(((SELECT pg_temp.attempt(format('SELECT public.impl_finalize_moderation_result(%L,%L,''needs_review'',''prototype_v0.1.1'',''title_description'',ARRAY[]::text[],ARRAY[]::text[],''[]''::jsonb,''[]''::jsonb)',claim->>'request_id',claim->>'claim_token'))='42501' FROM s3_cases WHERE label='revision')), 'security: authenticated finalization denied');
SET LOCAL ROLE anon;
SELECT ok(((SELECT count(*)=0 FROM public.listings WHERE id IN (SELECT lid FROM s3_cases WHERE family<>'goods'))), 'security: anonymous cannot see experimental pending listings');
RESET ROLE;
SELECT ok(((SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.listings'::regclass,'public.listing_moderation_requests'::regclass,'public.listing_moderation_results'::regclass))), 'security: listing and moderation RLS retained');
SELECT ok((NOT has_table_privilege('service_role','public.listing_moderation_results','UPDATE') AND NOT has_table_privilege('service_role','public.listing_moderation_results','DELETE')), 'security: worker cannot rewrite append-only results');
SELECT ok(((SELECT count(*)=0 FROM vault.secrets)), 'security: empty Vault after all cases');
SELECT ok(((SELECT count(*)=0 FROM net.http_request_queue)), 'security: no HTTP dispatch queued');
SELECT diag('STAGE3 '||jsonb_build_object(
 'case',c.label,'sqlstate',c.result->>'sqlstate','request_status',r.status::text,
 'listing_status',l.status::text,'attempt_count',r.attempt_count,
 'results',(SELECT count(*) FROM public.listing_moderation_results WHERE request_id=r.id),
 'revision_matches',l.revision=r.listing_revision,
 'lease_retained',r.claim_token IS NOT NULL)::text)
 FROM s3_cases c JOIN public.listings l ON l.id=c.lid
 JOIN public.listing_moderation_requests r ON r.id=(c.claim->>'request_id')::uuid
 WHERE c.label IN ('goods','cars','two-wheelers','property') ORDER BY c.label;
SELECT * FROM finish();
ROLLBACK;
