// IDV DigiLocker V1 (dark) and OIDC V2 badge-provenance release guards for the reusable Supabase workflow.
// All SQL here is read-only.
// Receipts carry only versions, names, digests and booleans: no user, binding, attempt or settings row contents.
import {getCandidate, PROJECT_REFS} from './reusable-candidates.mjs';

export const IDV_DIGILOCKER_CANDIDATE = 'idv-digilocker-v1';
export const IDV_DIGILOCKER_SCOPE = 'idv-digilocker-v1-dark-integrity';
// FairSwapTest already records V1 (installed before Production was eligible). Its Test stage is therefore a read-only
// attestation of that installation, and the attested ledger digest is what Production must reproduce.
export const IDV_DIGILOCKER_INSTALLED_SCOPE = 'idv-digilocker-v1-installed-integrity';
export const IDV_DIGILOCKER_V2_CANDIDATE = 'idv-digilocker-oidc-v2';
export const IDV_DIGILOCKER_V2_SCOPE = 'idv-digilocker-oidc-v2-badge-integrity';
export const isIdvDigilockerCandidate = id => id === IDV_DIGILOCKER_CANDIDATE || id === IDV_DIGILOCKER_V2_CANDIDATE;
const fail = code => { throw new Error(`REUSABLE_RELEASE_IDV_DIGILOCKER_${code}`); };

// The foundation was applied with project-scoped apply_migration, so each environment recorded its own hosted
// version under one name. It is never replayed, renamed or repaired to the source-file version (20261026183000).
export const IDV_FOUNDATION_LEDGER = Object.freeze({
  FairSwapTest: Object.freeze({version: '20261028091220', name: 'idv_digilocker_foundation_v1'}),
  FairSwapProd: Object.freeze({version: '20261028095605', name: 'idv_digilocker_foundation_v1'})
});
export const IDV_FOUNDATION_SOURCE_VERSION = '20261026183000';

// Rows newer than 20261117090000 differ per environment. The CLI inserts the older candidate only with --include-all; that
// is admitted only when the newer tail is exactly that environment's reviewed rows (version, name, statement count and
// digest of the CLI-split reviewed source, as stored by the reusable workflow). FairSwapTest: the Taxonomy V2 pair.
export const IDV_DIGILOCKER_TAIL = Object.freeze([
  Object.freeze({candidateId: 'taxonomy-v2-foundation', statementCount: 47,
    statementsSha256: '9f20f113121f922e89b5a186f0d30101c4d1c50b44bac00c3dfc0420c02369eb'}),
  Object.freeze({candidateId: 'taxonomy-v2-catalogue', statementCount: 16,
    statementsSha256: 'f9233abf20753db40bf206adf2d386c216c64ba9a665086174a0aaa863c8d741'})
]);

// FairSwapProd: the Taxonomy V2 pair, then the disabled V3 Production batch in its enforced order. The seven V3 schema
// digests equal the signed FairSwapTest receipts in unified-publishing-v3/TEST_RECEIPTS.json (which the V3 Production
// batch requires Production to reproduce); the Production-only identity prerequisite is the CLI split of its pinned source.
export const IDV_DIGILOCKER_PRODUCTION_TAIL = Object.freeze([
  ...IDV_DIGILOCKER_TAIL,
  ...[
    ['v3-production-identity-prerequisite', 26, 'b521935f8abc9eee155d0a5badffe8adbb162ba0e23d41d63c8ef19bc8fc7e21'],
    ['ordinary-goods-v3', 31, '7a32a3083666c27b12da8af45083c69733a4b3f2096f49401483ed9f94f36316'],
    ['bounded-goods-v3', 13, '1aa854e30011d04a73716114aa9dabdc19c9118fbb40e0d5e38940a3ee748a1a'],
    ['pedal-and-parts-v3', 9, 'eb1863e197c67c08563435e1124cfea69848696998582abbf16afcfa58bda7f1'],
    ['property-intake-v3', 11, '4889a1f42f5a796a64000fcd2f7bf385ff8c02acf10bdc8333786fb9f95ee5ca'],
    ['regulated-vehicle-drafts-v3', 11, 'ddbc8b043c6ed848021059b93f2cc292b57fc644af68337382342b58ad89b512'],
    ['specialist-vehicle-draft-binding-v3', 20, '6b39778d3a32f49c676f45d6450db32f00c6c23800e10f941f858782bf8c1041'],
    ['v3-require-active-seller-identity', 8, '9652f49945f082ae3c7578f403670c258d915893764727dc4e205c5256401550']
  ].map(([candidateId, statementCount, statementsSha256]) => Object.freeze({candidateId, statementCount, statementsSha256}))
]);
export const idvDigilockerTail = environment =>
  environment === 'FairSwapProd' ? IDV_DIGILOCKER_PRODUCTION_TAIL : environment === 'FairSwapTest' ? IDV_DIGILOCKER_TAIL : null;

const ledgerName = candidate => candidate.filename.slice(15, -4);
const matchesTail = (row, pin) => {
  const c = getCandidate(pin.candidateId);
  return row?.version === c.version && row.name === ledgerName(c) && row.hasStatements === true &&
    row.statementCount === pin.statementCount && row.statementsSha256 === pin.statementsSha256;
};

// Runs on readTabletsLedger rows (ordered by version) before any dry run. Returns the out-of-order plan.
export function assertIdvDigilockerLedger(environment, rows) {
  const candidate = getCandidate(IDV_DIGILOCKER_CANDIDATE);
  const own = IDV_FOUNDATION_LEDGER[environment];
  const tail = idvDigilockerTail(environment);
  if (!own || !tail || !Array.isArray(rows)) fail('ENVIRONMENT_INVALID');
  const foundation = rows.filter(row => row.name === own.name);
  if (foundation.length !== 1 || foundation[0].version !== own.version || foundation[0].hasStatements !== true) {
    fail('FOUNDATION_PREREQUISITE_MISMATCH');
  }
  if (rows.some(row => row.version === IDV_FOUNDATION_SOURCE_VERSION)) fail('FOUNDATION_HISTORY_MISMATCH');
  if (rows.some(row => row.version === candidate.version || row.name === ledgerName(candidate))) fail('ALREADY_RECORDED');
  const ahead = rows.filter(row => row.version > candidate.version);
  if (ahead.length !== tail.length || !tail.every((pin, i) => matchesTail(ahead[i], pin))) {
    fail('LEDGER_TAIL_MISMATCH');
  }
  return {includeAll: true, ahead: ahead.map(row => row.version)};
}

// FairSwapTest only: V1 is already recorded. Verifies the environment foundation row and the recorded V1 row (name and
// non-empty statements) and returns that row's statements digest. Nothing is applied, repaired or rewritten.
export function assertIdvDigilockerTestInstalled(environment, rows) {
  const candidate = getCandidate(IDV_DIGILOCKER_CANDIDATE);
  const own = IDV_FOUNDATION_LEDGER[environment];
  if (environment !== 'FairSwapTest' || !own || !Array.isArray(rows)) fail('INSTALLED_ATTESTATION_ENVIRONMENT_INVALID');
  const foundation = rows.filter(row => row.name === own.name);
  if (foundation.length !== 1 || foundation[0].version !== own.version || foundation[0].hasStatements !== true) {
    fail('FOUNDATION_PREREQUISITE_MISMATCH');
  }
  const installed = rows.filter(row => row.version === candidate.version || row.name === ledgerName(candidate));
  if (installed.length !== 1 || installed[0].version !== candidate.version || installed[0].name !== ledgerName(candidate) ||
      installed[0].hasStatements !== true || !(installed[0].statementCount > 0) || !/^[a-f0-9]{64}$/.test(installed[0].statementsSha256 ?? '')) {
    fail('INSTALLED_LEDGER_MISMATCH');
  }
  return installed[0].statementsSha256;
}

