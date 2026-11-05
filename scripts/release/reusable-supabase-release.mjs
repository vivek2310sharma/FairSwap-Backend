// Reusable Supabase CLI release and postflight verification script.
// Does not deploy automatically unless executed in deployment phase.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, chmodSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateRootCertificate} from './fsw-sec-003-prelaunch.mjs';
import {CANDIDATES, adoptionAttestation, getAdoption, getCandidate, planDispatch, verifyCandidateSha, PROJECT_REFS} from './reusable-candidates.mjs';
import {
  assertLedgerOrdering, assertStageInputs, requireStageEvidence, postflightQuery, runAccessoriesPostflight, runLivePreflight, verifyHistoryPreserved, verifyAccessoriesLedger
} from './accessories-v1-release.mjs';

import {runTabletsV2Preflight, runTabletsV2Postflight, verifyTabletsV2Web} from './tablets-v2-release.mjs';
import {readTabletsLedger, runTabletsPostflight, runTabletsPreflight, verifyTabletsLedger} from './tablets-v1-release.mjs';
import {ADOPTED_STATUS, assertCliSupportsIncludeAll, assertLedgerTail, assertMobilePhonesProvenance, assertSwitchingPrerequisite, runWearablesPostflight, runWearablesPreflight} from './wearables-v1-release.mjs';

export const REFS = PROJECT_REFS;

const root = fileURLToPath(new URL('../../', import.meta.url));

function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function subprocessFailure(result, phase) {
  const raw = String(result.stderr ?? '');
  const state = raw.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5})\b/)?.[1];
  const states = {
    '42601': 'SQL_SYNTAX',
    '42703': 'SQL_COLUMN',
    '42883': 'SQL_FUNCTION',
    '42P01': 'SQL_RELATION',
    '42501': 'SQL_PERMISSION',
    '25006': 'READ_ONLY',
    '57014': 'TIMEOUT',
    '28P01': 'AUTHENTICATION',
    '28000': 'AUTHENTICATION'
  };
  const kind = states[state] ?? (
    /certificate|SSL|TLS/i.test(raw) ? 'TLS' :
    /could not translate host|Name or service not known/i.test(raw) ? 'DNS' :
    /connection.*(?:failed|refused|timed out)/i.test(raw) ? 'CONNECTION' :
    result.error?.code === 'ENOENT' ? 'TOOL_MISSING' :
    result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'EXIT'
  );
  return new Error(`REUSABLE_SUBPROCESS_${phase.toUpperCase()}_${kind}_FAILED`);
}

export function parsePendingDryRun(dryRunCombinedOutput, expectedFilename) {
  // Capture all potential migration filename tokens from stdout and stderr combined
  const pending = [...new Set(dryRunCombinedOutput.match(/\b\d{14}_[A-Za-z0-9_-]+\.sql\b/g) ?? [])];
  if (pending.length !== 1 || pending[0] !== expectedFilename) {
    throw new Error(`REUSABLE_RELEASE_DRY_RUN_MISMATCH: expected exactly [${expectedFilename}], found [${pending.join(', ')}]`);
  }
  return pending;
}

function unwrapBackticks(str) {
  if (str.startsWith('`') && str.endsWith('`') && str.length >= 2) {
    // Balanced backticks only
    return str.slice(1, -1);
  }
  return str;
}

