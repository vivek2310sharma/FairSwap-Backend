// This entrypoint imports no database client, migration planner or subprocess API.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditProtection,bundleHash,requireOwnerActors} from './inbox-protection.mjs';
export async function auditOnly(environment,bundle,{env=process.env,fetcher=fetch}={}){
 if(['CHAT_DATABASE_PASSWORD','PGPASSWORD','SUPABASE_DB_PASSWORD'].some(name=>Object.hasOwn(env,name)))throw Error('CHAT_AUDIT_DATABASE_SECRET_FORBIDDEN');
 requireOwnerActors(env);
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='vivek2310sharma/FairSwap-Backend'||env.GITHUB_REF!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')||bundleHash()!==bundle)throw Error('CHAT_AUDIT_IMMUTABLE_INPUT_REQUIRED');
 const protection=await auditProtection(environment,env.CHAT_RELEASE_AUDIT_TOKEN,fetcher,{sourceCommit:env.GITHUB_SHA,bundleSha256:bundle,actor:env.GITHUB_ACTOR,triggeringActor:env.GITHUB_TRIGGERING_ACTOR});
 return {status:'verified',mode:'audit-only',environment,sourceCommit:env.GITHUB_SHA,bundleSha256:bundle,snapshotSha256:protection.snapshotSha256,databaseAccess:false,activation:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4)throw Error('CHAT_AUDIT_INPUT_REQUIRED');console.log(JSON.stringify(await auditOnly(...process.argv.slice(2))));}
 catch(error){console.error(/^CHAT_[A-Z_]+$/.test(error?.message??'')?error.message:'CHAT_AUDIT_BLOCKED');process.exitCode=1;}
}