const FOUNDATION_TABLES = ['public.user_identity_verifications', 'app_security.idv_verification_attempts',
  'app_security.idv_identity_records', 'app_security.idv_audit_events'];
const TABLES = ['app_security.idv_digilocker_attempts', 'app_security.idv_digilocker_bindings'];
// Exact signatures created by the migration, grouped by the EXECUTE grants it establishes.
export const IDV_DIGILOCKER_FUNCTIONS = Object.freeze({
  serviceOnly: Object.freeze([
    'app_security.impl_idv_dl_start_attempt(uuid,text,integer,text,boolean,text)',
    'app_security.impl_idv_dl_consume_state(uuid,text)',
    'app_security.impl_idv_dl_fail_attempt(uuid,uuid,text)',
    'app_security.impl_idv_dl_complete(uuid,uuid,text,text,text[])',
    'public.server_idv_dl_start_attempt(uuid,text,integer,text,boolean,text)',
    'public.server_idv_dl_consume_state(uuid,text)',
    'public.server_idv_dl_fail_attempt(uuid,uuid,text)',
    'public.server_idv_dl_complete(uuid,uuid,text,text,text[])',
    'app_security.enforce_verified_actor(uuid,boolean)'
  ]),
  authenticated: Object.freeze([
    'app_security.impl_admin_digilocker_fraud_block(uuid,text,integer)',
    'app_security.impl_admin_digilocker_fraud_block_resolve(uuid,text,text)',
    'public.admin_digilocker_fraud_block(uuid,text,integer)',
    'public.admin_digilocker_fraud_block_resolve(uuid,text,text)',
    'app_security.is_identity_verified(uuid)',
    'app_security.identity_gate_enabled()',
    'public.get_my_marketplace_access()'
  ]),
  internal: Object.freeze([
    'app_security.idv_request_role()',
    'app_security.identity_gate_system_write()',
    'app_security.trg_idv_dl_binding_guard()',
    'app_security.trg_idv_dl_binding_orphan_cleanup()',
    'app_security.trg_identity_gate_listings()',
    'app_security.trg_identity_gate_by_listing()',
    'app_security.trg_identity_gate_posting_session()',
    'app_security.trg_identity_gate_staged_media()',
    'app_security.trg_identity_gate_conversations()',
    'app_security.trg_identity_gate_messages()'
  ])
});
const INVOKER = ['app_security.identity_gate_system_write()'];
const ALL_FUNCTIONS = Object.values(IDV_DIGILOCKER_FUNCTIONS).flat();
const FUNCTION_NAMES = [...new Set(ALL_FUNCTIONS.map(sig => sig.split('(')[0].split('.')[1]))];
const REQUIRED_GATES = [
  ['public.listings', 'app_security.trg_identity_gate_listings()'],
  ['public.listing_media', 'app_security.trg_identity_gate_by_listing()'],
  ['public.conversations', 'app_security.trg_identity_gate_conversations()'],
  ['public.messages', 'app_security.trg_identity_gate_messages()']
];
// Created by the migration only where the table exists in that environment.
const OPTIONAL_GATES = [
  ['public.posting_upload_sessions', 'app_security.trg_identity_gate_posting_session()'],
  ['public.posting_staged_media', 'app_security.trg_identity_gate_staged_media()'],
  ...['listing_accessory_contexts', 'listing_car_contexts', 'listing_generic_product_identity', 'listing_mobile_contexts',
    'listing_property_contexts', 'listing_tablet_contexts', 'listing_vehicle_contexts', 'listing_wearable_contexts_v1']
    .map(table => [`public.${table}`, 'app_security.trg_identity_gate_by_listing()'])
];

const arr = values => `ARRAY[${values.map(v => `'${v}'`).join(',')}]::text[]`;
const pairs = list => `(VALUES ${list.map(([a, b]) => `('${a}','${b}')`).join(',')}) x(tbl, fn)`;
const allFns = (sigs, predicate) =>
  `(SELECT coalesce(bool_and(coalesce(${predicate}, false)), false) FROM unnest(${arr(sigs)}) s LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s)::oid)`;
const execBy = (role, value, sigs) => allFns(sigs, `has_function_privilege('${role}', p.oid, 'EXECUTE') = ${value}`);
const ANY_TABLE_PRIVILEGE = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER';
const tablePriv = (role, table, privileges) => `coalesce(has_table_privilege('${role}', to_regclass('${table}')::oid, '${privileges}'), false)`;
const gate = (tbl, fn) => `EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass(${tbl})::oid
  AND t.tgname = 'trg_identity_gate' AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = to_regprocedure(${fn})::oid)`;

export const IDV_DIGILOCKER_PREFLIGHT = Object.freeze({
  foundation_tables_rls: `(SELECT count(*) = ${FOUNDATION_TABLES.length} FROM unnest(${arr(FOUNDATION_TABLES)}) s
    JOIN pg_class c ON c.oid = to_regclass(s)::oid WHERE c.relrowsecurity)`,
  gate_targets_exist: `(SELECT bool_and(to_regclass(t) IS NOT NULL) FROM unnest(${arr(['public.app_system_settings', ...REQUIRED_GATES.map(([t]) => t)])}) t)`,
  gate_setting_not_on: `NOT EXISTS (SELECT 1 FROM public.app_system_settings
    WHERE setting_key = 'identity_verification_required' AND setting_value IS DISTINCT FROM 'false')`,
  digilocker_tables_absent: `(SELECT bool_and(to_regclass(t) IS NULL) FROM unnest(${arr(TABLES)}) t)`,
  digilocker_functions_absent: `NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_security') AND p.proname = ANY(${arr(FUNCTION_NAMES)}))`,
  digilocker_triggers_absent: `NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
    AND (tgname = 'trg_identity_gate' OR tgname LIKE 'trg\\_idv\\_dl\\_%'))`
});

