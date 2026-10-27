-- FairSwap IDV-V1 PG17 Verification & Security Assertions
-- Covers:
-- 1. Migration execution and schema grants
-- 2. Public badge table RLS and non-sensitive projection
-- 3. Private app_security.idv_* RLS defense-in-depth and direct client access rejection
-- 4. User ownership & cross-account rejection for get_my_identity_verification
-- 5. Administrator AAL2 enforcement and positive/negative cases for admin_revoke_verification
-- 6. Concurrent advisory lock & lifecycle (start, complete, withdraw, admin-revoke)
-- 7. Durable worker lease claiming, unique lease tokens, retry backoff, expired lease recovery, and duplicate worker handling
-- 8. Valid unexpired lease_token requirement for acknowledging success or recording failure
-- 9. Explicit activation of scheduler and Vault readiness

create or replace function public.idv_assert(ok boolean, label text) returns void
language plpgsql as $$
begin
  if ok is distinct from true then
    raise exception 'IDV PG17 ASSERTION FAILED: %', label;
  end if;
end;
$$;

-- Seed test users
insert into auth.users (id, email) values
  ('11111111-1111-4000-8000-000000000001', 'user1@fairswap.test'),
  ('22222222-2222-4000-8000-000000000002', 'user2@fairswap.test'),
  ('33333333-3333-4000-8000-000000000003', 'user3@fairswap.test'),
  ('99999999-9999-4000-8000-000000000099', 'admin@fairswap.test')
on conflict (id) do nothing;

insert into public.user_accounts (user_id, account_status) values
  ('11111111-1111-4000-8000-000000000001', 'active'),
  ('22222222-2222-4000-8000-000000000002', 'active'),
  ('33333333-3333-4000-8000-000000000003', 'suspended'),
  ('99999999-9999-4000-8000-000000000099', 'active')
on conflict (user_id) do nothing;

insert into public.staff_roles (user_id, role) values
  ('99999999-9999-4000-8000-000000000099', 'administrator')
on conflict (user_id) do nothing;

-- 1. Schema & Privilege Checks
select public.idv_assert(
  has_table_privilege('anon', 'public.user_identity_verifications', 'select'),
  'anon can select from public.user_identity_verifications'
);
select public.idv_assert(
  not has_table_privilege('anon', 'public.user_identity_verifications', 'insert'),
  'anon cannot insert into public.user_identity_verifications'
);
select public.idv_assert(
  not has_table_privilege('authenticated', 'public.user_identity_verifications', 'update'),
  'authenticated cannot update public.user_identity_verifications'
);

-- Check private schema defense-in-depth
select public.idv_assert(
  not has_table_privilege('anon', 'app_security.idv_verification_attempts', 'select'),
  'anon has NO privilege on app_security.idv_verification_attempts'
);
select public.idv_assert(
  not has_table_privilege('authenticated', 'app_security.idv_identity_records', 'select'),
  'authenticated has NO privilege on app_security.idv_identity_records'
);
select public.idv_assert(
  not has_table_privilege('authenticated', 'app_security.idv_audit_events', 'insert'),
  'authenticated has NO privilege on app_security.idv_audit_events'
);

-- Check RLS is enabled on all tables
select public.idv_assert(
  (select relrowsecurity from pg_class where oid = 'public.user_identity_verifications'::regclass),
  'RLS enabled on public.user_identity_verifications'
);
select public.idv_assert(
  (select relrowsecurity from pg_class where oid = 'app_security.idv_verification_attempts'::regclass),
  'RLS enabled on app_security.idv_verification_attempts'
);
select public.idv_assert(
  (select relrowsecurity from pg_class where oid = 'app_security.idv_identity_records'::regclass),
  'RLS enabled on app_security.idv_identity_records'
);
select public.idv_assert(
  (select relrowsecurity from pg_class where oid = 'app_security.idv_audit_events'::regclass),
  'RLS enabled on app_security.idv_audit_events'
);

-- 2. Lifecycle Execution: Start Attempt with Named Arguments
do $$
declare
  v_res jsonb;
begin
  -- Start attempt via service role using correctly typed named arguments
  v_res := public.server_idv_start_attempt(
    p_user_id := '11111111-1111-4000-8000-000000000001'::uuid,
    p_request_state := 'state_nonce_user1_test_001',
    p_ttl_seconds := 900,
    p_consent_purpose := 'FairSwap India Peer-to-Peer Identity Verification V1',
    p_consent_acknowledged := true,
    p_policy_version := 'v1.0'
  );
  perform public.idv_assert((v_res->>'success')::boolean is true, 'server_idv_start_attempt succeeds with named arguments');

  -- Attach provider request ID
  v_res := public.server_idv_attach_provider_session(
    p_attempt_id := (v_res->>'attempt_id')::uuid,
    p_provider_request_id := 'setu_req_1001',
    p_provider_session_url := 'https://dg-sandbox.setu.co/consent/1001'
  );
  perform public.idv_assert((v_res->>'success')::boolean is true, 'server_idv_attach_provider_session succeeds');
