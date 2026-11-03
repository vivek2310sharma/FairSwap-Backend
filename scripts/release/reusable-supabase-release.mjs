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
import {getCandidate, verifyCandidateSha, PROJECT_REFS} from './reusable-candidates.mjs';
import {
  assertLedgerOrdering, assertStageInputs, postflightQuery, runAccessoriesPostflight, runLivePreflight, verifyHistoryPreserved
} from './accessories-v1-release.mjs';

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

export async function verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner) {
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
  receiptDir = resolve('release-receipts')
}) {
  if (!REFS[environment]) {
    throw new Error(`REUSABLE_RELEASE_INVALID_ENVIRONMENT: ${environment}`);
  }
  const candidate = getCandidate(candidateId);
  const projectRef = REFS[environment];
  // Accessories evidence (Web SHAs, earlier stages) is re-derived here; no-op for non-strict candidates.
  const stagePlan = assertStageInputs(candidate, environment, context);

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

    if ((environment === 'FairSwapTest' || candidate.strict) && isAlreadyApplied) {
      // Support resumption for FairSwapTest if already applied: verify ledger, exact SQL hash, and postflight
      phase = 'postflight';
      const postflightResult = await verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner);
      if (!postflightResult || typeof postflightResult !== 'object' || postflightResult.status === 'NO_SPECIFIC_POSTFLIGHT') {
        throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
      }

      status = 'ALREADY_APPLIED_VERIFIED';
      dryRunPending = [];
    } else {
      // Standard path: candidate-only dry run, migration apply, ledger verification and postflight
      if (candidate.strict) {
        phase = 'preflight';
        runLivePreflight(candidate, sql => psqlQuery(sql, psqlUrl, env, runner, 'preflight_sql'));
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
      const dryRunOutput = run('supabase', ['db', 'push', '--db-url', psqlUrl, '--dry-run', '--workdir', workspace], env, undefined, true);
      dryRunPending = parsePendingDryRun(dryRunOutput, candidate.filename);

      // 6. Apply candidate migration
      phase = 'apply';
      run('supabase', ['db', 'push', '--db-url', psqlUrl, '--yes', '--workdir', workspace], env);

      // 7. Re-check migration ledger with exact match
      phase = 'ledger';
      const ledgerOutput = run('supabase', ['migration', 'list', '--linked', '--workdir', workspace], env);
      verifyLedgerVersion(ledgerOutput, candidate.version);
      if (candidate.strict) verifyHistoryPreserved(beforeRemote, ledgerOutput, candidate.version);

      // 8. Automated Read-only Postflight Verification (awaited and validated before receipt)
      phase = 'postflight';
      const postflightResult = await verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner);
      if (!postflightResult || typeof postflightResult !== 'object' || postflightResult.status === 'NO_SPECIFIC_POSTFLIGHT') {
        throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
      }

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