// ---------- FairSwapProd: V3 identity prerequisite (20261119090000) already installed ----------
// FairSwapProd records v3-production-identity-prerequisite before V1. It installed nine of V1's shared identity-gate functions
// (bodies byte-identical to V1's) and four enabled trg_identity_gate triggers, all with enforcement OFF and client EXECUTE revoked.
// The Production preflight therefore replaces "absent" with an exact match of that pinned V3 state; anything else fails closed.
// V1's reviewed effects on that state: (a) the nine functions are re-created with identical bodies, (b) the four V3 triggers are
// dropped and re-created identically, (c) EXECUTE on is_identity_verified(uuid) and identity_gate_enabled() is GRANTED to
// authenticated and service_role (V3 had revoked it; app_security is not exposed by PostgREST: supabase/config.toml schemas =
// ["public"]), (d) conversation/message triggers and the optional context-table triggers are added, gate still OFF.
// [signature, language, security definer, volatility, return type, md5(prosrc), EXECUTE for service_role after V3 (null = unchanged by V3)]
const V3_IDENTITY_FUNCTIONS = Object.freeze([
  ['app_security.is_identity_verified(uuid)', 'sql', true, 's', 'boolean', '155acd8b35554f9aa49b17621593238c', false],
  ['app_security.identity_gate_enabled()', 'sql', true, 's', 'boolean', '7697fcf0ecf1233afacc31fe3cdffef2', false],
  ['app_security.idv_request_role()', 'plpgsql', true, 's', 'text', '48c739691fbc24ec36e4ba18cc73438f', null],
  ['app_security.identity_gate_system_write()', 'sql', false, 's', 'boolean', '16e689f45a7920aca700c86a60b168f7', null],
  ['app_security.enforce_verified_actor(uuid,boolean)', 'plpgsql', true, 's', 'void', '79ef00dfef18ea693b89f75dc2be3657', true],
  ['app_security.trg_identity_gate_listings()', 'plpgsql', true, 'v', 'trigger', 'ce08e09e542a2cf111f48ba787b23478', false],
  ['app_security.trg_identity_gate_by_listing()', 'plpgsql', true, 'v', 'trigger', '7e0b3e832305fcfb9edc09c58c990e34', false],
  ['app_security.trg_identity_gate_posting_session()', 'plpgsql', true, 'v', 'trigger', '4c4dc8e188254fdd00009b23d6a04577', false],
  ['app_security.trg_identity_gate_staged_media()', 'plpgsql', true, 'v', 'trigger', '0d7bf1843cfcc24dbed5a89e29945657', false]
].map(row => Object.freeze(row)));
// [table, trigger function, tgtype]: BEFORE INSERT OR UPDATE FOR EACH ROW = 23, BEFORE INSERT FOR EACH ROW = 7.
const V3_IDENTITY_TRIGGERS = Object.freeze([
  ['public.listings', 'app_security.trg_identity_gate_listings()', 23],
  ['public.listing_media', 'app_security.trg_identity_gate_by_listing()', 7],
  ['public.posting_upload_sessions', 'app_security.trg_identity_gate_posting_session()', 7],
  ['public.posting_staged_media', 'app_security.trg_identity_gate_staged_media()', 23]
].map(row => Object.freeze(row)));
const V3_FUNCTION_SIGS = V3_IDENTITY_FUNCTIONS.map(row => row[0]);
const V3_FUNCTION_NAMES = V3_FUNCTION_SIGS.map(sig => sig.split('(')[0].split('.')[1]);

const v3Function = ([sig, lang, definer, volatility, returns, bodyMd5]) => `EXISTS (SELECT 1 FROM pg_proc p
  WHERE p.oid = to_regprocedure('${sig}')::oid AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = '${lang}') AND p.prokind = 'f' AND p.prosecdef = ${definer}
    AND p.provolatile = '${volatility}' AND p.prorettype = '${returns}'::regtype AND NOT p.proretset AND NOT p.proisstrict
    AND NOT p.proleakproof AND p.proparallel = 'u' AND p.prosupport = 0 AND p.probin IS NULL
    AND p.proconfig = ARRAY['search_path=""']::text[] AND md5(p.prosrc) = '${bodyMd5}')`;
const v3Trigger = ([tbl, fn, type]) => `EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('${tbl}')::oid
  AND t.tgname = 'trg_identity_gate' AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = to_regprocedure('${fn}')::oid
  AND t.tgtype = ${type} AND t.tgqual IS NULL AND t.tgnargs = 0 AND t.tgattr::text = '' AND t.tgconstraint = 0
  AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND NOT t.tgdeferrable AND t.tgparentid = 0)`;
const allOf = rows => rows.map(row => `(${row})`).join(' AND ');
// Exact V3 client/anon/PUBLIC EXECUTE posture (service_role only where V3 changed it).
const v3Execute = () => V3_IDENTITY_FUNCTIONS.map(([sig,,,,,, service]) => {
  const roles = ['public', 'anon', 'authenticated'].map(role => execBy(role, false, [sig]));
  return allOf([...roles, ...(service === null ? [] : [execBy('service_role', service, [sig])])]);
}).join(' AND ');

export const IDV_DIGILOCKER_PRODUCTION_PREFLIGHT = Object.freeze({
  ...Object.fromEntries(Object.entries(IDV_DIGILOCKER_PREFLIGHT)
    .filter(([key]) => key !== 'digilocker_functions_absent' && key !== 'digilocker_triggers_absent')),
  v3_functions_exact: allOf([
    ...V3_IDENTITY_FUNCTIONS.map(v3Function),
    // exactly one overload per V3 name and no other function using a V3 or V1 name outside the pinned set
    `(SELECT count(*) = ${V3_FUNCTION_SIGS.length} FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public','app_security') AND p.proname = ANY(${arr(V3_FUNCTION_NAMES)}))`
  ]),
  v3_function_grants_exact: v3Execute(),
  digilocker_functions_absent: `NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_security') AND p.proname = ANY(${arr(FUNCTION_NAMES.filter(name => !V3_FUNCTION_NAMES.includes(name)))}))`,
  v3_triggers_exact: allOf([
    ...V3_IDENTITY_TRIGGERS.map(v3Trigger),
    `(SELECT count(*) = ${V3_IDENTITY_TRIGGERS.length} FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_identity_gate')`,
    `NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\\_idv\\_dl\\_%')`
  ])
});

// Production postflight additions: V1 must leave V3's nine function bodies and four trigger definitions exactly as pinned.
const PRODUCTION_ONLY_POSTFLIGHT = Object.freeze({
  v3_function_bodies_preserved: allOf(V3_IDENTITY_FUNCTIONS.map(v3Function)),
  v3_triggers_preserved: allOf(V3_IDENTITY_TRIGGERS.map(v3Trigger))
});

export const IDV_DIGILOCKER_POSTFLIGHT = Object.freeze({
  foundation_tables_rls: IDV_DIGILOCKER_PREFLIGHT.foundation_tables_rls,
  tables_rls_forced: `(SELECT count(*) = 2 FROM unnest(${arr(TABLES)}) s JOIN pg_class c ON c.oid = to_regclass(s)::oid
    WHERE c.relrowsecurity AND c.relforcerowsecurity)`,
  tables_no_policies: `NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN (SELECT to_regclass(s)::oid FROM unnest(${arr(TABLES)}) s))`,
  tables_no_client_privileges: TABLES.flatMap(t => ['public', 'anon', 'authenticated']
    .map(role => `NOT ${tablePriv(role, t, ANY_TABLE_PRIVILEGE)}`)).join(' AND '),
  attempts_service_role: tablePriv('service_role', TABLES[0], 'SELECT') + ' AND ' + tablePriv('service_role', TABLES[0], 'INSERT') +
    ' AND ' + tablePriv('service_role', TABLES[0], 'UPDATE'),
  bindings_no_direct_dml: `NOT ${tablePriv('service_role', TABLES[1], 'INSERT,UPDATE,DELETE,TRUNCATE')}`,
  tables_empty: `(SELECT count(*) = 0 FROM app_security.idv_digilocker_attempts)
    AND (SELECT count(*) = 0 FROM app_security.idv_digilocker_bindings)`,
  gate_setting_off: `(SELECT count(*) = 1 AND bool_and(setting_value = 'false') FROM public.app_system_settings
    WHERE setting_key = 'identity_verification_required')`,
  gate_function_off: `app_security.identity_gate_enabled() IS FALSE`,
  functions_exact: allFns(ALL_FUNCTIONS.filter(s => !INVOKER.includes(s)), `p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]`) +
    ' AND ' + allFns(INVOKER, `NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]`),
  service_only_execute: execBy('service_role', true, IDV_DIGILOCKER_FUNCTIONS.serviceOnly) + ' AND ' +
    ['public', 'anon', 'authenticated'].map(role => execBy(role, false, IDV_DIGILOCKER_FUNCTIONS.serviceOnly)).join(' AND '),
  authenticated_execute: execBy('authenticated', true, IDV_DIGILOCKER_FUNCTIONS.authenticated) + ' AND ' +
    execBy('service_role', true, IDV_DIGILOCKER_FUNCTIONS.authenticated) + ' AND ' +
    ['public', 'anon'].map(role => execBy(role, false, IDV_DIGILOCKER_FUNCTIONS.authenticated)).join(' AND '),
  internal_no_client_execute: ['public', 'anon', 'authenticated']
    .map(role => execBy(role, false, IDV_DIGILOCKER_FUNCTIONS.internal)).join(' AND '),
  gate_triggers: `(SELECT bool_and(${gate('x.tbl', 'x.fn')}) FROM ${pairs(REQUIRED_GATES)})`,
  optional_gate_triggers: `(SELECT bool_and(to_regclass(x.tbl) IS NULL OR ${gate('x.tbl', 'x.fn')}) FROM ${pairs(OPTIONAL_GATES)})`,
  binding_triggers: `(SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = to_regclass('${TABLES[1]}')::oid AND NOT t.tgisinternal
    AND t.tgenabled = 'O' AND t.tgname IN ('trg_idv_dl_binding_guard','trg_idv_dl_binding_orphan_cleanup'))`
});

