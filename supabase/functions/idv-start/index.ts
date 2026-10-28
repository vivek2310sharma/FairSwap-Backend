import { readIdvEnvConfig, isIdvOperational, createSetuClientFromEnv } from "../_shared/idv/idv-config.ts";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

declare const Deno: {
  env: {
    toObject(): Record<string, string | undefined>;
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response>): void;
};

// Server-owned approved consent policy version
export const APPROVED_CONSENT_POLICY_VERSION = "v1.0";

export const startPayloadSchema = z.object({
  redirectPath: z.string().optional().default("/account/verification"),
  consentAcknowledged: z.literal(true, {
    errorMap: () => ({ message: "Affirmative consent acknowledgement is required." }),
  }),
  docCategory: z.enum(["aadhaar_kyc", "pan_card", "driving_licence"], {
    errorMap: () => ({ message: "Explicit document category consent is required before starting verification." }),
  }),
  policyVersion: z.string().optional().refine((val) => !val || val === APPROVED_CONSENT_POLICY_VERSION, {
    message: `Invalid policy version. Expected server-approved version ${APPROVED_CONSENT_POLICY_VERSION}.`,
  }),
});

export async function handleIdvStart(
  req: Request,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: unknown = {};
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = raw;
  } catch {
    // default to empty object
  }

  const parseResult = startPayloadSchema.safeParse(body);
  if (!parseResult.success) {
    return new Response(
      JSON.stringify({
        error: "CONSENT_REQUIRED",
        message: "Explicit consent acknowledgement is required before initiating identity verification.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  let config;
  try {
    config = readIdvEnvConfig(env);
  } catch {
    return new Response(
      JSON.stringify({
        error: "CONFIGURATION_ERROR",
        message: "Identity verification service is misconfigured.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // 1. Fail closed if not enabled or missing credentials
  if (!isIdvOperational(config)) {
    return new Response(
      JSON.stringify({
        error: "FEATURE_DISABLED",
        message: "Identity verification is coming soon.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2. Authenticate user from bearer JWT
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

  // Generate unpredictable single-use state nonce (64 hex characters)
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const stateNonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Call public server RPC wrapper via service client
  const { data: startResult, error: startError } = await adminClient.rpc(
    "server_idv_start_attempt",
    {
      p_user_id: userId,
      p_request_state: stateNonce,
      p_ttl_seconds: 900,
      p_consent_purpose: "FairSwap India Peer-to-Peer Identity Verification V1",
      p_consent_acknowledged: true,
      p_policy_version: APPROVED_CONSENT_POLICY_VERSION,
      p_evidence_category: parseResult.data.docCategory,
    }
  );

  if (startError || !startResult?.success) {
    const code = startResult?.error || "ATTEMPT_INITIALIZATION_FAILED";
    const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : 400;
    return new Response(JSON.stringify({ error: code, message: "Unable to start verification session." }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const attemptId = startResult.attempt_id;
  const setuClient = createSetuClientFromEnv(config, fetchImpl);
  if (!setuClient) {
    return new Response(JSON.stringify({ error: "PROVIDER_UNAVAILABLE", message: "Provider service is unavailable." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Build callback URL with state nonce
  const redirectUrl = new URL(config.SETU_REDIRECT_BASE_URL);
  redirectUrl.searchParams.set("state", stateNonce);

  try {
    const setuSession = await setuClient.createRequest(redirectUrl.toString());

    const { data: attachResult, error: attachError } = await adminClient.rpc("server_idv_attach_provider_session", {
      p_attempt_id: attemptId,
      p_provider_request_id: setuSession.id,
      p_provider_session_url: setuSession.url,
    });

    if (attachError || !attachResult?.success) {
      return new Response(
        JSON.stringify({
          error: "SESSION_ATTACHMENT_FAILED",
          message: "Failed to link verification session.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        attemptId,
        redirectUrl: setuSession.url,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch {
    // Never expose raw Setu errors or stack details to browser clients
    return new Response(
      JSON.stringify({
        error: "PROVIDER_REQUEST_FAILED",
        message: "Failed to initialize verification session with provider.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}

if (typeof Deno !== "undefined" && "serve" in Deno) {
  Deno.serve((req) => handleIdvStart(req, Deno.env.toObject()));
}
