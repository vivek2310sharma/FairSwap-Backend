// Synthetic local cluster only. Historical fixtures are executed and recorded by CLI.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,basename,isAbsolute} from 'node:path';
import {canonicalMessaging,root} from '../../tests/chat-v2-inbox-only/canonical.mjs';
import {buildPlan,verifyHistoryWorkspace} from '../release/protected-inbox-plan.mjs';
import {manifest} from '../release/chat-v2-inbox-only.mjs';
const [directory,phase='seed',...extra]=process.argv.slice(2);
if(extra.length||!isAbsolute(directory??'')||!basename(directory).startsWith('chat-inbox-native.')||!['seed','plan'].includes(phase))throw Error('Dedicated fixture directory and phase required');
const config='project_id="chat-native-fixture"\n[db]\nmajor_version=17\n';
if(phase==='seed'){
 const seed=join(directory,'seed');mkdirSync(join(seed,'supabase/migrations'),{recursive:true});
 mkdirSync(join(directory,'supabase/migrations'),{recursive:true});
 writeFileSync(join(seed,'supabase/config.toml'),config);writeFileSync(join(directory,'supabase/config.toml'),config);
 const bootstrap=readFileSync(resolve(root,'tests/chat-v2-inbox-only/bootstrap.sql'),'utf8');
 // Omit the legacy mock-ledger seed before any database exists; never delete/repair history.
 const mock=/^insert into supabase_migrations\.schema_migrations values\('20260914000011',array\['fixture baseline'\], 'create_communication'\);\r?\n/m;
 if(!mock.test(bootstrap))throw Error('CHAT_FIXTURE_BOOTSTRAP_SEED_CHANGED');
 writeFileSync(join(directory,'prepare.sql'),bootstrap.replace(mock,'')+'\n'+canonicalMessaging()+'\nreset role;set session authorization inbox_fixture_admin;alter role postgres login;');
 // Real test-only migrations: repeat execution would fail, exposing accidental replay.
 writeFileSync(join(seed,'supabase/migrations/20000101000000_ci_fixture_baseline.sql'),'create table app_security.inbox_cli_baseline_fixture(id integer primary key);\ninsert into app_security.inbox_cli_baseline_fixture values(1);\n');
 writeFileSync(join(seed,'supabase/migrations/20990101000000_ci_fixture_later.sql'),'create table app_security.inbox_cli_later_fixture(id integer primary key);\ninsert into app_security.inbox_cli_later_fixture values(1);\n');
}else{
 const ledger=JSON.parse(readFileSync(join(directory,'history.json'),'utf8'));
 if(!Array.isArray(ledger)||ledger.length!==2||ledger[0].version!=='20000101000000'||ledger[1].version!=='20990101000000')throw Error('CHAT_NATIVE_CLI_SEED_HISTORY_REQUIRED');
 const input={projectRef:manifest.environments.fairswaptest.projectRef,baseCommit:manifest.baseCommit,observedAt:new Date().toISOString(),reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/60',ledger};
 verifyHistoryWorkspace(directory,ledger);
 const plan=buildPlan('fairswaptest',input);
 writeFileSync(join(directory,'supabase/migrations',`${manifest.version}_${manifest.name}.sql`),plan.execution);
 verifyHistoryWorkspace(directory,ledger,{pending:true});
 writeFileSync(join(directory,'approved.sql'),plan.execution);
 writeFileSync(join(directory,'postflight.sql'),plan.postflight);
 writeFileSync(join(directory,'security.sql'),'set role postgres;\n'+readFileSync(resolve(root,'tests/chat-v2-inbox-only/native-security.sql'),'utf8'));
}