export const IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT = Object.freeze({...IDV_DIGILOCKER_POSTFLIGHT, ...PRODUCTION_ONLY_POSTFLIGHT});

// ---------- enforce_verified_actor: the only permitted body evolution, bound to the ledger ----------
// historical:   the V3-prerequisite / V1 body (predicate is_identity_verified), pinned above in V3_IDENTITY_FUNCTIONS. It is
//               the ONLY state FairSwapProd may hold; every Production check keeps using that unchanged pin.
// requiredGate: the body of 20261122100000_idv_digilocker_required_gate.sql (predicate has_digilocker_badge). Valid ONLY in
//               FairSwapTest and ONLY when the ledger records that exact row (version, name, CLI statement count and digest).
// Any other body, or a row that only partially matches, fails closed. No state is inferred from the body alone.
const ENFORCE_SIG = 'app_security.enforce_verified_actor(uuid,boolean)';
const HISTORICAL_ENFORCE = V3_IDENTITY_FUNCTIONS.find(row => row[0] === ENFORCE_SIG);
export const ENFORCE_VERIFIED_ACTOR_STATES = Object.freeze({
  historical: Object.freeze({bodyMd5: HISTORICAL_ENFORCE[5], ledger: null}),
  requiredGate: Object.freeze({bodyMd5: 'a2f0ad7ff0bf388c2f6a054f8167b1d2', ledger: Object.freeze({
    version: '20261122100000', name: 'idv_digilocker_required_gate', statementCount: 8,
    statementsSha256: '1c8339f6c808dc687023e2ffaabbadf4c380f4dfb38fa39f1cfe62fbda1cda9c'})})
});
// Exact function attributes (owner, language, SECURITY DEFINER, volatility, empty search_path) and the state's body digest.
const enforceBody = state => v3Function([...HISTORICAL_ENFORCE.slice(0, 5), ENFORCE_VERIFIED_ACTOR_STATES[state].bodyMd5]);

export function enforceVerifiedActorState(environment, rows) {
  if (!IDV_FOUNDATION_LEDGER[environment] || !Array.isArray(rows)) fail('ENFORCE_STATE_ENVIRONMENT_INVALID');
  const pin = ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.ledger;
  const recorded = rows.filter(row => row.version === pin.version || row.name === pin.name);
  if (recorded.length === 0) return 'historical';
  if (environment !== 'FairSwapTest') fail('REQUIRED_GATE_PRODUCTION_FORBIDDEN');
  const [row] = recorded;
  if (recorded.length !== 1 || row.version !== pin.version || row.name !== pin.name || row.hasStatements !== true ||
      row.statementCount !== pin.statementCount || row.statementsSha256 !== pin.statementsSha256) {
    fail('REQUIRED_GATE_LEDGER_MISMATCH');
  }
  return 'requiredGate';
}

// The receipt block an attestation of an evolved FairSwapTest V1 installation must carry (absent in the historical state).
export const idvDigilockerEvolvedVariant = (acr = 'absent') => ({
  state: 'requiredGate',
  ledger: {...ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.ledger},
  enforceVerifiedActorBodyMd5: ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5,
  ...(acr === 'applied' ? {aadhaarAcr: {
    ledger: {...IDV_DIGILOCKER_ACR_LEDGER},
    hasDigilockerBadgeBodyMd5: IDV_DIGILOCKER_ACR_BODIES.after.badge,
    completeV2BodyMd5: IDV_DIGILOCKER_ACR_BODIES.after.complete
  }} : {})
});
const isProduction = environment => environment === 'FairSwapProd';

// Digest of every pre-existing table, policy, function and trigger in public/app_security that the migration must not
// change. New DigiLocker objects and the added trg_identity_gate triggers are excluded; everything else must be identical.
const preservedSql = (tables, functionNames, gateTriggersExcluded = true) => `encode(sha256(convert_to(jsonb_build_object(
  'tables', (SELECT jsonb_agg(jsonb_build_array(n.nspname, c.relname, c.relowner, c.relacl::text, c.relrowsecurity, c.relforcerowsecurity)
      ORDER BY n.nspname, c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','app_security') AND c.relkind IN ('r','p') AND n.nspname || '.' || c.relname <> ALL(${arr(tables)})),
  'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.schemaname, p.tablename, p.policyname)
    FROM pg_policies p WHERE p.schemaname IN ('public','app_security')),
  'functions', (SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text, p.proowner, p.proacl::text, p.prosecdef, p.proconfig, md5(p.prosrc))
      ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_security') AND p.proname <> ALL(${arr(functionNames)})),
  'triggers', (SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text, t.tgname, t.tgenabled, t.tgfoid::regprocedure::text)
      ORDER BY t.tgrelid::regclass::text, t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname IN ('public','app_security') ${gateTriggersExcluded ? "AND t.tgname <> 'trg_identity_gate'" : ''}
      AND n.nspname || '.' || c.relname <> ALL(${arr(tables)}))
)::text, 'UTF8')), 'hex')`;
const PRESERVED = preservedSql(TABLES, FUNCTION_NAMES);

export const snapshotSql = (checks, label, preserved = PRESERVED) => `-- idv-digilocker-${label}
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT jsonb_build_object('checks', jsonb_build_object(${Object.entries(checks).map(([k, sql]) => `'${k}', (${sql})`).join(',\n  ')}),
  'preserved', ${preserved})::text;
COMMIT;`;

function readSnapshot(query, checks, label, preserved = PRESERVED) {
  let value;
  try { value = JSON.parse(String(query(snapshotSql(checks, label, preserved))).trim()); } catch { fail(`${label.toUpperCase().replace(/-/g, '_')}_INVALID`); }
  const keys = Object.keys(value?.checks ?? {});
  if (!/^[a-f0-9]{64}$/.test(value?.preserved ?? '') || keys.length !== Object.keys(checks).length ||
      Object.keys(checks).some(key => value.checks[key] !== true)) {
    fail(`${label.toUpperCase().replace(/-/g, '_')}_FAILED`);
  }
  return {preserved: value.preserved};
}

// Installed-state integrity of an existing V1 installation (FairSwapTest attestation). Same structure, grant, trigger and
// gate checks as the postflight, without the fresh-install-only conditions (empty tables, unchanged-object baseline).
export const IDV_DIGILOCKER_INSTALLED = Object.freeze(Object.fromEntries(Object.entries(IDV_DIGILOCKER_POSTFLIGHT)
  .filter(([key]) => key !== 'tables_empty')));
