// Step 1R only: materializes source; never starts Docker, PostgreSQL or CI.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync,lstatSync,realpathSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
export const digest=b=>createHash('sha256').update(b).digest('hex');
const manifestPath='scripts/stage3/finalizer-rehearsal-source.json';
export const overlayFiles=[
 'scripts/stage3/prepare-finalizer-rehearsal.mjs','scripts/stage3/verify-finalizer-rehearsal.mjs',
 manifestPath,'scripts/stage3/finalizer-rehearsal.test.mjs',
 'scripts/stage3/step1q-finalizer.proposed.sql','tests/stage3/step1q-finalizer-additional.proposed.test.sql'];
export function manifest(root=sourceRoot){
 const bytes=readFileSync(path.join(root,manifestPath));
 assert.equal(digest(bytes),'5298bef9e55910ae75a68ad3f6bc0a702ee4991ff49376ac0f46f92af21c806f');
 return JSON.parse(bytes);
}
export const extraSuite='step1q-finalizer-additional.proposed.test.sql';
export const hooks={
 before: `# Step 1R: exact proposal, only after the original canonical replay/security gate.
failure_stage=security-before-verify
failure_category=none
docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres <"$root/scripts/stage3/finalizer-rehearsal-state.sql" >"$raw/state-before.json"
node "$root/scripts/stage3/verify-finalizer-rehearsal.mjs" --before "$project" "$raw" >"$raw/overlay-before.log" 2>&1
failure_stage=migrations
docker exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <"$root/scripts/stage3/step1q-finalizer.proposed.sql" >"$raw/overlay-apply.log" 2>&1
failure_stage=security-before-verify
check_cron_safety true >"$raw/cron-overlay.stdout" 2>"$raw/cron-overlay.stderr"
[[ $(cat -- "$raw/cron-overlay.stdout") == t ]]
docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres <"$root/scripts/stage3/assert-local-security.sql" >"$raw/security-overlay.json"
docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres <"$root/scripts/stage3/finalizer-rehearsal-state.sql" >"$raw/state-overlay.json"
node "$root/scripts/stage3/verify-finalizer-rehearsal.mjs" --overlay "$project" "$raw" >"$raw/overlay-gate.log" 2>&1
`,
 supplement: `# Step 1R: supplemental assertions use exact Step 1Q bytes; no canonical test edits.
failure_stage=pgtap
status=0
docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres <"$root/tests/stage3/step1q-finalizer-additional.proposed.test.sql" >"$raw/step1q-finalizer-additional.proposed.test.sql.log" 2>&1 || status=$?
printf '%s\\n' "$status" >"$raw/step1q-finalizer-additional.proposed.test.sql.exit"
node "$root/scripts/stage3/verify-finalizer-rehearsal.mjs" --tap "$raw/step1q-finalizer-additional.proposed.test.sql.log" "$status" >"$raw/supplemental-verify.log" 2>&1 || suite_failure=1
[[ $status == 0 ]] || suite_failure=1
`,
 after: `# Step 1R: always verify post-SQL security, even when an assertion failed.
check_cron_safety true >"$raw/cron-after.stdout" 2>"$raw/cron-after.stderr"
[[ $(cat -- "$raw/cron-after.stdout") == t ]]
docker exec -i "$db" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d postgres <"$root/scripts/stage3/finalizer-rehearsal-state.sql" >"$raw/state-after.json"
node "$root/scripts/stage3/verify-finalizer-rehearsal.mjs" --after "$project" "$raw" >"$raw/after-gate.log" 2>&1
`
};
function replaceOnce(text,old,replacement){assert.equal(text.split(old).length,2);return text.replace(old,replacement);}
export function deriveRunner(original){
 let s=replaceOnce(original,'fi\nfailure_stage=pgtap\nsuite_failure=0','fi\n'+hooks.before+'failure_stage=pgtap\nsuite_failure=0');
 s=replaceOnce(s,'failure_stage=security-after\ndocker exec',hooks.supplement+'failure_stage=security-after\ndocker exec');
 s=replaceOnce(s,'failure_stage=isolation-after\ncheck_isolation',hooks.after+'failure_stage=isolation-after\ncheck_isolation');
 for(const mode of ['--collect','--cleanup-failed'])s=replaceOnce(s,'"$root/scripts/stage3/verify-db-results.mjs" '+mode,'"$root/scripts/stage3/verify-finalizer-rehearsal.mjs" '+mode);
 return s;
}
export const stateSql=`BEGIN READ ONLY;
SELECT jsonb_build_object(
 'function',(SELECT jsonb_build_object('oid',p.oid::bigint,'owner',p.proowner::bigint,'acl',p.proacl,'config',p.proconfig,
   'definer',p.prosecdef,'volatility',p.provolatile,'language',l.lanname,'body',md5(p.prosrc))
 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
 WHERE p.oid='app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'::regprocedure),
 'guards',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'table',c.relname,'enabled',t.tgenabled,
   'function',t.tgfoid::bigint,'body',md5(p.prosrc)) ORDER BY c.relname,t.tgname)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE n.nspname='public' AND (t.tgname='z_0_test_submission_lifecycle' AND c.relname='listings'
   OR t.tgname='zz_test_submission_child' AND c.relname IN ('listing_vehicle_contexts','listing_car_contexts','listing_property_contexts','listing_media'))),
 'cronOff',(SELECT count(*)=1 AND bool_and(setting='off' AND source='command line' AND NOT pending_restart)
 FROM pg_settings WHERE name='cron.launch_active_jobs'),
 'cronHistoryEmpty',NOT EXISTS(SELECT 1 FROM cron.job_run_details));
COMMIT;
`;
function bytes(root,file){const p=path.join(root,file);assert.ok(lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink());assert.ok(realpathSync(p).startsWith(realpathSync(root)+path.sep));return readFileSync(p);}
export function verifySource(root,prepared=false){
 const m=manifest(root);assert.equal(Object.keys(m.sources).length,137);
 for(const [file,sha]of Object.entries(m.sources)){
  assert.ok(!file.includes('..')&&!path.isAbsolute(file));
  if(prepared&&file==='scripts/stage3/run-local-db.sh'){
   const approved=bytes(root,'scripts/stage3/approved-run-local-db.sh');assert.equal(digest(approved),sha);
   assert.equal(bytes(root,file).toString(),deriveRunner(approved.toString()));
  }else assert.equal(digest(bytes(root,file)),sha,file);
 }
 for(const [file,sha]of Object.entries(m.payloads))assert.equal(digest(bytes(root,file)),sha);
 if(prepared)assert.equal(bytes(root,'scripts/stage3/finalizer-rehearsal-state.sql').toString(),stateSql);
 return m;
}
export function expectedBodyHashes(root=sourceRoot){
 const extract=s=>{const start=s.indexOf('CREATE OR REPLACE FUNCTION app_security.impl_finalize_moderation_result(');assert.ok(start>=0);const match=s.slice(start).match(/AS \$\$([\s\S]*?)\$\$;/);assert.ok(match);return createHash('md5').update(match[1]).digest('hex');};
 return {before:extract(bytes(root,'supabase/migrations/20261011000038_create_moderation_queue_and_results.sql').toString()),after:extract(bytes(root,'scripts/stage3/step1q-finalizer.proposed.sql').toString())};
}
export function prepare(root=sourceRoot){
 const m=verifySource(root),out=mkdtempSync(path.join(realpathSync(tmpdir()),'fairswap-step1r-source-'));
 const write=(f,b)=>{const p=path.join(out,f);mkdirSync(path.dirname(p),{recursive:true,mode:0o700});writeFileSync(p,b,{flag:'wx',mode:0o600});};
 try{
  for(const f of [...Object.keys(m.sources),...overlayFiles])write(f,bytes(root,f));
  write('scripts/stage3/approved-run-local-db.sh',bytes(root,'scripts/stage3/run-local-db.sh'));
  writeFileSync(path.join(out,'scripts/stage3/run-local-db.sh'),deriveRunner(bytes(root,'scripts/stage3/run-local-db.sh').toString()),{mode:0o600});
  write('scripts/stage3/finalizer-rehearsal-state.sql',stateSql);
  write('.step1r-source-owner',JSON.stringify({head:m.head,manifest:'5298bef9e55910ae75a68ad3f6bc0a702ee4991ff49376ac0f46f92af21c806f'}));
  verifySource(out,true);return out;
 }catch(e){discardCreated(out);throw e;}
}
function discardCreated(root){
 const resolved=realpathSync(root);assert.equal(path.dirname(resolved),realpathSync(tmpdir()));assert.ok(path.basename(resolved).startsWith('fairswap-step1r-source-'));rmSync(resolved,{recursive:true});
}
export function removePrepared(root){
 const resolved=realpathSync(root);assert.equal(path.dirname(resolved),realpathSync(tmpdir()));assert.ok(path.basename(resolved).startsWith('fairswap-step1r-source-'));
 const proof=JSON.parse(bytes(root,'.step1r-source-owner'));assert.equal(proof.head,'6e0ca44dfb5416661c780cb831617f5c3196c2a1');verifySource(root,true);
 discardCreated(resolved);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [mode,arg,...extra]=process.argv.slice(2);assert.equal(extra.length,0);
  if(mode==='--prepare'&&!arg)console.log(prepare());
  else if(mode==='--remove-prepared'&&arg)removePrepared(arg);
  else throw new Error();
 }catch{console.error('FAIL: Step 1R source preparation/cleanup rejected');process.exitCode=1;}
}
