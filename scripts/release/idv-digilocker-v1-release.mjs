// IDV DigiLocker V1 (dark) release guards for the reusable Supabase workflow. All SQL here is read-only.
// Receipts carry only versions, names, digests and booleans: no user, binding, attempt or settings row contents.
import {getCandidate, PROJECT_REFS} from './reusable-candidates.mjs';

export const IDV_DIGILOCKER_CANDIDATE = 'idv-digilocker-v1';
export const IDV_DIGILOCKER_SCOPE = 'idv-digilocker-v1-dark-integrity';
const fail = code => { throw new Error(`REUSABLE_RELEASE_IDV_DIGILOCKER_${code}`); };

// The foundation was applied with project-scoped apply_migration, so each environment recorded its own hosted
// version under one name. It is never replayed, renamed or repaired to the source-file version (20261026183000).
export const IDV_FOUNDATION_LEDGER = Object.freeze({
  FairSwapTest: Object.freeze({version: '20261028091220', name: 'idv_digilocker_foundation_v1'}),
  FairSwapProd: Object.freeze({version: '20261028095605', name: 'idv_digilocker_foundation_v1'})
});
export const IDV_FOUNDATION_SOURCE_VERSION = '20261026183000';

// Both environments already record the Taxonomy V2 pair, which sorts after 20261117090000. The CLI inserts the older
// candidate only with --include-all; that is admitted only when the newer tail is exactly these reviewed rows
// (version, name, statement count and digest of the CLI-split reviewed source, as stored by the reusable workflow).
export const IDV_DIGILOCKER_TAIL = Object.freeze([
  Object.freeze({candidateId: 'taxonomy-v2-foundation', statementCount: 47,
    statementsSha256: '9f20f113121f922e89b5a186f0d30101c4d1c50b44bac00c3dfc0420c02369eb'}),
  Object.freeze({candidateId: 'taxonomy-v2-catalogue', statementCount: 16,
    statementsSha256: 'f9233abf20753db40bf206adf2d386c216c64ba9a665086174a0aaa863c8d741'})
]);

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
  if (!own || !Array.isArray(rows)) fail('ENVIRONMENT_INVALID');
  const foundation = rows.filter(row => row.name === own.name);
  if (foundation.length !== 1 || foundation[0].version !== own.version || foundation[0].hasStatements !== true) {
    fail('FOUNDATION_PREREQUISITE_MISMATCH');
  }
  if (rows.some(row => row.version === IDV_FOUNDATION_SOURCE_VERSION)) fail('FOUNDATION_HISTORY_MISMATCH');
  if (rows.some(row => row.version === candidate.version || row.name === ledgerName(candidate))) fail('ALREADY_RECORDED');
  const ahead = rows.filter(row => row.version > candidate.version);
  if (ahead.length !== IDV_DIGILOCKER_TAIL.length || !IDV_DIGILOCKER_TAIL.every((pin, i) => matchesTail(ahead[i], pin))) {
    fail('LEDGER_TAIL_MISMATCH');
  }
  return {includeAll: true, ahead: ahead.map(row => row.version)};
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

// Digest of every pre-existing table, policy, function and trigger in public/app_security that the migration must not
// change. New DigiLocker objects and the added trg_identity_gate triggers are excluded; everything else must be identical.
const PRESERVED = `encode(sha256(convert_to(jsonb_build_object(
  'tables', (SELECT jsonb_agg(jsonb_build_array(n.nspname, c.relname, c.relowner, c.relacl::text, c.relrowsecurity, c.relforcerowsecurity)
      ORDER BY n.nspname, c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','app_security') AND c.relkind IN ('r','p') AND n.nspname || '.' || c.relname <> ALL(${arr(TABLES)})),
  'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.schemaname, p.tablename, p.policyname)
    FROM pg_policies p WHERE p.schemaname IN ('public','app_security')),
  'functions', (SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text, p.proowner, p.proacl::text, p.prosecdef, p.proconfig, md5(p.prosrc))
      ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_security') AND p.proname <> ALL(${arr(FUNCTION_NAMES)})),
  'triggers', (SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text, t.tgname, t.tgenabled, t.tgfoid::regprocedure::text)
      ORDER BY t.tgrelid::regclass::text, t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname IN ('public','app_security') AND t.tgname <> 'trg_identity_gate'
      AND n.nspname || '.' || c.relname <> ALL(${arr(TABLES)}))
)::text, 'UTF8')), 'hex')`;

