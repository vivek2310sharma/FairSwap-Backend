// supabase/functions/idv-revocation-worker/index.ts
// FairSwap Edge Function: idv-revocation-worker
// Scheduled or securely dispatched worker that executes bounded Setu DigiLocker token revocations.

import { createClient } from "@supabase/supabase-js";
import { runIdvRevocationRetryWorker, sanitizeRevocationError } from "../_shared/idv/idv-revocation-worker.ts";

declare const Deno: {
  env: {
    toObject(): Record<string, string | undefined>;
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response>): void;
};

export async function handleIdvRevocationWorker(
  req: Request,
  env: Record<string, string | undefined>
): Promise<Response> {
  // Allow POST invocation via scheduled cron or authorized maintenance worker dispatch
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Authorization check: require service role bearer or shared worker secret
  const authHeader = req.headers.get("Authorization");
  const workerSecretHeader = req.headers.get("x-idv-worker-secret");
  const expectedSecret = env["IDV_WORKER_SECRET"];
  const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"];

  const isAuthorized =
    (authHeader && serviceKey && authHeader === `Bearer ${serviceKey}`) ||
    (expectedSecret && workerSecretHeader === expectedSecret);

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = env["SUPABASE_URL"];
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "CONFIGURATION_ERROR", message: "Missing backend configuration" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Extract optional batch size from query param or body
  let batchSize = 10;
  try {
    const url = new URL(req.url);
    const sizeParam = url.searchParams.get("batchSize");
    if (sizeParam) {
      batchSize = parseInt(sizeParam, 10);
    }
  } catch {
    // default batch size
  }

  try {
    const result = await runIdvRevocationRetryWorker(env, supabase, { batchSize });
    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "REVOCATION_WORKER_FAILED",
        message: sanitizeRevocationError(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req) => handleIdvRevocationWorker(req, Deno.env.toObject()));
}
