// Local disposable Docker target ONLY. Never accepts a hostname/connection URL.
export {scramVerifier} from './c2-foundation-login-proof.mjs';
import {spawnSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {diagnostic} from './operator-policy.mjs';
import {createHash} from 'node:crypto';
export const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
export const localDir=join(root,'artifacts/mod-v2-worker-complete/local');
export const docker='C:/Users/VivekKumar/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const target=JSON.parse(readFileSync(join(localDir,'container.json'),'utf8'));
if(!/^fairswap-p3-c2-20261020-[0-9a-f]{8}$/.test(target.name)||target.image!=='sha256:b3bfedb107413abb3b8cb0d0874b0414a1dceb3d55bc0c778de6ad22d1f7dc86')throw Error('LOCAL_CONTAINER_IDENTITY_REJECTED');
export const container=target.name;
function environment(password){const env={};for(const k of ['PATH','Path','SystemRoot','WINDIR','TMP','TEMP'])if(process.env[k])env[k]=process.env[k];if(password)env.PGPASSWORD=password;return env;}
export function argsFor({user='postgres',password}={}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(user))throw Error('LOCAL_ROLE_REJECTED');
 return ['exec','-i',...(password?['-e','PGPASSWORD']:[]),container,'psql','-X','-w','-qAt','-h',password?'127.0.0.1':'/tmp','-U',user,'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-f','-'];
}
export function raw(sql,options={}){return spawnSync(docker,argsFor(options),{input:sql,encoding:'utf8',env:environment(options.password),timeout:options.timeout||180000,maxBuffer:24*1024*1024,windowsHide:true});}
export function query(sql,options={}){const p=raw(sql,options);if(p.status!==0){const d=diagnostic(p.stderr||'',p.error);throw Object.assign(Error('LOCAL_SQL_FAILED'),{diagnostic:d,stderr:p.stderr||''});}return (p.stdout||'').trim();}
export function stream(sql,options={}){const p=spawn(docker,argsFor(options),{env:environment(options.password),windowsHide:true,stdio:['pipe','pipe','pipe']});p.stdin.end(sql);return p;}
export function inspect(){
 const p=spawnSync(docker,['inspect','--format','{{json .HostConfig}}',container],{encoding:'utf8',env:environment(),windowsHide:true});
 if(p.status!==0)throw Error('LOCAL_INSPECT_FAILED');const c=JSON.parse(p.stdout);
 if(c.NetworkMode!=='none'||!c.ReadonlyRootfs||c.Memory!==1073741824||c.MemorySwap!==1073741824||c.PidsLimit!==256)throw Error('LOCAL_CONTAINMENT_MISMATCH');
 return {network:c.NetworkMode,readOnlyRoot:c.ReadonlyRootfs,memory:c.Memory,swap:c.MemorySwap-c.Memory,pids:c.PidsLimit,nanoCpus:c.NanoCpus,capDrop:c.CapDrop,securityOptions:c.SecurityOpt};
}
if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv[2]==='--bootstrap'){
 const report={state:'BLOCKED',target:'DISPOSABLE_LOCAL_SCHEMA_CLONE',hostedDataImported:false,errors:[]};
 try{
  report.containment=inspect();
  const admin=sql=>query(sql,{user:'p3_local_bootstrap'});
  if(admin("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';")!=='0')throw Error('LOCAL_DATABASE_NOT_EMPTY');
  const catalog=JSON.parse(readFileSync(join(localDir,'schema-source/role-metadata.json'),'utf8'));
  const ident=s=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(s))throw Error('CATALOG_ROLE_NAME');return '"'+s+'"';};
  admin(catalog.roles.map(r=>`CREATE ROLE ${ident(r.name)} NOLOGIN ${r.super?'SUPERUSER':'NOSUPERUSER'} ${r.inherit?'INHERIT':'NOINHERIT'} ${r.createrole?'CREATEROLE':'NOCREATEROLE'} ${r.createdb?'CREATEDB':'NOCREATEDB'} ${r.bypassrls?'BYPASSRLS':'NOBYPASSRLS'} ${r.replication?'REPLICATION':'NOREPLICATION'};`).join('\n'));
  admin(catalog.members.map(m=>`GRANT ${ident(m.role)} TO ${ident(m.member)} WITH ADMIN ${m.admin?'TRUE':'FALSE'},INHERIT ${m.inherit?'TRUE':'FALSE'},SET ${m.set?'TRUE':'FALSE'};`).join('\n'));
  admin('CREATE SCHEMA extensions;CREATE SCHEMA vault;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;CREATE EXTENSION supabase_vault WITH SCHEMA vault;DROP SCHEMA public;');
  const dump=readFileSync(join(localDir,'schema-source/schema.sql'),'utf8');
  // pg_dump.exe stdout text mode adds one CR before each LF. Preserve the raw
  // export and remove exactly that transport layer, NOT stored SQL body CRLFs.
  const restore=dump.replace(/\r\n/g,'\n');writeFileSync(join(localDir,'schema-source/schema.restore.sql'),restore);
  admin(restore);
  const versions=JSON.parse(readFileSync(join(localDir,'schema-source/migration-identities.json'),'utf8'));
  const literal=s=>s===null?'NULL':"'"+String(s).replaceAll("'","''")+"'";
  admin('INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES'+versions.map(v=>`(${literal(v.version)},${literal(v.name)})`).join(',')+';');
  admin("INSERT INTO public.app_system_settings(setting_key,setting_value) VALUES('moderation_v2_enabled','false'),('moderation_v2_mode','disabled'),('moderation_automation_enabled','false');INSERT INTO app_moderation_v2.policy_registry(policy_version,contract_version,provider_model,seal_recipe) VALUES('fairswap_moderation_v2.0.0','2.0.0','omni-moderation-2024-09-26','seal_v1');INSERT INTO public.categories(id,slug,name,macro_category,new_listing_enabled) VALUES('e1000000-0000-4000-8000-000000000001','synthetic-goods','Synthetic Goods','goods',true);INSERT INTO public.cities(id,name,state,slug) VALUES('e2000000-0000-4000-8000-000000000001','Synthetic City','Synthetic State','synthetic-city');INSERT INTO app_moderation_v2.input_admission_slots(slot_id) VALUES(1),(2);");
  const pg=catalog.roles.find(r=>r.name==='postgres');
  admin(`ALTER ROLE postgres LOGIN ${pg.super?'SUPERUSER':'NOSUPERUSER'} ${pg.inherit?'INHERIT':'NOINHERIT'} ${pg.createrole?'CREATEROLE':'NOCREATEROLE'} ${pg.createdb?'CREATEDB':'NOCREATEDB'} ${pg.bypassrls?'BYPASSRLS':'NOBYPASSRLS'};ALTER DATABASE postgres OWNER TO postgres;GRANT USAGE ON SCHEMA vault TO postgres;GRANT SELECT ON vault.secrets,vault.decrypted_secrets TO postgres;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA vault TO postgres;`);
  const expected=JSON.parse(readFileSync(join(localDir,'schema-source/function-baseline.json'),'utf8'));
  const actual=JSON.parse(query("SELECT json_agg(json_build_object('identity',p.oid::regprocedure::text,'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'config',p.proconfig) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','auth','app_security','app_moderation_v2') AND p.prokind='f';"));
  const differences=expected.filter(e=>!actual.some(a=>a.identity===e.identity&&a.body_sha256===e.body_sha256&&a.owner===e.owner&&JSON.stringify(a.config)===JSON.stringify(e.config)));
  report.functionBodyDifferences=differences.map(x=>x.identity);report.functionBodiesVerified=expected.length-differences.length;report.restoreSha256=createHash('sha256').update(restore).digest('hex');
  if(differences.length||actual.length!==expected.length)throw Error('LOCAL_FUNCTION_FIDELITY_MISMATCH');
  report.state='LOCAL_SCHEMA_CLONE_READY';report.migrationIdentityRows=versions.length;report.warning='Identity rows are local fixture metadata, not evidence of replaying or applying hosted migration history.';
 }catch(e){report.errors.push(e.diagnostic||{code:/^[A-Z_]+$/.test(e.message)?e.message:'LOCAL_BOOTSTRAP_ERROR'});process.exitCode=2;}
 writeFileSync(join(localDir,'bootstrap-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