// The attestation also binds enforce_verified_actor's body to the ledger state (enforceVerifiedActorState), so an installation
// evolved by 20261122100000 is never attested as the historical V1 state, and vice versa.
// acr === 'applied' (FairSwapTest only, proven by the exact 20261123120000 ledger row): the live gate is ON by owner decision, so the
// OFF assertions are replaced by ON assertions and the Aadhaar-assured function bodies and evidence constraint are pinned.
export const idvDigilockerInstalledChecks = (state = 'historical', acr = 'absent') => {
  const base = {...IDV_DIGILOCKER_INSTALLED, enforce_verified_actor_state: enforceBody(state)};
  if (acr !== 'applied') return base;
  const {gate_setting_off: _setting, gate_function_off: _function, ...rest} = base;
  return {...rest, ...ACR_GATE_ON, acr_evidence_constraint: acrConstraint('after'), acr_bodies_exact: acrBodies('after')};
};
export const runIdvDigilockerInstalledCheck = (query, state = 'historical', acr = 'absent') => {
  readSnapshot(query, idvDigilockerInstalledChecks(state, acr), 'installed');
  return {status: 'PASS', scope: IDV_DIGILOCKER_INSTALLED_SCOPE, enforceVerifiedActorState: state};
};

// ---------- OIDC V2 badge provenance (20261119200000) ----------
const BINDINGS = TABLES[1];
export const IDV_DIGILOCKER_V2_FUNCTIONS = Object.freeze({
  serviceOnly: Object.freeze([
    'app_security.has_digilocker_badge(uuid)',
    'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)',
    'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)'
  ]),
  projection: Object.freeze(['public.get_digilocker_badges(uuid[])']),
  // Replaced in place with unchanged signatures and grants.
  replaced: Object.freeze([
    'app_security.impl_idv_dl_start_attempt(uuid,text,integer,text,boolean,text)',
    'app_security.impl_idv_dl_complete(uuid,uuid,text,text,text[])',
    'public.get_my_marketplace_access()'
  ])
});
const V2_NEW = [...IDV_DIGILOCKER_V2_FUNCTIONS.serviceOnly, ...IDV_DIGILOCKER_V2_FUNCTIONS.projection];
const V2_ALL = [...V2_NEW, ...IDV_DIGILOCKER_V2_FUNCTIONS.replaced];
const V2_FUNCTION_NAMES = [...new Set(V2_ALL.map(sig => sig.split('(')[0].split('.')[1]))];
const V2_PRESERVED = preservedSql([BINDINGS], V2_FUNCTION_NAMES, false);
const column = name => `(SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = to_regclass('${BINDINGS}')::oid AND a.attname = '${name}' AND NOT a.attisdropped)`;
const hasColumn = name => `EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('${BINDINGS}')::oid AND a.attname = '${name}' AND NOT a.attisdropped)`;
const anyFn = sigs => `EXISTS (SELECT 1 FROM unnest(${arr(sigs)}) s WHERE to_regprocedure(s) IS NOT NULL)`;

export const IDV_DIGILOCKER_V2_PREFLIGHT = Object.freeze({
  v1_installed: IDV_DIGILOCKER_INSTALLED.functions_exact + ' AND ' + IDV_DIGILOCKER_INSTALLED.tables_rls_forced,
  gate_setting_off: IDV_DIGILOCKER_POSTFLIGHT.gate_setting_off,
  provenance_columns_absent: `NOT ${hasColumn('evidence_method')} AND NOT ${hasColumn('evidence_verified_at')}`,
  v2_functions_absent: `NOT ${anyFn(V2_NEW)}`
});

export const IDV_DIGILOCKER_V2_POSTFLIGHT = Object.freeze({
  provenance_columns: `${column('evidence_method')} IS TRUE AND ${column('evidence_verified_at')} IS FALSE`,
  provenance_constraint: `EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('${BINDINGS}')::oid
    AND conname = 'chk_idv_dl_evidence_method' AND contype = 'c' AND convalidated)`,
  provenance_consistent: `NOT EXISTS (SELECT 1 FROM app_security.idv_digilocker_bindings
    WHERE evidence_method = 'oidc_v2_signed_id_token' AND evidence_verified_at IS NULL)`,
  functions_exact: allFns(V2_ALL, `p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]`),
  service_only_execute: execBy('service_role', true, IDV_DIGILOCKER_V2_FUNCTIONS.serviceOnly) + ' AND ' +
    ['public', 'anon', 'authenticated'].map(role => execBy(role, false, IDV_DIGILOCKER_V2_FUNCTIONS.serviceOnly)).join(' AND '),
  projection_execute: ['anon', 'authenticated', 'service_role'].map(role => execBy(role, true, IDV_DIGILOCKER_V2_FUNCTIONS.projection)).join(' AND ') +
    ' AND ' + execBy('public', false, IDV_DIGILOCKER_V2_FUNCTIONS.projection),
  v1_grants_unchanged: IDV_DIGILOCKER_INSTALLED.service_only_execute + ' AND ' + IDV_DIGILOCKER_INSTALLED.authenticated_execute,
  tables_no_client_privileges: IDV_DIGILOCKER_POSTFLIGHT.tables_no_client_privileges,
  bindings_no_direct_dml: IDV_DIGILOCKER_POSTFLIGHT.bindings_no_direct_dml,
  gate_setting_off: IDV_DIGILOCKER_POSTFLIGHT.gate_setting_off,
  gate_function_off: IDV_DIGILOCKER_POSTFLIGHT.gate_function_off
});

export const runIdvDigilockerV2Preflight = query => readSnapshot(query, IDV_DIGILOCKER_V2_PREFLIGHT, 'v2-preflight', V2_PRESERVED);
export function runIdvDigilockerV2Postflight(before, query) {
  if (!before?.preserved) fail('BASELINE_REQUIRED');
  const after = readSnapshot(query, IDV_DIGILOCKER_V2_POSTFLIGHT, 'v2-postflight', V2_PRESERVED);
  if (after.preserved !== before.preserved) fail('EXISTING_OBJECTS_CHANGED');
  return {status: 'PASS', scope: IDV_DIGILOCKER_V2_SCOPE};
}
export const idvDigilockerV2SnapshotSql = (checks, label) => snapshotSql(checks, label, V2_PRESERVED);

export const runIdvDigilockerPreflight = (query, environment) =>
  readSnapshot(query, isProduction(environment) ? IDV_DIGILOCKER_PRODUCTION_PREFLIGHT : IDV_DIGILOCKER_PREFLIGHT, 'preflight');

export function runIdvDigilockerPostflight(before, query, environment) {
  if (!before?.preserved) fail('BASELINE_REQUIRED');
  const after = readSnapshot(query, isProduction(environment) ? IDV_DIGILOCKER_PRODUCTION_POSTFLIGHT : IDV_DIGILOCKER_POSTFLIGHT, 'postflight');
  if (after.preserved !== before.preserved) fail('EXISTING_OBJECTS_CHANGED');
  return {status: 'PASS', scope: IDV_DIGILOCKER_SCOPE};
}

// Receipt block shared by the writer and the Test-receipt validator.
export const idvDigilockerReceiptFields = environment => ({
  prerequisiteLedger: {...IDV_FOUNDATION_LEDGER[environment]},
  identityVerificationRequired: false,
  edgeFunctionsDeployedByThisWorkflow: false
});

const RECEIPT_CONTEXT_OK = context => /^[a-f0-9]{40}$/.test(context.GITHUB_SHA ?? '') && /^[1-9]\d*$/.test(context.GITHUB_RUN_ID ?? '') &&
  /^[1-9]\d*$/.test(context.GITHUB_RUN_ATTEMPT ?? '');
