// This entrypoint imports no database client, migration planner or subprocess API.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectProtection,verifyAdministrativeAttestation,bundleHash} from './inbox-protection.mjs';
export async function auditOnly(environment,bundle,{env=process.env,fetcher=fetch,report=value=>console.log(JSON.stringify(value))}={}){
 if(['CHAT_DATABASE_PASSWORD','PGPASSWORD','SUPABASE_DB_PASSWORD'].some(name=>Object.hasOwn(env,name)))throw Error('CHAT_AUDIT_DATABASE_SECRET_FORBIDDEN');
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='vivek2310sharma/FairSwap-Backend'||env.GITHUB_REF!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')||bundleHash()!==bundle)throw Error('CHAT_AUDIT_IMMUTABLE_INPUT_REQUIRED');
 const inspection=await inspectProtection(environment,env.CHAT_RELEASE_AUDIT_TOKEN,env.GITHUB_SHA,fetcher);
 // Allows administrators to prepare evidence; this is explicitly NOT a pass.
 report({status:'UNAPPROVED_SNAPSHOT',environment,sourceCommit:env.GITHUB_SHA,bundleSha256:bundle,...inspection});
 const attestationSha256=await verifyAdministrativeAttestation(environment,env.CHAT_RELEASE_AUDIT_TOKEN,{sourceCommit:env.GITHUB_SHA,bundleSha256:bundle,attestationJson:env.CHAT_RELEASE_ADMIN_ATTESTATION_JSON},inspection,fetcher);
 return {status:'verified',mode:'audit-only',environment,sourceCommit:env.GITHUB_SHA,bundleSha256:bundle,snapshotSha256:inspection.snapshotSha256,attestationSha256,databaseAccess:false,activation:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4)throw Error('CHAT_AUDIT_INPUT_REQUIRED');console.log(JSON.stringify(await auditOnly(...process.argv.slice(2))));}
 catch(error){console.error(/^CHAT_[A-Z_]+$/.test(error?.message??'')?error.message:'CHAT_AUDIT_BLOCKED');process.exitCode=1;}
}
