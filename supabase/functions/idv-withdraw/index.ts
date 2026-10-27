import { createClient } from "@supabase/supabase-js";
import { readIdvEnvConfig, createSetuRevocationClient } from "../_shared/idv/idv-config";

declare const Deno: {
  env: {
    toObject(): Record<string, string | undefined>;
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response>): void;
};

export async function handleIdvWithdraw(
  req: Request,
  env: Record<string, string | undefined>
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  // server_idv_withdraw_consent atomically revokes local badge/record, cancels in-flight attempts,
  // and durably queues token revocation for the revocation worker in the same database transaction.
  const { data: result, error } = await adminClient.rpc("server_idv_withdraw_consent", {
    p_user_id: userId,
  });

  if (error || !result?.success) {
    return new Response(
      JSON.stringify({ error: result?.error || "WITHDRAW_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      message: "Consent withdrawn and identity verification revoked.",
      queued_revocations: Array.isArray(result.attempts) ? result.attempts.length : 0,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

if (typeof Deno !== "undefined" && "serve" in Deno) {
  Deno.serve((req) => handleIdvWithdraw(req, Deno.env.toObject()));
}
