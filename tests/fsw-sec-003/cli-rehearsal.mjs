import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,mkdtempSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
const port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
// Authenticated only as a local synthetic fixture administrator. No hosted inputs.
if(process.argv.length!==4||!path.isAbsolute(process.argv[2])||!path.isAbsolute(process.argv[3])) throw Error('Supply absolute PG17.6 bin and CLI2.117.0 paths only');
const repo=fileURLToPath(new URL('../../',import.meta.url));
const pg=process.argv[2];
if(execFileSync(path.join(pg,'postgres'),['--version'],{encoding:'utf8'}).trim()!=='postgres (PostgreSQL) 17.6') throw Error('Exact PG17.6 required');
const cli=process.argv[3];
if(!execFileSync(cli,['--version'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:mkdtempSync('/tmp/fsw-search-cli-home-')}}).startsWith('2.117.0'))throw Error('Exact CLI2.117.0 required');
const fixtureHome=mkdtempSync('/tmp/fsw-search-cli-home-');
const socket=realpathSync(mkdtempSync('/tmp/fsw-search-native-'));
const run=(cmd,args,input)=>execFileSync(cmd,args,{input,encoding:'utf8',timeout:120000,env:{PATH:process.env.PATH,HOME:fixtureHome,NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
run(path.join(pg,'initdb'),['-D',socket+'/data','-U','search_fixture_admin','--auth=trust','--encoding=UTF8','--locale=C']);
run(path.join(pg,'pg_ctl'),['-D',socket+'/data','-l',socket+'/rehearsal.log','-o',`-k ${socket} -p ${port} -c listen_addresses='127.0.0.1'`,'-w','start']);
try {
 const oldInitial=readFileSync(repo+'/supabase/migrations/20261001000031_harden_public_listing_location_privacy.sql','utf8');
 const discovery=readFileSync(repo+'/supabase/migrations/20260914000009_create_discovery_and_favourites.sql','utf8');
 const fixture=readFileSync(repo+'/tests/fsw-sec-003/fixture.sql','utf8');
 const setup=fixture+oldInitial.slice(oldInitial.indexOf('CREATE OR REPLACE FUNCTION'),oldInitial.indexOf('-- 2. Revoke'))+discovery.slice(discovery.indexOf('REVOKE ALL ON FUNCTION app_security.impl_search_public_listings'));
 run(path.join(pg,'psql'),['-XqAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',String(port),'-U','search_fixture_admin','-d','postgres'],setup);
 const dir=mkdtempSync('/tmp/fsw-search-cli-');
 const url=`postgresql://search_fixture_admin@127.0.0.1:${port}/postgres?sslmode=disable`;
 const invoke=args=>run(cli,[...args,'--workdir',dir]);
 invoke(['init']);invoke(['migration','new','fsw_fixture_seed']);
 const migrationDir=dir+'/supabase/migrations';const seed=readdirSync(migrationDir).find(x=>x.endsWith('.sql'));
 writeFileSync(path.join(migrationDir,seed),'select 1;\n');
 invoke(['migration','up','--db-url',url]);
 const fetched=mkdtempSync('/tmp/fsw-search-fetch-');
 run(cli,['init','--workdir',fetched]);
 run(cli,['migration','fetch','--db-url',url,'--workdir',fetched]);
 const raw=run(path.join(pg,'psql'),['-XqAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',String(port),'-U','search_fixture_admin','-d','postgres','-c',"select json_agg(json_build_object('version',version,'name',name,'statementsSha256',encode(sha256(convert_to(btrim(array_to_string(statements,E';\\n'), E' \\t\\r\\n;'),'UTF8')),'hex')) order by version) from supabase_migrations.schema_migrations"]);
 const {verifyHistory}=await import(pathToFileURL(repo+'/tests/fsw-sec-003/release-gate.mjs'));
 verifyHistory({ledger:JSON.parse(raw)},fetched+'/supabase/migrations');
 console.log('PASS authentic CLI seed/fetch digest comparison');
 // Verify the metadata capture SQL actually executes, not merely its JS fixture.
 const cap=run(path.join(pg,'psql'),['-XqAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',String(port),'-U','search_fixture_admin','-d','postgres','-f',repo+'/tests/fsw-sec-003/capture-release.sql']);
 const meta=JSON.parse(cap);if(meta.functions.length!==2||meta.security.length!==6)throw Error('metadata capture incomplete');
 console.log('PASS native read-only catalog capture SQL');
 const old=readFileSync(repo+'/supabase/migrations/20261001000031_harden_public_listing_location_privacy.sql','utf8');
 const baseline=old.slice(old.indexOf('CREATE OR REPLACE FUNCTION'),old.indexOf('-- 2. Revoke'));
 run(path.join(pg,'psql'),['-XqAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',String(port),'-U','search_fixture_admin','-d','postgres'],baseline);
 const {FILE,LEDGER_SHA,canonical,sha}=await import(pathToFileURL(repo+'/tests/fsw-sec-003/release-gate.mjs'));
 const candidate=readFileSync(repo+'/releases/candidates/fsw-sec-003/supabase/migrations/'+FILE,'utf8');
 writeFileSync(path.join(migrationDir,FILE),candidate);
 const dry=spawnSync(cli,['db','push','--dry-run','--include-all','--db-url',url,'--workdir',dir],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:fixtureHome,NO_COLOR:'1'}});
 if(dry.status!==0) throw Error('local CLI dry-run failed');
 const {verifyDryRun}=await import(pathToFileURL(repo+'/tests/fsw-sec-003/release-gate.mjs'));
 verifyDryRun(dry.stdout+'\n'+dry.stderr);console.log('PASS genuine CLI dry-run pending migration parsing');
 invoke(['migration','up','--include-all','--db-url',url]);
 const post=JSON.parse(run(path.join(pg,'psql'),['-XqAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',String(port),'-U','search_fixture_admin','-d','postgres','-f',repo+'/tests/fsw-sec-003/capture-release.sql']));
 const row=post.ledger.find(x=>x.version==='20261031110408');
 if(row.statementsSha256!==LEDGER_SHA) throw Error('candidate CLI ledger serialization differs from raw approved SQL: '+row.statementsSha256);
 console.log('PASS exact candidate CLI installation and ledger digest contract');

 console.log('Local CLI workspace: '+dir+'; fetched workspace: '+fetched);
} catch(e) {console.error('FAIL disposable CLI rehearsal:',e.message,e.stderr?.toString());process.exitCode=1;}
finally {run(path.join(pg,'pg_ctl'),['-D',socket+'/data','-m','fast','-w','stop']);}
