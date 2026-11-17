// No environment files, URLs, hosted clients, installs or network operations.
// Reuses an already installed PGlite package; optional native PG17 uses a new
// socket-only cluster; the tracked psql adapter needs no JavaScript PG driver.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,chmodSync,mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {snapshotSql,postflightSql,verifyTaxonomyPostflight} from '../../scripts/release/taxonomy-v2-release.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const pins=JSON.parse(readFileSync(resolve(root,'tests/taxonomy-v2/prerequisites.json'),'utf8'));
for(const [file,want] of Object.entries(pins.files)) {
 const bytes=readFileSync(resolve(root,file));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),want.sha256,`prerequisite SHA-256: ${file}`);
 assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex'),want.gitBlob,`tracked Git blob: ${file}`);
}
console.log(`PASS: ${Object.keys(pins.files).length} prerequisites match GitHub main ${pins.commit}`);
const args=process.argv.slice(2);
assert(args.every(x=>/^--(modules|native-bin|category-count)=.+/.test(x)),'Only --modules=<existing package directory> and --native-bin=<PG17 bin> allowed');
const option=name=>args.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3);
const require=createRequire(resolve(option('modules')??resolve(root,'tests/ratings'),'package.json'));
const native=option('native-bin');
const categoryCount=Number(option('category-count')??53);
assert([53,55].includes(categoryCount),'Use synthetic category inventory 53 or 55');
const db=native
 ? await openNative(native)
 : new (require('@electric-sql/pglite').PGlite)();
const read=p=>readFileSync(resolve(root,p),'utf8');
const q=async sql=>(await db.query(sql)).rows;
const digest=async()=>({
 functions:await q(`select n.nspname,p.proname,pg_get_functiondef(p.oid) as def,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_security') and p.prokind='f' order by p.oid`),
 policies:await q(`select * from pg_policies where schemaname='public' order by tablename,policyname`),
 security:await q(`select c.relname,c.relacl,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname`),
 triggers:await q(`select t.tgname,t.tgrelid,pg_get_triggerdef(t.oid) as def from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by t.oid`),
 catalogues:await Promise.all(['phone_brands','phone_models','tablet_brands_v1','tablet_models_v1','wearable_brands_v1','wearable_models_v1','car_brands','car_models','vehicle_brands','vehicle_models'].map(async t=>[t,await q(`select * from public.${t} order by id`)])),
 categories:await q('select * from public.categories order by id'),
 listings:await q('select * from public.listings order by id'),
});
try {
 console.log('Engine:',(await q('select version() as version'))[0].version);
 await db.exec(read('tests/taxonomy-v2/fixture.sql'));
 const migrations=[
  'supabase/migrations/20261009201151_two_wheeler_draft_v1.sql',
  'supabase/migrations/20261010064518_car_draft_v1.sql',
  'supabase/forward-migrations/posting-v2/supabase/migrations/20261025131116_posting_v2_mobiles.sql',
  'supabase/forward-migrations/posting-v2/supabase/migrations/20261105213015_posting_v2_mobile_catalogue_india.sql',
  'supabase/forward-migrations/posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql',
  'supabase/forward-migrations/accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql',
  'supabase/forward-migrations/tablets-v1/supabase/migrations/20261102165946_posting_v2_tablets.sql',
  'supabase/forward-migrations/tablets-v2/supabase/migrations/20261104215253_tablets_v2_india_catalogue.sql',
  'supabase/forward-migrations/wearables-v1/supabase/migrations/20261104120000_posting_v2_wearables.sql',
  'supabase/forward-migrations/wearables-v11/supabase/migrations/20261111195641_wearables_v11_catalogue.sql',
  'supabase/migrations/20261009163210_seller_listing_category_context.sql',
 ];
 for(const file of migrations) await db.exec(read(file));
 // Extract the real helper from its guarded historical installer; do not replay
 // that installer's environment-specific preconditions on a synthetic database.
 const eligibility=read('supabase/migrations/20261013192336_post_ad_listing_insert_category_guard.sql').split('$function$')[1];
 assert(eligibility?.includes('CREATE FUNCTION app_security.is_new_listing_category_eligible'));
 await db.exec(eligibility);
 const lifecycle=read('supabase/migrations/20260914000005_create_listings.sql')
  .split('CREATE OR REPLACE FUNCTION public.handle_listing_before_update()')[1]?.split('$$;')[0];
 assert(lifecycle,'real baseline listing lifecycle function available');
 await db.exec('CREATE OR REPLACE FUNCTION public.handle_listing_before_update()'+lifecycle+'$$;');
 await db.exec('create trigger fixture_listing_lifecycle before update on public.listings for each row execute function public.handle_listing_before_update()');
 await db.exec(`revoke all on function app_security.is_new_listing_category_eligible(uuid) from public,anon,service_role;
 grant execute on function app_security.is_new_listing_category_eligible(uuid) to authenticated;
 alter policy listings_insert_policy on public.listings with check (
 seller_id=auth.uid() and app_security.get_account_status(auth.uid())='active'
 and app_security.has_current_policy_acceptance(auth.uid()) and app_security.is_new_listing_category_eligible(category_id));`);
 // Model divergent environment inventories without claiming these are hosted dumps.
 await db.exec(`insert into public.categories(slug,name,macro_category,new_listing_enabled) values ('legacy-broad','Legacy broad','goods',true);
 insert into auth.users values('11111111-1111-4111-8111-111111111111');
 insert into public.listings(seller_id,category_id,title) select '11111111-1111-4111-8111-111111111111',id,'Legacy draft' from public.categories where slug='legacy-broad';`);
 const existing=(await q('select count(*)::int as n from public.categories'))[0].n;
 assert(existing<=categoryCount);
 await db.exec(`insert into public.categories(slug,name) select 'legacy-extra-'||n,'Inert legacy '||n from generate_series(1,${categoryCount-existing}) n`);
 console.log(`Synthetic pre-migration inventory: ${categoryCount} categories (not a hosted dump)`);
 const releaseValue=async sql=>{const r=await db.exec(sql);return typeof r==='string'?JSON.parse(r):r.find(x=>x.rows?.[0]?.jsonb_build_object)?.rows[0].jsonb_build_object;};
 const releaseBefore=await releaseValue(snapshotSql);
 assert.equal(releaseBefore.installed,false);
 const before=await digest();
 await db.exec(read('supabase/forward-migrations/taxonomy-v2/supabase/migrations/20261117185218_taxonomy_v2_foundation.sql'));
 const after=await digest();
 assert.equal(verifyTaxonomyPostflight(releaseBefore,await releaseValue(snapshotSql),await releaseValue(postflightSql)).status,'PASS');
 console.log('PASS: real read-only release preflight/postflight SQL and preservation checks');
 assert.deepEqual(after.functions.filter(f=>before.functions.some(b=>b.proname===f.proname)),before.functions);
 assert.deepEqual(after.policies.filter(p=>!p.tablename.startsWith('generic_product_')&&p.tablename!=='listing_generic_product_identity'),before.policies);
 assert.deepEqual(after.catalogues,before.catalogues);
 assert.deepEqual(after.security.filter(a=>before.security.some(b=>b.relname===a.relname)),before.security);
 assert.deepEqual(after.triggers.filter(a=>before.triggers.some(b=>b.tgname===a.tgname&&b.tgrelid===a.tgrelid)),before.triggers);
 assert.deepEqual(after.listings,before.listings);
 assert.deepEqual(after.categories.map(({parent_id,status,posting_flow,catalogue_mode,taxonomy_is_root,taxonomy_parent_is_root,...old})=>old),before.categories);
 console.log('PASS: existing functions/ACLs, RLS policies, five specialist catalogues, categories and saved listing unchanged');
 const results=await db.exec(read('tests/taxonomy-v2/foundation.test.sql'));
 const messages=typeof results==='string' ? results.split('\n').filter(line=>/^(ok \d+ -|PASS:)/.test(line)) : results.flatMap(result=>result.rows??[]).filter(row=>row.test).map(row=>row.test);
 assert.equal(messages.filter(message=>message.startsWith('ok ')).length,77,'complete SQL assertion inventory');
 for(const message of messages) console.log(message);
 assert.equal((await q('select count(*)::int as n from public.generic_product_brands'))[0].n,0);
 assert.equal((await q('select count(*)::int as n from public.generic_product_models'))[0].n,0);
 console.log('PASS: fixture transaction rolled back; both generic lookup tables remain empty');
 if(native) await (await import('./native-races.mjs')).verifyRaces(db);
} catch (error) {
 console.error('FAIL:',error.message,'SQLSTATE:',error.code??'n/a');
 process.exitCode=1;
} finally {await db.close();}

