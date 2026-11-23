#!/usr/bin/env node
/**
 * Test Suite: FairSwap Account Security DigiLocker Email Delivery V2
 * Verifies template byte/branding parity, SQL hardening/idempotency/RLS guarantees,
 * safe deactivation rollback, real in-memory PostgreSQL 17 execution (via PGlite),
 * and worker processing contracts (idempotency keys, Resend delivery, RPC completions, fail-closed errors).
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  renderEmailTemplate,
  renderAccountSecurityHtml,
  renderAccountSecurityText,
  claimJobs,
  processSingleJob,
  calculateBackoffSeconds,
  sanitizeErrorMessage,
} from "../../supabase/functions/_shared/email-outbox-worker.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../../");

export async function runAccountSecurityEmailTests() {
  console.log("=== Running Account Security DigiLocker Email V2 Verification Suite ===\n");

  // ---------------------------------------------------------------------------
  // 1. Template Verification & First-Party Asset Checks
  // ---------------------------------------------------------------------------
  console.log("1. Verifying approved email templates and first-party branding...");

  const prodUrl = "https://fairswap.in";
  const testUrl = "https://fair-swap-git-staging-fairswap.vercel.app";

  const prodRendered = renderEmailTemplate("account_security_digilocker", {}, prodUrl);
  const testRendered = renderEmailTemplate("account_security_digilocker", {}, testUrl);

  const expectedSubject = "FairSwap account security: Please verify your account";
  const expectedPreheader = "For account security, please verify your identity with DigiLocker from My Account.";
  const expectedFairSwapLogo = "https://fairswap.in/brand/FairSwap_Web_Logo_Transparent.png";

  // Production checks
  assert.equal(prodRendered.subject, expectedSubject, "Production subject mismatch");
  assert.ok(prodRendered.html.includes(expectedPreheader), "Production preheader missing");
  assert.ok(prodRendered.html.includes(expectedFairSwapLogo), "FairSwap logo missing from HTML");
  assert.ok(prodRendered.html.includes('alt="FairSwap"'), "FairSwap alt text missing");
  assert.ok(prodRendered.html.includes(`${prodUrl}/brand/digilocker-logo.png`), "Production HTML must use first-party DigiLocker logo");
  assert.ok(prodRendered.html.includes('alt="DigiLocker"'), "DigiLocker alt text missing");
  assert.ok(prodRendered.html.includes(`href="${prodUrl}/account"`), "Production CTA must point to https://fairswap.in/account");
  assert.ok(!prodRendered.html.includes("/account/verification"), "Must never link to /account/verification");
  assert.ok(!prodRendered.html.includes("upload.wikimedia.org"), "Must not use external Wikimedia URL");
  assert.ok(!/<script/i.test(prodRendered.html), "Executable script detected in HTML");
  assert.ok(prodRendered.text.includes(`Go to My Account: ${prodUrl}/account`), "Production text CTA mismatch");
  assert.ok(prodRendered.text.includes("FairSwap will never ask for your DigiLocker PIN"), "Security notice missing from text");

  // Test / Staging checks
  assert.equal(testRendered.subject, expectedSubject, "Test subject mismatch");
  assert.ok(testRendered.html.includes(expectedPreheader), "Test preheader missing");
  assert.ok(testRendered.html.includes(`${testUrl}/brand/digilocker-logo.png`), "Test HTML must use first-party DigiLocker logo");
  assert.ok(testRendered.html.includes(`href="${testUrl}/account"`), "Test CTA must point to staging /account");
  assert.ok(!testRendered.html.includes("/account/verification"), "Test must never link to /account/verification");
  assert.ok(!testRendered.html.includes("upload.wikimedia.org"), "Test must not use external Wikimedia URL");
  assert.ok(testRendered.text.includes(`Go to My Account: ${testUrl}/account`), "Test text CTA mismatch");

  // Optional check: verify first-party hosted DigiLocker asset if sibling Web repository is present
  const siblingWebDir = path.resolve(backendRoot, "../FairSwap-Web");
  if (existsSync(siblingWebDir)) {
    const webDigiLockerLogo = path.join(siblingWebDir, "public/brand/digilocker-logo.png");
    assert.ok(
      existsSync(webDigiLockerLogo),
      "First-party hosted DigiLocker asset missing at FairSwap-Web/public/brand/digilocker-logo.png"
    );
  }

  // Deterministic stable SHA-256 assertions
  const sha = (str) => createHash("sha256").update(str).digest("hex");
  assert.equal(sha(prodRendered.html), "83945608c3eef64d3075dfde19905dd26cbab8f386e392e2db70ce45e26b9ecf", "Prod HTML sha256 mismatch");
  assert.equal(sha(prodRendered.text), "ce50e3573515165db1f8859d994afea82661add5e5fee221ba3e74b4e49c33ab", "Prod Text sha256 mismatch");
  assert.equal(sha(testRendered.html), "ae5118e75f901fe05e469630c28b5244be1873fb9864e89e5e7efeb19270ae17", "Test HTML sha256 mismatch");
  assert.equal(sha(testRendered.text), "b63b6f3da9936369817a1295316bd9dc50ee7b9d357f9de2d680279e837513db", "Test Text sha256 mismatch");

  console.log("   ✓ Production and Test templates verified with first-party DigiLocker asset and stable hashes.");
  console.log("   ✓ Verified no Wikimedia URLs, no /account/verification links, and accessible alt text.");

  // ---------------------------------------------------------------------------
  // 2. Migration & Rollback SQL Static Invariants
  // ---------------------------------------------------------------------------
  console.log("\n2. Verifying additive SQL migration and non-destructive deactivation invariants...");

  const migrationPath = path.join(backendRoot, "supabase/forward-migrations/account-security-email/20261122213000_account_security_digilocker_email_outbox.sql");
  const rollbackPath = path.join(backendRoot, "supabase/forward-migrations/account-security-email/rollback.sql");

  assert.ok(existsSync(migrationPath), "Migration file 20261122213000_account_security_digilocker_email_outbox.sql missing");
  assert.ok(existsSync(rollbackPath), "Rollback script missing");

  const migrationSql = readFileSync(migrationPath, "utf8");
  const rollbackSql = readFileSync(rollbackPath, "utf8");

  // Hardening headers
  assert.ok(migrationSql.includes("begin;"), "Migration missing 'begin;'");
  assert.ok(migrationSql.includes("set local lock_timeout = '5s';"), "Migration missing lock_timeout");
  assert.ok(migrationSql.includes("set local statement_timeout = '30s';"), "Migration missing statement_timeout");
  assert.ok(migrationSql.includes("commit;"), "Migration missing 'commit;'");

  // Schema and RLS
  assert.ok(migrationSql.includes("CREATE TABLE IF NOT EXISTS public.security_email_outbox"), "Table public.security_email_outbox missing");
  assert.ok(migrationSql.includes("CONSTRAINT uq_security_email_outbox_user_event UNIQUE (recipient_user_id, event_type)"), "Unique idempotency constraint missing");
  assert.ok(migrationSql.includes("ALTER TABLE public.security_email_outbox ENABLE ROW LEVEL SECURITY;"), "RLS not enabled");
  assert.ok(migrationSql.includes("ALTER TABLE public.security_email_outbox FORCE ROW LEVEL SECURITY;"), "RLS not forced");
  assert.ok(migrationSql.includes("REVOKE ALL ON public.security_email_outbox FROM PUBLIC, anon, authenticated;"), "Least privilege revoke missing");
  assert.ok(migrationSql.includes("GRANT ALL ON public.security_email_outbox TO service_role;"), "Service role grant missing");

  // Trigger checks
  assert.ok(migrationSql.includes("CREATE TRIGGER trg_auth_user_signup_security_email"), "Trigger missing");
  assert.ok(migrationSql.includes("AFTER UPDATE ON auth.users"), "Trigger must fire AFTER UPDATE ON auth.users");
  assert.ok(migrationSql.includes("WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)"), "Trigger condition must only fire on initial confirmation");
  assert.ok(migrationSql.includes("ON CONFLICT (recipient_user_id, event_type) DO NOTHING"), "Trigger insert must be idempotent");
  assert.ok(!migrationSql.includes("net.http_post"), "Must NOT perform network calls inside auth.users confirmation transaction");

  // Safe deactivation rollback: must NOT drop the table or delivery history
  assert.ok(rollbackSql.includes("DROP TRIGGER IF EXISTS trg_auth_user_signup_security_email ON auth.users;"), "Rollback must drop trigger");
  assert.ok(rollbackSql.includes("DROP FUNCTION IF EXISTS app_security.trg_fn_enqueue_signup_security_email();"), "Rollback must drop trigger function");
  assert.ok(!rollbackSql.includes("DROP TABLE"), "Rollback must NOT drop tables (data preservation requirement)");

  console.log("   ✓ SQL migration hardening, idempotency, RLS, and non-destructive deactivation verified.");

  // ---------------------------------------------------------------------------
  // 3. Real PostgreSQL 17 Execution (via in-memory PGlite)
  // ---------------------------------------------------------------------------
  console.log("\n3. Executing real PostgreSQL 17 integration tests in PGlite...");

  const cliPgliteArg = process.argv.find((x) => x.startsWith("--pglite-module="))?.slice("--pglite-module=".length);
  const pgliteCandidates = [
    cliPgliteArg ? path.resolve(cliPgliteArg) : null,
    path.join(backendRoot, "tests/ratings/node_modules/@electric-sql/pglite/dist/index.js"),
    path.join(backendRoot, "node_modules/@electric-sql/pglite/dist/index.js"),
  ].filter(Boolean);
  const pgliteEntry = pgliteCandidates.find((p) => existsSync(p)) ?? pgliteCandidates[0];
  assert.ok(existsSync(pgliteEntry), `PGlite module missing at ${pgliteEntry}`);

  const { PGlite } = await import(pathToFileURL(pgliteEntry).href);
  const db = new PGlite();

  // Initialize roles and baseline schema
  await db.exec(`
    CREATE ROLE service_role;
    CREATE ROLE anon;
    CREATE ROLE authenticated;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS app_security;

    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      email_confirmed_at timestamptz
    );

    CREATE TYPE public.email_outbox_status AS ENUM (
      'pending',
      'processing',
      'retry',
      'sent',
      'dead_letter'
    );

    CREATE TYPE public.email_outbox_event_type AS ENUM (
      'listing_approved',
      'listing_rejected',
      'account_security_digilocker'
    );

    -- Baseline listing notifications outbox to verify isolation
    CREATE TABLE IF NOT EXISTS public.email_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type public.email_outbox_event_type NOT NULL,
      recipient_user_id uuid NOT NULL,
      status public.email_outbox_status NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
  `);

  // Apply the additive forward migration
  await db.exec(migrationSql);

  // 3a. Test: User signup without confirmation does NOT enqueue
  const user1 = "11111111-1111-4111-8111-111111111111";
  await db.query(
    "INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, NULL)",
    [user1, "unconfirmed@example.com"]
  );

  let outboxRows = await db.query("SELECT * FROM public.security_email_outbox WHERE recipient_user_id = $1", [user1]);
  assert.equal(outboxRows.rows.length, 0, "Unconfirmed user must not enqueue security notice");

  // 3b. Test: User confirms email -> exactly 1 row enqueued
  await db.query(
    "UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1",
    [user1]
  );

  outboxRows = await db.query("SELECT * FROM public.security_email_outbox WHERE recipient_user_id = $1", [user1]);
  assert.equal(outboxRows.rows.length, 1, "Confirmed user must enqueue exactly 1 security notice");
  assert.equal(outboxRows.rows[0].event_type, "account_security_digilocker");
  assert.equal(outboxRows.rows[0].status, "pending");
  assert.equal(outboxRows.rows[0].attempt_count, 0);

  // 3c. Test: Subsequent updates on confirmed user do NOT enqueue duplicates
  await db.query(
    "UPDATE auth.users SET email = $1 WHERE id = $2",
    ["updated_email@example.com", user1]
  );
  outboxRows = await db.query("SELECT * FROM public.security_email_outbox WHERE recipient_user_id = $1", [user1]);
  assert.equal(outboxRows.rows.length, 1, "Subsequent user updates must not create duplicate jobs");

  // 3d. Test: Worker claim RPCs and lock management
  const lockToken = "22222222-2222-4222-8222-222222222222";
  const claimBatchRes = await db.query(
    "SELECT * FROM public.claim_security_email_outbox_batch(10, $1::uuid, 600)",
    [lockToken]
  );
  assert.equal(claimBatchRes.rows.length, 1, "Worker claim RPC should return the 1 pending job");
  assert.equal(claimBatchRes.rows[0].id, outboxRows.rows[0].id);
  assert.equal(claimBatchRes.rows[0].status, "processing");
  assert.equal(claimBatchRes.rows[0].lock_token, lockToken);

  // 3e. Test: Worker complete RPC
  const completeRes = await db.query(
    "SELECT public.complete_security_email_outbox_job($1::uuid, $2::uuid, $3)",
    [outboxRows.rows[0].id, lockToken, "msg_resend_12345"]
  );
  assert.equal(completeRes.rows[0].complete_security_email_outbox_job, true);

  const completedRow = await db.query("SELECT * FROM public.security_email_outbox WHERE id = $1", [outboxRows.rows[0].id]);
  assert.equal(completedRow.rows[0].status, "sent");
  assert.equal(completedRow.rows[0].provider_message_id, "msg_resend_12345");
  assert.equal(completedRow.rows[0].lock_token, null);

  // 3f. Test: Existing public.email_outbox listing notifications table remained untouched
  const listingOutboxCount = await db.query("SELECT count(*)::int AS count FROM public.email_outbox");
  assert.equal(listingOutboxCount.rows[0].count, 0, "Listing outbox remained untouched");

  // 3g. Test: RLS restricts anon and authenticated access
  const rlsAnonCheck = await db.query(`
    SELECT has_table_privilege('anon', 'public.security_email_outbox', 'SELECT') as anon_select,
           has_table_privilege('authenticated', 'public.security_email_outbox', 'SELECT') as auth_select,
           has_table_privilege('service_role', 'public.security_email_outbox', 'SELECT') as service_select
  `);
  assert.equal(rlsAnonCheck.rows[0].anon_select, false, "anon must not have SELECT on security_email_outbox");
  assert.equal(rlsAnonCheck.rows[0].auth_select, false, "authenticated must not have SELECT on security_email_outbox");
  assert.equal(rlsAnonCheck.rows[0].service_select, true, "service_role must have SELECT on security_email_outbox");

  // 3h. Test: Safe deactivation rollback
  await db.exec(rollbackSql);

  // Second user confirms email after deactivation
  const user2 = "33333333-3333-4333-8333-333333333333";
  await db.query("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, NULL)", [user2, "user2@example.com"]);
  await db.query("UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1", [user2]);

  const user2Outbox = await db.query("SELECT * FROM public.security_email_outbox WHERE recipient_user_id = $1", [user2]);
  assert.equal(user2Outbox.rows.length, 0, "No new jobs enqueued after trigger deactivation");

  const totalRetained = await db.query("SELECT count(*)::int AS count FROM public.security_email_outbox");
  assert.equal(totalRetained.rows[0].count, 1, "Rollback safely preserved existing records and history");

  console.log("   ✓ PGlite: Signup confirmation enqueues once, ignores unconfirmed & repeat updates.");
  console.log("   ✓ PGlite: Worker claim, completion, and lock management verified.");
  console.log("   ✓ PGlite: Table privileges and RLS enforcement verified.");
  console.log("   ✓ PGlite: Non-destructive deactivation verified (halts triggers, preserves history).");

  // ---------------------------------------------------------------------------
  // 4. Worker Fail-Closed Error Handling & Dispatch Unit Verification
  // ---------------------------------------------------------------------------
  console.log("\n4. Verifying fail-closed RPC handling, Resend dispatch, and error recovery...");

  const sampleConfig = {
    supabaseUrl: "https://test.supabase.co",
    supabaseServiceRoleKey: "test-service-key",
    resendApiKey: "re_test_key_12345",
    emailFrom: "FairSwap <notifications@fairswap.in>",
    siteUrl: "https://fairswap.in",
    emailWorkerSecret: "test-worker-secret-42",
    maxAttempts: 5,
  };

  const sampleSecJob = {
    id: "sec-00000000-0000-0000-0000-000000000001",
    event_type: "account_security_digilocker",
    recipient_user_id: "user-sec-123",
    listing_id: null,
    transition_id: null,
    payload: { user_id: "user-sec-123", email_type: "account_security_digilocker" },
    status: "processing",
    attempt_count: 1,
    max_attempts: 5,
    next_attempt_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    lock_token: "token-sec-abc",
    provider_message_id: null,
    last_error_code: null,
    last_error_status: null,
    last_error_message: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    queue_type: "security",
  };

  // 4a. Verify fail-closed behavior: permission/database error throws
  const mockDbErrorSupabase = {
    rpc: async (fn) => {
      if (fn === "claim_email_outbox_batch") {
        return { data: [], error: null };
      }
      if (fn === "claim_security_email_outbox_batch") {
        return { data: null, error: { code: "42501", message: "permission denied for table security_email_outbox" } };
      }
      return { data: null, error: null };
    },
  };

  await assert.rejects(
    async () => {
      await claimJobs(mockDbErrorSupabase, null, "tok-fail", 600);
    },
    (err) => {
      assert.ok(err.message.includes("permission denied"), "Should throw on non-42883 error");
      return true;
    },
    "claimJobs must fail closed on unexpected database error"
  );

  // 4b. Verify rollout missing-function suppression: 42883 does NOT throw
  const mockRolloutSupabase = {
    rpc: async (fn) => {
      if (fn === "claim_email_outbox_batch") {
        return { data: [], error: null };
      }
      if (fn === "claim_security_email_outbox_batch") {
        return { data: null, error: { code: "42883", message: "function claim_security_email_outbox_batch does not exist" } };
      }
      return { data: null, error: null };
    },
  };
  const rolloutJobs = await claimJobs(mockRolloutSupabase, null, "tok-rollout", 600);
  assert.equal(rolloutJobs.length, 0, "Missing function during rollout safely returns empty without crash");

  // 4c. Verify Resend dispatch and idempotency key
  let capturedFetch = null;
  const mockFetchSuccess = async (url, init) => {
    capturedFetch = { url, init };
    return new Response(JSON.stringify({ id: "msg_resend_sec_999" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const rpcCalls = [];
  const mockWorkingSupabase = {
    auth: {
      admin: {
        getUserById: async (uid) => {
          if (uid === "user-sec-123") {
            return { data: { user: { id: uid, email: "user@example.com" } }, error: null };
          }
          return { data: null, error: { message: "User not found" } };
        },
      },
    },
    rpc: async (fn, params) => {
      rpcCalls.push({ fn, params });
      return { data: true, error: null };
    },
  };

  const resultSuccess = await processSingleJob(mockWorkingSupabase, sampleSecJob, sampleConfig, mockFetchSuccess);
  assert.equal(resultSuccess.success, true);
  assert.equal(resultSuccess.providerMessageId, "msg_resend_sec_999");
  assert.equal(capturedFetch.init.headers["Idempotency-Key"], `fairswap/security-email/${sampleSecJob.id}`);
  assert.equal(capturedFetch.init.headers["Authorization"], `Bearer ${sampleConfig.resendApiKey}`);

  const completeCall = rpcCalls.find((c) => c.fn === "complete_security_email_outbox_job");
  assert.ok(completeCall, "Must call complete_security_email_outbox_job on delivery");
  assert.equal(completeCall.params.p_provider_message_id, "msg_resend_sec_999");

  // 4d. Verify retryable rate-limit failure (429)
  const mockFetch429 = async () => new Response(JSON.stringify({ name: "rate_limit_exceeded" }), { status: 429 });
  rpcCalls.length = 0;
  const result429 = await processSingleJob(mockWorkingSupabase, sampleSecJob, sampleConfig, mockFetch429);
  assert.equal(result429.success, false);
  const fail429 = rpcCalls.find((c) => c.fn === "fail_security_email_outbox_job");
  assert.ok(fail429);
  assert.equal(fail429.params.p_is_permanent, false);
  assert.equal(fail429.params.p_backoff_seconds, calculateBackoffSeconds(1));

  // 4e. Verify permanent failure (403 forbidden)
  const mockFetch403 = async () => new Response(JSON.stringify({ name: "forbidden" }), { status: 403 });
  rpcCalls.length = 0;
  const result403 = await processSingleJob(mockWorkingSupabase, sampleSecJob, sampleConfig, mockFetch403);
  assert.equal(result403.success, false);
  const fail403 = rpcCalls.find((c) => c.fn === "fail_security_email_outbox_job");
  assert.ok(fail403);
  assert.equal(fail403.params.p_is_permanent, true);

  console.log("   ✓ Fail-closed error handling: 42501/unexpected throws, 42883 suppressed during rollout.");
  console.log("   ✓ Resend dispatch with exact idempotency key verified.");
  console.log("   ✓ Exponential backoff on 429 and dead-letter on 403 verified.");

  console.log("\n=== ALL ACCOUNT SECURITY EMAIL CHECKS PASSED SUCCESSFULLY ===");
}

// Run immediately when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAccountSecurityEmailTests();
}