export function verifyLedgerVersion(ledgerOutput, expectedVersion) {
  // Require a recognized Supabase CLI table header: LOCAL | REMOTE | TIME (UTC)
  // Accepts optional balanced backticks on header tokens or cell tokens
  const lines = ledgerOutput.split('\n');
  const headerIdx = lines.findIndex(line => {
    const parts = line.split('|').map(s => unwrapBackticks(s.trim()).toUpperCase());
    return parts.length >= 3 && parts[0] === 'LOCAL' && parts[1] === 'REMOTE' && parts[2].startsWith('TIME');
  });

  if (headerIdx === -1) {
    throw new Error('REUSABLE_RELEASE_LEDGER_HEADER_MISSING: expected LOCAL | REMOTE | TIME (UTC) table');
  }

  // Scan rows following the header and divider
  let candidateMatches = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('---') || rawLine.startsWith('===') || rawLine.startsWith('Connecting')) {
      continue;
    }
    const cols = rawLine.split('|').map(s => s.trim());
    if (cols.length < 3) {
      continue;
    }
    const rawLocal = cols[0];
    const rawRemote = cols[1];

    // Check for unbalanced backticks (e.g. `20261102000000 or 20261102000000`)
    const localHasUnbalanced = (rawLocal.startsWith('`') !== rawLocal.endsWith('`')) || (rawLocal.match(/`/g)?.length !== 2 && rawLocal.includes('`'));
    const remoteHasUnbalanced = (rawRemote.startsWith('`') !== rawRemote.endsWith('`')) || (rawRemote.match(/`/g)?.length !== 2 && rawRemote.includes('`'));
    if (localHasUnbalanced || remoteHasUnbalanced) {
      throw new Error(`REUSABLE_RELEASE_LEDGER_MALFORMED_ROW: unbalanced backticks in row "${rawLine}"`);
    }

    const localCol = unwrapBackticks(rawLocal);
    const remoteCol = unwrapBackticks(rawRemote);

    const localIsCandidate = (localCol === expectedVersion);
    const remoteIsCandidate = (remoteCol === expectedVersion);

    // Fail closed on partial matches (e.g. version prefix/suffix)
    if (!localIsCandidate && localCol.includes(expectedVersion)) {
      throw new Error(`REUSABLE_RELEASE_LEDGER_PARTIAL_MATCH: ${localCol}`);
    }
    if (!remoteIsCandidate && remoteCol.includes(expectedVersion)) {
      throw new Error(`REUSABLE_RELEASE_LEDGER_PARTIAL_MATCH: ${remoteCol}`);
    }

    if (localIsCandidate || remoteIsCandidate) {
      // Must be present in both LOCAL and REMOTE
      if (!localIsCandidate || !remoteIsCandidate) {
        throw new Error(`REUSABLE_RELEASE_LEDGER_UNSYNCHRONIZED: LOCAL=${localCol}, REMOTE=${remoteCol}`);
      }
      candidateMatches++;
    }
  }

  // Exactly one candidate row where both LOCAL and REMOTE equal expectedVersion
  if (candidateMatches === 0) {
    throw new Error(`REUSABLE_RELEASE_EXACT_LEDGER_ENTRY_MISSING: version ${expectedVersion}`);
  }
  if (candidateMatches > 1) {
    throw new Error(`REUSABLE_RELEASE_LEDGER_DUPLICATE_ROW: found ${candidateMatches} rows for ${expectedVersion}`);
  }
}

export async function verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner, catalogueBefore) {
  const candidate = getCandidate(candidateId);
  if (candidate.id === 'moderation-analytics-v1') {
    // Read-only SQL query to verify exact function attributes, empty search_path, volatility, definer/invoker, and permissions.
    // Uses standard PostgreSQL array containment: p.proconfig @> ARRAY['search_path=""']::text[]
    const query = `
      BEGIN READ ONLY;
      SET LOCAL statement_timeout = '15s';
      SELECT jsonb_build_object(
        'public_signature_exact', (
          SELECT count(*) = 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_type t ON t.oid = p.prorettype
          WHERE n.nspname = 'public'
            AND p.proname = 'get_admin_moderation_analytics'
            AND NOT p.prosecdef
            AND p.provolatile = 's'
            AND t.typname = 'jsonb'
            AND p.pronargs = 1
            AND pg_get_function_identity_arguments(p.oid) = 'filter_range text'
            AND p.proconfig @> ARRAY['search_path=""']::text[]
        ),
        'app_security_signature_exact', (
          SELECT count(*) = 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_type t ON t.oid = p.prorettype
          WHERE n.nspname = 'app_security'
            AND p.proname = 'get_admin_moderation_analytics'
            AND p.prosecdef
            AND p.provolatile = 's'
            AND t.typname = 'jsonb'
            AND p.pronargs = 1
            AND pg_get_function_identity_arguments(p.oid) = 'p_filter_range text'
            AND p.proconfig @> ARRAY['search_path=""']::text[]
        ),
        'no_public_execute', (
          SELECT has_function_privilege('public', 'public.get_admin_moderation_analytics(text)', 'EXECUTE') = false
            AND has_function_privilege('public', 'app_security.get_admin_moderation_analytics(text)', 'EXECUTE') = false
        ),
        'no_anon_execute', (
          SELECT has_function_privilege('anon', 'public.get_admin_moderation_analytics(text)', 'EXECUTE') = false
            AND has_function_privilege('anon', 'app_security.get_admin_moderation_analytics(text)', 'EXECUTE') = false
        ),
        'auth_can_execute', (
          SELECT has_function_privilege('authenticated', 'public.get_admin_moderation_analytics(text)', 'EXECUTE') = true
            AND has_function_privilege('authenticated', 'app_security.get_admin_moderation_analytics(text)', 'EXECUTE') = true
        )
      )::text;
      COMMIT;
    `;
    let rawOutput;
    if (runner) {
      rawOutput = runner('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl, '-c', query], env);
    } else {
      const res = spawnSync('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl, '-c', query], {env, encoding: 'utf8'});
      if (res.status !== 0) {
        throw subprocessFailure(res, 'postflight_sql');
      }
      rawOutput = res.stdout;
    }

    let check;
    try {
      check = JSON.parse(rawOutput.trim());
    } catch {
      throw new Error('REUSABLE_RELEASE_POSTFLIGHT_INVALID_RESPONSE');
    }
    if (!check.public_signature_exact || !check.app_security_signature_exact || !check.no_public_execute || !check.no_anon_execute || !check.auth_can_execute) {
      throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
    }
    return check;
  }
  if (candidate.id === 'moderation-azure-v1') {
    // Read-only SQL query to verify Azure Moderation V1 authoritative gate & tables:
    // 1. app_security.listing_media_verified_hashes (RLS, exact privileges SELECT, INSERT, UPDATE, DELETE)
    // 2. app_security.listing_moderation_scan_receipts (RLS, exact privileges SELECT, INSERT, UPDATE, DELETE)
    // 3. Exact RPC signatures, search_path='', and EXECUTE permissions
    const query = `
      BEGIN READ ONLY;
      SET LOCAL statement_timeout = '15s';
      SELECT jsonb_build_object(
        'verified_hashes_table_rls', (
          SELECT c.relrowsecurity AND c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app_security' AND c.relname = 'listing_media_verified_hashes'
        ),
        'scan_receipts_table_rls', (
          SELECT c.relrowsecurity AND c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app_security' AND c.relname = 'listing_moderation_scan_receipts'
        ),
        'tables_no_anon', (
          SELECT has_table_privilege('anon', 'app_security.listing_media_verified_hashes', 'SELECT') = false
            AND has_table_privilege('anon', 'app_security.listing_media_verified_hashes', 'INSERT') = false
            AND has_table_privilege('anon', 'app_security.listing_media_verified_hashes', 'UPDATE') = false
            AND has_table_privilege('anon', 'app_security.listing_media_verified_hashes', 'DELETE') = false
            AND has_table_privilege('anon', 'app_security.listing_moderation_scan_receipts', 'SELECT') = false
            AND has_table_privilege('anon', 'app_security.listing_moderation_scan_receipts', 'INSERT') = false
            AND has_table_privilege('anon', 'app_security.listing_moderation_scan_receipts', 'UPDATE') = false
            AND has_table_privilege('anon', 'app_security.listing_moderation_scan_receipts', 'DELETE') = false
        ),
        'tables_no_auth', (
          SELECT has_table_privilege('authenticated', 'app_security.listing_media_verified_hashes', 'SELECT') = false
            AND has_table_privilege('authenticated', 'app_security.listing_media_verified_hashes', 'INSERT') = false
            AND has_table_privilege('authenticated', 'app_security.listing_media_verified_hashes', 'UPDATE') = false
            AND has_table_privilege('authenticated', 'app_security.listing_media_verified_hashes', 'DELETE') = false
            AND has_table_privilege('authenticated', 'app_security.listing_moderation_scan_receipts', 'SELECT') = false
            AND has_table_privilege('authenticated', 'app_security.listing_moderation_scan_receipts', 'INSERT') = false
            AND has_table_privilege('authenticated', 'app_security.listing_moderation_scan_receipts', 'UPDATE') = false
            AND has_table_privilege('authenticated', 'app_security.listing_moderation_scan_receipts', 'DELETE') = false
        ),
        'tables_service_role_all_ops', (
          SELECT has_table_privilege('service_role', 'app_security.listing_media_verified_hashes', 'SELECT') = true
            AND has_table_privilege('service_role', 'app_security.listing_media_verified_hashes', 'INSERT') = true
            AND has_table_privilege('service_role', 'app_security.listing_media_verified_hashes', 'UPDATE') = true
            AND has_table_privilege('service_role', 'app_security.listing_media_verified_hashes', 'DELETE') = true
            AND has_table_privilege('service_role', 'app_security.listing_moderation_scan_receipts', 'SELECT') = true
            AND has_table_privilege('service_role', 'app_security.listing_moderation_scan_receipts', 'INSERT') = true
            AND has_table_privilege('service_role', 'app_security.listing_moderation_scan_receipts', 'UPDATE') = true
            AND has_table_privilege('service_role', 'app_security.listing_moderation_scan_receipts', 'DELETE') = true
        ),
        'registrar_search_path', (
          SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app_security' AND p.proname = 'register_moderation_scan_receipt'
            AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]
        ),
        'finalizer_search_path', (
          SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app_security' AND p.proname = 'impl_finalize_moderation_result'
            AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]
        ),
        'rpc_exact_signatures', (
          SELECT to_regprocedure('app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)') IS NOT NULL
            AND to_regprocedure('public.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)') IS NOT NULL
            AND to_regprocedure('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') IS NOT NULL
            AND to_regprocedure('public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') IS NOT NULL
        ),
        'registrar_no_public', (
          SELECT has_function_privilege('public', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
            AND has_function_privilege('public', 'public.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
            AND has_function_privilege('anon', 'public.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
            AND has_function_privilege('authenticated', 'public.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
        ),
        'registrar_service_role', (
          SELECT has_function_privilege('service_role', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = true
            AND has_function_privilege('service_role', 'public.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = true
        ),
        'finalizer_no_public', (
          SELECT has_function_privilege('public', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
            AND has_function_privilege('public', 'public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
            AND has_function_privilege('anon', 'public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
            AND has_function_privilege('authenticated', 'public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
        ),
        'finalizer_service_role', (
          SELECT has_function_privilege('service_role', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = true
            AND has_function_privilege('service_role', 'public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = true
        )
      )::text;
      COMMIT;
    `;
    let rawOutput;
    if (runner) {
      rawOutput = runner('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl, '-c', query], env);
    } else {
      const res = spawnSync('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl, '-c', query], {env, encoding: 'utf8'});
      if (res.status !== 0) {
        throw subprocessFailure(res, 'postflight_sql');
      }
      rawOutput = res.stdout;
    }

    let check;
    try {
      check = JSON.parse(rawOutput.trim());
    } catch {
      throw new Error('REUSABLE_RELEASE_POSTFLIGHT_INVALID_RESPONSE');
    }
    if (
      !check.verified_hashes_table_rls ||
      !check.scan_receipts_table_rls ||
      !check.tables_no_anon ||
      !check.tables_no_auth ||
      !check.tables_service_role_all_ops ||
      !check.registrar_search_path ||
      !check.finalizer_search_path ||
      !check.rpc_exact_signatures ||
      !check.registrar_no_public ||
      !check.registrar_service_role ||
      !check.finalizer_no_public ||
      !check.finalizer_service_role
    ) {
      throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
    }
    return check;
  }
  if (candidate.id === 'moderation-switching-v1') {
    const query = `
      BEGIN READ ONLY;
      SET LOCAL statement_timeout = '15s';
      SELECT jsonb_build_object(
        'system_settings_azure_exists', (
          SELECT count(*) = 1 FROM public.app_system_settings
          WHERE setting_key = 'moderation_azure_enabled' AND setting_value = 'false'
        ),
        'system_settings_google_exists', (
          SELECT count(*) = 1 FROM public.app_system_settings
          WHERE setting_key = 'moderation_google_cloud_enabled' AND setting_value = 'false'
        ),
        'system_settings_automation_exists', (
          SELECT count(*) = 1 FROM public.app_system_settings
          WHERE setting_key = 'moderation_automation_enabled'
        ),
        'registrar_search_path', (
          SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app_security' AND p.proname = 'register_moderation_scan_receipt'
            AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]
        ),
        'finalizer_search_path', (
          SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app_security' AND p.proname = 'impl_finalize_moderation_result'
            AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[]
        ),
        'registrar_service_role', (
          SELECT has_function_privilege('service_role', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = true
            AND has_function_privilege('public', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
            AND has_function_privilege('anon', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
            AND has_function_privilege('authenticated', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
        ),
        'finalizer_service_role', (
          SELECT has_function_privilege('service_role', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = true
            AND has_function_privilege('public', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
            AND has_function_privilege('anon', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
            AND has_function_privilege('authenticated', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
        ),
        'finalizer_contains_baseline_logic', (
          SELECT count(*) >= 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app_security' AND p.proname IN ('impl_finalize_moderation_result', 'impl_finalize_moderation_result_azure_v1')
            AND p.prosrc LIKE '%baseline_two_check%' AND p.prosrc LIKE '%india_baseline_v1.0.0%'
        )
      )::text;
      COMMIT;
    `;
    let rawOutput;
    if (runner) {
      rawOutput = runner('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl, '-c', query], env);
    } else {
      const res = spawnSync('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl, '-c', query], {env, encoding: 'utf8'});
      if (res.status !== 0) {
        throw subprocessFailure(res, 'postflight_sql');
      }
      rawOutput = res.stdout;
    }

    let check;
    try {
      check = JSON.parse(rawOutput.trim());
    } catch {
      throw new Error('REUSABLE_RELEASE_POSTFLIGHT_INVALID_RESPONSE');
    }

    if (
      !check.system_settings_azure_exists ||
      !check.system_settings_google_exists ||
      !check.system_settings_automation_exists ||
      !check.registrar_search_path ||
      !check.finalizer_search_path ||
      !check.registrar_service_role ||
      !check.finalizer_service_role ||
      !check.finalizer_contains_baseline_logic
    ) {
      throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
    }
    return check;
  }
  if (candidate.id === 'tablets-v2-catalogue') {
    return runTabletsV2Postflight(catalogueBefore,
      sql => psqlQuery(sql, psqlUrl, env, runner, 'postflight_sql'));
  }
  if (candidate.id.startsWith('tablets-v1-')) {
    return runTabletsPostflight(candidate.stage === 'activation',
      sql => psqlQuery(sql, psqlUrl, env, runner, 'postflight_sql'));
  }
  if (candidate.id.startsWith('wearables-v1-')) {
    return runWearablesPostflight(candidate, sql => psqlQuery(sql, psqlUrl, env, runner, 'postflight_sql'));
  }
  if (candidate.strict) {
    const rawOutput = psqlQuery(postflightQuery(candidate.stage), psqlUrl, env, runner, 'postflight_sql');
    return runAccessoriesPostflight(candidate, rawOutput);
  }
  // Fail closed: an unrecognized candidate must never be accepted without a real postflight.
  throw new Error(`REUSABLE_RELEASE_NO_POSTFLIGHT_IMPLEMENTED: ${candidateId}`);
}

function psqlQuery(query, psqlUrl, env, runner, phase) {
  const args = ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl, '-c', query];
  if (runner) return runner('psql', args, env);
  const res = spawnSync('psql', args, {env, encoding: 'utf8', timeout: 60000});
  if (res.error || res.status !== 0) throw subprocessFailure(res, phase);
  return res.stdout;
}

export async function releaseReusable({
  environment,
  candidateId,
  context = process.env,
  runner,
  fetcher = fetch,
  receiptDir = resolve('release-receipts')
}) {
  if (!REFS[environment]) {
    throw new Error(`REUSABLE_RELEASE_INVALID_ENVIRONMENT: ${environment}`);
  }
  const candidate = getCandidate(candidateId);
  const projectRef = REFS[environment];
  // Accessories evidence (Web SHAs, earlier stages) is re-derived here; no-op for non-strict candidates.
  const stagePlan = assertStageInputs(candidate, environment, context);

  let catalogueWebEvidence;
  if (candidate.id === 'tablets-v2-catalogue' && environment === 'FairSwapProd') {
    const receipts = await requireStageEvidence(stagePlan.priorRuns, context, fetcher);
    if (receipts.test_catalogue_run_id.ledgerStatementsSha256 !== context.TABLETS_CANDIDATE_LEDGER_SHA) {
      throw new Error('REUSABLE_RELEASE_TABLETS_TEST_LEDGER_EVIDENCE_REQUIRED');
    }
    catalogueWebEvidence = await verifyTabletsV2Web(stagePlan, context, fetcher, receipts.test_catalogue_run_id);
  }

  const recoveredCommit = context.ACCESSORIES_RECOVERED_FOUNDATION_SHA || '';
  const recovering = recoveredCommit !== '';
  const recheckProductionFoundation = context.ACCESSORIES_RECHECK_PROD_FOUNDATION === 'true';
  const accessoriesActivation = candidateId === 'accessories-v1-activation';
  const recoveryProductionFoundation = candidateId === 'accessories-v1-foundation' && environment === 'FairSwapProd';
  if (recovering && (!/^[a-f0-9]{40}$/.test(recoveredCommit) || recoveredCommit === context.GITHUB_SHA
      || !(accessoriesActivation || recoveryProductionFoundation))) {
    throw new Error('REUSABLE_RELEASE_INVALID_ACCESSORIES_RECOVERY');
  }

  if (recheckProductionFoundation && (!accessoriesActivation || environment !== 'FairSwapProd')) {
    throw new Error('REUSABLE_RELEASE_INVALID_ACCESSORIES_RECOVERY');
  }

  // Validate candidate file and SHA-256
  const {fullPath, sha256: candidateSha} = verifyCandidateSha(candidateId, root);

  // Validate environment variables and tokens
  const token = context.SUPABASE_ACCESS_TOKEN;
  const dbPassword = context.CHAT_DATABASE_PASSWORD;
  const poolerHost = context.CHAT_DB_POOLER_HOST;
  const sslCert = context.CHAT_DB_SSL_ROOT_CERT_PEM;

  if (!token || !dbPassword || !sslCert || !poolerHost) {
    throw new Error('REUSABLE_RELEASE_MISSING_CREDENTIALS');
  }
  if (!/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(poolerHost)) {
    throw new Error('REUSABLE_RELEASE_INVALID_POOLER_HOST');
  }

  let phase = 'init';
  const run = (cmd, args, env, input, returnCombined = false) => {
    if (runner) return runner(cmd, args, env, input, returnCombined);
    const res = spawnSync(cmd, args, {env, input, encoding: 'utf8', timeout: 120000});
    if (res.error || res.status !== 0) {
      throw subprocessFailure(res, phase);
    }
    return returnCombined ? (res.stdout + '\n' + res.stderr) : res.stdout;
  };

  // Check Supabase CLI version (stdout only)
  phase = 'cli_version';
  const cliVer = run('supabase', ['--version'], process.env).trim().split('\n')[0].replace(/^supabase\s*/, '');
  if (!cliVer.includes('2.117.0')) {
    throw new Error(`REUSABLE_RELEASE_CLI_VERSION_MISMATCH: expected 2.117.0, got ${cliVer}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), `fs-release-${candidateId}-${environment}-`));
  chmodSync(tempDir, 0o700);

  let status = 'FAIL';
  let dryRunPending = [];

  try {
    const certPath = join(tempDir, 'ca.pem');
    writeFileSync(certPath, validateRootCertificate(sslCert), {flag: 'wx', mode: 0o600});

    const env = {
      ...process.env,
      HOME: tempDir,
      PGSSLMODE: 'verify-full',
      PGCONNECT_TIMEOUT: '10',
      PGPASSWORD: dbPassword,
      SUPABASE_DB_PASSWORD: dbPassword,
      SUPABASE_ACCESS_TOKEN: token,
      PGSSLROOTCERT: certPath
    };

    const psqlUrl = `postgresql://postgres.${projectRef}@${poolerHost}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(certPath)}&connect_timeout=10`;
    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace, {mode: 0o700});

    // 1. Initialize isolated Supabase project
    phase = 'init';
    run('supabase', ['init', '--workdir', workspace], env);

    // 2. Link target project
    phase = 'link';
    run('supabase', ['link', '--project-ref', projectRef, '--workdir', workspace], env);
    const linkedRef = readFileSync(join(workspace, 'supabase/.temp/project-ref'), 'utf8').trim();
    if (linkedRef !== projectRef) {
      throw new Error(`REUSABLE_RELEASE_LINKED_REF_MISMATCH: expected ${projectRef}, got ${linkedRef}`);
    }

    // 3. Fetch migration history independently
    phase = 'fetch';
    run('supabase', ['migration', 'fetch', '--linked', '--workdir', workspace], env);
    const fetchedFiles = readdirSync(join(workspace, 'supabase/migrations'));
    if (fetchedFiles.length < 50) {
      throw new Error(`REUSABLE_RELEASE_UNEXPECTED_HISTORY_COUNT: ${fetchedFiles.length}`);
    }

    // Check if candidate migration is already recorded in remote ledger
    phase = 'initial_ledger_check';
    const initialLedger = run('supabase', ['migration', 'list', '--linked', '--workdir', workspace], env);
    let isAlreadyApplied = false;
    let beforeRemote = null;
    const catalogue = candidate.id === 'tablets-v2-catalogue';
    const tablets = catalogue || candidate.id.startsWith('tablets-v1-');
    const wearables = candidate.id.startsWith('wearables-v1-');
    // Tablets and Wearables pin the ledger: history is read before apply, must not change, and the installed
    // statements hash is carried Test -> Production through the receipts.
    const pinned = tablets || wearables;
    const label = wearables ? 'WEARABLES' : 'TABLETS';
    const foundationVersion = wearables ? '20261104120000' : '20261102165946';
    const readLedger = () => readTabletsLedger(sql => psqlQuery(sql, psqlUrl, env, runner, 'ledger_sql'));
    let catalogueBefore;
    let ledgerBefore;
    let ledgerStatementsSha256;
    let outOfOrder = {includeAll: false, ahead: []};
    if (candidate.strict) {
      // Prerequisites, ordering and partial state fail closed; resumption of a verified release is allowed in both environments.
      const ordering = assertLedgerOrdering(candidate, initialLedger);
      isAlreadyApplied = ordering.state === 'applied';
      beforeRemote = ordering.remote;
    } else {
      try {
        verifyLedgerVersion(initialLedger, candidate.version);
        isAlreadyApplied = true;
      } catch {
        isAlreadyApplied = false;
      }
    }

    if (pinned) {
      // A pre-existing entry has no trusted receipt tying it to the reviewed source bytes.
      if (isAlreadyApplied) throw new Error(`REUSABLE_RELEASE_${label}_ALREADY_RECORDED`);
      ledgerBefore = readLedger();
      if (wearables) {
        assertMobilePhonesProvenance(environment, ledgerBefore);
        outOfOrder = assertLedgerTail(candidate, ledgerBefore, environment);
        assertSwitchingPrerequisite(candidate, ledgerBefore);
      }
      for (const version of candidate.requiredLedgerVersions) {
        const prerequisite = Object.values(CANDIDATES).find(entry => entry.version === version);
        const row = ledgerBefore.find(entry => entry.version === version);
        if (!row?.hasStatements || row.name !== prerequisite.filename.slice(15, -4)) {
          throw new Error(`REUSABLE_RELEASE_${label}_PREREQUISITE_LEDGER_MISMATCH`);
        }

      }
      if (wearables && environment === 'FairSwapProd') {
        // Production Accessories predates the pipeline: both installed rows (foundation and activation) must be exactly the
        // adopted, observed installation (names, statements, pinned digests).
        for (const entry of getAdoption('accessories-v1-foundation', 'FairSwapProd').entries) {
          const row = ledgerBefore.find(item => item.version === entry.ledgerVersion);
          if (!row?.hasStatements || row.name !== entry.ledgerName || row.statementsSha256 !== entry.statementsSha256) {
            throw new Error('REUSABLE_RELEASE_WEARABLES_ACCESSORIES_ADOPTION_LEDGER_MISMATCH');
          }
        }
      }
      if (candidate.stage === 'activation' &&
          ledgerBefore.find(row => row.version === foundationVersion)?.statementsSha256 !== context.TABLETS_FOUNDATION_LEDGER_SHA) {
        throw new Error(`REUSABLE_RELEASE_${label}_FOUNDATION_EVIDENCE_MISMATCH`);
      }
      if (environment === 'FairSwapProd' && !/^[a-f0-9]{64}$/.test(context.TABLETS_CANDIDATE_LEDGER_SHA ?? '')) {
        throw new Error(`REUSABLE_RELEASE_${label}_TEST_LEDGER_EVIDENCE_REQUIRED`);
      }
      if (ledgerBefore.length !== beforeRemote.size || ledgerBefore.some(row =>
        !beforeRemote.has(row.version) || (row.version >= candidate.version && !outOfOrder.ahead.includes(row.version)))) {
        throw new Error(`REUSABLE_RELEASE_${label}_LEDGER_MISMATCH`);
      }
    }

    if (recovering || recheckProductionFoundation) {
      const test = environment === 'FairSwapTest';
      if (isAlreadyApplied !== (test || recoveryProductionFoundation)) {
        throw new Error('REUSABLE_RELEASE_ACCESSORIES_RECOVERY_STATE_MISMATCH');
      }
      const exec = sql => psqlQuery(sql, psqlUrl, env, runner, 'ledger_sql');
      verifyAccessoriesLedger(test, exec);
      if (accessoriesActivation && !test) {
        // Confirm the disabled foundation before considering the pending activation.
        await verifyRemotePostflight(environment, 'accessories-v1-foundation', psqlUrl, env, runner);
      }
    }

    if ((environment === 'FairSwapTest' || candidate.strict) && isAlreadyApplied) {
      // Support resumption for FairSwapTest if already applied: verify ledger, exact SQL hash, and postflight
      phase = 'postflight';
      const postflightResult = await verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner, catalogueBefore);
      if (!postflightResult || typeof postflightResult !== 'object' || postflightResult.status === 'NO_SPECIFIC_POSTFLIGHT') {
        throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
      }

      status = 'ALREADY_APPLIED_VERIFIED';
      dryRunPending = [];
    } else {
      // Standard path: candidate-only dry run, migration apply, ledger verification and postflight
      if (candidate.strict) {
        phase = 'preflight';
        if (catalogue) catalogueBefore = runTabletsV2Preflight(sql => psqlQuery(sql, psqlUrl, env, runner, 'preflight_sql'));
        const preflight = catalogue ? null : tablets ? runTabletsPreflight : wearables ? runWearablesPreflight : runLivePreflight;
        if (preflight) preflight(candidate, sql => psqlQuery(sql, psqlUrl, env, runner, 'preflight_sql'));
      }
        // 4. Copy candidate migration into workspace
      const destMigration = join(workspace, 'supabase/migrations', candidate.filename);
      copyFileSync(fullPath, destMigration);
      const destSha = sha(readFileSync(destMigration));
      if (destSha !== candidateSha) {
        throw new Error('REUSABLE_RELEASE_DEST_SHA_MISMATCH');
      }

      // 5. Dry run push to verify EXACTLY only this candidate is pending (capturing stdout + stderr)
      phase = 'dry_run';
      // Out-of-order flag only for the approved Production Wearables foundation case, after the pinned CLI advertises it.
      if (outOfOrder.includeAll) {
        assertCliSupportsIncludeAll(run('supabase', ['db', 'push', '--help'], env, undefined, true));
      }
      const pushFlags = outOfOrder.includeAll ? ['--include-all'] : [];
      const dryRunOutput = run('supabase', ['db', 'push', '--db-url', psqlUrl, '--dry-run', ...pushFlags, '--workdir', workspace], env, undefined, true);
      dryRunPending = parsePendingDryRun(dryRunOutput, candidate.filename);

      // 6. Apply candidate migration
      if (pinned && JSON.stringify(readLedger()) !== JSON.stringify(ledgerBefore)) {
        throw new Error(`REUSABLE_RELEASE_${label}_LEDGER_CHANGED`);
      }
      phase = 'apply';
      run('supabase', ['db', 'push', '--db-url', psqlUrl, '--yes', ...pushFlags, '--workdir', workspace], env);

      // 7. Re-check migration ledger with exact match
      phase = 'ledger';
      const ledgerOutput = run('supabase', ['migration', 'list', '--linked', '--workdir', workspace], env);
      verifyLedgerVersion(ledgerOutput, candidate.version);
      if (candidate.strict) verifyHistoryPreserved(beforeRemote, ledgerOutput, candidate.version);
      if (pinned) {
        ledgerStatementsSha256 = verifyTabletsLedger(ledgerBefore, readLedger(), candidate);
        if (environment === 'FairSwapProd' && ledgerStatementsSha256 !== context.TABLETS_CANDIDATE_LEDGER_SHA) {
          throw new Error(`REUSABLE_RELEASE_${label}_TEST_LEDGER_MISMATCH`);
        }
      }

      // 8. Automated Read-only Postflight Verification (awaited and validated before receipt)
      phase = 'postflight';
      const postflightResult = await verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner, catalogueBefore);
      if (!postflightResult || typeof postflightResult !== 'object' || postflightResult.status === 'NO_SPECIFIC_POSTFLIGHT') {
        throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
      }

      if (recovering || recheckProductionFoundation) verifyAccessoriesLedger(true, sql => psqlQuery(sql, psqlUrl, env, runner, 'ledger_sql'));
      status = 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED';
    }

    const receipt = {
      environment,
      projectRef,
      candidateId: candidate.id,
      migrationVersion: candidate.version,
      migrationFile: candidate.filename,
      migrationSha256: candidateSha,
      reviewedCommit: context.GITHUB_SHA || 'unknown',
      releaseWorkflowRun: context.GITHUB_RUN_ID || 'local',
      status,
      dryRunPending,
      postflightVerified: true,
      ...(pinned ? {ledgerStatementsSha256} : {}),
      ...(catalogue ? {webStagingEvidence: catalogueWebEvidence ?? null} : {}),
      ...(recovering ? {recoveredFoundationCommit: recoveredCommit} : {}),
      ...(outOfOrder.includeAll ? {outOfOrderInstall: {includeAll: true, aheadVersions: outOfOrder.ahead}} : {}),
      ...(wearables ? {
        // SQL postflight is a catalogue/ACL/ownership/moderation integrity check, never E2E evidence.
        postflightScope: 'sql-integrity-smoke-not-e2e',
        ...(stagePlan.crossCommitRuns ? {
          accessoriesProdFoundationRunId: stagePlan.crossCommitRuns[0].runId
        } : {}),
        ...(stagePlan.e2eRunId ? {e2eRunId: stagePlan.e2eRunId} : {}),
        ...(stagePlan.e2eWaiver ? {e2eWaiver: stagePlan.e2eWaiver} : {})
      } : {}),
      ...(candidate.strict ? {
        stage: candidate.stage,
        webStagingSha: stagePlan.webStagingSha,
        webProductionSha: stagePlan.webProductionSha,
        priorRuns: stagePlan.priorRuns.map(r => ({key: r.key, runId: r.runId}))
      } : {}),
      timestamp: new Date().toISOString()
    };

    mkdirSync(receiptDir, {recursive: true, mode: 0o700});
    const receiptFile = join(receiptDir, `${candidateId}-${environment.toLowerCase()}.json`);
    const receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
    writeFileSync(receiptFile, receiptBytes, {mode: 0o600});
    writeFileSync(join(receiptDir, `SHA256SUMS_${environment.toLowerCase()}`), `${sha(receiptBytes)}  ${candidateId}-${environment.toLowerCase()}.json\n`, {mode: 0o600});

    return receipt;
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
}

// Read-only adoption of an existing Production installation that has no release-workflow receipt (it predates the
// pipeline). It attests the CURRENT ledger row (version, name, statement count, JSON-statements digest), the reviewed
// source bytes and the strict installed-state postflight. It applies nothing, never touches the Supabase CLI or the
// migration workspace, and its receipt states that the installation was not performed by this workflow. No historical
// run ID or receipt is fabricated.
export async function adoptExistingInstallation({
  environment,
  candidateId,
  context = process.env,
  runner,
  receiptDir = resolve('release-receipts')
}) {
  if (environment !== 'FairSwapProd') throw new Error(`REUSABLE_RELEASE_ADOPTION_ENVIRONMENT_NOT_ALLOWED: ${environment}`);
  const candidate = getCandidate(candidateId);
  const adoption = getAdoption(candidateId, environment);
  planDispatch({candidateId, target: 'adopt'});
  const {sha256: candidateSha} = verifyCandidateSha(candidateId, root);
  const dbPassword = context.CHAT_DATABASE_PASSWORD;
  const poolerHost = context.CHAT_DB_POOLER_HOST;
  const sslCert = context.CHAT_DB_SSL_ROOT_CERT_PEM;
  if (!dbPassword || !sslCert || !poolerHost) throw new Error('REUSABLE_RELEASE_MISSING_CREDENTIALS');
  if (!/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(poolerHost)) throw new Error('REUSABLE_RELEASE_INVALID_POOLER_HOST');
  const projectRef = REFS[environment];
  const tempDir = mkdtempSync(join(tmpdir(), `fs-adopt-${candidateId}-`));
  chmodSync(tempDir, 0o700);
  try {
    const certPath = join(tempDir, 'ca.pem');
    writeFileSync(certPath, validateRootCertificate(sslCert), {flag: 'wx', mode: 0o600});
    const env = {
      ...process.env, HOME: tempDir, PGSSLMODE: 'verify-full', PGCONNECT_TIMEOUT: '10', PGPASSWORD: dbPassword, PGSSLROOTCERT: certPath
    };
    const psqlUrl = `postgresql://postgres.${projectRef}@${poolerHost}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(certPath)}&connect_timeout=10`;
    const q = (sql, phase) => psqlQuery(sql, psqlUrl, env, runner, phase);
    const fail = code => { throw new Error(`REUSABLE_RELEASE_ADOPTION_${code}`); };

    const ledger = readTabletsLedger(sql => q(sql, 'ledger_sql'));
    if (ledger.length < 50) fail('UNEXPECTED_HISTORY_COUNT');
    const observed = {};
    for (const entry of adoption.entries) {
      // Reviewed source bytes for every attested migration must still be the registered ones.
      const reviewed = verifyCandidateSha(entry.candidateId, root);
      const row = ledger.find(item => item.version === entry.ledgerVersion);
      if (!row) fail('LEDGER_ENTRY_MISSING');
      if (row.name !== entry.ledgerName || row.hasStatements !== true) fail('LEDGER_ENTRY_MISMATCH');
      if (row.statementsSha256 !== entry.statementsSha256) fail('STATEMENTS_HASH_MISMATCH');
      const count = Number(String(q(`BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; SELECT cardinality(statements) FROM supabase_migrations.schema_migrations WHERE version = '${entry.ledgerVersion}'; COMMIT;`, 'ledger_sql')).trim());
      if (!Number.isInteger(count) || count !== entry.statementCount) fail('STATEMENT_COUNT_MISMATCH');
      if (entry.storedSqlSha256 !== null) {
        // Stored SQL text provenance: the single hosted statement must be byte-identical to the pinned digest AND to the reviewed
        // source file read just above (verifyCandidateSha). The digest is computed in the database over the stored text.
        const stored = String(q(`BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; SELECT encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') FROM supabase_migrations.schema_migrations WHERE version = '${entry.ledgerVersion}'; COMMIT;`, 'ledger_sql')).trim();
        if (!/^[a-f0-9]{64}$/.test(stored) || stored !== entry.storedSqlSha256) fail('STORED_SQL_HASH_MISMATCH');
        if (stored !== reviewed.sha256) fail('STORED_SQL_SOURCE_MISMATCH');
        observed[entry.ledgerVersion] = stored;
      }
    }
    // Wearables (and any other forbidden later stage) must not be recorded.
    if (adoption.forbiddenLedgerVersions.some(version => ledger.some(item => item.version === version))) fail('LATER_STAGE_RECORDED');
    // Tablets is allowed only as a complete verified foundation+activation pair; a partial pair is a different, rejected state.
    const tabletRows = adoption.postTabletsLedger.map(entry => ledger.find(item => item.version === entry.ledgerVersion));
    const postTablets = tabletRows.some(Boolean);
    if (postTablets) {
      adoption.postTabletsLedger.forEach((entry, index) => {
        verifyCandidateSha(entry.candidateId, root);
        const row = tabletRows[index];
        if (!row || row.name !== entry.ledgerName || row.hasStatements !== true) fail('TABLETS_LEDGER_MISMATCH');
      });
    }
    // The observed installation is ACTIVATED: validate the active-state postflight (release enabled, category active, RLS,
    // ACL, guards). A disabled or foundation-only installation is a different state and is rejected here.
    const activation = getCandidate(adoption.entries.find(entry => entry.role === 'activation').candidateId);
    if (postTablets) {
      // Existing active Tablets security postflight; throws REUSABLE_RELEASE_TABLETS_POSTFLIGHT_FAILED on any drift.
      runTabletsPostflight(true, sql => q(sql, 'postflight_sql'));
    }
    const postflight = runAccessoriesPostflight(activation, q(postflightQuery(activation.stage), 'postflight_sql'),
      {exemptKeys: postTablets ? adoption.postTabletsExemptKeys : []});
    if (!postflight || typeof postflight !== 'object') fail('POSTFLIGHT_VERIFICATION_FAILED');
    // The ledger must be unchanged by the read-only checks above (guards against concurrent change during attestation).
    if (JSON.stringify(readTabletsLedger(sql => q(sql, 'ledger_sql'))) !== JSON.stringify(ledger)) fail('LEDGER_CHANGED');

    const receipt = {
      environment,
      projectRef,
      candidateId: candidate.id,
      migrationVersion: candidate.version,
      migrationFile: candidate.filename,
      migrationSha256: candidateSha,
      reviewedCommit: context.GITHUB_SHA || 'unknown',
      releaseWorkflowRun: context.GITHUB_RUN_ID || 'local',
      status: ADOPTED_STATUS,
      dryRunPending: [],
      postflightVerified: true,
      stage: candidate.stage,
      webStagingSha: null,
      webProductionSha: null,
      priorRuns: [],
      adoption: adoptionAttestation(adoption, observed),
      timestamp: new Date().toISOString()
    };
    mkdirSync(receiptDir, {recursive: true, mode: 0o700});
    const receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
    const lower = environment.toLowerCase();
    writeFileSync(join(receiptDir, `${candidateId}-${lower}.json`), receiptBytes, {mode: 0o600});
    writeFileSync(join(receiptDir, `SHA256SUMS_${lower}`), `${sha(receiptBytes)}  ${candidateId}-${lower}.json\n`, {mode: 0o600});
    return receipt;
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
}
