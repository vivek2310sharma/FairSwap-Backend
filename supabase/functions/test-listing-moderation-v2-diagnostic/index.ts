import postgres from "postgres";
import {
  type SqlConnection,
  workerDatabase,
} from "../_shared/listing-moderation-v2-postgres.ts";
import { createTestModerationV2Runtime } from "../_shared/listing-moderation-v2-runtime.ts";
import { syntheticDependencies } from "../_shared/listing-moderation-v2-synthetic.ts";

// Connected Test-only synthetic worker. Provider and object transports have no
// live network implementation. Deployment, fixture enrollment and gates require
// separate approval; this source does not approve policy or enable dispatch.
Deno.serve(async (request) => {
  const deny = (code: string, status = 503) =>
    Response.json({ code }, { status });
  if (request.method !== "POST") return deny("METHOD_NOT_ALLOWED", 405);
  const dispatch = Deno.env.get("MOD_V2_TEST_DISPATCH_SECRET");
  if (
    !dispatch || dispatch.length < 32 ||
    request.headers.get("authorization") !== `Bearer ${dispatch}`
  ) return deny("UNAUTHORIZED", 401);
  if (
    Deno.env.get("SUPABASE_URL") !== "https://wpppxlnbzqynvhpeuavd.supabase.co"
  ) return deny("TEST_TARGET_REQUIRED");
  // Both secrets come from a separately provisioned Test deployment inventory.
  // Never accept credentials, targets, object URLs or bytes in an invocation body.
  const password = Deno.env.get("MOD_V2_TEST_DB_PASSWORD"),
    user = Deno.env.get("MOD_V2_TEST_DB_USER");
  const secret = Deno.env.get("MOD_V2_TEST_WORKER_SECRET"),
    ca = Deno.env.get("MOD_V2_TEST_DB_CA");
  if (
    !password || !user || !/^mv2_worker_test_[a-z0-9_]{1,32}$/.test(user) ||
    !secret || !/^[0-9a-f]{64}$/.test(secret) || !ca
  ) return deny("CONFIG_REQUIRED");
  let sql: ReturnType<typeof postgres> | undefined;
  let stage = "INIT";
  try {
    stage = "POSTGRES_CLIENT_INIT";
    sql = postgres({
      host: "aws-0-ap-south-1.pooler.supabase.com",
      port: 5432,
      database: "postgres",
      username: `${user}.wpppxlnbzqynvhpeuavd`,
      password,
      ssl: { rejectUnauthorized: true, ca },
      prepare: false,
      max: 1,
      connect_timeout: 10,
      idle_timeout: 5,
      max_lifetime: 60,
      connection: {
        application_name: "fairswap-v2-test-candidate",
        statement_timeout: 10000,
        lock_timeout: 4000,
      },
      onnotice: () => {},
      debug: false,
    });
    stage = "WORKER_AUTH";
    await workerDatabase(sql as unknown as SqlConnection, secret)
      .authenticate();
    const fixture = Deno.env.get("MOD_V2_TEST_FIXTURE_PACKAGE"),
      pin = Deno.env.get("MOD_V2_TEST_FIXTURE_SHA256"),
      processor = Deno.env.get("MOD_V2_TEST_PROCESSOR_BUILD"),
      build = Deno.env.get("MOD_V2_TEST_EVALUATOR_BUILD"),
      workerId = Deno.env.get("MOD_V2_TEST_WORKER_ID");
    if (!fixture || !pin || !processor || !build || !workerId) {
      return deny("SYNTHETIC_CONFIG_REQUIRED");
    }
    stage = "SYNTHETIC_FIXTURE_VALIDATION";
    const dependencies = await syntheticDependencies(fixture, pin, processor);
    const useRealOpenAI = Deno.env.get("MOD_V2_TEST_USE_REAL_OPENAI") === "true";
    let transport = dependencies.transport;
    let apiKey = dependencies.apiKey;
    if (useRealOpenAI) {
      const liveKey = Deno.env.get("OPENAI_API_KEY");
      if (!liveKey || !liveKey.startsWith("sk-")) {
        return deny("OPENAI_API_KEY_REQUIRED");
      }
      apiKey = liveKey.trim();
      transport = async (url: string, init: RequestInit) => {
        return await fetch(url, init);
      };
    }
    stage = "RUNTIME_ASSEMBLY";
    return await createTestModerationV2Runtime({
      ...dependencies,
      apiKey,
      transport,
      connection: sql as unknown as SqlConnection,
      workerSecret: secret,
      dispatchSecret: dispatch,
      build,
      workerId,
      now: () => Date.now(),
    })(request);
  } catch (err: unknown) {
    const errorRecord = err && typeof err === "object" ? err as Record<string, unknown> : null;
    const rawSqlstate = typeof errorRecord?.code === "string" && /^[A-Z0-9]{5}$/.test(errorRecord.code)
      ? errorRecord.code
      : null;
    const code = err instanceof Error && /^[A-Z_]+$/.test(err.message) ? err.message : null;
    let detail: string | null = null;
    if (stage === "SYNTHETIC_FIXTURE_VALIDATION" && err instanceof Error) {
      const fixture = Deno.env.get("MOD_V2_TEST_FIXTURE_PACKAGE") || "";
      const pin = Deno.env.get("MOD_V2_TEST_FIXTURE_SHA256") || "";
      const len = fixture.length;
      const pinLen = pin.length;
      detail = `len:${len},pinLen:${pinLen}`;
    }
    console.error(JSON.stringify({
      worker_diagnostic: true,
      stage,
      sqlstate: rawSqlstate,
      kind: code || (rawSqlstate ? "SQL_ERROR" : "INTERNAL_ERROR"),
      detail
    }));
    return deny("WORKER_AUTHENTICATION_OR_CONNECTION_FAILED");
  } finally {
    try {
      await sql?.end({ timeout: 2 });
    } catch { /* No raw driver diagnostics. */ }
  }
});
