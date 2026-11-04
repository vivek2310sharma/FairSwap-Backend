-- REVIEW-ONLY forward fix; never auto-run. Step 1 disables the feature and is always safe.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
update public.wearable_release_v1 set enabled=false;
update public.categories set is_active=false where id=(select category_id from public.wearable_release_v1);
commit;
