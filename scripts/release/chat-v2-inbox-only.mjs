// Offline only: render reviewed, environment-specific SQL; never open a connection.
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {z} from 'zod';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const directory=resolve(root,'releases/candidates/chat-v2-inbox-only');
export const manifest=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const entry=z.object({version:z.string().regex(/^\d{14}$/),name:z.string().regex(/^[A-Za-z0-9_-]+$/),statementsSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const snapshotSchema=z.object({projectRef:z.string(),baseCommit:z.literal(manifest.baseCommit),observedAt:z.string().datetime({offset:true}),
  ledger:z.array(entry).min(1).max(1000),reviewEvidence:z.string().url().refine(value=>!/[\r\n\x00-\x20]/.test(value)&&value.startsWith('https://github.com/vivek2310sharma/FairSwap-Backend/'))}).strict();
export function candidate(){
 const bytes=readFileSync(resolve(directory,manifest.migration));
 if(sha(bytes)!==manifest.sha256||createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex')!==manifest.gitBlob)throw Error('CHAT_CANDIDATE_BYTES_MISMATCH');
 const sql=bytes.toString('utf8');
 if(!sql.includes('\nbegin;\n')||!sql.endsWith('commit;\n'))throw Error('CHAT_CANDIDATE_BOUNDARIES_CHANGED');
 return {sql,body:sql.replace('\nbegin;\n','\n').slice(0,-'commit;\n'.length)};
}
export function validateSnapshot(environment,input,now=Date.now()){
 const target=manifest.environments[environment];if(!target)throw Error('CHAT_ENVIRONMENT_INVALID');
 const parsed=snapshotSchema.safeParse(input);if(!parsed.success)throw Error('CHAT_LEDGER_SNAPSHOT_INVALID');
 const snapshot=parsed.data;
 if(snapshot.projectRef!==target.projectRef)throw Error('CHAT_WRONG_ENVIRONMENT');
 const age=now-Date.parse(snapshot.observedAt);if(age< -60000||age>86400000)throw Error('CHAT_LEDGER_SNAPSHOT_EXPIRED');
 if(new Set(snapshot.ledger.map(row=>row.version)).size!==snapshot.ledger.length)throw Error('CHAT_LEDGER_DUPLICATE_VERSION');
 if(snapshot.ledger.some(row=>manifest.excludedVersions.includes(row.version)))throw Error('CHAT_WORKER_RELEASE_ALREADY_PRESENT');
 const foundation=snapshot.ledger.find(row=>row.version===manifest.version);
 if(foundation&&foundation.name!==manifest.name)throw Error('CHAT_VERSION_COLLISION');
 if(foundation&&foundation.statementsSha256!==sha(JSON.stringify([candidate().sql])))throw Error('CHAT_FOUNDATION_LEDGER_REVIEW_MISMATCH');
 return {...snapshot,ledger:[...snapshot.ledger].sort((a,b)=>a.version.localeCompare(b.version))};
}
export function identityGuard(ref){return `
do $chat_identity$
declare v record; n integer; value text; anchors integer:=0;
begin
 if current_user<>'postgres' then raise exception using errcode='42501',message='CHAT_APPLICATION_OWNER_REQUIRED';end if;
 if to_regclass('vault.decrypted_secrets') is null then raise exception 'CHAT_TRUSTED_IDENTITY_REQUIRED';end if;
 for v in select * from (values ('email_outbox_worker_url','process-email-outbox'),('moderation_worker_url','process-listing-moderation')) x(name,path) loop
  select count(*),min(decrypted_secret) into n,value from vault.decrypted_secrets where name=v.name;
  if n>1 or (n=1 and value is distinct from ('https://${ref}.supabase.co/functions/v1/'||v.path)) then raise exception 'CHAT_ENVIRONMENT_MISMATCH';end if;
  anchors:=anchors+n;
 end loop;
 if anchors=0 then raise exception 'CHAT_TRUSTED_IDENTITY_REQUIRED';end if;
end $chat_identity$;
`;}
export function stateGuard(){return `
do $chat_state$
begin
 if (select count(*) from app_security.chat_v2_flags)<>5 or exists(select 1 from app_security.chat_v2_flags where enabled)
  then raise exception 'CHAT_ALL_FIVE_FLAGS_MUST_BE_OFF';end if;
 if exists(select 1 from app_security.chat_safety_jobs) or exists(select 1 from public.message_safety_findings)
  then raise exception 'CHAT_SAFETY_STATE_REQUIRES_SEPARATE_REVIEW';end if;
 if to_regclass('app_security.chat_safety_runtime') is not null or to_regprocedure('app_security.dispatch_chat_safety()') is not null
  or to_regclass('app_security.chat_safety_scheduler_runs') is not null then raise exception 'CHAT_WORKER_RELEASE_ALREADY_PRESENT';end if;
end $chat_state$;
`;}
export function catalogGuard(sql){
 const functions=[...sql.matchAll(/create function ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\(([\s\S]*?)\)\s*returns[\s\S]*?\bas \$\$([\s\S]*?)\$\$;/gi)];
 if(functions.length!==10)throw Error('CHAT_FUNCTION_INVENTORY_CHANGED');
 const rows=functions.map(match=>`(${literal(match[1])},${literal(match[2])},${literal(match[4])},${match[1]==='app_security'?'true':'false'})`).join(',\n');
 return `
do $chat_catalog$
declare expected record; n integer;
begin
 for expected in select * from (values ${rows}) x(schema_name,function_name,source_body,is_definer) loop
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname=expected.schema_name and p.proname=expected.function_name
   and p.prosrc=expected.source_body and p.prosecdef=expected.is_definer and 'search_path=""'=any(p.proconfig)
   and p.proowner=(select oid from pg_roles where rolname='postgres');
  if n<>1 then raise exception 'CHAT_INSTALLED_FUNCTION_DRIFT';end if;
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname=expected.schema_name and p.proname=expected.function_name)<>1 then raise exception 'CHAT_FUNCTION_OVERLOAD_DRIFT';end if;
 end loop;
 if not has_function_privilege('authenticated','public.chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean)','EXECUTE')
  or not has_function_privilege('authenticated','public.chat_v2_messages(uuid,integer,timestamptz,uuid)','EXECUTE')
  or has_function_privilege('anon','public.chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean)','EXECUTE')
  or has_function_privilege('anon','public.chat_v2_messages(uuid,integer,timestamptz,uuid)','EXECUTE')
  or has_table_privilege('authenticated','app_security.chat_v2_flags','SELECT,UPDATE')
  or has_table_privilege('authenticated','app_security.chat_safety_jobs','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('anon','public.message_safety_findings','SELECT')
  or has_table_privilege('authenticated','public.message_safety_findings','INSERT,UPDATE,DELETE') then raise exception 'CHAT_INSTALLED_GRANT_DRIFT';end if;
 if (select count(*) from pg_class where oid in ('app_security.chat_v2_flags'::regclass,'app_security.chat_safety_jobs'::regclass,'public.message_safety_findings'::regclass)
   and relrowsecurity and relforcerowsecurity and relowner=(select oid from pg_roles where rolname='postgres'))<>3 then raise exception 'CHAT_INSTALLED_RLS_DRIFT';end if;
 if to_regclass('public.chat_v2_conversations_listing_activity') is null or to_regclass('public.chat_v2_conversations_buyer_activity') is null
  or to_regclass('public.chat_v2_conversations_seller_activity') is null then raise exception 'CHAT_INSTALLED_INDEX_DRIFT';end if;
end $chat_catalog$;
`;
}
export function render(environment,input,now=Date.now()){
 const snapshot=validateSnapshot(environment,input,now),target=manifest.environments[environment],{sql,body}=candidate();
 const expected=snapshot.ledger.filter(row=>row.version!==manifest.version);
 const guard=`
${identityGuard(target.projectRef)}
do $chat_ledger$
declare observed jsonb;
begin
 if clock_timestamp() < ${literal(snapshot.observedAt)}::timestamptz-interval '1 minute'
  or clock_timestamp() > ${literal(snapshot.observedAt)}::timestamptz+interval '24 hours' then raise exception 'CHAT_LEDGER_SNAPSHOT_EXPIRED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'statementsSha256',encode(sha256(convert_to(coalesce(to_jsonb(statements)::text,'null'),'UTF8')),'hex')) order by version),'[]'::jsonb)
  into observed from supabase_migrations.schema_migrations where version<>${literal(manifest.version)};
 if observed<>${literal(JSON.stringify(expected))}::jsonb then raise exception 'CHAT_EXACT_LEDGER_MISMATCH';end if;
 if exists(select 1 from supabase_migrations.schema_migrations where version=${literal(manifest.version)} and
   (name is distinct from ${literal(manifest.name)} or cardinality(statements) is distinct from 1 or
    encode(sha256(convert_to(statements[1],'UTF8')),'hex') is distinct from ${literal(manifest.sha256)}))
  then raise exception 'CHAT_EXISTING_FOUNDATION_RECONCILIATION_REQUIRED';end if;
end $chat_ledger$;
`;
 const dependencies=`
do $chat_dependencies$
begin
 if to_regprocedure('public.send_message(uuid,text,text)') is null or to_regprocedure('public.mark_conversation_read(uuid,uuid)') is null
  or to_regprocedure('app_security.get_account_status(uuid)') is null or to_regprocedure('app_security.has_current_policy_acceptance(uuid)') is null
  or to_regprocedure('app_security.is_listing_publicly_visible(uuid)') is null or to_regclass('public.conversation_read_states') is null
  then raise exception 'CHAT_MESSAGING_DEPENDENCIES_REQUIRED';end if;
 if not exists(select 1 from supabase_migrations.schema_migrations where version=${literal(manifest.version)}) and
   (to_regclass('app_security.chat_v2_flags') is not null or to_regclass('app_security.chat_safety_jobs') is not null
    or to_regclass('public.message_safety_findings') is not null or to_regprocedure('public.chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean)') is not null
    or to_regprocedure('public.chat_v2_messages(uuid,integer,timestamptz,uuid)') is not null)
  then raise exception 'CHAT_ORPHANED_OBJECTS_RECONCILIATION_REQUIRED';end if;
end $chat_dependencies$;
`;
 const apply=`
do $chat_apply$
begin
 if not exists(select 1 from supabase_migrations.schema_migrations where version=${literal(manifest.version)}) then
  execute $chat_payload$${body}$chat_payload$;
  insert into supabase_migrations.schema_migrations(version,name,statements)
   values(${literal(manifest.version)},${literal(manifest.name)},array[$chat_source$${sql}$chat_source$]);
 end if;
end $chat_apply$;
`;
 for(const delimiter of ['$chat_payload$','$chat_source$','$chat_apply$'])if(sql.includes(delimiter))throw Error('CHAT_PAYLOAD_DELIMITER_COLLISION');
 const header=`-- ${target.name} / ${target.projectRef}: INACTIVE foundation only; requires independent protected release approval.\n-- Source SHA256 ${manifest.sha256}; observed ledger ${snapshot.observedAt}.\n-- Review provenance ${snapshot.reviewEvidence}; offline metadata is not an approval credential.\n`;
 const existingGuard=`do $chat_existing$ begin if exists(select 1 from supabase_migrations.schema_migrations where version=${literal(manifest.version)}) then execute $chat_existing_checks$${stateGuard()}${catalogGuard(sql)}$chat_existing_checks$;end if;end $chat_existing$;\n`;
 return {preflight:`${header}begin transaction read only;\n${guard}${dependencies}${existingGuard}commit;\n`,
  apply:`${header}begin;\nset local standard_conforming_strings=on;\nset local lock_timeout='5s';\nset local statement_timeout='30s';\nselect pg_advisory_xact_lock(hashtextextended('chat-v2-foundation-release',0));\nlock table supabase_migrations.schema_migrations in share row exclusive mode;\n${guard}${dependencies}${apply}${stateGuard()}${catalogGuard(sql)}commit;\n`,
  rollback:`${header}begin;\nset local lock_timeout='5s';\nset local statement_timeout='30s';\n${identityGuard(target.projectRef)}update app_security.chat_v2_flags set enabled=false where name='inbox';\ndo $$begin if exists(select 1 from app_security.chat_v2_flags where name<>'inbox' and enabled) then raise exception 'CHAT_OTHER_FLAGS_MUST_REMAIN_OFF';end if;end$$;\ncommit;\n`};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [environment,inputPath,...extra]=process.argv.slice(2);if(!environment||!inputPath||extra.length)throw Error('Usage: node scripts/release/chat-v2-inbox-only.mjs fairswaptest|fairswapprod <reviewed-snapshot.json>');
  render(environment,JSON.parse(readFileSync(resolve(inputPath),'utf8')));
  throw Error('CHAT_LEGACY_RENDERER_OFFLINE_ONLY');
 }catch(error){const message=error instanceof Error?error.message:'';console.error(/^CHAT_[A-Z_]+$/.test(message)?message:message.startsWith('Usage:')?'Usage: node scripts/release/chat-v2-inbox-only.mjs fairswaptest|fairswapprod <reviewed-snapshot.json>':'CHAT_PREPARATION_FAILED');process.exitCode=1;}
}
