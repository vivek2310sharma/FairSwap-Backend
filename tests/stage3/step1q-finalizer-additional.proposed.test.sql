-- STEP 1Q ADDITIONAL TEST PROPOSAL ONLY. NOT EXECUTED.
-- Future separate isolated approval must apply the scratch migration before this file.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public,extensions;
SELECT plan(85);
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
SELECT set_config('request.jwt.claim.sub',owner_id::text,true), set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated','aal','aal1')::text,true) FROM s3_ids;
SET LOCAL ROLE authenticated;
SELECT pg_temp.make_case('cars-clean','cars');
SELECT pg_temp.make_case('cars-invalid','cars');
SELECT pg_temp.make_case('cars-stale','cars');
SELECT pg_temp.make_case('cars-expired','cars');
SELECT pg_temp.make_case('cars-media_wait','cars');
SELECT pg_temp.make_case('cars-retry_limit','cars');
SELECT pg_temp.make_case('two-wheelers-clean','two-wheelers');
SELECT pg_temp.make_case('two-wheelers-invalid','two-wheelers');
SELECT pg_temp.make_case('two-wheelers-stale','two-wheelers');
SELECT pg_temp.make_case('two-wheelers-expired','two-wheelers');
SELECT pg_temp.make_case('two-wheelers-media_wait','two-wheelers');
SELECT pg_temp.make_case('two-wheelers-retry_limit','two-wheelers');
SELECT pg_temp.make_case('property-clean','property');
SELECT pg_temp.make_case('property-invalid','property');
SELECT pg_temp.make_case('property-stale','property');
SELECT pg_temp.make_case('property-expired','property');
SELECT pg_temp.make_case('property-media_wait','property');
SELECT pg_temp.make_case('property-retry_limit','property');
SELECT pg_temp.make_case('goods-clean','goods');
SELECT pg_temp.make_case('goods-invalid','goods');
INSERT INTO public.listing_media(listing_id,original_filename,content_type,file_size_bytes) SELECT lid,'primary.jpg','image/jpeg',100 FROM s3_cases;
INSERT INTO public.listing_media(listing_id,original_filename,content_type,file_size_bytes) SELECT lid,'processing.jpg','image/jpeg',100 FROM s3_cases WHERE label LIKE '%-media_wait';
RESET ROLE;
UPDATE s3_cases c SET mid=m.id FROM public.listing_media m WHERE m.listing_id=c.lid AND m.original_filename='primary.jpg';
SET LOCAL ROLE service_role;
SELECT public.record_media_processing_result(mid,jsonb_build_object('original',lid||'/'||mid||'/original','thumbnail',lid||'/'||mid||'/thumbnail','medium',lid||'/'||mid||'/medium','large',lid||'/'||mid||'/large'),'{"width":500,"height":500}','ready',null) FROM s3_cases;
SET LOCAL ROLE authenticated;
UPDATE s3_cases c SET result=CASE WHEN family='goods' THEN public.seller_submit_listing(lid) ELSE public.seller_submit_listing(lid,(SELECT revision FROM public.listings WHERE id=c.lid)) END;
RESET ROLE;
SELECT ok(((SELECT bool_and(result->>'success'='true') AND count(*)=20 FROM s3_cases)), 'all twenty saved cases submitted through unchanged interfaces');
SET LOCAL ROLE service_role;
UPDATE s3_cases c SET claim=(SELECT to_jsonb(q) FROM public.claim_moderation_batch(1,3600,(SELECT id FROM public.listing_moderation_requests WHERE listing_id=c.lid)) q);
RESET ROLE;
CREATE TEMP TABLE q_listing_before AS SELECT c.label,to_jsonb(l) AS value FROM s3_cases c JOIN public.listings l ON l.id=c.lid;
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='cars-clean';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' AND result->'response'->>'decision'='routed_to_admin' AND result->'response'->>'reason'='EXPERIMENTAL_PUBLICATION_DISABLED' FROM s3_cases WHERE label='cars-clean')), 'cars: clean terminal routing with explicit policy reason');
SELECT ok(((SELECT to_jsonb(l)=b.value AND l.status='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN q_listing_before b USING(label) WHERE c.label='cars-clean')), 'cars: complete listing bytes/state/revision unchanged');
SELECT ok(((SELECT r.status='completed' AND r.attempt_count=1 AND r.claim_token=(c.claim->>'claim_token')::uuid FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='cars-clean')), 'cars: request completed without changing lease identity');
SELECT ok(((SELECT count(*)=1 AND bool_and(r.outcome='no_review_flags' AND r.decision='routed_to_admin' AND r.listing_revision=(c.claim->>'listing_revision')::integer AND r.generation_id=(c.claim->>'generation_id')::uuid AND r.errors='[]'::jsonb) FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='cars-clean')), 'cars: exactly one unchanged clean evidence payload');
SELECT ok(((SELECT count(*)=1 FROM public.audit_logs a JOIN s3_cases c ON a.target_id=c.lid WHERE c.label='cars-clean' AND a.action='moderation.experimental_publication_disabled' AND a.details->>'reason'='EXPERIMENTAL_PUBLICATION_DISABLED' AND a.details->>'request_id'=c.claim->>'request_id')), 'cars: policy reason auditable');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='cars-clean';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='REQUEST_NOT_CLAIMED' FROM s3_cases WHERE label='cars-clean')), 'cars: duplicate follows existing non-claimed response');
SELECT ok(((SELECT count(*)=1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='cars-clean')), 'cars: duplicate adds no evidence');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='cars-invalid';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' AND result->'response'->>'decision'='escalated_to_admin' AND result->'response'->>'reason'='EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED' FROM s3_cases WHERE label='cars-invalid')), 'cars: invalid input has explicit manual-intervention decision');
SELECT ok(((SELECT to_jsonb(l)=b.value AND l.status='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN q_listing_before b USING(label) WHERE c.label='cars-invalid')), 'cars: invalid input never attempts rejected transition');
SELECT ok(((SELECT r.status='failed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='cars-invalid')), 'cars: invalid-input request terminal failed');
SELECT ok(((SELECT count(*)=1 AND bool_and(r.outcome='invalid_input' AND r.decision='escalated_to_admin') FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='cars-invalid')), 'cars: one invalid-input evidence row');
SELECT ok(((SELECT count(*)=1 FROM public.audit_logs a JOIN s3_cases c ON a.target_id=c.lid WHERE c.label='cars-invalid' AND a.action='moderation.experimental_invalid_input' AND a.details->>'reason'='EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED')), 'cars: manual intervention auditable');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='cars-invalid';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='REQUEST_NOT_CLAIMED' FROM s3_cases WHERE label='cars-invalid') AND (SELECT count(*)=1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='cars-invalid')), 'cars: invalid-input replay does not append twice');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags',gen_random_uuid()) WHERE label='cars-stale';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_TOKEN_MISMATCH' FROM s3_cases WHERE label='cars-stale')), 'cars: stale token denied');
SELECT ok(((SELECT r.status='claimed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='cars-stale') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='cars-stale')), 'cars: stale-token denial changes no request or evidence');
-- Timing/counter fixtures only; no listing/context/guard mutation.
UPDATE public.listing_moderation_requests r SET claim_expires_at=clock_timestamp()-interval '1 minute' FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='cars-expired';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='cars-expired';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_EXPIRED' FROM s3_cases WHERE label='cars-expired') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='cars-expired')), 'cars: expired lease cannot finalize');
UPDATE public.listing_moderation_requests r SET attempt_count=max_attempts FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='cars-retry_limit';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'checks_incomplete') WHERE label='cars-retry_limit';
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='cars-media_wait';
RESET ROLE;
SELECT ok(((SELECT r.status='failed' AND c.result->'response'->>'decision'='escalated_to_admin' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='cars-retry_limit')), 'cars: existing retry bound remains terminal');
SELECT ok(((SELECT r.status='retry' AND r.claim_token IS NULL AND r.attempt_count=0 AND c.result->'response'->>'decision'='awaiting_media_processing' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='cars-media_wait')), 'cars: media retry still precedes policy completion');
SET LOCAL ROLE service_role;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='cars-clean')), 'cars: service_role direct publication denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='cars-clean')), 'cars: authenticated direct publication denied');
RESET ROLE;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='cars-clean')), 'cars: elevated direct publication denied');
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''rejected'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='cars-invalid')), 'cars: elevated direct rejection remains denied');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='two-wheelers-clean';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' AND result->'response'->>'decision'='routed_to_admin' AND result->'response'->>'reason'='EXPERIMENTAL_PUBLICATION_DISABLED' FROM s3_cases WHERE label='two-wheelers-clean')), 'two-wheelers: clean terminal routing with explicit policy reason');
SELECT ok(((SELECT to_jsonb(l)=b.value AND l.status='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN q_listing_before b USING(label) WHERE c.label='two-wheelers-clean')), 'two-wheelers: complete listing bytes/state/revision unchanged');
SELECT ok(((SELECT r.status='completed' AND r.attempt_count=1 AND r.claim_token=(c.claim->>'claim_token')::uuid FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='two-wheelers-clean')), 'two-wheelers: request completed without changing lease identity');
SELECT ok(((SELECT count(*)=1 AND bool_and(r.outcome='no_review_flags' AND r.decision='routed_to_admin' AND r.listing_revision=(c.claim->>'listing_revision')::integer AND r.generation_id=(c.claim->>'generation_id')::uuid AND r.errors='[]'::jsonb) FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='two-wheelers-clean')), 'two-wheelers: exactly one unchanged clean evidence payload');
SELECT ok(((SELECT count(*)=1 FROM public.audit_logs a JOIN s3_cases c ON a.target_id=c.lid WHERE c.label='two-wheelers-clean' AND a.action='moderation.experimental_publication_disabled' AND a.details->>'reason'='EXPERIMENTAL_PUBLICATION_DISABLED' AND a.details->>'request_id'=c.claim->>'request_id')), 'two-wheelers: policy reason auditable');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='two-wheelers-clean';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='REQUEST_NOT_CLAIMED' FROM s3_cases WHERE label='two-wheelers-clean')), 'two-wheelers: duplicate follows existing non-claimed response');
SELECT ok(((SELECT count(*)=1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='two-wheelers-clean')), 'two-wheelers: duplicate adds no evidence');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='two-wheelers-invalid';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' AND result->'response'->>'decision'='escalated_to_admin' AND result->'response'->>'reason'='EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED' FROM s3_cases WHERE label='two-wheelers-invalid')), 'two-wheelers: invalid input has explicit manual-intervention decision');
SELECT ok(((SELECT to_jsonb(l)=b.value AND l.status='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN q_listing_before b USING(label) WHERE c.label='two-wheelers-invalid')), 'two-wheelers: invalid input never attempts rejected transition');
SELECT ok(((SELECT r.status='failed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='two-wheelers-invalid')), 'two-wheelers: invalid-input request terminal failed');
SELECT ok(((SELECT count(*)=1 AND bool_and(r.outcome='invalid_input' AND r.decision='escalated_to_admin') FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='two-wheelers-invalid')), 'two-wheelers: one invalid-input evidence row');
SELECT ok(((SELECT count(*)=1 FROM public.audit_logs a JOIN s3_cases c ON a.target_id=c.lid WHERE c.label='two-wheelers-invalid' AND a.action='moderation.experimental_invalid_input' AND a.details->>'reason'='EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED')), 'two-wheelers: manual intervention auditable');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='two-wheelers-invalid';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='REQUEST_NOT_CLAIMED' FROM s3_cases WHERE label='two-wheelers-invalid') AND (SELECT count(*)=1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='two-wheelers-invalid')), 'two-wheelers: invalid-input replay does not append twice');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags',gen_random_uuid()) WHERE label='two-wheelers-stale';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_TOKEN_MISMATCH' FROM s3_cases WHERE label='two-wheelers-stale')), 'two-wheelers: stale token denied');
SELECT ok(((SELECT r.status='claimed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='two-wheelers-stale') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='two-wheelers-stale')), 'two-wheelers: stale-token denial changes no request or evidence');
-- Timing/counter fixtures only; no listing/context/guard mutation.
UPDATE public.listing_moderation_requests r SET claim_expires_at=clock_timestamp()-interval '1 minute' FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='two-wheelers-expired';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='two-wheelers-expired';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_EXPIRED' FROM s3_cases WHERE label='two-wheelers-expired') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='two-wheelers-expired')), 'two-wheelers: expired lease cannot finalize');
UPDATE public.listing_moderation_requests r SET attempt_count=max_attempts FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='two-wheelers-retry_limit';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'checks_incomplete') WHERE label='two-wheelers-retry_limit';
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='two-wheelers-media_wait';
RESET ROLE;
SELECT ok(((SELECT r.status='failed' AND c.result->'response'->>'decision'='escalated_to_admin' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='two-wheelers-retry_limit')), 'two-wheelers: existing retry bound remains terminal');
SELECT ok(((SELECT r.status='retry' AND r.claim_token IS NULL AND r.attempt_count=0 AND c.result->'response'->>'decision'='awaiting_media_processing' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='two-wheelers-media_wait')), 'two-wheelers: media retry still precedes policy completion');
SET LOCAL ROLE service_role;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='two-wheelers-clean')), 'two-wheelers: service_role direct publication denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='two-wheelers-clean')), 'two-wheelers: authenticated direct publication denied');
RESET ROLE;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='two-wheelers-clean')), 'two-wheelers: elevated direct publication denied');
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''rejected'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='two-wheelers-invalid')), 'two-wheelers: elevated direct rejection remains denied');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='property-clean';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' AND result->'response'->>'decision'='routed_to_admin' AND result->'response'->>'reason'='EXPERIMENTAL_PUBLICATION_DISABLED' FROM s3_cases WHERE label='property-clean')), 'property: clean terminal routing with explicit policy reason');
SELECT ok(((SELECT to_jsonb(l)=b.value AND l.status='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN q_listing_before b USING(label) WHERE c.label='property-clean')), 'property: complete listing bytes/state/revision unchanged');
SELECT ok(((SELECT r.status='completed' AND r.attempt_count=1 AND r.claim_token=(c.claim->>'claim_token')::uuid FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='property-clean')), 'property: request completed without changing lease identity');
SELECT ok(((SELECT count(*)=1 AND bool_and(r.outcome='no_review_flags' AND r.decision='routed_to_admin' AND r.listing_revision=(c.claim->>'listing_revision')::integer AND r.generation_id=(c.claim->>'generation_id')::uuid AND r.errors='[]'::jsonb) FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='property-clean')), 'property: exactly one unchanged clean evidence payload');
SELECT ok(((SELECT count(*)=1 FROM public.audit_logs a JOIN s3_cases c ON a.target_id=c.lid WHERE c.label='property-clean' AND a.action='moderation.experimental_publication_disabled' AND a.details->>'reason'='EXPERIMENTAL_PUBLICATION_DISABLED' AND a.details->>'request_id'=c.claim->>'request_id')), 'property: policy reason auditable');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='property-clean';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='REQUEST_NOT_CLAIMED' FROM s3_cases WHERE label='property-clean')), 'property: duplicate follows existing non-claimed response');
SELECT ok(((SELECT count(*)=1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='property-clean')), 'property: duplicate adds no evidence');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='property-invalid';
RESET ROLE;
SELECT ok(((SELECT result->>'sqlstate'='00000' AND result->'response'->>'success'='true' AND result->'response'->>'decision'='escalated_to_admin' AND result->'response'->>'reason'='EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED' FROM s3_cases WHERE label='property-invalid')), 'property: invalid input has explicit manual-intervention decision');
SELECT ok(((SELECT to_jsonb(l)=b.value AND l.status='pending_review' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN q_listing_before b USING(label) WHERE c.label='property-invalid')), 'property: invalid input never attempts rejected transition');
SELECT ok(((SELECT r.status='failed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='property-invalid')), 'property: invalid-input request terminal failed');
SELECT ok(((SELECT count(*)=1 AND bool_and(r.outcome='invalid_input' AND r.decision='escalated_to_admin') FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='property-invalid')), 'property: one invalid-input evidence row');
SELECT ok(((SELECT count(*)=1 FROM public.audit_logs a JOIN s3_cases c ON a.target_id=c.lid WHERE c.label='property-invalid' AND a.action='moderation.experimental_invalid_input' AND a.details->>'reason'='EXPERIMENTAL_INVALID_INPUT_MANUAL_REVIEW_REQUIRED')), 'property: manual intervention auditable');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='property-invalid';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='REQUEST_NOT_CLAIMED' FROM s3_cases WHERE label='property-invalid') AND (SELECT count(*)=1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='property-invalid')), 'property: invalid-input replay does not append twice');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags',gen_random_uuid()) WHERE label='property-stale';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_TOKEN_MISMATCH' FROM s3_cases WHERE label='property-stale')), 'property: stale token denied');
SELECT ok(((SELECT r.status='claimed' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='property-stale') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='property-stale')), 'property: stale-token denial changes no request or evidence');
-- Timing/counter fixtures only; no listing/context/guard mutation.
UPDATE public.listing_moderation_requests r SET claim_expires_at=clock_timestamp()-interval '1 minute' FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='property-expired';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='property-expired';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='LEASE_EXPIRED' FROM s3_cases WHERE label='property-expired') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='property-expired')), 'property: expired lease cannot finalize');
UPDATE public.listing_moderation_requests r SET attempt_count=max_attempts FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='property-retry_limit';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'checks_incomplete') WHERE label='property-retry_limit';
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='property-media_wait';
RESET ROLE;
SELECT ok(((SELECT r.status='failed' AND c.result->'response'->>'decision'='escalated_to_admin' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='property-retry_limit')), 'property: existing retry bound remains terminal');
SELECT ok(((SELECT r.status='retry' AND r.claim_token IS NULL AND r.attempt_count=0 AND c.result->'response'->>'decision'='awaiting_media_processing' FROM s3_cases c JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='property-media_wait')), 'property: media retry still precedes policy completion');
SET LOCAL ROLE service_role;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='property-clean')), 'property: service_role direct publication denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='property-clean')), 'property: authenticated direct publication denied');
RESET ROLE;
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''active'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='property-clean')), 'property: elevated direct publication denied');
SELECT ok(((SELECT pg_temp.attempt(format('UPDATE public.listings SET status=''rejected'' WHERE id=%L',lid))='42501' FROM s3_cases WHERE label='property-invalid')), 'property: elevated direct rejection remains denied');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='goods-clean';
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='goods-invalid';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'decision'='auto_approved' AND result->'response'->>'status'='active' FROM s3_cases WHERE label='goods-clean')), 'Goods clean response unchanged');
SELECT ok(((SELECT l.status='active' AND r.status='completed' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='goods-clean')), 'Goods clean publication unchanged');
SELECT ok(((SELECT result->'response'->>'decision'='rejected_invalid' AND result->'response'->>'status'='rejected' FROM s3_cases WHERE label='goods-invalid')), 'Goods invalid-input response unchanged');
SELECT ok(((SELECT l.status='rejected' AND r.status='failed' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='goods-invalid')), 'Goods invalid-input state unchanged');
SELECT ok(((SELECT count(*)=2 FROM public.listing_moderation_results r JOIN s3_cases c ON c.lid=r.listing_id WHERE c.family='goods')), 'Goods evidence count unchanged');
SELECT ok((NOT EXISTS(SELECT 1 FROM app_security.test_submission_permits)), 'finalization never manufactures a permit');
SELECT ok((NOT has_function_privilege('authenticated','public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)','EXECUTE')), 'finalizer public wrapper remains service-only');
SELECT ok((NOT has_table_privilege('service_role','public.listing_moderation_results','UPDATE') AND NOT has_table_privilege('service_role','public.listing_moderation_results','DELETE')), 'append-only result ACL unchanged');
SELECT ok(((SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.listings'::regclass,'public.listing_moderation_requests'::regclass,'public.listing_moderation_results'::regclass))), 'RLS remains enabled');
-- Additional freshness fixtures change request snapshots only, never listing guards.
UPDATE public.listing_moderation_requests r SET listing_revision=r.listing_revision-1 FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='cars-stale';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='cars-stale';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'decision'='superseded' FROM s3_cases WHERE label='cars-stale') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='cars-stale')), 'cars: stale evaluated revision superseded without publication/evidence');
UPDATE public.listing_moderation_requests r SET listing_revision=r.listing_revision-1 FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='two-wheelers-stale';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='two-wheelers-stale';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'decision'='superseded' FROM s3_cases WHERE label='two-wheelers-stale') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='two-wheelers-stale')), 'two-wheelers: stale evaluated revision superseded without publication/evidence');
UPDATE public.listing_moderation_requests r SET listing_revision=r.listing_revision-1 FROM s3_cases c WHERE c.lid=r.listing_id AND c.label='property-stale';
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='property-stale';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'decision'='superseded' FROM s3_cases WHERE label='property-stale') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='property-stale')), 'property: stale evaluated revision superseded without publication/evidence');
-- Synthetic eligible vehicle metadata without an authoritative family contract.
CREATE TEMP TABLE q_unknown_category AS SELECT gen_random_uuid() AS id;
GRANT SELECT ON q_unknown_category TO authenticated;
INSERT INTO public.categories(id,name,slug,is_active,macro_category,new_listing_enabled)
SELECT id,'Synthetic uncontracted category','q-uncontracted-'||id,true,'vehicles',true FROM q_unknown_category;
SET LOCAL ROLE authenticated;
WITH created AS (
 INSERT INTO public.listings(title,description,category_id,city_id,pin_code,condition,price_type,price_paise)
 SELECT 'Synthetic unknown family','Synthetic category classification must fail closed',q.id,s.city_id,'560001','good','fixed',10000 FROM q_unknown_category q CROSS JOIN s3_ids s RETURNING id
) INSERT INTO s3_cases(label,family,lid) SELECT 'unknown-category','goods',id FROM created;
INSERT INTO public.listing_media(listing_id,original_filename,content_type,file_size_bytes)
SELECT lid,'unknown.jpg','image/jpeg',100 FROM s3_cases WHERE label='unknown-category';
RESET ROLE;
UPDATE s3_cases c SET mid=m.id FROM public.listing_media m WHERE c.lid=m.listing_id AND c.label='unknown-category';
SET LOCAL ROLE service_role;
SELECT public.record_media_processing_result(mid,jsonb_build_object('original',lid||'/'||mid||'/original','thumbnail',lid||'/'||mid||'/thumbnail','medium',lid||'/'||mid||'/medium','large',lid||'/'||mid||'/large'),'{"width":500,"height":500}','ready',null) FROM s3_cases WHERE label='unknown-category';
SET LOCAL ROLE authenticated;
UPDATE s3_cases SET result=public.seller_submit_listing(lid) WHERE label='unknown-category';
RESET ROLE;
SELECT ok(((SELECT result->>'success'='true' FROM s3_cases WHERE label='unknown-category')), 'synthetic unsupported family reaches finalizer through existing submission interface');
SET LOCAL ROLE service_role;
UPDATE s3_cases c SET claim=(SELECT to_jsonb(q) FROM public.claim_moderation_batch(1,3600,(SELECT id FROM public.listing_moderation_requests WHERE listing_id=c.lid)) q) WHERE label='unknown-category';
UPDATE s3_cases SET result=pg_temp.finalize(claim,'no_review_flags') WHERE label='unknown-category';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='UNSUPPORTED_MODERATION_CATEGORY' FROM s3_cases WHERE label='unknown-category')), 'unknown authoritative category cannot fall through to Goods despite a Goods fixture label');
SELECT ok(((SELECT l.status='pending_review' AND r.status='claimed' FROM s3_cases c JOIN public.listings l ON l.id=c.lid JOIN public.listing_moderation_requests r ON r.listing_id=c.lid WHERE c.label='unknown-category') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='unknown-category')), 'unknown category fails closed with no publication or fabricated completion');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'invalid_input') WHERE label='unknown-category';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='UNSUPPORTED_MODERATION_CATEGORY' FROM s3_cases WHERE label='unknown-category') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='unknown-category')), 'unknown category: invalid_input also fails closed');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'needs_review') WHERE label='unknown-category';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='UNSUPPORTED_MODERATION_CATEGORY' FROM s3_cases WHERE label='unknown-category') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='unknown-category')), 'unknown category: needs_review also fails closed');
SET LOCAL ROLE service_role;
UPDATE s3_cases SET result=pg_temp.finalize(claim,'checks_incomplete') WHERE label='unknown-category';
RESET ROLE;
SELECT ok(((SELECT result->'response'->>'error'='UNSUPPORTED_MODERATION_CATEGORY' FROM s3_cases WHERE label='unknown-category') AND NOT EXISTS(SELECT 1 FROM s3_cases c JOIN public.listing_moderation_results r ON r.listing_id=c.lid WHERE c.label='unknown-category')), 'unknown category: checks_incomplete also fails closed');
SELECT * FROM finish();
ROLLBACK;