export const snapshotSql = (checks, label) => `-- idv-digilocker-${label}
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT jsonb_build_object('checks', jsonb_build_object(${Object.entries(checks).map(([k, sql]) => `'${k}', (${sql})`).join(',\n  ')}),
  'preserved', ${PRESERVED})::text;
COMMIT;`;

function readSnapshot(query, checks, label) {
  let value;
  try { value = JSON.parse(String(query(snapshotSql(checks, label))).trim()); } catch { fail(`${label.toUpperCase()}_INVALID`); }
  const keys = Object.keys(value?.checks ?? {});
  if (!/^[a-f0-9]{64}$/.test(value?.preserved ?? '') || keys.length !== Object.keys(checks).length ||
      Object.keys(checks).some(key => value.checks[key] !== true)) {
    fail(`${label.toUpperCase()}_FAILED`);
  }
  return {preserved: value.preserved};
}

export const runIdvDigilockerPreflight = query => readSnapshot(query, IDV_DIGILOCKER_PREFLIGHT, 'preflight');

export function runIdvDigilockerPostflight(before, query) {
  if (!before?.preserved) fail('BASELINE_REQUIRED');
  const after = readSnapshot(query, IDV_DIGILOCKER_POSTFLIGHT, 'postflight');
  if (after.preserved !== before.preserved) fail('EXISTING_OBJECTS_CHANGED');
  return {status: 'PASS', scope: IDV_DIGILOCKER_SCOPE};
}

// Receipt block shared by the writer and the Test-receipt validator.
export const idvDigilockerReceiptFields = environment => ({
  prerequisiteLedger: {...IDV_FOUNDATION_LEDGER[environment]},
  identityVerificationRequired: false,
  edgeFunctionsDeployedByThisWorkflow: false
});

export function verifyIdvDigilockerTestReceipt(receipt, context) {
  const c = getCandidate(IDV_DIGILOCKER_CANDIDATE);
  const expectedTail = IDV_DIGILOCKER_TAIL.map(pin => getCandidate(pin.candidateId).version);
  const prerequisite = IDV_FOUNDATION_LEDGER.FairSwapTest;
  if (!/^[a-f0-9]{40}$/.test(context.GITHUB_SHA ?? '') || !/^[1-9]\d*$/.test(context.GITHUB_RUN_ID ?? '') ||
      !/^[1-9]\d*$/.test(context.GITHUB_RUN_ATTEMPT ?? '') ||
      receipt?.environment !== 'FairSwapTest' || receipt.projectRef !== PROJECT_REFS.FairSwapTest ||
      receipt.candidateId !== c.id || receipt.migrationVersion !== c.version || receipt.migrationFile !== c.filename ||
      receipt.migrationSha256 !== c.sha256 || receipt.reviewedCommit !== context.GITHUB_SHA ||
      receipt.releaseWorkflowRun !== context.GITHUB_RUN_ID || receipt.releaseWorkflowAttempt !== context.GITHUB_RUN_ATTEMPT ||
      receipt.status !== 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED' || receipt.postflightVerified !== true ||
      receipt.postflightScope !== IDV_DIGILOCKER_SCOPE || !Array.isArray(receipt.dryRunPending) ||
      receipt.dryRunPending.length !== 1 || receipt.dryRunPending[0] !== c.filename ||
      receipt.outOfOrderInstall?.includeAll !== true ||
      JSON.stringify(receipt.outOfOrderInstall.aheadVersions) !== JSON.stringify(expectedTail) ||
      receipt.prerequisiteLedger?.version !== prerequisite.version || receipt.prerequisiteLedger?.name !== prerequisite.name ||
      receipt.identityVerificationRequired !== false || receipt.edgeFunctionsDeployedByThisWorkflow !== false ||
      !/^[a-f0-9]{64}$/.test(receipt.ledgerStatementsSha256 ?? '')) {
    fail('TEST_RECEIPT_INVALID');
  }
  return receipt.ledgerStatementsSha256;
}
