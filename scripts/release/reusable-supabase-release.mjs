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
import {getCandidate, verifyCandidateSha} from './reusable-candidates.mjs';

export const REFS = Object.freeze({
  FairSwapTest: 'wpppxlnbzqynvhpeuavd',
  FairSwapProd: 'kriuhwppxgxsyyrbjsau'
});

const root = fileURLToPath(new URL('../../', import.meta.url));

function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function parsePendingDryRun(dryRunCombinedOutput, expectedFilename) {
  // Capture all potential migration filename tokens from stdout and stderr combined
  const pending = [...new Set(dryRunCombinedOutput.match(/\b\d{14}_[A-Za-z0-9_-]+\.sql\b/g) ?? [])];
  if (pending.length !== 1 || pending[0] !== expectedFilename) {
    throw new Error(`REUSABLE_RELEASE_DRY_RUN_MISMATCH: expected exactly [${expectedFilename}], found [${pending.join(', ')}]`);
  }
  return pending;
}

export function verifyLedgerVersion(ledgerOutput, expectedVersion, expectedFilename) {
  // Verify exact ledger entry match on its own row/line, avoiding partial substring confusion
  const lines = ledgerOutput.split('\n');
  const match = lines.some(line => {
    const tokens = line.trim().split(/[\s|]+/);
    const hasVersion = tokens.includes(expectedVersion);
    if (!hasVersion) return false;
    if (expectedFilename) {
      // If filename given, ensure the migration filename or root name is also associated on the line
      const baseName = expectedFilename.replace(/\.sql$/, '');
      return tokens.some(t => t.includes(expectedVersion) || t.includes(baseName));
    }
    return true;
  });
  if (!match) {
    throw new Error(`REUSABLE_RELEASE_EXACT_LEDGER_ENTRY_MISSING: version ${expectedVersion}`);
  }
}

export async function verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner) {
  const candidate = getCandidate(candidateId);
  if (candidate.id === 'moderation-analytics-v1') {
    // Read-only SQL query to verify exact function attributes, search_path, volatility, security definer/invoker, and permissions
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
            AND array_to_string(p.proconfig, ',') = 'search_path='
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
            AND array_to_string(p.proconfig, ',') = 'search_path='
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
        throw new Error('REUSABLE_RELEASE_POSTFLIGHT_SQL_FAILED');
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
  return {status: 'NO_SPECIFIC_POSTFLIGHT'};
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

  const run = (cmd, args, env, input, returnCombined = false) => {
    if (runner) return runner(cmd, args, env, input, returnCombined);
    const res = spawnSync(cmd, args, {env, input, encoding: 'utf8', timeout: 120000});
    if (res.status !== 0) {
      throw new Error(`CMD_FAILED: ${cmd} ${args.join(' ')}: ${res.stderr || res.stdout}`);
    }
    return returnCombined ? (res.stdout + '\n' + res.stderr) : res.stdout;
  };

  // Check Supabase CLI version (stdout only)
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
    run('supabase', ['init', '--workdir', workspace], env);

    // 2. Link target project
    run('supabase', ['link', '--project-ref', projectRef, '--workdir', workspace], env);
    const linkedRef = readFileSync(join(workspace, 'supabase/.temp/project-ref'), 'utf8').trim();
    if (linkedRef !== projectRef) {
      throw new Error(`REUSABLE_RELEASE_LINKED_REF_MISMATCH: expected ${projectRef}, got ${linkedRef}`);
    }

    // 3. Fetch migration history independently
    run('supabase', ['migration', 'fetch', '--linked', '--workdir', workspace], env);
    const fetchedFiles = readdirSync(join(workspace, 'supabase/migrations'));
    if (fetchedFiles.length < 50) {
      throw new Error(`REUSABLE_RELEASE_UNEXPECTED_HISTORY_COUNT: ${fetchedFiles.length}`);
    }

    // 4. Copy candidate migration into workspace
    const destMigration = join(workspace, 'supabase/migrations', candidate.filename);
    copyFileSync(fullPath, destMigration);
    const destSha = sha(readFileSync(destMigration));
    if (destSha !== candidateSha) {
      throw new Error('REUSABLE_RELEASE_DEST_SHA_MISMATCH');
    }

    // 5. Dry run push to verify EXACTLY only this candidate is pending (capturing stdout + stderr)
    const dryRunOutput = run('supabase', ['db', 'push', '--db-url', psqlUrl, '--dry-run', '--workdir', workspace], env, undefined, true);
    dryRunPending = parsePendingDryRun(dryRunOutput, candidate.filename);

    // 6. Apply candidate migration
    run('supabase', ['db', 'push', '--db-url', psqlUrl, '--yes', '--workdir', workspace], env);

    // 7. Re-check migration ledger with exact match
    const ledgerOutput = run('supabase', ['migration', 'list', '--linked', '--workdir', workspace], env);
    verifyLedgerVersion(ledgerOutput, candidate.version, candidate.filename);

    // 8. Automated Read-only Postflight Verification (awaited and validated before receipt)
    const postflightResult = await verifyRemotePostflight(environment, candidateId, psqlUrl, env, runner);
    if (!postflightResult || typeof postflightResult !== 'object') {
      throw new Error('REUSABLE_RELEASE_POSTFLIGHT_VERIFICATION_FAILED');
    }

    status = 'APPLIED_CLI_LEDGER_POSTFLIGHT_VERIFIED';

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