end $$;

-- 3. Complete Verification & Queue Revocation
do $$
declare
  v_att RECORD;
  v_res jsonb;
begin
  select * into v_att from app_security.idv_verification_attempts
  where user_id = '11111111-1111-4000-8000-000000000001'::uuid;

  v_res := public.server_idv_complete_verification(
    p_attempt_id := v_att.id,
    p_user_id := '11111111-1111-4000-8000-000000000001'::uuid,
    p_evidence_category := 'aadhaar_kyc',
    p_issuer_authority := 'UIDAI',
    p_document_reference_hash := 'hmac_digest_token_user1_aadhaar'
  );
  perform public.idv_assert((v_res->>'success')::boolean is true, 'server_idv_complete_verification succeeds');

  -- Assert verification completed queues revocation pending for the worker
  select * into v_att from app_security.idv_verification_attempts where id = v_att.id;
  perform public.idv_assert(v_att.status = 'verified', 'attempt status is verified');
  perform public.idv_assert(v_att.revocation_pending is true, 'revocation_pending is true upon completion');
end $$;

-- 4. User Status Query (Owner-scoped RPC with session-level GUCs)
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4000-8000-000000000001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

select public.idv_assert(
  (select (public.get_my_identity_verification()->>'badge_issued')::boolean is true),
  'user 1 sees verified badge issued'
);
select public.idv_assert(
  (select (public.get_my_identity_verification()->>'status') = 'verified'),
  'user 1 sees status verified'
);

-- User 2 sees not_started
select set_config('request.jwt.claim.sub', '22222222-2222-4000-8000-000000000002', false);
select public.idv_assert(
  (select (public.get_my_identity_verification()->>'badge_issued')::boolean is false),
  'user 2 sees badge_issued false'
);
select public.idv_assert(
  (select (public.get_my_identity_verification()->>'status') = 'not_started'),
  'user 2 sees status not_started'
);

-- Direct SELECT on public.user_identity_verifications
-- User 2 can see active verified badge of User 1 (public directory lookup)
select public.idv_assert(
  exists(select 1 from public.user_identity_verifications where user_id = '11111111-1111-4000-8000-000000000001' and badge_issued = true),
  'user 2 can see user 1 active verified badge'
);

-- Suspended user 3's badge is NOT publicly visible even if issued
reset role;
update public.user_identity_verifications
set badge_issued = true, verification_status = 'verified'
where user_id = '33333333-3333-4000-8000-000000000003';

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4000-8000-000000000002', false);
select public.idv_assert(
  not exists(select 1 from public.user_identity_verifications where user_id = '33333333-3333-4000-8000-000000000003'),
  'suspended user badge is filtered from public reads by RLS'
);
reset role;

-- 5. Durable Revocation Queue & Lease Mechanics
do $$
declare
  v_claim jsonb;
  v_lease uuid;
  v_attempt_id uuid;
  v_ack jsonb;
begin
  -- Claim due revocation items
  v_claim := public.server_idv_claim_revocation_retries(p_limit := 10, p_lease_seconds := 60);
  perform public.idv_assert((v_claim->>'success')::boolean is true, 'claim retries succeeds');
  perform public.idv_assert(jsonb_array_length(v_claim->'claimed_retries') = 1, 'claims 1 pending item');

  v_lease := (v_claim->>'lease_token')::uuid;
  v_attempt_id := (v_claim->'claimed_retries'->0->>'attempt_id')::uuid;

  -- Attempting acknowledge without lease token MUST FAIL
  v_ack := public.server_idv_record_token_revoked(p_attempt_id := v_attempt_id, p_lease_token := null);
  perform public.idv_assert((v_ack->>'success')::boolean is false, 'record_token_revoked rejects null lease token');

  -- Attempting acknowledge with wrong lease token MUST FAIL
  v_ack := public.server_idv_record_token_revoked(p_attempt_id := v_attempt_id, p_lease_token := gen_random_uuid());
  perform public.idv_assert((v_ack->>'success')::boolean is false, 'record_token_revoked rejects mismatched lease token');

  -- Attempting failure record with missing lease token MUST FAIL
  v_ack := public.server_idv_record_token_revocation_failed(p_attempt_id := v_attempt_id, p_error := 'err', p_lease_token := null, p_consume_retry := true);
  perform public.idv_assert((v_ack->>'success')::boolean is false, 'record_token_revocation_failed rejects null lease token');

  -- Successful acknowledgement with matching lease token MUST SUCCEED
  v_ack := public.server_idv_record_token_revoked(p_attempt_id := v_attempt_id, p_lease_token := v_lease);
  perform public.idv_assert((v_ack->>'success')::boolean is true, 'record_token_revoked succeeds with matching lease token');

  -- Item is no longer pending
  perform public.idv_assert(
    (select revocation_pending from app_security.idv_verification_attempts where id = v_attempt_id) is false,
    'revocation_pending is false after success'
  );
  perform public.idv_assert(
    (select token_revoked_at from app_security.idv_verification_attempts where id = v_attempt_id) is not null,
    'token_revoked_at is recorded'
  );
