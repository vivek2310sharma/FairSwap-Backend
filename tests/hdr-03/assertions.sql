-- Raises on any assertion failure; no skips, hosted target or external data.
create function public.hdr03_assert(ok boolean, label text) returns void
language plpgsql as $$ begin if ok is distinct from true then raise exception 'HDR03 FAIL: %', label; end if; end $$;

insert into auth.users values
('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002'),
('00000000-0000-4000-8000-000000000003'), ('00000000-0000-4000-8000-000000000004');
insert into public.user_accounts select id, case when id::text like '%004' then 'deleted'::public.account_status_enum else 'active'::public.account_status_enum end from auth.users;
insert into public.listings(id) values ('10000000-0000-4000-8000-000000000001'), ('10000000-0000-4000-8000-000000000002');
insert into public.conversations(id,listing_id,buyer_id,seller_id) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003');
insert into public.notifications(user_id,type,title,body,read_at) values
('00000000-0000-4000-8000-000000000001','new_message','fixture','fixture',null),
('00000000-0000-4000-8000-000000000001','new_message','fixture','fixture',now()),
('00000000-0000-4000-8000-000000000002','new_message','fixture','fixture',null),
('00000000-0000-4000-8000-000000000002','new_message','fixture','fixture',null);

select public.hdr03_assert(not has_function_privilege('anon','public.get_unread_counts()','execute'),'anon execute revoked');
select public.hdr03_assert(not (select prosecdef from pg_proc where oid='public.get_unread_counts()'::regprocedure),'aggregate uses invoker RLS');
select public.hdr03_assert((select count(*)=1 from pg_proc where pronamespace='public'::regnamespace and proname='get_unread_counts' and pronargs=0),'no user-id overload');
select public.hdr03_assert((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.unread_count_signals'::regclass),'signal RLS forced');
select public.hdr03_assert(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='unread_count_signals'),'minimal signal published');
select public.hdr03_assert(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='conversation_read_states'),'private read markers not newly published');
select public.hdr03_assert((select count(*)=3 from information_schema.columns where table_name='unread_count_signals' and table_schema='public'),'signal payload has only opaque id, owner and revision');

set role anon;
do $$ begin
  begin perform public.get_unread_counts(); raise exception 'anon RPC unexpectedly allowed'; exception when insufficient_privilege then null; end;
  begin perform * from public.unread_count_signals; raise exception 'anon signals unexpectedly allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
do $$ begin
  begin perform public.get_unread_counts(); raise exception 'missing uid unexpectedly allowed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
select public.hdr03_assert((select unread_messages=0 and unread_notifications=1 from public.get_unread_counts()),'initial exact zero and only own unread notifications');
do $$ begin
  begin insert into public.unread_count_signals(user_id) values(auth.uid()); raise exception 'client signal write allowed'; exception when insufficient_privilege then null; end;
  begin perform app_security.hdr03_signal_message(); raise exception 'trigger helper execute allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Two inbound messages with the SAME timestamp; the ID breaks cursor ties.
insert into public.messages(id,conversation_id,sender_id,client_request_id,content,created_at) values
('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','fixture-1','fixture','2026-10-23 10:00:00Z'),
('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','fixture-2','fixture','2026-10-23 10:00:00Z'),
('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','fixture-3','fixture','2026-10-23 11:00:00Z'),
('30000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','fixture-4','fixture','2026-10-23 11:00:00Z');
select public.hdr03_assert((select revision=2 from public.unread_count_signals where user_id='00000000-0000-4000-8000-000000000001'),'inbound messages increment recipient signal only');
set role authenticated;
select public.hdr03_assert((select unread_messages=2 and unread_notifications=1 from public.get_unread_counts()),'two messages not one conversation; exclude own and unrelated messages');
select public.hdr03_assert((select count(*)=1 from public.unread_count_signals),'signal SELECT hides other owners');
select public.hdr03_assert(not exists(select 1 from public.unread_count_signals where user_id='00000000-0000-4000-8000-000000000002'),'explicit cross-user filter cannot bypass RLS');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
select public.hdr03_assert((select unread_messages=2 and unread_notifications=2 from public.get_unread_counts()),'second caller gets only its own aggregates');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
select public.hdr03_assert((select unread_messages=0 and unread_notifications=0 from public.get_unread_counts()),'third user excludes unrelated conversation and own sent message');
select public.hdr03_assert((select count(*)=0 from public.unread_count_signals),'third user sees no other recipient signal');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',false);
do $$ begin
  begin perform public.get_unread_counts(); raise exception 'restricted account allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;

