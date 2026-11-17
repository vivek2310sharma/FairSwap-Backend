import assert from 'node:assert/strict';
// Independent psql transactions on the cluster created by run.mjs. No DB URL.
export async function verifyRaces(db) {
 const driver=db.races;
 const owner='11111111-1111-4111-8111-111111111111';
 const root='aaaaaaaa-0000-4000-8000-000000000001';
 const root2='aaaaaaaa-0000-4000-8000-000000000002';
 const a='aaaaaaaa-0000-4000-8000-000000000003';
 const b='aaaaaaaa-0000-4000-8000-000000000004';
 const listing='aaaaaaaa-0000-4000-8000-000000000005';
 const holders=[];
 try {
  await db.exec(`insert into public.categories(id,slug,name,status) values
   ('${root}','race-root','Race root','live'),('${root2}','race-root2','Race root 2','live');
   insert into public.categories(id,slug,name,parent_id,status,posting_flow,catalogue_mode,macro_category,new_listing_enabled) values
   ('${a}','race-a','Race leaf A','${root}','live','generic','brand_model','goods',true),
   ('${b}','race-b','Race leaf B','${root}','live','generic','brand_model','goods',true);
   insert into public.listings(id,seller_id,category_id,title) values('${listing}','${owner}','${a}','Race fixture');`);
  const hold=(sql,name)=>{const h=driver.start(sql,{name},true);holders.push(h);return h;};
  const submission=hold(`update public.listings set status='pending_review' where id='${listing}'`,'taxonomy_submission');
  await driver.wait(submission,r=>r.state==='idle in transaction');
  const identity=driver.start(`insert into public.listing_generic_product_identity(listing_id,category_id,brand_name_snapshot)
   values('${listing}','${a}','Fixture text')`,{owner,role:'authenticated',name:'taxonomy_identity_waiter'});
  await driver.blocked(identity,submission);
  await submission.finish();holders.splice(holders.indexOf(submission),1);
  await assert.rejects(identity.done,error=>error.code==='23514'&&error.message.includes('TAXONOMY_V2_IDENTITY_DRAFT_ONLY'));
  assert.equal((await db.query('select count(*)::int as n from public.listing_generic_product_identity')).rows[0].n,0);
  console.log('PASS native race 1: identity waits for submission and rejects reviewed listing');

  await db.exec(`update public.listings set status='draft' where id='${listing}'`);
  const saved=hold(`insert into public.listing_generic_product_identity(listing_id,category_id) values('${listing}','${a}')`,'taxonomy_save');
  await driver.wait(saved,r=>r.state==='idle in transaction');
  const categoryEdit=driver.start(`update public.listings set category_id='${b}' where id='${listing}'`,{owner,role:'authenticated',name:'taxonomy_category_waiter'});
  await driver.blocked(categoryEdit,saved);
  await saved.finish();holders.splice(holders.indexOf(saved),1);
  await assert.rejects(categoryEdit.done,error=>error.code==='23503');
  assert.equal((await db.query(`select category_id::text as id from public.listings where id='${listing}'`)).rows[0].id,a);
  console.log('PASS native race 2: category edit waits for identity and rejects stranded reference');

  const child=hold(`insert into public.categories(slug,name,parent_id,status,posting_flow,catalogue_mode)
   values('race-child','Concurrent child','${root2}','coming_soon','generic','none')`,'taxonomy_child');
  await driver.wait(child,r=>r.state==='idle in transaction');
  const reparent=driver.start(`update public.categories set parent_id='${root}',posting_flow='generic',catalogue_mode='none' where id='${root2}'`,{name:'taxonomy_depth_waiter'});
  await driver.blocked(reparent,child);
  await child.finish();holders.splice(holders.indexOf(child),1);
  await assert.rejects(reparent.done,error=>error.code==='23503');
  console.log('PASS native race 3: concurrent root reparent cannot introduce a third level');
  assert.equal(driver.observations.length,3);
 } finally {
  for(const holder of holders) {try{await holder.finish(false);}catch{ /* already closed */ }}
 }
}
