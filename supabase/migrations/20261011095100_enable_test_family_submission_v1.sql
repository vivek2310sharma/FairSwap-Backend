-- Approved FairSwapTest only; executed with an explicitly verified project-ref.
-- No category/reference changes. Guards were installed in the preceding batch.
begin;
do $$ begin
 if (select count(*) from app_security.test_submission_policies where policy_key='test-submission-v1' and not enabled and not maintenance)<>3
 or to_regprocedure('public.seller_submit_listing(uuid,integer)') is null
 or to_regprocedure('public.get_seller_submission_status(uuid)') is null
 or (select count(*) from pg_trigger where tgname='z_0_test_submission_lifecycle' and tgrelid='public.listings'::regclass and tgenabled='O')<>1
 or (select count(*) from pg_trigger where tgname='zz_test_submission_child' and tgenabled='O')<>4
 then raise exception 'Test submission activation prerequisites incomplete'; end if;
end $$;
update app_security.test_submission_policies set enabled=true
where family in ('two-wheelers','cars','property') and policy_key='test-submission-v1';
commit;