// gateRequired: the expected identity_verification_required state recorded by the receipt (false for every release before the
// Aadhaar ACR evidence; true only for FairSwapTest receipts of the ACR candidate / an ACR-state attestation).
const receiptCommon = (receipt, c, context, gateRequired = false) => RECEIPT_CONTEXT_OK(context) &&
  receipt?.environment === 'FairSwapTest' && receipt.projectRef === PROJECT_REFS.FairSwapTest &&
  receipt.candidateId === c.id && receipt.migrationVersion === c.version && receipt.migrationFile === c.filename &&
  receipt.migrationSha256 === c.sha256 && receipt.reviewedCommit === context.GITHUB_SHA &&
  receipt.releaseWorkflowRun === context.GITHUB_RUN_ID && receipt.releaseWorkflowAttempt === context.GITHUB_RUN_ATTEMPT &&
  receipt.postflightVerified === true && Array.isArray(receipt.dryRunPending) &&
  receipt.identityVerificationRequired === gateRequired && receipt.edgeFunctionsDeployedByThisWorkflow === false &&
  /^[a-f0-9]{64}$/.test(receipt.ledgerStatementsSha256 ?? '');

// Validates the FairSwapTest receipt of either IDV candidate and returns the ledger digest Production must reproduce.
// V1: a fresh out-of-order apply (historical shape) or the read-only attestation of the existing Test installation.
// V2: an ordinary in-order apply with the V2 postflight.
export function verifyIdvDigilockerTestReceipt(receipt, context) {
  const candidateId = receipt?.candidateId;
  if (!isIdvDigilockerCandidate(candidateId) || (context.CANDIDATE && context.CANDIDATE !== candidateId)) fail('TEST_RECEIPT_INVALID');
  const c = getCandidate(candidateId);
  const prerequisite = IDV_FOUNDATION_LEDGER.FairSwapTest;
  const acrVariant = candidateId === IDV_DIGILOCKER_CANDIDATE && receipt.status === 'ALREADY_INSTALLED_VERIFIED' &&
    receipt.installedStateVariant?.aadhaarAcr !== undefined;
  if (!receiptCommon(receipt, c, context, acrVariant) ||
      receipt.prerequisiteLedger?.version !== prerequisite.version || receipt.prerequisiteLedger?.name !== prerequisite.name) {
    fail('TEST_RECEIPT_INVALID');
  }
  if (candidateId === IDV_DIGILOCKER_V2_CANDIDATE) {
    if (receipt.status !== 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' || receipt.postflightScope !== IDV_DIGILOCKER_V2_SCOPE ||
        receipt.dryRunPending.length !== 1 || receipt.dryRunPending[0] !== c.filename || receipt.outOfOrderInstall !== undefined) {
      fail('TEST_RECEIPT_INVALID');
    }
    return receipt.ledgerStatementsSha256;
  }
  if (receipt.status === 'ALREADY_INSTALLED_VERIFIED') {
    if (receipt.postflightScope !== IDV_DIGILOCKER_INSTALLED_SCOPE || receipt.dryRunPending.length !== 0 ||
        receipt.outOfOrderInstall !== undefined || receipt.installedBeforeThisWorkflow !== true ||
        // Historical state: no variant. Evolved state: exactly the ledger-bound required-gate variant.
        (receipt.installedStateVariant !== undefined &&
          JSON.stringify(receipt.installedStateVariant) !== JSON.stringify(idvDigilockerEvolvedVariant(acrVariant ? 'applied' : 'absent')))) {
      fail('TEST_RECEIPT_INVALID');
    }
    return receipt.ledgerStatementsSha256;
  }
  const expectedTail = IDV_DIGILOCKER_TAIL.map(pin => getCandidate(pin.candidateId).version);
  if (receipt.status !== 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' || receipt.postflightScope !== IDV_DIGILOCKER_SCOPE ||
      receipt.dryRunPending.length !== 1 || receipt.dryRunPending[0] !== c.filename ||
      receipt.outOfOrderInstall?.includeAll !== true ||
      JSON.stringify(receipt.outOfOrderInstall.aheadVersions) !== JSON.stringify(expectedTail)) {
    fail('TEST_RECEIPT_INVALID');
  }
  return receipt.ledgerStatementsSha256;
}

// ---------- Mandatory-gate predicate (20261122100000): FairSwapTest ONLY, never promoted ----------
// Replaces only enforce_verified_actor (is_identity_verified -> has_digilocker_badge). identity_verification_required must
// be 'false' before and after: this release never activates the gate. Production can never reach this code path.
export const IDV_DIGILOCKER_REQUIRED_CANDIDATE = 'idv-digilocker-required-gate';
export const IDV_DIGILOCKER_REQUIRED_SCOPE = 'idv-digilocker-required-gate-integrity';
// FairSwapTest prerequisite rows. V1 predates the pipeline in FairSwapTest, so only its version and name are bound; V2 was
// applied by the reusable workflow, so its CLI statement count and digest (CLI split of the SHA-pinned source) are bound too.
export const IDV_DIGILOCKER_REQUIRED_PREREQUISITES = Object.freeze([
  Object.freeze({candidateId: IDV_DIGILOCKER_CANDIDATE, version: '20261117090000', name: 'idv_digilocker_direct_v1'}),
  Object.freeze({candidateId: IDV_DIGILOCKER_V2_CANDIDATE, version: '20261119200000', name: 'idv_digilocker_oidc_v2_badge',
    statementCount: 23, statementsSha256: '64533b75929c2de07213cca92501591e073a0b2b7341de3bae039feae882e465'})
]);

// Runs on readTabletsLedger rows before any dry run.
export function assertIdvDigilockerRequiredLedger(environment, rows) {
  if (environment !== 'FairSwapTest' || !Array.isArray(rows)) fail('REQUIRED_GATE_TEST_ONLY');
  const own = IDV_FOUNDATION_LEDGER.FairSwapTest;
  const foundation = rows.filter(row => row.name === own.name);
  if (foundation.length !== 1 || foundation[0].version !== own.version || foundation[0].hasStatements !== true) {
    fail('FOUNDATION_PREREQUISITE_MISMATCH');
  }
  if (rows.some(row => row.version === IDV_FOUNDATION_SOURCE_VERSION)) fail('FOUNDATION_HISTORY_MISMATCH');
  for (const pin of IDV_DIGILOCKER_REQUIRED_PREREQUISITES) {
    const found = rows.filter(row => row.version === pin.version || row.name === pin.name);
    if (found.length !== 1 || found[0].version !== pin.version || found[0].name !== pin.name || found[0].hasStatements !== true ||
        !(found[0].statementCount > 0) ||
        (pin.statementsSha256 !== undefined && (found[0].statementCount !== pin.statementCount || found[0].statementsSha256 !== pin.statementsSha256))) {
      fail('REQUIRED_GATE_PREREQUISITE_LEDGER_MISMATCH');
    }
  }
  if (enforceVerifiedActorState(environment, rows) !== 'historical') fail('REQUIRED_GATE_ALREADY_RECORDED');
  return {includeAll: false, ahead: []};
}

const enforceServerOnly = execBy('service_role', true, [ENFORCE_SIG]) + ' AND ' +
  ['public', 'anon', 'authenticated'].map(role => execBy(role, false, [ENFORCE_SIG])).join(' AND ');
