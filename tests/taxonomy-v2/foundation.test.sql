-- Automated disposable fixture imports only. Every test write rolls back.
begin;
create temp sequence tv_checks;
grant usage on sequence tv_checks to anon,authenticated;
create function pg_temp.check_ok(label text, passed boolean) returns text language plpgsql as $$
begin
 if passed is distinct from true then raise exception 'FAIL: %',label; end if;
 return 'ok '||nextval('pg_temp.tv_checks')||' - '||label;
end;
$$;
create function pg_temp.rejects(label text, statement text, expected text) returns text language plpgsql as $$
declare actual text;
begin
 begin execute statement; exception when others then actual:=sqlstate; end;
 if actual is distinct from expected then raise exception 'FAIL: % (expected %, got %)',label,expected,coalesce(actual,'success'); end if;
 return pg_temp.check_ok(label,true);
end;
$$;
create temp table tv_ids(label text primary key,id uuid not null default gen_random_uuid());
insert into tv_ids(label) values ('root'),('root2'),('a'),('b'),('brand_only'),('none'),('coming'),('hidden'),('blocked'),('specialist'),('parent_coming'),('child_coming'),
 ('brand_a'),('brand_a2'),('brand_b'),('brand_only_id'),('model_a'),('model_a2'),('model_b'),('la'),('lb'),('other_listing'),('manual_listing'),('none_listing'),('brand_only_listing'),('empty_listing');
grant select on tv_ids to anon,authenticated;
create function pg_temp.id(label text) returns uuid language sql stable as $$select id from pg_temp.tv_ids where tv_ids.label=$1$$;
insert into auth.users values('22222222-2222-4222-8222-222222222222');
select pg_temp.check_ok('deployment imports zero brands and models',
 (select count(*)=0 from public.generic_product_brands) and (select count(*)=0 from public.generic_product_models)) as test;
select pg_temp.check_ok('all pre-V2 rows remain explicit legacy references',not exists(select 1 from public.categories where status is not null)) as test;
insert into public.categories(id,slug,name,status,is_active) values
 (pg_temp.id('root'),'tv-root','Fixture group','live',true),
 (pg_temp.id('root2'),'tv-root2','Fixture group 2','live',true),
 (pg_temp.id('parent_coming'),'tv-root-coming','Coming group','coming_soon',true);
insert into public.categories(id,slug,name,parent_id,status,posting_flow,catalogue_mode,is_active,new_listing_enabled,macro_category)
select pg_temp.id(label),'tv-'||label,label,pg_temp.id('root'),status,flow,mode,active,enabled,'goods'
from (values
 ('a','live','generic','brand_model',true,true),('b','live','generic','brand_model',true,true),
 ('brand_only','live','generic','brand_only',true,true),('none','live','generic','none',true,true),
 ('coming','coming_soon','generic','brand_model',true,false),('hidden','hidden','generic','brand_model',false,false),
 ('blocked','blocked','generic','none',false,false),('specialist','live','specialist:phone','brand_model',true,true)
) x(label,status,flow,mode,active,enabled);
insert into public.categories(id,slug,name,parent_id,status,posting_flow,catalogue_mode,is_active,new_listing_enabled,macro_category)
values(pg_temp.id('child_coming'),'tv-child-coming','Parent unavailable',pg_temp.id('parent_coming'),'live','generic','brand_model',true,true,'goods');
select pg_temp.rejects('third hierarchy level rejected',
 $$update public.categories set parent_id=pg_temp.id('a') where id=pg_temp.id('b')$$,'23503') as test;
select pg_temp.rejects('self-cycle rejected',
 $$update public.categories set parent_id=id,posting_flow='generic',catalogue_mode='none' where id=pg_temp.id('root2')$$,'23503') as test;
select pg_temp.rejects('root with children cannot become a leaf',
 $$update public.categories set parent_id=pg_temp.id('root2'),posting_flow='generic',catalogue_mode='none' where id=pg_temp.id('root')$$,'23503') as test;