insert into public.conversation_read_states(conversation_id,user_id,last_read_message_id,last_read_at) values
('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','2030-01-01Z');
select public.hdr03_assert((select revision=3 from public.unread_count_signals where user_id='00000000-0000-4000-8000-000000000001'),'initial read marker emits owner signal');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
select public.hdr03_assert((select unread_messages=1 from public.get_unread_counts()),'cursor tie: next same-timestamp message remains unread despite later read_at');
reset role;
update public.conversation_read_states set last_read_message_id='30000000-0000-4000-8000-000000000002';
select public.hdr03_assert((select revision=4 from public.unread_count_signals where user_id='00000000-0000-4000-8000-000000000001'),'updated read marker emits signal');
update public.conversation_read_states set last_read_message_id=last_read_message_id;
select public.hdr03_assert((select revision=4 from public.unread_count_signals where user_id='00000000-0000-4000-8000-000000000001'),'no signal for unchanged marker');
set role authenticated;
select public.hdr03_assert((select unread_messages=0 from public.get_unread_counts()),'all incoming messages read');
reset role;
-- Fresh message AFTER read cursor, even though read_at is artificially later.
insert into public.messages(id,conversation_id,sender_id,client_request_id,content,created_at) values
('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','fixture-5','fixture','2026-10-23 12:00:00Z');
set role authenticated;
select public.hdr03_assert((select unread_messages=1 from public.get_unread_counts()),'arrival after read changes count');
select public.hdr03_assert((select revision=5 from public.unread_count_signals),'arrival after read emits owner signal');
select public.mark_all_notifications_read();
select public.hdr03_assert((select unread_notifications=0 from public.get_unread_counts()),'notification mark-read changes aggregate');
reset role;
update public.user_accounts set account_status='suspended' where user_id='00000000-0000-4000-8000-000000000001';
set role authenticated;
select public.hdr03_assert((select unread_messages=1 from public.get_unread_counts()),'suspended read access matches existing RLS');
reset role;
insert into public.messages(id,conversation_id,sender_id,client_request_id,content,created_at) values
('30000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001',null,'fixture-6','retained deleted sender','2026-10-23 13:00:00Z');
set role authenticated;
select public.hdr03_assert((select unread_messages=2 from public.get_unread_counts()),'retained null-sender messages count as inbound');
select public.hdr03_assert(not has_table_privilege('authenticated','public.unread_count_signals','UPDATE') and not has_table_privilege('authenticated','public.unread_count_signals','DELETE'),'client cannot change signal revisions');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',false);
do $$ begin
  begin perform public.get_unread_counts(); raise exception 'missing account allowed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
reset role;
-- Removing a base-table policy must hide its rows even from the aggregate.
drop policy messages_participant_select_policy on public.messages;
set role authenticated;
select public.hdr03_assert((select unread_messages=0 from public.get_unread_counts()),'aggregate cannot bypass source message RLS');
reset role;

select public.hdr03_assert((select a.attname='id' from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='public.unread_count_signals'::regclass and i.indisprimary),'delete replica key is opaque id, never owner identity');
select public.hdr03_assert((select relreplident='d' from pg_class where oid='public.unread_count_signals'::regclass),'default replica identity prevents owner fields in delete tombstones');