// Same checks before and after; only the expected enforce_verified_actor state differs.
const requiredChecks = state => Object.freeze({
  v1_structure: [IDV_DIGILOCKER_INSTALLED.functions_exact, IDV_DIGILOCKER_INSTALLED.tables_rls_forced,
    IDV_DIGILOCKER_INSTALLED.gate_triggers, IDV_DIGILOCKER_INSTALLED.binding_triggers].join(' AND '),
  ...IDV_DIGILOCKER_V2_POSTFLIGHT,
  enforce_state_exact: enforceBody(state),
  enforce_single_overload: `(SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_security') AND p.proname = 'enforce_verified_actor')`,
  enforce_server_only: enforceServerOnly
});
export const IDV_DIGILOCKER_REQUIRED_PREFLIGHT = requiredChecks('historical');
export const IDV_DIGILOCKER_REQUIRED_POSTFLIGHT = requiredChecks('requiredGate');
// Every other public/app_security table, policy, function (owner, ACL, attributes, body) and trigger must be unchanged.
const REQUIRED_PRESERVED = preservedSql([], ['enforce_verified_actor'], false);
export const idvDigilockerRequiredSnapshotSql = (checks, label) => snapshotSql(checks, label, REQUIRED_PRESERVED);

export const runIdvDigilockerRequiredPreflight = query =>
  readSnapshot(query, IDV_DIGILOCKER_REQUIRED_PREFLIGHT, 'required-preflight', REQUIRED_PRESERVED);
export function runIdvDigilockerRequiredPostflight(before, query) {
  if (!before?.preserved) fail('BASELINE_REQUIRED');
  const after = readSnapshot(query, IDV_DIGILOCKER_REQUIRED_POSTFLIGHT, 'required-postflight', REQUIRED_PRESERVED);
  if (after.preserved !== before.preserved) fail('EXISTING_OBJECTS_CHANGED');
  return {status: 'PASS', scope: IDV_DIGILOCKER_REQUIRED_SCOPE};
}

// Receipt block shared by the writer and the Test-receipt validator.
export const idvDigilockerRequiredReceiptFields = () => ({
  testOnly: true,
  autoPromote: false,
  requiredLedger: IDV_DIGILOCKER_REQUIRED_PREREQUISITES.map(({version, name}) => ({version, name})),
  enforceVerifiedActorTransition: {
    from: {state: 'historical', bodyMd5: ENFORCE_VERIFIED_ACTOR_STATES.historical.bodyMd5},
    to: {state: 'requiredGate', bodyMd5: ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.bodyMd5}
  }
});

// Validates the FairSwapTest receipt of the required-gate release. It is never Production evidence: the workflow does not
// promote this candidate, and the receipt carries testOnly/autoPromote so it cannot be mistaken for promotion input.
export function verifyIdvDigilockerRequiredTestReceipt(receipt, context) {
  const c = getCandidate(IDV_DIGILOCKER_REQUIRED_CANDIDATE);
  const expected = idvDigilockerRequiredReceiptFields();
  const prerequisite = IDV_FOUNDATION_LEDGER.FairSwapTest;
  if ((context.CANDIDATE && context.CANDIDATE !== c.id) || !receiptCommon(receipt, c, context) ||
      receipt.prerequisiteLedger?.version !== prerequisite.version || receipt.prerequisiteLedger?.name !== prerequisite.name ||
      receipt.status !== 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' || receipt.postflightScope !== IDV_DIGILOCKER_REQUIRED_SCOPE ||
      receipt.dryRunPending.length !== 1 || receipt.dryRunPending[0] !== c.filename || receipt.outOfOrderInstall !== undefined ||
      receipt.ledgerStatementsSha256 !== ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.ledger.statementsSha256 ||
      receipt.testLedgerStatementsSha256 !== undefined ||
      Object.keys(expected).some(key => JSON.stringify(receipt[key]) !== JSON.stringify(expected[key]))) {
    fail('REQUIRED_TEST_RECEIPT_INVALID');
  }
  return receipt.ledgerStatementsSha256;
}

// ---------- Aadhaar ACR evidence (20261123120000): FairSwapTest ONLY, never promoted ----------
// Replaces exactly two function bodies (has_digilocker_badge, impl_idv_dl_complete_v2) and widens the evidence CHECK constraint.
// FairSwapTest already runs with identity_verification_required = 'true' (owner decision): this release requires 'true' before
// AND after, never writes the setting, and rejects a 'false'/missing/duplicated switch at preflight. Production can never reach it.
export const IDV_DIGILOCKER_ACR_CANDIDATE = 'idv-digilocker-aadhaar-acr';
export const IDV_DIGILOCKER_ACR_SCOPE = 'idv-digilocker-aadhaar-acr-integrity';
// CLI split of the SHA-pinned source (statement count and digest recorded in the hosted ledger).
export const IDV_DIGILOCKER_ACR_LEDGER = Object.freeze({
  version: '20261123120000', name: 'idv_digilocker_aadhaar_acr', statementCount: 15,
  statementsSha256: '76fd817535682397f1a6f8446663d872ba1f5fe4af114996b23dbcc54f35ed3b'
});
// md5(prosrc) before (20261119200000) and after (20261123120000); the public wrapper is unchanged.
export const IDV_DIGILOCKER_ACR_BODIES = Object.freeze({
  before: Object.freeze({badge: '7c3f9bd29fdfdfa4ae2943a557712485', complete: 'b82c810a399c11e91d11a2c8fa35ee86'}),
  after: Object.freeze({badge: 'd7dfd9d48588b6903fc6c2a1fa6ecf09', complete: '271fe8f3895ba6c9b3ddd35ef8072811'}),
  wrapper: '22d1c47edd7f8383f7f17adc53f47964'
});
const ACR_BADGE = 'app_security.has_digilocker_badge(uuid)';
const ACR_COMPLETE = 'app_security.impl_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)';
const ACR_WRAPPER = 'public.server_idv_dl_complete_v2(uuid,uuid,text,text,text[],text)';
const ACR_FUNCTION_NAMES = ['has_digilocker_badge', 'impl_idv_dl_complete_v2', 'server_idv_dl_complete_v2'];
const ACR_EVIDENCE = 'oidc_v2_signed_aadhaar_acr';

// Owner, language, SECURITY DEFINER, volatility, return type, empty search_path and body digest of the three functions, with
// exactly one overload of each name.
const acrBodies = state => allOf([
  v3Function([ACR_BADGE, 'sql', true, 's', 'boolean', IDV_DIGILOCKER_ACR_BODIES[state].badge]),
  v3Function([ACR_COMPLETE, 'plpgsql', true, 'v', 'jsonb', IDV_DIGILOCKER_ACR_BODIES[state].complete]),
  v3Function([ACR_WRAPPER, 'sql', true, 'v', 'jsonb', IDV_DIGILOCKER_ACR_BODIES.wrapper]),
  `(SELECT count(*) = ${ACR_FUNCTION_NAMES.length} FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_security') AND p.proname = ANY(${arr(ACR_FUNCTION_NAMES)}))`
]);
// before: the Aadhaar label is not yet allowed; after: allowed next to both historical labels. Always present and validated.
const acrConstraint = state => `EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('${BINDINGS}')::oid
  AND c.conname = 'chk_idv_dl_evidence_method' AND c.contype = 'c' AND c.convalidated
  AND position('legacy_account_link' in pg_get_constraintdef(c.oid)) > 0
  AND position('oidc_v2_signed_id_token' in pg_get_constraintdef(c.oid)) > 0
  AND (position('${ACR_EVIDENCE}' in pg_get_constraintdef(c.oid)) > 0) = ${state === 'after'})`;
