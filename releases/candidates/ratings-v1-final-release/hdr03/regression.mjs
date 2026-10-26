import assert from 'node:assert/strict';
import {readFileSync as read} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {verifySource} from './verify-source.mjs';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../../..');
const text=p=>read(resolve(root,p),'utf8').replaceAll('\r\n','\n');
const json=p=>JSON.parse(read(resolve(here,p),'utf8'));
export async function hdr03Checks(db,check,environment){
 const chain=verifySource();
 const rawQuery=read(resolve(here,'fingerprint.sql'),'utf8');
 const query=rawQuery.slice(rawQuery.indexOf('select ')).replace(/;\s*$/,'');
 const fingerprint=async()=>Object.values((await db.query(query)).rows[0])[0];
 // Explicit Supabase public-schema default grants; private helpers receive no client grant.
 await db.exec(`alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
create publication supabase_realtime for table public.messages,public.notifications;`);
 const ledger=JSON.parse(text('releases/production/hdr-03/production-ledger-20261023.json')).entries;
 for(const row of ledger)await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,array['DISPOSABLE FIXTURE ONLY'])",[row.version,row.name]);
 const source=json('reviewed-source.json').content;
 await db.exec(source);
 const expected=await fingerprint();
 await check('HDR-03 reviewed SQL recreates installed contract fingerprint including ACL/RLS/triggers/publication',async()=>{
  assert.deepEqual(expected,json('installed-contract.json').contract);
  assert.deepEqual(expected,json('expected-contract.json').contract);
 });
 await db.exec("insert into supabase_migrations.schema_migrations(version,name,statements) values('20261023160752','hdr03_production_unread_counts',null)");
 const guard=read(resolve(here,'../production/hdr03-exception.sql'),'utf8');
 // Set identity for the independently tested Production-only historical exception.
 await db.exec('delete from vault.decrypted_secrets');await db.query("insert into vault.decrypted_secrets values('project_url','https://kriuhwppxgxsyyrbjsau.supabase.co')");
 await check('HDR-03 historical exception accepts only reviewed NULL row and exact contract',async()=>{await db.exec(guard);});
 const denied=async(sql,pattern=/HDR03_HISTORICAL_(CONTRACT|ROW)_DRIFT/)=>{
  // Mutations are disposable fixture transactions; rollback after evaluating the exact guard.
  // Each adapter invocation has a distinct session, so combine mutation+guard in one transaction.
  const inner=guard.slice(guard.indexOf('do $ratings_hdr03$'),guard.lastIndexOf('rollback;'));
  await assert.rejects(()=>db.exec('begin;'+sql+'\n'+inner+'\nrollback;'),pattern);
 };
 await check('HDR-03 exception denies changed name, version, non-NULL statements and foreign project',async()=>{
  for(const mutation of ["update supabase_migrations.schema_migrations set name='wrong' where version='20261023160752';","update supabase_migrations.schema_migrations set version='20261023160753' where version='20261023160752';","update supabase_migrations.schema_migrations set statements=array[]::text[] where version='20261023160752';","update supabase_migrations.schema_migrations set statements=null where version='20260914000001';"])await denied(mutation);
  await denied("update vault.decrypted_secrets set decrypted_secret='https://wpppxlnbzqynvhpeuavd.supabase.co';",/RATINGS_ENVIRONMENT_MISMATCH/);
 });
 await check('HDR-03 exception denies RPC body/grant/overload and trigger drift',async()=>{
  for(const mutation of [
   "create or replace function public.get_unread_counts() returns table(unread_messages bigint,unread_notifications bigint) language sql as $$select 0::bigint,0::bigint$$;",
   'grant execute on function public.get_unread_counts() to anon;',
   'grant execute on function app_security.hdr03_signal_message() to authenticated;',
   'create function public.get_unread_counts(integer) returns integer language sql as $$select 0$$;',
   'alter table public.messages disable trigger hdr03_message_arrival;'
  ])await denied(mutation);
 });
 await check('HDR-03 exception denies RLS/policy/column/constraint/publication drift',async()=>{
  for(const mutation of [
   'alter table public.unread_count_signals disable row level security;',
   'alter table public.unread_count_signals no force row level security;',
   'alter policy unread_count_signals_owner_select on public.unread_count_signals using (true);',
   'alter table public.unread_count_signals add column leaked text;',
   'alter table public.unread_count_signals drop constraint unread_count_signals_revision_check;',
   'alter publication supabase_realtime drop table public.unread_count_signals;',
   'alter table public.messages disable row level security;'
  ])await denied(mutation);
 });
 await check('HDR-03 remains NULL; exception does not change ledger or apply permissions',async()=>{
  await db.exec(guard);assert.equal(Object.values((await db.query("select statements from supabase_migrations.schema_migrations where version='20261023160752'")).rows[0])[0],null);
 });
 await db.exec('delete from vault.decrypted_secrets');await db.query("insert into vault.decrypted_secrets values('project_url',$1)",['https://'+(environment==='test'?'wpppxlnbzqynvhpeuavd':'kriuhwppxgxsyyrbjsau')+'.supabase.co']);
 await db.exec('delete from supabase_migrations.schema_migrations');
}
