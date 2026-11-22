// FairSwapProd sequence: foundation -> V3 production identity prerequisite -> DigiLocker V1.
// Engine-neutral: the PGlite release test and the native PostgreSQL 17 runner both drive these scenarios.
// run(sql): executes a script (several statements allowed) and returns the text of the last SELECT result, or ''.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  IDV_DIGILOCKER_POSTFLIGHT, IDV_DIGILOCKER_PREFLIGHT, IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT, IDV_DIGILOCKER_PRODUCTION_PREFLIGHT, snapshotSql
} from '../../scripts/release/idv-digilocker-v1-release.mjs';
import {getCandidate} from '../../scripts/release/reusable-candidates.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const source = path => readFileSync(join(root, path), 'utf8');
// Supabase roles are cluster-wide: make fixture role creation idempotent so a shared native cluster can be reused.
const idempotentRoles = sql => sql.replace(/^create role (\w+) ([^;]*);/gim,
  (_, role, attrs) => `do $r$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} ${attrs}; end if; end $r$;`);

export const SETUP_FILES = Object.freeze(['tests/idv-pg17/fixture.sql', 'tests/idv-pg17/fixture-digilocker.sql',
  'tests/idv-pg17/fixture-prod-v3.sql', 'supabase/forward-migrations/idv/20261026183000_idv_digilocker_foundation.sql',
  getCandidate('v3-production-identity-prerequisite').path]);
export const V1_PATH = getCandidate('idv-digilocker-v1').path;
export const setupSql = () => idempotentRoles(SETUP_FILES.map(source).join('\n'));

const selectOnly = sql => sql.slice(sql.indexOf('SELECT jsonb_build_object'), sql.lastIndexOf('\nCOMMIT;'));
const U = '99999999-9999-4999-8999-999999999999';