// Live FairSwapTest gate is ON. Both the stored switch and the function that reads it must say so, exactly one switch row.
const ACR_GATE_ON = Object.freeze({
  gate_setting_on: `(SELECT count(*) = 1 AND bool_and(setting_value = 'true') FROM public.app_system_settings
    WHERE setting_key = 'identity_verification_required')`,
  gate_function_on: `app_security.identity_gate_enabled() IS TRUE`
});

// Strict ledger state of the ACR migration: absent, or applied as exactly the pinned row (FairSwapTest only, and only on top of
// the exact required-gate row). Anything partial or in Production fails closed.
export function idvAcrLedgerState(environment, rows) {
  if (!IDV_FOUNDATION_LEDGER[environment] || !Array.isArray(rows)) fail('ACR_STATE_ENVIRONMENT_INVALID');
  const pin = IDV_DIGILOCKER_ACR_LEDGER;
  const recorded = rows.filter(row => row.version === pin.version || row.name === pin.name);
  if (recorded.length === 0) return 'absent';
  if (environment !== 'FairSwapTest') fail('ACR_PRODUCTION_FORBIDDEN');
  const [row] = recorded;
  if (recorded.length !== 1 || row.version !== pin.version || row.name !== pin.name || row.hasStatements !== true ||
      row.statementCount !== pin.statementCount || row.statementsSha256 !== pin.statementsSha256 ||
      enforceVerifiedActorState(environment, rows) !== 'requiredGate') {
    fail('ACR_LEDGER_MISMATCH');
  }
  return 'applied';
}

// Runs on readTabletsLedger rows before any dry run. Historical V1, V2 and required-gate receipts must all be present as pinned.
export function assertIdvDigilockerAcrLedger(environment, rows) {
  if (environment !== 'FairSwapTest' || !Array.isArray(rows)) fail('ACR_TEST_ONLY');
  const own = IDV_FOUNDATION_LEDGER.FairSwapTest;
  const foundation = rows.filter(row => row.name === own.name);
  if (foundation.length !== 1 || foundation[0].version !== own.version || foundation[0].hasStatements !== true) {
    fail('FOUNDATION_PREREQUISITE_MISMATCH');
  }
  if (rows.some(row => row.version === IDV_FOUNDATION_SOURCE_VERSION)) fail('FOUNDATION_HISTORY_MISMATCH');
  const gatePin = ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.ledger;
  for (const pin of [...IDV_DIGILOCKER_REQUIRED_PREREQUISITES, {...gatePin, statementsSha256: gatePin.statementsSha256}]) {
    const found = rows.filter(row => row.version === pin.version || row.name === pin.name);
    if (found.length !== 1 || found[0].version !== pin.version || found[0].name !== pin.name || found[0].hasStatements !== true ||
        !(found[0].statementCount > 0) ||
        (pin.statementsSha256 !== undefined && (found[0].statementCount !== pin.statementCount || found[0].statementsSha256 !== pin.statementsSha256))) {
      fail('ACR_PREREQUISITE_LEDGER_MISMATCH');
    }
  }
  if (idvAcrLedgerState(environment, rows) !== 'absent') fail('ACR_ALREADY_RECORDED');
  return {includeAll: false, ahead: []};
}

const {gate_setting_off: _acrSettingOff, gate_function_off: _acrFunctionOff, ...ACR_V2_STRUCTURE} = IDV_DIGILOCKER_V2_POSTFLIGHT;
const acrChecks = state => Object.freeze({
  v1_structure: [IDV_DIGILOCKER_INSTALLED.functions_exact, IDV_DIGILOCKER_INSTALLED.tables_rls_forced,
    IDV_DIGILOCKER_INSTALLED.gate_triggers, IDV_DIGILOCKER_INSTALLED.binding_triggers].join(' AND '),
  ...ACR_V2_STRUCTURE,
  // enforce_verified_actor stays exactly the required-gate body in both states (this release never touches it).
  enforce_state_exact: enforceBody('requiredGate'),
  enforce_single_overload: `(SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_security') AND p.proname = 'enforce_verified_actor')`,
  enforce_server_only: enforceServerOnly,
  ...ACR_GATE_ON,
  acr_evidence_constraint: acrConstraint(state),
  acr_bodies_exact: acrBodies(state)
});
export const IDV_DIGILOCKER_ACR_PREFLIGHT = acrChecks('before');
export const IDV_DIGILOCKER_ACR_POSTFLIGHT = acrChecks('after');
// Every other table, policy, function (owner, ACL, attributes, body) and trigger in public/app_security must be unchanged.
const ACR_PRESERVED = preservedSql([], ACR_FUNCTION_NAMES.filter(name => name !== 'server_idv_dl_complete_v2'), false);
export const idvDigilockerAcrSnapshotSql = (checks, label) => snapshotSql(checks, label, ACR_PRESERVED);

export const runIdvDigilockerAcrPreflight = query =>
  readSnapshot(query, IDV_DIGILOCKER_ACR_PREFLIGHT, 'acr-preflight', ACR_PRESERVED);
export function runIdvDigilockerAcrPostflight(before, query) {
  if (!before?.preserved) fail('BASELINE_REQUIRED');
  const after = readSnapshot(query, IDV_DIGILOCKER_ACR_POSTFLIGHT, 'acr-postflight', ACR_PRESERVED);
  if (after.preserved !== before.preserved) fail('EXISTING_OBJECTS_CHANGED');
  return {status: 'PASS', scope: IDV_DIGILOCKER_ACR_SCOPE};
}

// Receipt block shared by the writer and the Test-receipt validator. identityVerificationRequired is TRUE: the live Test gate.
export const idvDigilockerAcrReceiptFields = () => ({
  testOnly: true,
  autoPromote: false,
  identityVerificationRequired: true,
  requiredLedger: [...IDV_DIGILOCKER_REQUIRED_PREREQUISITES.map(({version, name}) => ({version, name})),
    {version: ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.ledger.version, name: ENFORCE_VERIFIED_ACTOR_STATES.requiredGate.ledger.name}],
  bodyTransition: {
    hasDigilockerBadge: {from: IDV_DIGILOCKER_ACR_BODIES.before.badge, to: IDV_DIGILOCKER_ACR_BODIES.after.badge},
    completeV2: {from: IDV_DIGILOCKER_ACR_BODIES.before.complete, to: IDV_DIGILOCKER_ACR_BODIES.after.complete}
  }
});

// Validates the FairSwapTest receipt of the ACR release. Never Production evidence: testOnly/autoPromote are carried explicitly.
export function verifyIdvDigilockerAcrTestReceipt(receipt, context) {
  const c = getCandidate(IDV_DIGILOCKER_ACR_CANDIDATE);
  const expected = idvDigilockerAcrReceiptFields();
  const prerequisite = IDV_FOUNDATION_LEDGER.FairSwapTest;
  if ((context.CANDIDATE && context.CANDIDATE !== c.id) || !receiptCommon(receipt, c, context, true) ||
      receipt.prerequisiteLedger?.version !== prerequisite.version || receipt.prerequisiteLedger?.name !== prerequisite.name ||
      receipt.status !== 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' || receipt.postflightScope !== IDV_DIGILOCKER_ACR_SCOPE ||
      receipt.dryRunPending.length !== 1 || receipt.dryRunPending[0] !== c.filename || receipt.outOfOrderInstall !== undefined ||
      receipt.ledgerStatementsSha256 !== IDV_DIGILOCKER_ACR_LEDGER.statementsSha256 ||
      receipt.testLedgerStatementsSha256 !== undefined ||
      Object.keys(expected).some(key => JSON.stringify(receipt[key]) !== JSON.stringify(expected[key]))) {
    fail('ACR_TEST_RECEIPT_INVALID');
  }
  return receipt.ledgerStatementsSha256;
}