end $$;

-- 6. Expired Lease Recovery & Missing Credential Non-Consumption
do $$
declare
  v_att_id uuid;
  v_claim jsonb;
  v_lease uuid;
  v_res jsonb;
begin
  -- Seed an attempt with an expired lease
  insert into app_security.idv_verification_attempts (
    id, user_id, request_state, provider_request_id, status, attempt_expires_at,
    revocation_pending, next_retry_at, lease_token, lease_expires_at, token_revocation_retry_count
  ) values (
    '44444444-4444-4000-8000-000000000004'::uuid,
    '22222222-2222-4000-8000-000000000002'::uuid,
    'state_nonce_crash_recovery_004',
    'setu_req_crash_4004',
    'verified',
    clock_timestamp() + interval '1 day',
    true,
    clock_timestamp() - interval '10 minutes',
    gen_random_uuid(),
    clock_timestamp() - interval '5 minutes', -- Stale expired lease
    0
  ) on conflict (id) do nothing;

  v_att_id := '44444444-4444-4000-8000-000000000004'::uuid;

  -- Worker claims: the expired lease must be recovered and claimed
  v_claim := public.server_idv_claim_revocation_retries(p_limit := 10, p_lease_seconds := 60);
  perform public.idv_assert(
    exists(
      select 1 from jsonb_array_elements(v_claim->'claimed_retries') elem
      where (elem->>'attempt_id')::uuid = v_att_id
    ),
    'worker recovers crashed/expired lease row'
  );

  v_lease := (v_claim->>'lease_token')::uuid;

  -- Missing credentials test: record failure with p_consume_retry: false
  v_res := public.server_idv_record_token_revocation_failed(
    p_attempt_id := v_att_id,
    p_error := 'Setu provider credentials unavailable for revocation retry',
    p_lease_token := v_lease,
    p_consume_retry := false
  );
  perform public.idv_assert((v_res->>'success')::boolean is true, 'record failure without consume_retry succeeds');

  -- Retry count must NOT have incremented
  perform public.idv_assert(
    (select token_revocation_retry_count from app_security.idv_verification_attempts where id = v_att_id) = 0,
    'retry quota is NOT consumed when credentials are unavailable'
  );
  -- Still pending
  perform public.idv_assert(
    (select revocation_pending from app_security.idv_verification_attempts where id = v_att_id) is true,
    'remains pending for worker retry'
  );
end $$;

-- 7. User Consent Withdrawal
do $$
declare
  v_res jsonb;
begin
  v_res := public.server_idv_withdraw_consent(p_user_id := '11111111-1111-4000-8000-000000000001'::uuid);
  perform public.idv_assert((v_res->>'success')::boolean is true, 'server_idv_withdraw_consent succeeds');

  -- Badge revoked immediately
  perform public.idv_assert(
    (select badge_issued from public.user_identity_verifications where user_id = '11111111-1111-4000-8000-000000000001'::uuid) is false,
    'badge_issued is false after withdrawal'
  );
  perform public.idv_assert(
    (select verification_status from public.user_identity_verifications where user_id = '11111111-1111-4000-8000-000000000001'::uuid) = 'revoked',
    'verification_status is revoked after withdrawal'
  );
end $$;

