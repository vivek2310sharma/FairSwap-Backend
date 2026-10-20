-- UNAPPLIED additive candidate. Execute only inside an approved rollback proof.
-- No queue, policy, lease, function replacement, publication or table grants.
DO $preflight$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('app_moderation_v2.p3_worker_authorized(text)'))
  IS DISTINCT FROM '5eab0a32b8421a4948d48bceef057b48be42984b5ea8598a9866f4d6b6acab60'
  OR app_moderation_v2.p3_publication_boundary_verified() IS DISTINCT FROM false
  OR (SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_v2_enabled') IS DISTINCT FROM 'false'
  OR (SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_v2_mode') IS DISTINCT FROM 'disabled'
 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Pinned disabled Point 3 foundation required';END IF;
END $preflight$;
GRANT CREATE ON SCHEMA app_moderation_v2 TO mv2_p3_lease;
CREATE FUNCTION app_moderation_v2.p3_read_worker_context(p_secret text,req uuid,a uuid,token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $read$
DECLARE f jsonb;e app_moderation_v2.p3_evaluation_evidence;c app_moderation_v2.input_claims;
 checkpoints jsonb;starts jsonb;objects jsonb;s jsonb;
BEGIN
 IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN
  RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;
 f:=app_moderation_v2.p3_lock_attempt(req,a,token);
 IF f->>'success' IS DISTINCT FROM 'true' THEN RETURN f;END IF;
 SELECT * INTO STRICT e FROM app_moderation_v2.p3_evaluation_evidence WHERE request_id=req AND attempt_id=a;
 SELECT * INTO STRICT c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;
 s:=app_moderation_v2.p3_full_snapshot(req);
 IF s IS DISTINCT FROM e.snapshot OR app_moderation_v2.p3_manifest((s->>'listing_id')::uuid)::jsonb IS DISTINCT FROM e.source_manifest THEN
  RETURN jsonb_build_object('success',false,'error','SNAPSHOT_MISMATCH');END IF;
 -- Parent lock held by p3_lock_attempt serializes media edits/retirement.
 SELECT coalesce(jsonb_agg(jsonb_build_object('attempt_id',x.attempt_id,'attempt_number',cl.attempt_number,
  'check',x.payload,'retry_after_seconds',x.retry_after_seconds,'recorded_at',x.recorded_at)
  ORDER BY cl.attempt_number,x.recorded_at,x.check_key),'[]') INTO checkpoints
 FROM app_moderation_v2.p3_checkpoints x JOIN app_moderation_v2.p3_evaluation_evidence ev USING(request_id,attempt_id)
 JOIN app_moderation_v2.input_claims cl USING(request_id,attempt_id)
 WHERE x.request_id=req AND ev.snapshot=e.snapshot AND ev.evaluator_build=e.evaluator_build AND cl.attempt_number<=c.attempt_number;
 SELECT coalesce(jsonb_agg(jsonb_build_object('attempt_id',st.attempt_id,'check_key',st.check_key,
  'input_sha256',st.input_sha256,'start_number',st.start_number,'deadline',st.deadline)
  ORDER BY st.check_key,st.start_number),'[]') INTO starts
 FROM app_moderation_v2.p3_call_starts st JOIN app_moderation_v2.p3_evaluation_evidence ev USING(request_id,attempt_id)
 WHERE st.request_id=req AND ev.snapshot=e.snapshot AND ev.evaluator_build=e.evaluator_build;
 SELECT coalesce(jsonb_agg(jsonb_build_object('media_id',b.media_id,'asset_version',b.asset_version,
  'object_id',o.object_id,'bucket',o.bucket,'logical_key',o.logical_key,'sha256',o.sha256,
  'bytes',o.bytes,'width',o.width,'height',o.height,'recipe',b.recipe)
  ORDER BY m.display_order,m.id),'[]') INTO objects
 FROM public.listing_media m JOIN app_moderation_v2.seal_media_bindings bind ON bind.media_id=m.id AND bind.listing_id=m.listing_id
 JOIN app_moderation_v2.seal_bundles b ON b.asset_version=bind.asset_version AND b.listing_id=m.listing_id AND b.media_id=m.id
 JOIN app_moderation_v2.seal_objects o ON o.asset_version=b.asset_version AND o.variant='canonical'
 WHERE m.listing_id=(s->>'listing_id')::uuid AND NOT EXISTS(SELECT 1 FROM app_moderation_v2.seal_retirements r WHERE r.asset_version=b.asset_version);
 IF jsonb_array_length(objects)<>jsonb_array_length(s->'media') THEN RETURN jsonb_build_object('success',false,'error','SNAPSHOT_MISMATCH');END IF;
 f:=app_moderation_v2.p3_lock_attempt(req,a,token);
 IF f->>'success' IS DISTINCT FROM 'true' THEN RETURN f;END IF;
 RETURN jsonb_build_object('success',true,'request_id',req,'attempt_id',a,'snapshot_sha256',s->>'snapshot_sha256',
  'evaluator_build',e.evaluator_build,'lease_expires_at',c.lease_expires_at,'provider_work_until',c.attempt_started_at+interval '210 seconds',
  'prior_checks',checkpoints,'reserved_calls',starts,'canonical_objects',objects);
 EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'PT409' THEN
  RETURN jsonb_build_object('success',false,'error','SNAPSHOT_MISMATCH');
END $read$;
ALTER FUNCTION app_moderation_v2.p3_read_worker_context(text,uuid,uuid,text) OWNER TO mv2_p3_lease;
REVOKE ALL ON FUNCTION app_moderation_v2.p3_read_worker_context(text,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_read_worker_context(text,uuid,uuid,text) TO mv2_p3_worker;

-- Terminal recovery authenticates the original claim token and exact submitted
-- JSONB payload digest. It does not require an unexpired lease after a commit.
CREATE FUNCTION app_moderation_v2.p3_read_worker_terminal(p_secret text,req uuid,a uuid,token text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $terminal$
DECLARE c app_moderation_v2.input_claims;e app_moderation_v2.p3_evaluation_evidence;z app_moderation_v2.p3_evaluation_results;
BEGIN
 IF app_moderation_v2.p3_worker_authorized(p_secret) IS DISTINCT FROM true THEN
  RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='Worker authentication failed';END IF;
 SELECT * INTO c FROM app_moderation_v2.input_claims WHERE request_id=req AND attempt_id=a;
 IF NOT FOUND OR c.phase<>'evaluation' OR c.claim_token_hash IS DISTINCT FROM encode(sha256(convert_to(token,'UTF8')),'hex') THEN
  RETURN jsonb_build_object('success',false,'error','LEASE_TOKEN_MISMATCH');END IF;
 SELECT * INTO e FROM app_moderation_v2.p3_evaluation_evidence WHERE request_id=req AND attempt_id=a;
 SELECT * INTO z FROM app_moderation_v2.p3_evaluation_results WHERE request_id=req AND attempt_id=a;
 IF NOT FOUND OR c.status NOT IN('evaluation_completed','evaluation_superseded') OR z.payload IS DISTINCT FROM p_payload
 OR z.payload_digest IS DISTINCT FROM encode(sha256(convert_to('fairswap:v2:result_v1:'||p_payload::text,'UTF8')),'hex')
 OR z.payload->'snapshot' IS DISTINCT FROM e.snapshot OR z.response->>'success' IS DISTINCT FROM 'true' THEN
  RETURN jsonb_build_object('success',false,'error','TERMINAL_RESULT_MISMATCH');END IF;
 RETURN jsonb_build_object('success',true,'request_id',req,'attempt_id',a,'snapshot_sha256',e.snapshot->>'snapshot_sha256',
  'evaluator_build',e.evaluator_build,'payload',z.payload,'decision',z.response->>'decision');
END $terminal$;
ALTER FUNCTION app_moderation_v2.p3_read_worker_terminal(text,uuid,uuid,text,jsonb) OWNER TO mv2_p3_lease;
REVOKE ALL ON FUNCTION app_moderation_v2.p3_read_worker_terminal(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_moderation_v2.p3_read_worker_terminal(text,uuid,uuid,text,jsonb) TO mv2_p3_worker;
REVOKE CREATE ON SCHEMA app_moderation_v2 FROM mv2_p3_lease;