select pg_temp.rejects('root cannot enable posting',
 $$update public.categories set new_listing_enabled=true where id=pg_temp.id('root')$$,'23514') as test;
select pg_temp.rejects('unavailable leaf cannot enable posting',
 $$update public.categories set new_listing_enabled=true where id=pg_temp.id('coming')$$,'23514') as test;
select pg_temp.rejects('hidden rows cannot leak through legacy active discovery',
 $$update public.categories set is_active=true where id=pg_temp.id('hidden')$$,'23514') as test;
select pg_temp.rejects('invalid status rejected',$$update public.categories set status='unknown' where id=pg_temp.id('a')$$,'23514') as test;
select pg_temp.rejects('invalid catalogue mode rejected',$$update public.categories set catalogue_mode='required' where id=pg_temp.id('a')$$,'23514') as test;
select pg_temp.rejects('legacy parent cannot masquerade as V2 root',
 $$update public.categories set parent_id=(select id from public.categories where slug='legacy-broad') where id=pg_temp.id('a')$$,'23503') as test;

select pg_temp.check_ok('three tables enable and force RLS',
 (select count(*)=3 from pg_class where oid in ('public.generic_product_brands'::regclass,'public.generic_product_models'::regclass,'public.listing_generic_product_identity'::regclass) and relrowsecurity and relforcerowsecurity)) as test;
