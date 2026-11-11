-- Forward only. The release runner owns the transaction and migration ledger.
-- Keep all environment-specific moderation guards, ownership checks and ACLs.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local timezone = 'UTC';

do $migration$
declare
  v_item record;
  v_definition text;
  v_changed text;
begin
  for v_item in select * from (values
    ('app_security.impl_moderate_listing(uuid,text,text)',
     '0dd9051728d5ac49639469d367f21354',
     'expires_at = pg_catalog.clock_timestamp() + INTERVAL ''30 days''',
     'expires_at = pg_catalog.statement_timestamp() + INTERVAL ''365 days'''),
    ('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)',
     'dc29654e03e500b826c4778d9d1bd80c',
     'expires_at = v_now + INTERVAL ''30 days''',
     'expires_at = v_now + INTERVAL ''365 days'''),
    ('public.trg_fn_listing_transition_notification()',
     '41cffceab962fb6ca4f158beb49b3958',
     'has been approved and is now live.',
     'has been approved and is now live. Listing validity is 365 days from publication, unless sold or removed sooner.')
  ) as patches(signature, expected_hash, old_text, new_text)
  loop
    if pg_catalog.to_regprocedure(v_item.signature) is null then
      raise exception 'Listing validity prerequisite missing: %', v_item.signature;
    end if;
    v_definition := pg_catalog.replace(pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_item.signature)), E'\r\n', E'\n');
    if pg_catalog.md5(v_definition) <> v_item.expected_hash then
      raise exception 'Listing validity function drift: %', v_item.signature;
    end if;
    if (pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_item.old_text, ''))) /
        pg_catalog.length(v_item.old_text) <> 1 then
      raise exception 'Listing validity patch must match once: %', v_item.signature;
    end if;
    v_changed := pg_catalog.replace(v_definition, v_item.old_text, v_item.new_text);
    if v_item.signature = 'app_security.impl_moderate_listing(uuid,text,text)' then
      -- One publication instant for exact boundary equality, including renewals.
      v_changed := pg_catalog.replace(v_changed,
        'published_at = pg_catalog.clock_timestamp(),',
        'published_at = pg_catalog.statement_timestamp(),');
    end if;
    execute v_changed;
  end loop;
end;
$migration$;

-- Serialize with expiry/status writers. No status or renewal-count changes.
lock table public.listings in share row exclusive mode;
do $backfill$
declare
  v_protected_expiry timestamptz;
begin
  select expires_at into v_protected_expiry from public.listings
  where id = 'f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8';

  update public.listings as l
  set expires_at = l.published_at + interval '365 days'
  where l.id <> 'f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8'
    and l.status in ('active', 'reserved', 'paused')
    and l.published_at is not null
    and l.sold_at is null
    and l.expires_at > pg_catalog.clock_timestamp()
    and l.expires_at < l.published_at + interval '365 days'
    and app_security.get_account_status(l.seller_id) = 'active'
    and app_security.has_current_policy_acceptance(l.seller_id)
    and exists (select 1 from public.categories c
                where c.id = l.category_id and c.is_active);

  if (select expires_at from public.listings
      where id = 'f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8')
      is distinct from v_protected_expiry then
    raise exception 'Protected listing expiry changed';
  end if;
end;
$backfill$;
