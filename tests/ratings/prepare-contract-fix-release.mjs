// Local files only. Never executes SQL or contacts hosted services.
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir='releases/candidates/ratings-v1-contract-fix/';
mkdirSync(dir,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const migrations=readdirSync('supabase/forward-migrations/ratings').filter(x=>/^\d{14}_.+\.sql$/.test(x)).sort().map(file=>{
 const path='supabase/forward-migrations/ratings/'+file,bytes=readFileSync(path);
 return {version:file.slice(0,14),path,sha256:sha(bytes),lfSha256:sha(bytes.toString().replace(/\r\n/g,'\n'))};
});
if(migrations.length!==6)throw new Error('Expected five original plus one additive migration');
const write=(name,value)=>writeFileSync(dir+name,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
for(const [environment,name,ref,count] of [['staging','FairSwapTest','wpppxlnbzqynvhpeuavd',61],['production','FairSwapProd','kriuhwppxgxsyyrbjsau',52]]){
 write(environment+'.manifest.json',{
  release:'ratings-v1-consumer-contract-fix',status:'PREPARED_NOT_DEPLOYED',environment,project:{name,ref},
  localBaseHead:'213b57c84e2b3767e3ab3499846dd280bf3315c3',synchronized:false,
  initialRatings:{userReportedPr:59,userReportedCommit:'d5cc399d2b8e0ae3f3fcc91c800bcc2be4d7af19',remotelyVerified:false,migrations:migrations.slice(0,5)},
  documentedHistoricalLedger:{date:'2026-10-18',count,currentLedgerVerified:false},
  applyOrder:migrations.slice(5),freshInstallOrder:migrations,
  preflight:environment+'.preflight.sql',
  infrastructure:'No new jobs or infrastructure; fresh installations use original environment-specific inactive infrastructure after all six migrations.',
  featureFlags:{enabled:false,public_reads:false,jobs_enabled:false,staff_enabled:false},newEnvironmentVariables:[],
  ownershipRestrictions:'Existing Backend release ownership, backup/restore, isolated ledger and staff authorization gates remain required. No hosted execution authorized by this candidate.',
  rollback:'Disable Ratings flags and only its two schedules; revert affected consumers; preserve data and privacy erasure; use reviewed forward fixes.'
 });
 write(environment+'.preflight.sql',`-- Read-only delta preflight for ${name}; run after the initial five Ratings migrations.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
 if (select count(*) from vault.decrypted_secrets where name='project_url')<>1 or (select decrypted_secret from vault.decrypted_secrets where name='project_url') is distinct from 'https://${ref}.supabase.co' then raise exception 'RATINGS_ENVIRONMENT_MISMATCH'; end if;
 if current_setting('server_version_num')::integer not between 170000 and 179999 then raise exception 'RATINGS_REQUIRES_PG17'; end if;
 if to_regprocedure('app_security.rating_review_json(uuid,boolean)') is null or to_regprocedure('app_security.impl_ratings_trade(uuid)') is null or to_regprocedure('app_security.ratings_export_base(uuid)') is null or to_regprocedure('app_security.impl_admin_ratings_case(uuid,text,text)') is null then raise exception 'RATINGS_INITIAL_RELEASE_REQUIRED'; end if;
 if (select count(*) from app_security.ratings_settings)<>1 or exists(select 1 from app_security.ratings_settings where enabled or public_reads or jobs_enabled or staff_enabled) then raise exception 'RATINGS_FLAGS_MUST_BE_OFF'; end if;
 if exists(select 1 from cron.job where jobname in ('ratings-v1-publication','ratings-v1-reminders') and active) then raise exception 'RATINGS_JOBS_MUST_BE_INACTIVE'; end if;
 if to_regprocedure('public.ratings_given_history(timestamptz,uuid)') is not null then raise exception 'RATINGS_DELTA_ALREADY_INSTALLED_OR_PARTIAL'; end if;
end $$;
-- Capture installed contracts/ACLs in this environment's receipt, without secrets.
select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl
 from pg_proc p where p.oid in ('app_security.rating_review_json(uuid,boolean)'::regprocedure,'app_security.impl_seller_transition_listing(uuid,text)'::regprocedure,'app_security.impl_fulfill_data_export(uuid)'::regprocedure,'app_security.impl_admin_ratings_case(uuid,text,text)'::regprocedure);
rollback;
`);
 write(environment+'.receipt.template.json',{environment,projectRef:ref,status:'NOT_EXECUTED',operator:null,authorization:null,ledgerBefore:null,ledgerAfter:null,backupRestoreReceipt:null,preflightDefinitionsAndAcls:null,reviewedMigrations:migrations,automatedChecks:null,consumerRelease:null,flagsAllOff:null,ratingsJobsInactive:null,productionChecklist:null,rollbackDecision:null});
}
write('migration-order.json',{delta:migrations.slice(5),initialPrerequisites:migrations.slice(0,5),freshInstall:migrations,notes:'No raw historical chain apply. Reconcile separate staging/production ledgers; initial five are prerequisites, never replay them.'});
console.log('Prepared independent staging/production delta and fresh-install plans');
