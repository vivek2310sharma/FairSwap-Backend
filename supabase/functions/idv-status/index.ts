import { readIdvEnvConfig, isIdvOperational, createSetuClientFromEnv } from "../_shared/idv/idv-config";
import { createClient } from "@supabase/supabase-js";

declare const Deno: {
  env: {
    toObject(): Record<string, string | undefined>;
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response>): void;
};

export async function handleIdvStatus(
  req: Request,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = env["SUPABASE_URL"] || "";
  const supabaseAnonKey = env["SUPABASE_ANON_KEY"] || "";
  const supabaseServiceKey = env["SUPABASE_SERVICE_ROLE_KEY"] || "";

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = userData.user.id;
  const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // Query latest attempt for this user via server RPC
  const { data: attempt, error: attemptError } = await adminClient.rpc(
    "server_idv_get_latest_attempt",
    { p_user_id: userId }
  );

  if (attemptError || !attempt) {
    return new Response(
      JSON.stringify({ status: "not_started", hasActiveAttempt: false }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const config = readIdvEnvConfig(env);
  let providerStatus: string | null = null;

  // If in_progress and provider_request_id exists, poll Setu independently using GET /api/digilocker/:id/status
  if (attempt.status === "in_progress" && attempt.provider_request_id && isIdvOperational(config)) {
    const setuClient = createSetuClientFromEnv(config, fetchImpl);
    if (setuClient) {
      try {
        const res = await setuClient.getStatus(attempt.provider_request_id);
        providerStatus = res.status;
      } catch {
        // Provider status poll non-fatal for general status view
        providerStatus = "check_failed";
      }
    }
  }

  return new Response(
    JSON.stringify({
      attemptId: attempt.id,
      status: attempt.status,
      expiresAt: attempt.attempt_expires_at,
      providerStatus,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

if (typeof Deno !== "undefined" && "serve" in Deno) {
  Deno.serve((req) => handleIdvStatus(req, Deno.env.toObject()));
}
