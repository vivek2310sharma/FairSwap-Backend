import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv.length !== 4 || process.argv[2] !== '--pglite-module') throw Error('Use --pglite-module <installed local PGlite entry>; accepts no database URL');
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[3])).href);
const db = new PGlite();
const read = p => readFileSync(path.join(root,p),'utf8');
const candidateDir = 'releases/candidates/fsw-sec-003/supabase/migrations';
const files = readdirSync(path.join(root,candidateDir)).filter(f=>f.endsWith('.sql'));
assert.equal(files.length,1);
const old = read('supabase/migrations/20261001000031_harden_public_listing_location_privacy.sql');
const baseline = old.slice(old.indexOf('CREATE OR REPLACE FUNCTION'),old.indexOf('-- 2. Revoke'));
const discovery = read('supabase/migrations/20260914000009_create_discovery_and_favourites.sql');
const rpc = async (args='') => (await db.query(`select public.search_public_listings(${args}) as result`)).rows[0].result;
let tests=0;
const check = (value,label) => { assert.ok(value,label); tests++; };
const rejects = async (args,code='22023') => {
 await assert.rejects(()=>rpc(args), e=>e.code===code, args); tests++;
};
const snapshot = async () => (await db.query(`select oid, proowner, proacl::text, proargnames, proargtypes::text, prorettype, prosecdef, provolatile, proconfig from pg_proc where oid in ('public.search_public_listings(text,uuid,text,uuid,uuid,text,integer,integer,text,integer,integer)'::regprocedure,'app_security.impl_search_public_listings(text,uuid,text,uuid,uuid,text,integer,integer,text,integer,integer)'::regprocedure) order by oid`)).rows;
try {
 await db.exec(read('tests/fsw-sec-003/fixture.sql'));
 await db.exec(discovery.split('\n').filter(l=>l.startsWith('CREATE INDEX idx_listings_')).join('\n'));
 await db.exec(baseline + discovery.slice(discovery.indexOf('REVOKE ALL ON FUNCTION app_security.impl_search_public_listings')));
 await db.exec('analyze');
 const catalogBefore=await snapshot();
 const validArgs=['',"query => 'laptop', sort => 'relevance'", "query => 'साइकिल'", "query => 'the'", "query => '!!!'", "category_slug => 'goods', price_min => 1000, price_max => 5000", "sort => 'price_asc'", "sort => 'price_desc'", "sort => null", "page => 2, per_page => 12", "page => 1000", "query => '  laptop  '"];
 const before=[];
 for(const args of validArgs) before.push(await rpc(args));
 const benchmark = async () => {
  // Warm-up followed by paired comparable batches; WASM timings are indicative only.
  for(let i=0;i<10;i++) await rpc(validArgs[i%validArgs.length]);
  const samples=[];
  for(let b=0;b<5;b++) { const start=performance.now(); for(let i=0;i<50;i++) await rpc(validArgs[i%validArgs.length]); samples.push((performance.now()-start)/50); }
  return samples.map(x=>Number(x.toFixed(3)));
 };
 const beforeMs=await benchmark();
 const candidate=read(`${candidateDir}/${files[0]}`);
 // The complete two-query/JSON-return tail must stay byte-identical to baseline.
 assert.equal(candidate.slice(candidate.indexOf('  -- Count total matching rows')).split('$$;')[0],baseline.slice(baseline.indexOf('  -- Count total matching rows')).split('$$;')[0]); tests++;
 const explain = async source => {
  const tail=source.slice(source.indexOf('  -- Count total matching rows'));
  const count=tail.slice(tail.indexOf('  SELECT count(*)'),tail.indexOf('  -- Fetch matching items')).replace('  INTO v_total_count','').trim();
  const fetch=tail.slice(tail.indexOf("  SELECT coalesce(jsonb_agg(item)"),tail.indexOf('  RETURN jsonb_build_object')).replace('  INTO v_items','').trim();
  const plans=[];
  for(let query of [count,fetch]) {
   const replacements={v_cat_id:'NULL::uuid',p_city_id:'NULL::uuid',p_locality_id:'NULL::uuid',v_cond:'NULL::public.listing_condition_enum',p_price_min:'NULL::integer',p_price_max:'NULL::integer',v_tsquery:"pg_catalog.websearch_to_tsquery('english','laptop')",p_sort:"'relevance'",v_per_page:'12',v_offset:'0'};
   for(const [name,value] of Object.entries(replacements)) query=query.replaceAll(new RegExp('\\b'+name+'\\b','g'),value);
   plans.push((await db.query('explain (format json) '+query)).rows[0]['QUERY PLAN'][0].Plan);
  }
  return plans;
 };
 const beforePlans=await explain(baseline);
 // Drift is rejected atomically before replacement; restore known fixture source.
 await db.exec(baseline.replace('  -- Validate pagination bounds','  -- drift fixture'));
 await assert.rejects(()=>db.exec(candidate),e=>e.code==='55000'); tests++;
 await db.exec('rollback');
 await db.exec(baseline);
 await db.exec(read(`${candidateDir}/${files[0]}`));
 assert.deepEqual(await snapshot(),catalogBefore); tests++;
 const afterPlans=await explain(candidate); assert.deepEqual(afterPlans,beforePlans); tests++;
 for(let i=0;i<validArgs.length;i++) { assert.deepEqual(await rpc(validArgs[i]),before[i],validArgs[i]); tests++; }
 const afterMs=await benchmark();
 for(const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  check((await rpc()).total_count===120,`${role}: active-only empty browse`);
  check((await rpc("query => 'laptop'")).total_count===119,`${role}: English`);
  check((await rpc("query => 'साइकिल'")).total_count===1,`${role}: Hindi`);
  for(const query of ["repeat('a',100)","repeat('अ',100)","repeat('😀',100)","' ' || repeat('a',100) || ' '"]) check((await rpc(`query => ${query}`)).page===1,`${role}: 100 Unicode characters accepted`);
  for(const args of ["query => repeat('a',101)","query => repeat('अ',101)","query => repeat('😀',101)","query => repeat(' ',4097)","query => repeat('a',1000000)","page => 0","page => -2147483648","page => 1001","page => 2147483647","condition => 'bogus'","condition => ''","category_slug => 'missing'","category_slug => ''","category_slug => 'hidden'","category_id => '00000000-0000-0000-0000-000000000002', category_slug => 'goods'","price_min => -1","price_max => -1","price_min => 200, price_max => 100","sort => 'bogus'","sort => ''","category_slug => repeat('a',4097)","condition => repeat('a',65)","sort => repeat('a',65)"]) await rejects(args);
  for(const [args,code] of [["page => '999999999999999999999'",'22003'],["page => 'oops'",'22P02'],["price_min => '1.5'",'22P02'],["city_id => 'bad'",'22P02'],["category_id => 'bad'",'22P02'],["locality_id => 'bad'",'22P02']]) await rejects(args,code);
  for(const [arg,expected] of [['null',20],['0',20],['-1',20],['1',1],['50',50],['51',50],['2147483647',50]]) check((await rpc(`per_page => ${arg}`)).per_page===expected,`${role}: per_page ${arg}`);
  check((await rpc('page => null, per_page => null')).page===1,`${role}: default page`);
  check((await rpc('page => 1000, per_page => 50')).items.length===0,`${role}: maximum offset`);
  const first=await rpc('page => 1, per_page => 12'); const second=await rpc('page => 2, per_page => 12');
  check(first.total_pages===10 && first.items.length===12 && second.items.length===12 && !first.items.some(i=>second.items.some(j=>j.id===i.id)),`${role}: stable pagination`);
  check(first.items.every(i=>!('pin_code' in i)&&!('landmark' in i)),`${role}: private location absent`);
  check((await rpc("category_id => 'ffffffff-ffff-ffff-ffff-ffffffffffff'")).total_count===0,`${role}: unknown UUID restricts`);
  check((await rpc("city_id => 'ffffffff-ffff-ffff-ffff-ffffffffffff'")).total_count===0,`${role}: unknown city restricts`);
  await db.exec('reset role');
 }
 check((await db.query("select relrowsecurity from pg_class where oid='public.listings'::regclass")).rows[0].relrowsecurity,'RLS retained');
 console.log(JSON.stringify({status:'PASS',tests,engine:(await db.query('select version()')).rows[0],fixtureRows:130,plansIdentical:true,planRootNodes:beforePlans.map(p=>p['Node Type']),baselineMsPerCall:beforeMs,candidateMsPerCall:afterMs,scope:'in-memory PostgreSQL; reduced schema, no Auth/PostgREST/network or hosted data'},null,2));
} catch(e) { console.error('FAIL',e.message,e.code,e.where); process.exitCode=1; }
finally { await db.close(); }
