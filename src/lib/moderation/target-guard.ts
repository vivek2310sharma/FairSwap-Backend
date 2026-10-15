// src/lib/moderation/target-guard.ts
// Strict validation for test database and HTTP PostgREST integration targets

export interface ValidatedTestTargetConfig {
  isOptedIn: boolean;
  runId: string;
  host: string;
  port: number;
  db: string;
  restUrl: string;
  serviceRoleKey?: string;
  anonKey?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Validates database and HTTP targets for integration testing.
 * Fails closed before any network request if any parameter is invalid, non-loopback,
 * or targets a hosted/remote environment.
 */
export function validateTestTargetConfig(
  env: Record<string, string | undefined>
): ValidatedTestTargetConfig {
  const isOptedIn = env.MOD03A_RUN_LOCAL_DB_TESTS === "true";
  if (!isOptedIn) {
    return {
      isOptedIn: false,
      runId: "",
      host: "127.0.0.1",
      port: 5433,
      db: "postgres",
      restUrl: "http://127.0.0.1:54321",
    };
  }

  const rawRunId = env.MOD03A_TASK_RUN_ID;
  const rawHost = env.MOD03A_DB_HOST;
  const rawPort = env.MOD03A_DB_PORT;
  const rawDb = env.MOD03A_DB_NAME || "postgres";
  const rawRestUrl = env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";

  if (!rawRunId || rawRunId.trim().length === 0) {
    throw new Error("ABORT: MOD03A_TASK_RUN_ID must be explicitly set and non-empty when MOD03A_RUN_LOCAL_DB_TESTS=true.");
  }
  if (!rawHost || rawHost.trim().length === 0) {
    throw new Error("ABORT: MOD03A_DB_HOST must be explicitly specified when MOD03A_RUN_LOCAL_DB_TESTS=true.");
  }
  if (!rawPort || isNaN(parseInt(rawPort, 10))) {
    throw new Error("ABORT: MOD03A_DB_PORT must be an explicitly specified integer when MOD03A_RUN_LOCAL_DB_TESTS=true.");
  }
  if (!LOOPBACK_HOSTS.has(rawHost)) {
    throw new Error(`ABORT: Database host "${rawHost}" is not on the loopback allowlist.`);
  }

  // Parse and strictly validate PostgREST HTTP target
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawRestUrl);
  } catch {
    throw new Error(`ABORT: Invalid NEXT_PUBLIC_SUPABASE_URL format: "${rawRestUrl}".`);
  }

  if (parsedUrl.protocol !== "http:") {
    throw new Error(`ABORT: Insecure/unsupported protocol "${parsedUrl.protocol}" for local test target. Only "http:" is allowed on loopback.`);
  }

  const httpHostname = parsedUrl.hostname;
  if (!LOOPBACK_HOSTS.has(httpHostname)) {
    throw new Error(`ABORT: HTTP target host "${httpHostname}" is not on the loopback allowlist. Hosted environments are strictly forbidden.`);
  }

  const httpPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 80;
  if (isNaN(httpPort) || httpPort <= 0 || httpPort > 65535) {
    throw new Error(`ABORT: Invalid HTTP port "${parsedUrl.port}" for local test target.`);
  }

  // Ensure origin is clean with no auth credentials embedded in URL
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("ABORT: Embedded credentials in NEXT_PUBLIC_SUPABASE_URL are forbidden.");
  }

  return {
    isOptedIn: true,
    runId: rawRunId,
    host: rawHost,
    port: parseInt(rawPort, 10),
    db: rawDb,
    restUrl: parsedUrl.origin,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}