export async function runProdV3ToV1Scenarios(run) {
  const snap = async (checks, label, tamper = '') => JSON.parse(await run(
    tamper ? `begin;\n${tamper};\n${selectOnly(snapshotSql(checks, label))}\nrollback;` : selectOnly(snapshotSql(checks, label))));
  const failing = value => Object.entries(value.checks).filter(([, ok]) => ok !== true).map(([key]) => key).sort();
  const gateDenied = label => run(`begin;
    insert into auth.users (id, email) values ('${U}', 'prodv3@fairswap.test') on conflict do nothing;
    insert into public.user_accounts (user_id, account_status) values ('${U}', 'active') on conflict do nothing;
    select set_config('request.jwt.claim.sub', '${U}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    insert into public.listings (seller_id) values ('${U}');   -- gate OFF: allowed
    update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required';
    do $t$ begin insert into public.listings (seller_id) values ('${U}'); raise exception 'GATE_NOT_ENFORCED_${label}';
      exception when sqlstate '42501' then null; end $t$;
    rollback;`);

  // 1. The real Production state: the historical strict preflight fails only on the two V3-installed object classes.
  const strict = await snap(IDV_DIGILOCKER_PREFLIGHT, 'preflight');
  assert.deepEqual(failing(strict), ['digilocker_functions_absent', 'digilocker_triggers_absent']);

  // 2. Production preflight accepts exactly that state, and V3 behaviour (gate OFF, enforcement when ON) is live.
  const pre = await snap(IDV_DIGILOCKER_PRODUCTION_PREFLIGHT, 'preflight');
  assert.deepEqual(failing(pre), [], JSON.stringify(pre.checks));
  assert.equal(await run('select app_security.identity_gate_enabled()::text'), 'false');
  await gateDenied('BEFORE_V1');

  // 3. Tampered V3 functions, permissions and triggers are refused before any SQL is applied.
  const tampers = [
    ['function body (gate forced on)', "create or replace function app_security.identity_gate_enabled() returns boolean language sql stable security definer set search_path = '' as $$ select true $$", 'v3_functions_exact'],
    ['function body (enforcement removed)', "create or replace function app_security.enforce_verified_actor(p_actor uuid, p_any_caller boolean default false) returns void language plpgsql stable security definer set search_path = '' as $$ begin return; end $$", 'v3_functions_exact'],
    ['function search_path', 'alter function app_security.is_identity_verified(uuid) set search_path = public', 'v3_functions_exact'],
    ['function security invoker', 'alter function app_security.trg_identity_gate_listings() security invoker', 'v3_functions_exact'],
    ['function marked leakproof', 'alter function app_security.identity_gate_enabled() leakproof', 'v3_functions_exact'],
    ['function owner', 'create role prodv3_other; alter function app_security.idv_request_role() owner to prodv3_other', 'v3_functions_exact'],
    ['extra overload', "create function app_security.enforce_verified_actor(uuid) returns void language sql as 'select'", 'v3_functions_exact'],
    ['V1 name already present', "create function public.get_my_marketplace_access() returns jsonb language sql as 'select null::jsonb'", 'digilocker_functions_absent'],
    ['authenticated EXECUTE on gate', 'grant execute on function app_security.identity_gate_enabled() to authenticated', 'v3_function_grants_exact'],
    ['service_role EXECUTE on verified predicate', 'grant execute on function app_security.is_identity_verified(uuid) to service_role', 'v3_function_grants_exact'],
    ['PUBLIC EXECUTE on enforce', 'grant execute on function app_security.enforce_verified_actor(uuid,boolean) to public', 'v3_function_grants_exact'],
    ['authenticated EXECUTE on enforce', 'grant execute on function app_security.enforce_verified_actor(uuid,boolean) to authenticated', 'v3_function_grants_exact'],
    ['anon EXECUTE on trigger function', 'grant execute on function app_security.trg_identity_gate_listings() to anon', 'v3_function_grants_exact'],
    ['service_role EXECUTE on trigger function', 'grant execute on function app_security.trg_identity_gate_by_listing() to service_role', 'v3_function_grants_exact'],
    ['authenticated EXECUTE on request role', 'grant execute on function app_security.idv_request_role() to authenticated', 'v3_function_grants_exact'],
    ['service_role EXECUTE on enforce revoked', 'revoke execute on function app_security.enforce_verified_actor(uuid,boolean) from service_role', 'v3_function_grants_exact'],
    ['trigger disabled', 'alter table public.listings disable trigger trg_identity_gate', 'v3_triggers_exact'],
    ['trigger replica-only', 'alter table public.listings enable replica trigger trg_identity_gate', 'v3_triggers_exact'],
    ['trigger dropped', 'drop trigger trg_identity_gate on public.listing_media', 'v3_triggers_exact'],
    ['trigger narrowed to INSERT', 'drop trigger trg_identity_gate on public.listings; create trigger trg_identity_gate before insert on public.listings for each row execute function app_security.trg_identity_gate_listings()', 'v3_triggers_exact'],
    ['trigger with WHEN', 'drop trigger trg_identity_gate on public.listings; create trigger trg_identity_gate before insert or update on public.listings for each row when (false) execute function app_security.trg_identity_gate_listings()', 'v3_triggers_exact'],
    ['trigger column-scoped', 'drop trigger trg_identity_gate on public.listings; create trigger trg_identity_gate before insert or update of status on public.listings for each row execute function app_security.trg_identity_gate_listings()', 'v3_triggers_exact'],
    ['trigger wrong function', 'drop trigger trg_identity_gate on public.listing_media; create trigger trg_identity_gate before insert on public.listing_media for each row execute function app_security.trg_identity_gate_posting_session()', 'v3_triggers_exact'],
    ['trigger on a V1 target', 'create trigger trg_identity_gate before insert on public.messages for each row execute function app_security.trg_identity_gate_by_listing()', 'v3_triggers_exact'],
    ['V1 binding trigger name present', 'create trigger trg_idv_dl_probe before insert on public.messages for each row execute function app_security.trg_identity_gate_by_listing()', 'v3_triggers_exact'],
    ['gate setting on', "update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required'", 'gate_setting_not_on']
  ];
  for (const [name, sql, key] of tampers) {
    assert.ok(failing(await snap(IDV_DIGILOCKER_PRODUCTION_PREFLIGHT, 'preflight', sql)).includes(key), `tamper not detected: ${name}`);
  }
  assert.deepEqual(failing(await snap(IDV_DIGILOCKER_PRODUCTION_PREFLIGHT, 'preflight')), []);   // every tamper was rolled back

  // 4. Apply the real, unmodified V1 migration. Postflight (Production) passes and nothing else changed.
  await run(source(V1_PATH));
  const post = await snap(IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT, 'postflight');
  assert.deepEqual(failing(post), [], JSON.stringify(post.checks));
  assert.equal(post.preserved, pre.preserved);
  assert.equal(await run('select app_security.identity_gate_enabled()::text'), 'false');
  await gateDenied('AFTER_V1');
  // The reviewed permission change: V1 grants EXECUTE on the two helpers to authenticated and service_role; anon/PUBLIC stay denied.
  assert.equal(await run(`select (has_function_privilege('authenticated','app_security.identity_gate_enabled()','execute')
    and has_function_privilege('service_role','app_security.is_identity_verified(uuid)','execute')
    and not has_function_privilege('anon','app_security.is_identity_verified(uuid)','execute')
    and not has_function_privilege('public','app_security.identity_gate_enabled()','execute'))::text`), 'true');
  // Every other V3 grant stays revoked from clients.
  assert.equal(await run(`select (not has_function_privilege('authenticated','app_security.enforce_verified_actor(uuid,boolean)','execute')
    and not has_function_privilege('authenticated','app_security.trg_identity_gate_listings()','execute')
    and not has_function_privilege('service_role','app_security.trg_identity_gate_staged_media()','execute'))::text`), 'true');
  // V1 added the conversation/message gates and the optional context-table gate (gate OFF).
  assert.equal(await run(`select count(*)::text from pg_trigger where tgname = 'trg_identity_gate' and not tgisinternal`), '7');

  // 5. Post-install tampering of V3-owned objects is refused by the Production postflight (no receipt would be written).
  const postTampers = [
    ['V3 function body', "create or replace function app_security.is_identity_verified(p_user_id uuid) returns boolean language sql stable security definer set search_path = '' as $$ select true $$", 'v3_function_bodies_preserved'],
    ['V3 trigger disabled', 'alter table public.posting_staged_media disable trigger trg_identity_gate', 'v3_triggers_preserved'],
    ['gate on', "update public.app_system_settings set setting_value = 'true' where setting_key = 'identity_verification_required'", 'gate_setting_off'],
    ['service-only grant widened', 'grant execute on function public.server_idv_dl_complete(uuid,uuid,text,text,text[]) to authenticated', 'service_only_execute']
  ];
  for (const [name, sql, key] of postTampers) {
    assert.ok(failing(await snap(IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT, 'postflight', sql)).includes(key), `post tamper not detected: ${name}`);
  }
  // The plain postflight does not know the V3 pins; Production must use its own.
  assert.ok(Object.keys(IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT).length > Object.keys(IDV_DIGILOCKER_POSTFLIGHT).length);

  // 6. A second attempt is refused by the Production preflight.
  assert.ok(failing(await snap(IDV_DIGILOCKER_PRODUCTION_PREFLIGHT, 'preflight')).length > 0);
}