select pg_temp.check_ok('public wrappers are invoker with empty search path',
 (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.get_category_catalogue_v2()'::regprocedure)) as test;
select pg_temp.check_ok('private write guards cannot be called by clients',not exists(
 select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_security' and p.proname like 'impl_taxonomy_v2_%'
 and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')))) as test;
set local role anon;
select pg_temp.check_ok('anonymous versioned API returns explicit version',public.get_category_catalogue_v2()->>'api_version'='2') as test;
select pg_temp.check_ok('hidden blocked and legacy rows excluded from read API',
 not exists(select 1 from jsonb_array_elements(public.get_category_catalogue_v2()->'nodes') n where n->>'status' is null or n->>'status' in ('hidden','blocked'))) as test;
select pg_temp.check_ok('roots and children of coming-soon roots are not advertised as postable',
 not exists(select 1 from jsonb_array_elements(public.get_category_catalogue_v2()->'nodes') n where (n->>'parent_id' is null or n->>'id'=pg_temp.id('child_coming')::text) and (n->>'posting_enabled')::boolean)) as test;
select pg_temp.rejects('anonymous cannot import brands',$$insert into public.generic_product_brands(category_id,name) values(pg_temp.id('a'),'Unauthorized')$$,'42501') as test;
select pg_temp.rejects('anonymous cannot read private identities',$$select * from public.listing_generic_product_identity$$,'42501') as test;
reset role;
create temp table tv_revision as select public.get_category_catalogue_v2()->>'revision' as revision;
update public.categories set name='Fixture renamed' where id=pg_temp.id('a');
select pg_temp.check_ok('visible metadata updates invalidate revision',public.get_category_catalogue_v2()->>'revision'<>(select revision from tv_revision)) as test;
-- Future importer: same schema, category-scoped normalized names, no migration.
insert into public.generic_product_brands(id,category_id,name) values
 (pg_temp.id('brand_a'),pg_temp.id('a'),'Fixture Brand'),(pg_temp.id('brand_a2'),pg_temp.id('a'),'Second Fixture'),
 (pg_temp.id('brand_b'),pg_temp.id('b'),'Fixture Brand'),(pg_temp.id('brand_only_id'),pg_temp.id('brand_only'),'Furniture Fixture');
insert into public.generic_product_models(id,category_id,brand_id,name) values
 (pg_temp.id('model_a'),pg_temp.id('a'),pg_temp.id('brand_a'),'Fixture Model'),
 (pg_temp.id('model_a2'),pg_temp.id('a'),pg_temp.id('brand_a2'),'Fixture Model'),
 (pg_temp.id('model_b'),pg_temp.id('b'),pg_temp.id('brand_b'),'Fixture Model');
select pg_temp.rejects('normalized brand duplicate rejected',
 $$insert into public.generic_product_brands(category_id,name) values(pg_temp.id('a'),' fixture brand ')$$,'23505') as test;
select pg_temp.rejects('normalized model duplicate rejected',
 $$insert into public.generic_product_models(category_id,brand_id,name) values(pg_temp.id('a'),pg_temp.id('brand_a'),' fixture model ')$$,'23505') as test;
select pg_temp.rejects('model cross-category brand rejected',
 $$insert into public.generic_product_models(category_id,brand_id,name) values(pg_temp.id('b'),pg_temp.id('brand_a'),'Wrong category')$$,'23503') as test;
select pg_temp.rejects('brand-only leaf rejects model import',
 $$insert into public.generic_product_models(category_id,brand_id,name) values(pg_temp.id('brand_only'),pg_temp.id('brand_only_id'),'Unsupported')$$,'23514') as test;
select pg_temp.rejects('specialist leaf rejects generic brand import',
 $$insert into public.generic_product_brands(category_id,name) values(pg_temp.id('specialist'),'Wrong flow')$$,'23514') as test;
select pg_temp.rejects('none capability rejects brand import',
 $$insert into public.generic_product_brands(category_id,name) values(pg_temp.id('none'),'Unsupported')$$,'23514') as test;
select pg_temp.rejects('root rejects brand import',
 $$insert into public.generic_product_brands(category_id,name) values(pg_temp.id('root'),'Unsupported')$$,'23514') as test;
select pg_temp.rejects('category with models cannot reduce capability',
 $$update public.categories set catalogue_mode='brand_only' where id=pg_temp.id('a')$$,'23514') as test;
select pg_temp.rejects('category with imports cannot switch to specialist',
 $$update public.categories set posting_flow='specialist:tablet' where id=pg_temp.id('a')$$,'23514') as test;
set local role anon;
select pg_temp.check_ok('future category-scoped brand query works',
 (select count(*)=2 from public.generic_product_brands where category_id=pg_temp.id('a') and normalized_name like '%fixture%')) as test;
select pg_temp.check_ok('future category-and-brand-scoped model query works',
 (select count(*)=1 from public.generic_product_models where category_id=pg_temp.id('a') and brand_id=pg_temp.id('brand_a'))) as test;
reset role;
update public.generic_product_brands set enabled=false where id=pg_temp.id('brand_b');
set local role anon;
select pg_temp.check_ok('disabled brand and its models hidden',
 (select count(*)=0 from public.generic_product_brands where id=pg_temp.id('brand_b')) and
 (select count(*)=0 from public.generic_product_models where id=pg_temp.id('model_b'))) as test;
reset role;
update public.generic_product_brands set enabled=true where id=pg_temp.id('brand_b');

insert into public.listings(id,seller_id,category_id,title)
select pg_temp.id(label),'11111111-1111-4111-8111-111111111111',pg_temp.id(category),'Fixture draft'
from (values('la','a'),('lb','b'),('manual_listing','a'),('none_listing','none'),('brand_only_listing','brand_only'),('empty_listing','a')) x(label,category);
insert into public.listings(id,seller_id,category_id,title) values
 (pg_temp.id('other_listing'),'22222222-2222-4222-8222-222222222222',pg_temp.id('a'),'Other fixture');
select pg_temp.rejects('privileged posting to root rejected',
 $$insert into public.listings(category_id,title) values(pg_temp.id('root'),'Root draft')$$,'23514') as test;
select pg_temp.rejects('coming-soon posting rejected',
 $$insert into public.listings(category_id,title) values(pg_temp.id('coming'),'Coming draft')$$,'23514') as test;
select pg_temp.rejects('hidden posting rejected',
 $$insert into public.listings(category_id,title) values(pg_temp.id('hidden'),'Hidden draft')$$,'23514') as test;
select pg_temp.rejects('blocked posting rejected',
 $$insert into public.listings(category_id,title) values(pg_temp.id('blocked'),'Blocked draft')$$,'23514') as test;
select pg_temp.rejects('coming-soon parent prevents child posting',
 $$insert into public.listings(category_id,title) values(pg_temp.id('child_coming'),'Parent closed')$$,'23514') as test;
select set_config('request.user','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
insert into public.listing_generic_product_identity(listing_id,category_id,brand_name_snapshot)
 values(pg_temp.id('manual_listing'),pg_temp.id('a'),'Seller-declared fixture');
select pg_temp.check_ok('seller can save optional manual text',
 (select brand_name_snapshot='Seller-declared fixture' and model_id is null from public.listing_generic_product_identity where listing_id=pg_temp.id('manual_listing'))) as test;
insert into public.listing_generic_product_identity(listing_id,category_id) values(pg_temp.id('empty_listing'),pg_temp.id('a'));
select pg_temp.check_ok('unfilled brand and model accepted',exists(select 1 from public.listing_generic_product_identity where listing_id=pg_temp.id('empty_listing') and brand_name_snapshot is null and model_name_snapshot is null)) as test;
select pg_temp.rejects('seller cannot import brands',
 $$insert into public.generic_product_brands(category_id,name) values(pg_temp.id('a'),'Unauthorized')$$,'42501') as test;
select pg_temp.rejects('seller cannot write another owner identity',
 $$insert into public.listing_generic_product_identity(listing_id,category_id) values(pg_temp.id('other_listing'),pg_temp.id('a'))$$,'42501') as test;
select pg_temp.rejects('identity category must match listing',
 $$insert into public.listing_generic_product_identity(listing_id,category_id) values(pg_temp.id('la'),pg_temp.id('b'))$$,'23514') as test;
select pg_temp.rejects('cross-category brand selection rejected',
 $$insert into public.listing_generic_product_identity(listing_id,category_id,brand_id,selection_source) values(pg_temp.id('la'),pg_temp.id('a'),pg_temp.id('brand_b'),'catalogue')$$,'23514') as test;
select pg_temp.rejects('cross-brand model selection rejected',
 $$insert into public.listing_generic_product_identity(listing_id,category_id,brand_id,model_id,selection_source) values(pg_temp.id('la'),pg_temp.id('a'),pg_temp.id('brand_a'),pg_temp.id('model_a2'),'catalogue')$$,'23514') as test;
select pg_temp.rejects('model without brand rejected',
 $$insert into public.listing_generic_product_identity(listing_id,category_id,model_id) values(pg_temp.id('la'),pg_temp.id('a'),pg_temp.id('model_a'))$$,'23514') as test;
select pg_temp.rejects('none category rejects identity',
 $$insert into public.listing_generic_product_identity(listing_id,category_id) values(pg_temp.id('none_listing'),pg_temp.id('none'))$$,'23514') as test;
select pg_temp.rejects('brand-only category rejects manual model',
 $$insert into public.listing_generic_product_identity(listing_id,category_id,model_name_snapshot) values(pg_temp.id('brand_only_listing'),pg_temp.id('brand_only'),'Unsupported')$$,'23514') as test;
insert into public.listing_generic_product_identity(listing_id,category_id,brand_id,model_id,selection_source,brand_name_snapshot)
 values(pg_temp.id('la'),pg_temp.id('a'),pg_temp.id('brand_a'),pg_temp.id('model_a'),'catalogue','Forged name');
select pg_temp.check_ok('catalogue names are captured authoritatively',
 (select brand_name_snapshot='Fixture Brand' and model_name_snapshot='Fixture Model' from public.listing_generic_product_identity where listing_id=pg_temp.id('la'))) as test;
select pg_temp.rejects('identity timestamps not client writable',
 $$update public.listing_generic_product_identity set created_at=now() where listing_id=pg_temp.id('la')$$,'42501') as test;
select pg_temp.rejects('identity keys not client writable',
 $$update public.listing_generic_product_identity set listing_id=pg_temp.id('lb') where listing_id=pg_temp.id('la')$$,'42501') as test;
reset role;
update public.generic_product_brands set name='Renamed Fixture' where id=pg_temp.id('brand_a');
update public.generic_product_models set name='Renamed Model' where id=pg_temp.id('model_a');
set local role authenticated;
update public.listing_generic_product_identity set brand_name_snapshot='Forged again' where listing_id=pg_temp.id('la');
select pg_temp.check_ok('catalogue rename and attempted overwrite preserve saved snapshots',
 (select brand_name_snapshot='Fixture Brand' and model_name_snapshot='Fixture Model' from public.listing_generic_product_identity where listing_id=pg_temp.id('la'))) as test;
select pg_temp.rejects('listing category edit cannot strand identity',
 $$update public.listings set category_id=pg_temp.id('b') where id=pg_temp.id('la')$$,'23503') as test;
select set_config('request.account','suspended',true);
with changed as (update public.listing_generic_product_identity set brand_name_snapshot='Denied' where listing_id=pg_temp.id('manual_listing') returning *)
select pg_temp.check_ok('suspended owner cannot update identity',(select count(*)=0 from changed)) as test;
select set_config('request.account','active',true);
select set_config('request.policy','false',true);
select pg_temp.rejects('policy acceptance required for identity insert',
 $$insert into public.listing_generic_product_identity(listing_id,category_id) values(pg_temp.id('lb'),pg_temp.id('b'))$$,'42501') as test;
select set_config('request.policy','true',true);
select set_config('request.user','22222222-2222-4222-8222-222222222222',true);
select pg_temp.check_ok('non-owner cannot read identities',(select count(*)=0 from public.listing_generic_product_identity)) as test;
with changed as (update public.listing_generic_product_identity set brand_name_snapshot='Denied' returning *)
select pg_temp.check_ok('non-owner cannot update identities',(select count(*)=0 from changed)) as test;
with changed as (delete from public.listing_generic_product_identity returning *)
select pg_temp.check_ok('non-owner cannot delete identities',(select count(*)=0 from changed)) as test;
reset role;
update public.listings set status='pending_review' where id=pg_temp.id('la');
select pg_temp.rejects('even privileged identity edits cannot bypass moderation',
 $$update public.listing_generic_product_identity set selection_source='manual',brand_id=null,model_id=null where listing_id=pg_temp.id('la')$$,'23514') as test;
select pg_temp.rejects('privileged identity deletion outside draft rejected',
 $$delete from public.listing_generic_product_identity where listing_id=pg_temp.id('la')$$,'23514') as test;
select set_config('request.user','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
with changed as (update public.listing_generic_product_identity set brand_name_snapshot='Denied' where listing_id=pg_temp.id('la') returning *)
select pg_temp.check_ok('owner cannot update reviewed identity',(select count(*)=0 from changed)) as test;
select pg_temp.check_ok('seller context still returns saved category',public.get_seller_listing_category_context(pg_temp.id('la'))->'category'->>'id'=pg_temp.id('a')::text) as test;
reset role;
update public.categories set status='coming_soon',new_listing_enabled=false where id=pg_temp.id('b');
update public.listings set title='Retained draft edit' where id=pg_temp.id('lb');
select pg_temp.check_ok('existing unavailable-category draft remains editable',
 (select title='Retained draft edit' from public.listings where id=pg_temp.id('lb'))) as test;
select pg_temp.rejects('saved unavailable draft cannot be submitted',
 $$update public.listings set status='pending_review' where id=pg_temp.id('lb')$$,'23514') as test;
select pg_temp.check_ok('Wearables retains text keys',
 (select data_type='text' from information_schema.columns where table_schema='public' and table_name='wearable_brands_v1' and column_name='id')
 and (select data_type='text' from information_schema.columns where table_schema='public' and table_name='wearable_models_v1' and column_name='id')) as test;
-- Additional retention, publication and future-import edges.
select pg_temp.rejects('legacy category with saved listings cannot become a root',
 $$update public.categories set status='live',new_listing_enabled=false where slug='legacy-broad'$$,'23514') as test;
insert into public.categories(slug,name,parent_id,status,posting_flow,catalogue_mode,macro_category,new_listing_enabled)
 values('tv-manual-capability','Manual capability',pg_temp.id('root'),'live','generic','brand_model','goods',true);
insert into public.listings(seller_id,category_id,title)
 select '11111111-1111-4111-8111-111111111111',id,'Manual model fixture' from public.categories where slug='tv-manual-capability';
insert into public.listing_generic_product_identity(listing_id,category_id,model_name_snapshot)
 select id,category_id,'Seller model' from public.listings where title='Manual model fixture';
select pg_temp.rejects('manual model snapshot prevents capability reduction',
 $$update public.categories set catalogue_mode='brand_only' where slug='tv-manual-capability'$$,'23514') as test;
update public.generic_product_models set enabled=false where id=pg_temp.id('model_a');
set local role authenticated;
select pg_temp.rejects('disabled model cannot be newly selected',
 $$update public.listing_generic_product_identity set selection_source='catalogue',brand_id=pg_temp.id('brand_a'),model_id=pg_temp.id('model_a') where listing_id=pg_temp.id('empty_listing')$$,'23514') as test;
insert into public.listing_generic_product_identity(listing_id,category_id,brand_id,selection_source)
 values(pg_temp.id('brand_only_listing'),pg_temp.id('brand_only'),pg_temp.id('brand_only_id'),'catalogue');
select pg_temp.check_ok('brand-only selection saves brand without model',
 (select brand_name_snapshot='Furniture Fixture' and model_id is null and model_name_snapshot is null from public.listing_generic_product_identity where listing_id=pg_temp.id('brand_only_listing'))) as test;
select pg_temp.rejects('manual text bounded at database boundary',
 $$update public.listing_generic_product_identity set brand_name_snapshot=repeat('x',101) where listing_id=pg_temp.id('manual_listing')$$,'23514') as test;
with changed as (delete from public.listing_generic_product_identity where listing_id=pg_temp.id('la') returning *)
select pg_temp.check_ok('owner cannot delete reviewed identity',(select count(*)=0 from changed)) as test;
delete from public.listing_generic_product_identity where listing_id=pg_temp.id('empty_listing');
update public.listings set category_id=pg_temp.id('brand_only') where id=pg_temp.id('empty_listing');
select pg_temp.check_ok('explicit draft identity removal permits safe category edit',
 (select category_id=pg_temp.id('brand_only') from public.listings where id=pg_temp.id('empty_listing'))) as test;
select set_config('request.user','',true);
select pg_temp.check_ok('authenticated role without subject cannot read identities',
 (select count(*)=0 from public.listing_generic_product_identity)) as test;
set local role anon;
select pg_temp.rejects('anonymous cannot update identities',
 $$update public.listing_generic_product_identity set brand_name_snapshot='Denied'$$,'42501') as test;
select pg_temp.rejects('anonymous cannot delete identities',
 $$delete from public.listing_generic_product_identity$$,'42501') as test;
reset role;
-- Foreign keys independently protect importer/model/listing assignments.
select pg_temp.check_ok('identity has three category-scoped composite FKs',
 (select count(*)=3 from pg_constraint where conrelid='public.listing_generic_product_identity'::regclass and contype='f' and array_length(conkey,1)>=2)) as test;
select pg_temp.check_ok('model FK binds both category and brand',
 (select count(*)=1 from pg_constraint where conrelid='public.generic_product_models'::regclass and contype='f' and array_length(conkey,1)=2)) as test;
-- AFTER UPDATE must see lifecycle transitions even when the client only edits title.
update public.listings set status='active' where id=pg_temp.id('empty_listing');
update public.categories set status='coming_soon',new_listing_enabled=false where id=pg_temp.id('brand_only');
select pg_temp.rejects('implicit lifecycle submission on title edit validates final category status',
 $$update public.listings set title='Material active edit' where id=pg_temp.id('empty_listing')$$,'23514') as test;
select 'PASS: '||last_value||' PostgreSQL assertions; all fixture imports roll back' as test from tv_checks;
rollback;
