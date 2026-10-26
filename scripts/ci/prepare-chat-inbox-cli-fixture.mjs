// Writes only synthetic local fixtures. No connection, credentials or hosted data.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,basename,isAbsolute} from 'node:path';
import {canonicalMessaging,root} from '../../tests/chat-v2-inbox-only/canonical.mjs';
import {buildPlan,hash} from '../release/protected-inbox-plan.mjs';
import {manifest} from '../release/chat-v2-inbox-only.mjs';
const [directory,...extra]=process.argv.slice(2);
if(extra.length||!isAbsolute(directory??'')||!basename(directory).startsWith('chat-inbox-native.'))throw Error('Dedicated fixture directory required');
const input={projectRef:manifest.environments.fairswaptest.projectRef,baseCommit:manifest.baseCommit,observedAt:new Date().toISOString(),reviewEvidence:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/60',ledger:[{version:'20260914000011',name:'create_communication',statementsSha256:hash(JSON.stringify(['fixture baseline']))},{version:'20261026000001',name:'fixture_later_baseline',statementsSha256:hash(JSON.stringify(['fixture later baseline']))}]};
const plan=buildPlan('fairswaptest',input);
mkdirSync(join(directory,'supabase/migrations'),{recursive:true});
writeFileSync(join(directory,'supabase/config.toml'),'project_id="chat-native-fixture"\n[db]\nmajor_version=17\n');
writeFileSync(join(directory,'prepare.sql'),readFileSync(resolve(root,'tests/chat-v2-inbox-only/bootstrap.sql'),'utf8')+'\n'+canonicalMessaging()+"\ninsert into supabase_migrations.schema_migrations values('20261026000001',array['fixture later baseline'],'fixture_later_baseline');\nreset role;set session authorization inbox_fixture_admin;alter role postgres login;");
writeFileSync(join(directory,'supabase/migrations',`${manifest.version}_${manifest.name}.sql`),plan.execution);
writeFileSync(join(directory,'approved.sql'),plan.execution);
writeFileSync(join(directory,'postflight.sql'),plan.postflight);
writeFileSync(join(directory,'security.sql'),'set role postgres;\n'+readFileSync(resolve(root,'tests/chat-v2-inbox-only/native-security.sql'),'utf8'));
