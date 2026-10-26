import {createHash} from 'node:crypto';
import {candidate,manifest,render,validateSnapshot,stateGuard,catalogGuard,identityGuard} from './chat-v2-inbox-only.mjs';
export const hash=value=>createHash('sha256').update(value).digest('hex');
const literal=s=>"'"+s.replaceAll("'","''")+"'";
export function buildPlan(environment,input,now=Date.now()){
 const snapshot=validateSnapshot(environment,input,now);
 if(snapshot.ledger.some(row=>row.version===manifest.version))throw Error('CHAT_EXISTING_REQUIRES_PROTECTED_RECOVERY');
 const legacy=render(environment,input,now).apply;
 const start=legacy.indexOf('do $chat_apply$'),end=legacy.indexOf('end $chat_apply$;')+'end $chat_apply$;'.length;
 if(start<0||end<start)throw Error('CHAT_GUARD_BOUNDARY_CHANGED');
 const prefix=legacy.slice(0,start).replace('\nbegin;\n','\n');
 const baseExecution=prefix+candidate().body+legacy.slice(end).replace(/commit;\n$/,'');
 const executionMarker=hash(baseExecution);
 const execution=baseExecution+`select '${executionMarker}'::text as chat_inbox_execution_marker;\n`;
 if(/insert into supabase_migrations/i.test(execution))throw Error('CHAT_CUSTOM_HISTORY_WRITE_FORBIDDEN');
 const expected=snapshot.ledger;
 const postflight=`begin transaction isolation level repeatable read read only;
${identityGuard(manifest.environments[environment].projectRef)}
${stateGuard()}${catalogGuard(candidate().sql)}
do $post$
declare actual jsonb;
begin
 if current_setting('server_version_num')::integer/10000<>17 then raise exception 'CHAT_PG17_REQUIRED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'statementsSha256',encode(sha256(convert_to(coalesce(to_jsonb(statements)::text,'null'),'UTF8')),'hex')) order by version),'[]'::jsonb)
 into actual from supabase_migrations.schema_migrations where version<>${literal(manifest.version)};
 if actual<>${literal(JSON.stringify(expected))}::jsonb then raise exception 'CHAT_POST_LEDGER_DRIFT';end if;
 if (select count(*) from supabase_migrations.schema_migrations where version=${literal(manifest.version)} and name=${literal(manifest.name)} and cardinality(statements)>0)<>1 then raise exception 'CHAT_CLI_HISTORY_REQUIRED';end if;
 if not exists(select 1 from supabase_migrations.schema_migrations m cross join lateral unnest(m.statements) as history_statement(body) where m.version=${literal(manifest.version)} and strpos(history_statement.body,${literal(executionMarker)})>0) then raise exception 'CHAT_CLI_EXECUTION_MARKER_MISMATCH';end if;
end $post$;
select jsonb_build_object('flagsOff',5,'version',version,'postgresVersionNum',current_setting('server_version_num')::integer,'historySha256',encode(sha256(convert_to(to_jsonb(statements)::text,'UTF8')),'hex')) from supabase_migrations.schema_migrations where version=${literal(manifest.version)};
commit;
`;
 return {execution,preflight:prefix+'rollback;\n',postflight,rollback:render(environment,input,now).rollback,
  sourceSha256:manifest.sha256,executionSha256:hash(execution),ledgerSha256:hash(JSON.stringify(snapshot.ledger))};
}
