import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {candidate,manifest,render,validateSnapshot,stateGuard,catalogGuard,identityGuard} from './chat-v2-inbox-only.mjs';
export const hash=value=>createHash('sha256').update(value).digest('hex');
// Return only a closed vocabulary. Never return a log fragment, SQL or connection URI.
export function classifyCliFailure(output){
 const text=String(output??'').replace(/\u001b\[[0-9;]*m/g,'');
 const state=text.match(/SQLSTATE\s*[:=]?\s*([0-9A-Z]{5})\b/i)?.[1]?.toUpperCase()
  ??text.match(/(?:^|[,{\s])["']?code["']?\s*[:=]\s*["']([0-9A-Z]{5})["']/im)?.[1]?.toUpperCase()
  ??text.match(/ERROR:\s+([0-9A-Z]{5}):/i)?.[1]?.toUpperCase();
 if(state?.startsWith('28')||/password authentication failed|no password supplied|authentication failed/i.test(text))return 'AUTHENTICATION_FAILURE';
 if(state?.startsWith('08'))return 'CONNECTION_FAILURE';
 if(/connection refused|failed to connect|could not connect|connection timed out|network is unreachable|no such host|certificate verify failed|ECONNREFUSED|ENOTFOUND|server closed the connection/i.test(text))return 'CONNECTION_FAILURE';
 if(/remote migration versions not found|ErrMissingLocal/i.test(text))return 'MISSING_LOCAL_HISTORY';
 if(/CHAT_HISTORY_WORKSPACE_(?:MISMATCH|DUPLICATE|INVALID)/.test(text))return 'LOCAL_HISTORY_WORKSPACE_FAILURE';
 if(/CHAT_FIXTURE_BOOTSTRAP_SEED_CHANGED|CHAT_NATIVE_CLI_SEED_HISTORY_REQUIRED/.test(text))return 'FIXTURE_CONFIGURATION_FAILURE';
 if(/inserted before the last migration|ErrMissingRemote/i.test(text))return 'MIGRATION_ORDER_FAILURE';
 if(state==='42501'||/permission denied|must be owner/i.test(text))return 'ROLE_PERMISSION_FAILURE';
 if(/invalid config|failed to parse config|unknown flag|unrecognized option|invalid connection|invalid database url|project is not linked/i.test(text))return 'CLI_CONFIGURATION_FAILURE';
 const sentinelMessage=/(?:^|\n)[^\n]*(?:ERROR|PostgresError):\s*(?:P0001:\s*)?CHAT_FIXTURE_ROLLBACK(?:\s|\(|$)/i.test(text)
  ||/(?:^|[,{\s])["']?message["']?\s*:\s*["']CHAT_FIXTURE_ROLLBACK["']/m.test(text);
 if(state==='P0001'&&sentinelMessage)return 'EXPECTED_SQL_ROLLBACK';
 if(state)return 'UNEXPECTED_SQL_FAILURE';
 return 'UNCLASSIFIED_CLI_FAILURE';
}
// CLI migration fetch reconstructs real applied sources. No placeholders or ledger edits.
export function verifyHistoryWorkspace(directory,ledger,{pending=false}={}){
 if(!Array.isArray(ledger)||ledger.some(row=>!/^\d{14}$/.test(row.version)||!/^[A-Za-z0-9_-]+$/.test(row.name)))throw Error('CHAT_HISTORY_WORKSPACE_INVALID_LEDGER');
 const expected=ledger.map(row=>`${row.version}_${row.name}.sql`);
 if(new Set(expected).size!==expected.length)throw Error('CHAT_HISTORY_WORKSPACE_DUPLICATE');
 if(pending)expected.push(`${manifest.version}_${manifest.name}.sql`);
 const target=join(directory,'supabase/migrations');
 const files=readdirSync(target).sort();
 if(JSON.stringify(files)!==JSON.stringify(expected.sort()))throw Error('CHAT_HISTORY_WORKSPACE_MISMATCH');
 for(const name of files){const file=join(target,name),stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0)throw Error('CHAT_HISTORY_WORKSPACE_INVALID_FILE');chmodSync(file,0o600);}
 return files.length;
}
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
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4||process.argv[2]!=='classify')throw Error('invalid classifier arguments');console.log(classifyCliFailure(readFileSync(process.argv[3],'utf8')));}
 catch{console.log('UNCLASSIFIED_CLI_FAILURE');process.exitCode=1;}
}
