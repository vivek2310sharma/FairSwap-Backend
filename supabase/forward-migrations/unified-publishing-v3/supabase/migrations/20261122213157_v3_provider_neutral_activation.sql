begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Forward correction only. No category, provider, identity switch, grants or RLS changes.
-- The installed shared quad-mode finalizer owns receipt validation, mode matching,
-- in-flight switch races, leases, generations and the automation/Vault kill switches.
do $$
declare def text;
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'::regprocedure);
  if pg_catalog.strpos(def,'v_is_google boolean')=0
    or pg_catalog.strpos(def,'v_is_dual_cloud boolean')=0 then
    raise exception 'V3_SHARED_QUAD_MODE_FINALIZER_REQUIRED';
  end if;
end $$;

-- Remove the additional global-IDV activation prerequisite for the approved goods
-- only. The 15 restricted contracts retain their existing availability behavior.
do $$
declare def text; needle text := 'and app_security.v3_seller_identity_enforced()';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_available_v3(uuid)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then
    raise exception 'V3_PROVIDER_NEUTRAL_AVAILABILITY_DRIFT';
  end if;
  execute replace(def,needle,$patch$and (
    (g.macro_category='goods' and g.slug not in ('v2-baby-gear-car-seats','v2-other-items'))
    or app_security.v3_seller_identity_enforced())$patch$);
end $$;

-- Keep posting_v2_actor's account/policy/authentication checks and the normal
-- enforce_verified_actor call: it still rejects unverified actors when enabled.
do $$
declare def text; needle text := 'if not app_security.v3_seller_identity_enforced() then';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_actor_v3()'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then
    raise exception 'V3_PROVIDER_NEUTRAL_ACTOR_DRIFT';
  end if;
  execute replace(def,needle,
    'if pg_catalog.to_regprocedure(''app_security.enforce_verified_actor(uuid,boolean)'') is null then');
end $$;

-- The publication trigger remains an independent fail-closed receipt/media guard.
-- Replace only its Azure-specific check list for the 43 approved goods. Preserve
-- all session, owner, revision, manifest and verified-content-hash predicates.
do $$
declare def text;
  needle text := $old$and s.completed_checks @> array['check_india_fraud_rules','check_openai_moderation','check_vision_nsfw','check_vision_category','check_ocr_qr']$old$;
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_listing_guard_v3()'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then
    raise exception 'V3_PROVIDER_NEUTRAL_PUBLICATION_GUARD_DRIFT';
  end if;
  execute replace(def,needle,$patch$and (
        -- Restricted contracts keep their original predicate and intake/draft guards.
        (g.macro_category <> 'goods' and s.completed_checks @> array['check_india_fraud_rules','check_openai_moderation','check_vision_nsfw','check_vision_category','check_ocr_qr'])
        or (g.macro_category='goods' and g.slug not in ('v2-baby-gear-car-seats','v2-other-items')
          and s.completed_checks @> array['check_india_fraud_rules','check_openai_moderation']
          and (
            (r.ruleset_version=s.ruleset_version and r.scope=s.scope and (
              (s.ruleset_version='india_baseline_v1.0.0' and s.scope='baseline_two_check')
              or (s.ruleset_version in ('india_v1.0.0','india_azure_v1.0.0') and s.scope='multimodal_five_check'
                and (s.completed_checks @> array['check_vision_nsfw','check_vision_category','check_ocr_qr']
                  or s.completed_checks @> array['check_azure_vision_nsfw','check_azure_vision_category','check_azure_ocr_qr']))
              or (s.ruleset_version='india_google_v1.0.0' and s.scope='multimodal_five_check'
                and s.completed_checks @> array['check_google_vision_nsfw','check_google_vision_category','check_google_ocr_qr'])
            ))
            -- Dual mode consumes two independent receipts, never a synthetic dual receipt.
            or (r.ruleset_version='india_dual_cloud_v1.0.0'
              and r.scope in ('multimodal_eight_check','multimodal_seven_check','dual_cloud_eight_check')
              and s.ruleset_version in ('india_v1.0.0','india_azure_v1.0.0') and s.scope='multimodal_five_check'
              and (s.completed_checks @> array['check_vision_nsfw','check_vision_category','check_ocr_qr']
                or s.completed_checks @> array['check_azure_vision_nsfw','check_azure_vision_category','check_azure_ocr_qr'])
              and exists (
                select 1 from app_security.listing_moderation_scan_receipts peer
                where peer.request_id=s.request_id and peer.listing_id=s.listing_id
                  and peer.listing_revision=s.listing_revision and peer.generation_id=s.generation_id
                  and peer.ruleset_version='india_google_v1.0.0' and peer.scope='multimodal_five_check'
                  and peer.verdict='APPROVE' and peer.consumed and cardinality(peer.failed_checks)=0
                  and jsonb_array_length(peer.flags)=0 and peer.media_digest=s.media_digest
                  and peer.scanned_media_count=s.scanned_media_count and peer.manifest=s.manifest
                  and peer.completed_checks @> array['check_india_fraud_rules','check_openai_moderation',
                    'check_google_vision_nsfw','check_google_vision_category','check_google_ocr_qr']
              ))
          ))
      )$patch$);
end $$;
-- The shared finalizer was installed after the original V3 migration. Restore
-- its V3 eligibility/intake routing without imposing any provider-specific mode.
do $$
declare def text; needle text := 'IF v_is_restricted_category THEN';
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    or pg_catalog.strpos(def,'ordinary_goods_contracts_v3')<>0 then
    raise exception 'V3_PROVIDER_NEUTRAL_FINALIZER_DRIFT';
  end if;
  execute replace(def,needle,$patch$
  IF p_outcome='no_review_flags' AND EXISTS (
    SELECT 1 FROM app_security.ordinary_goods_contracts_v3 g
    WHERE g.category_id=v_listing.category_id AND
      (NOT app_security.ordinary_goods_available_v3(g.category_id) OR g.moderation_mode='staff_intake')
  ) THEN p_outcome := 'needs_review'; END IF;

  IF v_is_restricted_category THEN$patch$);
end $$;
commit;
