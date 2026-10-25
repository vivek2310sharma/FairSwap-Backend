import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(
  new URL('../../releases/production/vehicles-property-launch-v1/candidate-family-submission.sql',import.meta.url),
  'utf8'
);

test('non-executable candidate stops BEFORE any DDL',()=>{
  const stop=source.indexOf("RAISE EXCEPTION 'REVIEW ONLY:");
  const firstDdl=source.indexOf('create table app_security.production_submission_policies');
  assert.ok(stop>0 && firstDdl>stop,'Missing deliberate fail-closed review stopper');
  assert.ok(source.includes("BEGIN;") && source.includes("COMMIT;"));
});

test('Production public RPC is new, Goods and Test submission endpoints unchanged',()=>{
  assert.match(source,/public\.seller_submit_family_listing\(listing_id uuid,expected_revision integer\)/);
  assert.match(source,/public\.get_seller_production_submission_status\(listing_id uuid\)/);
  assert.doesNotMatch(source,/public\.seller_submit_listing\s*\(/);
  assert.doesNotMatch(source,/app_security\.impl_seller_submit_listing\s*\(/);
  assert.doesNotMatch(source,/app_security\.test_submission_/);
  assert.doesNotMatch(source,/POST_AD_SUBMISSION_TEST_ENABLED/);
});

test('No default activation, no change to reviewer or active status in candidate',()=>{
  assert.match(source,/enabled boolean not null default false/);
  assert.match(source,/maintenance boolean not null default false/);
  assert.match(source,/new\.status not in \('draft','pending_review'\)/);
  assert.match(source,/new\.status='pending_review' and permitted='submit'/);
  assert.match(source,/review\/publication (is )?disabled/i);
  assert.doesNotMatch(source,/INSERT INTO public\.categories/i);
  assert.doesNotMatch(source,/update public\.categories set/i);
});

test('Own-context and revision checks precede mutations',()=>{
  assert.match(source,/l\.seller_id<>auth\.uid\(\)/);
  assert.match(source,/expected_revision<>l\.revision/);
  assert.match(source,/select \* into l from public\.listings where id=lid for update/);
  assert.match(source,/app_security\.validate_property_components/);
  assert.match(source,/ready<>total/);
  assert.match(source,/grant execute on function public\.seller_submit_family_listing\(uuid,integer\) to authenticated/);
  assert.match(source,/revoke all on function public\.seller_submit_family_listing\(uuid,integer\) from public,anon,authenticated,service_role/);
});
