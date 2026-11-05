// Run with node tests/posting-v212/mobile-catalogue.test.mjs --pglite-module=<absolute module path>.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { installPostingFixture } from '../../scripts/ci/posting-v2-fixture.mjs';

const modulePath = process.argv.find(arg => arg.startsWith('--pglite-module='))?.slice('--pglite-module='.length);
assert.ok(modulePath?.startsWith('/'), 'Supply the absolute path to the existing PGlite module');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const postingV2 = '../../supabase/forward-migrations/posting-v2/';
const source = path => readFileSync(new URL(postingV2 + path, import.meta.url), 'utf8');
const migration = source('supabase/migrations/20261105213015_posting_v2_mobile_catalogue_india.sql');

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await installPostingFixture(db);
  // The fixture omits the existing categories SELECT grant used by the invoker RPC.
  await db.exec('grant select on public.categories to anon, authenticated');
  return db;
}

async function catalogue(db) {
  const { rows: [row] } = await db.query('select public.posting_v2_catalogue() as value');
  return row.value;
}

function modelFor(data, brandName, modelName) {
  const brand = data.brands.find(brand => brand.name === brandName);
  return data.models.find(model => model.brand_id === brand?.id && model.name === modelName);
}

test('preserves legacy rows and listing references, imports supported models and is repeatable', async t => {
  const db = await fixture(t);
  const before = await catalogue(db);
  const legacy = modelFor(before, 'Apple', 'iPhone 15');
  const listing = '11111111-1111-4111-8111-111111111111';
  await db.query('insert into public.listings(id, category_id) values ($1, $2)', [
    listing, before.listing_category_id,
  ]);
  await db.query(`
    insert into public.listing_mobile_contexts
      (listing_id, category_id, brand_id, model_id, brand_name, model_name, storage)
    values ($1, $2, $3, $4, 'Apple', 'iPhone 15', '128 GB')
  `, [listing, before.listing_category_id, legacy.brand_id, legacy.id]);
  const contexts = await db.query('select * from public.listing_mobile_contexts');

  await db.exec(migration);
  const after = await catalogue(db);
  assert.equal(before.brands.length, 21);
  assert.equal(before.models.length, 100);
  assert.equal(after.brands.length, 27);
  assert.equal(after.models.length, 1473);
  const retainedBrands = new Map(after.brands.map(brand => [brand.id, brand]));
  const retainedModels = new Map(after.models.map(model => [model.id, model]));
  for (const brand of before.brands) assert.deepEqual(retainedBrands.get(brand.id), brand);
  for (const model of before.models) assert.deepEqual(retainedModels.get(model.id), model);
  assert.deepEqual((await db.query('select * from public.listing_mobile_contexts')).rows, contexts.rows);

  assert.deepEqual(after.brands.filter(brand => /^poco$/i.test(brand.name)).map(brand => brand.name), ['Poco']);
  assert.ok(modelFor(after, 'Poco', 'POCO X6 5G'));
  assert.ok(modelFor(after, 'Poco', 'X7'));
  assert.ok(modelFor(after, 'CMF', 'Phone 1')?.aliases.includes('CMF Phone 1'));
  assert.ok(modelFor(after, 'Nokia', '105 (2023)'));
  assert.equal(modelFor(after, 'Nokia', '105'), undefined);
  assert.ok(modelFor(after, 'Redmi', '12'));
  assert.ok(modelFor(after, 'Redmi', '12 5G'));
  for (const brand of after.brands) {
    const models = after.models.filter(model => model.brand_id === brand.id);
    assert.equal(models.filter(model => model.other).length, 1, brand.name);
    const keys = models.map(({ name }) => name.toLowerCase()
      .replace(new RegExp(`^${brand.name.toLowerCase()} +`), '')
      .replaceAll('+', 'plus').replace(/[\s()-]+/g, ''));
    assert.equal(new Set(keys).size, keys.length, brand.name);
  }
  assert.ok(after.models.every(model => retainedBrands.has(model.brand_id)));

  await db.exec(migration);
  assert.deepEqual(await catalogue(db), after);

  await db.exec(source('activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql'));
  const { rows: protections } = await db.query(`
    select relrowsecurity, relforcerowsecurity from pg_class
    where oid in ('public.phone_brands'::regclass, 'public.phone_models'::regclass)
  `);
  assert.deepEqual(protections, Array.from({ length: 2 }, () => ({
    relrowsecurity: true, relforcerowsecurity: true,
  })));
  await db.exec('set role authenticated');
  const seller = await catalogue(db);
  assert.equal(seller.enabled, true);
  assert.deepEqual(seller.models, after.models);
  await assert.rejects(db.exec("insert into public.phone_brands (name) values ('Unauthorized')"), { code: '42501' });
  await assert.rejects(db.exec('update public.phone_models set enabled = false'), { code: '42501' });
  await db.exec('set role anon');
  await assert.rejects(catalogue(db), { code: '42501' });
  await assert.rejects(db.exec('select id from public.phone_models'), { code: '42501' });
});

test('aborts atomically when a legacy spelling and an alias claim the same candidate', async t => {
  const db = await fixture(t);
  await db.exec(`
    insert into public.phone_models (brand_id, name, aliases)
    select id, 'Conflicting seller choice', array['iPhone 15'] from public.phone_brands where name = 'Apple'
  `);
  const before = await catalogue(db);
  await assert.rejects(db.exec(migration), { code: '23505' });
  await db.exec('rollback');
  assert.deepEqual(await catalogue(db), before);
});

test('aborts atomically if a generated model UUID belongs to a different model', async t => {
  const db = await fixture(t);
  await db.exec(migration);
  const model = modelFor(await catalogue(db), 'CMF', 'Phone 1');
  await db.query("update public.phone_models set name = 'Conflicting model', aliases = '{}' where id = $1", [model.id]);
  const before = await catalogue(db);
  await assert.rejects(db.exec(migration), /Mobile catalogue model ID collision/);
  await db.exec('rollback');
  assert.deepEqual(await catalogue(db), before);
});