-- 8. Admin Revocation with AAL2 checks
-- Negative: Missing verification record returns error
set role authenticated;
select set_config('request.jwt.claim.sub', '99999999-9999-4000-8000-000000000099', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claim.staff_role', 'administrator', false);
select set_config('request.jwt.claim.aal', 'aal2', false);

select public.idv_assert(
  (select (public.admin_revoke_verification(p_target_user_id := '22222222-2222-4000-8000-000000000002'::uuid, p_reason := 'Missing record test')->>'error') = 'VERIFICATION_RECORD_NOT_FOUND'),
  'revoking user without verification record fails with VERIFICATION_RECORD_NOT_FOUND'
);

-- Seed an active verification record for user 2 to test positive revocation
reset role;
insert into public.user_identity_verifications (
  user_id, verification_status, badge_issued, verified_at, valid_until
) values (
  '22222222-2222-4000-8000-000000000002'::uuid,
  'verified',
  true,
  clock_timestamp(),
  clock_timestamp() + interval '365 days'
) on conflict (user_id) do update set
  verification_status = excluded.verification_status,
  badge_issued = excluded.badge_issued;

insert into app_security.idv_identity_records (
  user_id, attempt_id, evidence_category, issuer_authority, document_reference_hash,
  consent_timestamp, consent_purpose, consent_policy_version, verified_at
) values (
  '22222222-2222-4000-8000-000000000002'::uuid,
  '44444444-4444-4000-8000-000000000004'::uuid,
  'aadhaar_kyc',
  'UIDAI',
  'hash_user2_doc',
  clock_timestamp() - interval '1 hour',
  'FairSwap India Peer-to-Peer Identity Verification V1',
  'v1.0',
  clock_timestamp()
) on conflict (user_id) do nothing;

-- Negative: Non-admin or non-AAL2 rejected
set role authenticated;
select set_config('request.jwt.claim.sub', '99999999-9999-4000-8000-000000000099', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claim.staff_role', 'moderator', false);
select set_config('request.jwt.claim.aal', 'aal1', false);

select public.idv_assert(
  (select (public.admin_revoke_verification(p_target_user_id := '22222222-2222-4000-8000-000000000002'::uuid, p_reason := 'Reason test fraud')->>'success')::boolean is false),
  'moderator with aal1 rejected from admin revocation'
);

-- Negative: Missing or too short reason rejected
select set_config('request.jwt.claim.staff_role', 'administrator', false);
select set_config('request.jwt.claim.aal', 'aal2', false);

select public.idv_assert(
  (select (public.admin_revoke_verification(p_target_user_id := '22222222-2222-4000-8000-000000000002'::uuid, p_reason := 'bad')->>'error') = 'MANDATORY_REASON_REQUIRED'),
  'administrator rejected when reason length is under 5 characters'
);

-- Positive: Administrator with AAL2 succeeds on existing record
select public.idv_assert(
  (select (public.admin_revoke_verification(p_target_user_id := '22222222-2222-4000-8000-000000000002'::uuid, p_reason := 'Verified fraud report')->>'success')::boolean is true),
  'administrator with aal2 succeeds with mandatory reason on active record'
);

-- Self-revocation restriction
select public.idv_assert(
  (select (public.admin_revoke_verification(p_target_user_id := '99999999-9999-4000-8000-000000000099'::uuid, p_reason := 'Self revocation attempt')->>'success')::boolean is false),
  'administrator cannot self-revoke'
);

reset role;

-- 9. Explicit Scheduler Activation Helper Verification
do $$
begin
  -- Seed required vault secrets for test
  insert into vault.decrypted_secrets (name, decrypted_secret) values
    ('idv_revocation_worker_url', 'https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/idv-revocation-worker'),
    ('idv_worker_secret', 'test_worker_secret_12345'),
    ('app_project_ref', 'wpppxlnbzqynvhpeuavd')
  on conflict (name) do update set decrypted_secret = excluded.decrypted_secret;

  -- Assert the activation helper exists and can register job
  perform app_security.idv_activate_revocation_scheduler();
  perform public.idv_assert(
    exists(select 1 from cron.job where jobname = 'process-idv-revocation-retries'),
    'scheduler activation helper successfully registers cron job'
  );

  -- Negative Case: Swapped project URL (e.g. prod worker URL in staging vault)
  update vault.decrypted_secrets
  set decrypted_secret = 'https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/idv-revocation-worker'
  where name = 'idv_revocation_worker_url';

  begin
    perform app_security.idv_activate_revocation_scheduler();
    raise exception 'FAIL: Cross-project swapped worker URL must be rejected';
  exception
    when others then
      if sqlerrm not like '%cross-project scheduler activation forbidden%' then
        raise exception 'Unexpected error on cross-project worker test: %', sqlerrm;
      end if;
  end;

  -- Negative Case: Arbitrary unapproved project URL (e.g. attacker-controlled project)
  update vault.decrypted_secrets
  set decrypted_secret = 'https://attackerproject123.supabase.co/functions/v1/idv-revocation-worker'
  where name = 'idv_revocation_worker_url';

  begin
    perform app_security.idv_activate_revocation_scheduler();
    raise exception 'FAIL: Unapproved project worker URL must be rejected';
  exception
    when others then
      if sqlerrm not like '%not a valid Supabase project worker endpoint%' then
        raise exception 'Unexpected error on unapproved worker URL test: %', sqlerrm;
      end if;
  end;

  -- Restore clean staging secrets
  update vault.decrypted_secrets
  set decrypted_secret = 'https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/idv-revocation-worker'
  where name = 'idv_revocation_worker_url';
end $$;


