-- Additive V2.1.2 correction. Original Posting V2 migrations stay immutable.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Unknown/legacy sessions are never assumed to lack a device-local draft.
alter table public.posting_upload_sessions
 add column draft_protected boolean not null default true,
 add column empty_request_id uuid;
create unique index posting_v212_empty_request on public.posting_upload_sessions(owner_id,empty_request_id);

create or replace function app_security.impl_posting_v2_session(p_session_id uuid,p_operation text,p_media_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor(); s public.posting_upload_sessions; m public.posting_staged_media; n integer; candidate_id uuid; request_id uuid; empty_allocation boolean:=false;
begin
 if p_operation='list_recovery' then
  return pg_catalog.jsonb_build_object('limit',5,'sessions',coalesce((
   select pg_catalog.jsonb_agg(q.item order by q.created_at,q.id) from (
    select candidate.id,candidate.created_at,pg_catalog.jsonb_build_object(
     'id',candidate.id,'state',candidate.state,'created_at',candidate.created_at,'expires_at',candidate.expires_at,
     'draft_protected',candidate.draft_protected,
     'can_rotate',not candidate.draft_protected and candidate.empty_request_id is not null and candidate.state='open' and not exists(select 1 from public.posting_staged_media pm where pm.session_id=candidate.id),
     'can_abandon',candidate.state='open' and not exists(select 1 from public.posting_staged_media pm where pm.session_id=candidate.id)
    ) as item from public.posting_upload_sessions candidate
    where candidate.owner_id=u and candidate.state in ('open','finalizing') and candidate.expires_at>now()
    order by candidate.created_at,candidate.id limit 5
   ) q),'[]'::jsonb));
 end if;
 -- Same seller lock as creation: capacity release and allocation serialize.
 if p_operation in ('create','create_empty','claim_draft','read','abandon_empty') then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,2));
 end if;
 if p_operation in ('create','create_empty') then
  if not exists(select 1 from public.posting_category_definitions where category_key='mobiles' and subcategory_key='mobile-phones' and version=2 and enabled) then raise exception 'Posting unavailable'; end if;
  if p_operation='create_empty' then
   -- A caller-supplied/local draft UUID can NEVER be certified empty. The request
   -- nonce is only an owner-scoped idempotency key; the new session id is server-minted.
   if p_session_id is null then raise exception using errcode='22023',message='Invalid empty allocation request'; end if;
   request_id:=p_session_id;
   select existing.id into candidate_id from public.posting_upload_sessions existing where existing.owner_id=u and existing.empty_request_id=request_id;
   if candidate_id is not null then p_session_id:=candidate_id;
   else p_session_id:=pg_catalog.gen_random_uuid(); empty_allocation:=true; end if;
  end if;
  -- Reject collisions before retirement, including a supplied id owned elsewhere.
  if exists(select 1 from public.posting_upload_sessions existing where existing.id=p_session_id and existing.owner_id<>u) then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
  if not exists(select 1 from public.posting_upload_sessions existing where existing.id=p_session_id and existing.owner_id=u)
   and (select count(*) from public.posting_upload_sessions where owner_id=u and state in ('open','finalizing') and expires_at>now())>=5 then
   -- Draft protection is monotonic. Null/legacy knowledge is protected by default.
   -- Reserve/prepare/claim take the same session row lock and protect before writing.
   select candidate.id into candidate_id from public.posting_upload_sessions candidate
    where candidate.owner_id=u and candidate.state='open' and candidate.expires_at>now()
     and not candidate.draft_protected and candidate.empty_request_id is not null
     and not exists(select 1 from public.posting_staged_media pm where pm.session_id=candidate.id)
    order by candidate.created_at,candidate.id limit 1 for update;
   if candidate_id is null then raise exception using errcode='PT429',message='UPLOAD_SESSION_LIMIT'; end if;
   -- No row or asset is deleted. The unchanged service-only cleanup consumes this tombstone.
   update public.posting_upload_sessions set state='expired',expires_at=now(),cleanup_after=now() where id=candidate_id;
  end if;
  insert into public.posting_upload_sessions(id,owner_id,draft_protected,empty_request_id)
   values(p_session_id,u,not empty_allocation,case when empty_allocation then request_id else null end) on conflict(id) do nothing;
 end if;
 select * into s from public.posting_upload_sessions where id=p_session_id and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
 if p_operation='abandon_empty' then
  -- Even removed/uploading media history protects the session and its objects.
  -- This row lock is also taken by reserve, media-ready, prepare and finalization.
  if exists(select 1 from public.posting_staged_media pm where pm.session_id=s.id)
   or s.state not in ('open','expired') then
   raise exception using errcode='PT409',message='UPLOAD_SESSION_PROTECTED';
  end if;
  if s.state='open' then
   if s.expires_at<=now() then raise exception using errcode='PT410',message='UPLOAD_SESSION_EXPIRED'; end if;
   update public.posting_upload_sessions set state='expired',expires_at=now(),cleanup_after=now() where id=s.id returning * into s;
  end if;
  -- Keep a tombstone for lost-response retries; never delete here.
  return pg_catalog.jsonb_build_object('session',pg_catalog.to_jsonb(s),'media','[]'::jsonb);
 end if;
 if s.state='submitted' then return jsonb_build_object('session',to_jsonb(s),'media','[]'::jsonb); end if;
 if s.expires_at<=now() or s.state in ('expired','cleaned') then raise exception using errcode='PT410',message='UPLOAD_SESSION_EXPIRED'; end if;
 if p_operation in ('create','read','claim_draft','reserve','remove','prepare') then
  update public.posting_upload_sessions set draft_protected=true where id=s.id returning * into s;
 end if;
 if p_operation in ('reserve','remove') then
  if s.expires_at<now()+interval '5 minutes' then raise exception using errcode='PT410',message='UPLOAD_SESSION_EXPIRED'; end if;
  if s.state<>'open' then raise exception 'Submission is being finalized'; end if;
  if p_operation='remove' then
   update public.posting_staged_media set state='removed' where id=p_media_id and session_id=s.id;
  else
   select * into m from public.posting_staged_media where id=p_media_id and session_id=s.id for update;
   if m.state='removed' then raise exception 'Photo removed'; end if;
   if m.id is null then
    select count(*) into n from public.posting_staged_media where session_id=s.id and state<>'removed';
    if n>=8 then raise exception 'Maximum 8 photos'; end if;
    insert into public.posting_staged_media(id,session_id) values(p_media_id,s.id) returning * into m;
   elsif m.state='uploading' then
    if m.lease_until>now() then raise exception using errcode='PT409',message='Upload in progress; retry shortly'; end if;
    update public.posting_staged_media set attempt=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id=m.id returning * into m;
   end if;
  end if;
 elsif p_operation='prepare' then
  if exists(select 1 from public.posting_staged_media where session_id=s.id and state='uploading') then raise exception 'Finish or remove failed uploads first'; end if;
  update public.posting_upload_sessions set state='finalizing',cleanup_after=greatest(cleanup_after,now()+interval '10 minutes') where id=s.id returning * into s;
 elsif p_operation not in ('create','create_empty','read','claim_draft') then raise exception 'Invalid operation';
 end if;
 return jsonb_build_object('session',to_jsonb(s),'media',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from public.posting_staged_media x where x.session_id=s.id and x.state<>'removed'),'[]'::jsonb));
end $$;

-- Preserve the existing public invoker signature, owner RLS and explicit grants.
revoke all on function app_security.impl_posting_v2_session(uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_posting_v2_session(uuid,text,uuid) to authenticated;
commit;