async function openNative(bin) {
 const command=(name,args)=>execFileSync(resolve(bin,name),args,{encoding:'utf8'});
 const pin=JSON.parse(readFileSync(resolve(root,'tests/ratings/pg17-source.json'),'utf8'));
 assert.equal(command('postgres',['--version']).trim(),`postgres (PostgreSQL) ${pin.version}`);
 const dir=realpathSync(mkdtempSync('/tmp/fairswap-posting-native-'));
 chmodSync(dir,0o700);
 writeFileSync(resolve(dir,'fixture-kind'),'fairswap-posting-native-v1\n');
 const data=resolve(dir,'data');
 let started=false,db;
 try {
  command('initdb',['-D',data,'-U','posting_fixture_admin','--encoding=UTF8','--no-locale','--auth-local=trust','--auth-host=reject']);
  command('pg_ctl',['-D',data,'-l',resolve(dir,'postgres.log'),'-w','start','-o',`-c listen_addresses='' -c unix_socket_directories=${dir} -c unix_socket_permissions=0700`]);
  started=true;
  const {NativeFixture}=await import('../posting-v212/native-adapter.mjs');
  db=new NativeFixture(bin,dir);await db.verify();
  return {
   query:(sql,args)=>db.query(sql,args),exec:sql=>db.exec(sql),races:db,
   async close(){try{db.close();}finally{stop();}},
  };
 } catch(error) {try{db?.close();}finally{stop();}throw error;}
 function stop(){if(started)command('pg_ctl',['-D',data,'-w','stop','-m','fast']);rmSync(dir,{recursive:true,force:true});}
}
