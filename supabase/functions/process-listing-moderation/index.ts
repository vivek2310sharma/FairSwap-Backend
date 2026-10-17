// supabase/functions/process-listing-moderation/index.ts
// FairSwap Edge Function: process-listing-moderation
// Database-initiated requests are authorized via a service-role-only Vault check.

import { createClient } from "@supabase/supabase-js";
import {
  authorizeModerationWorkerRequest,
  handleModerationWorkerRequest,
  WorkerConfigSchema,
} from "../_shared/listing-moderation-worker";

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response>): void;
};

export async function processListingModerationHandler(req: Request): Promise<Response> {
  const getEnv = (k: string) => {
    if (typeof Deno !== "undefined" && Deno.env) {
      return Deno.env.get(k);
    }
    return process.env[k];
  };

  // Reject malformed requests before connecting to the database.
  const workerToken = req.headers.get("x-moderation-worker-secret");
  if (!workerToken || !/^[a-f0-9]{64}$/.test(workerToken)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are Supabase-hosted defaults.
  // The dispatch token itself lives only in encrypted Vault; not in source or
  // Edge Function environment variables.
  const rawEnv = {
    supabaseUrl: getEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    moderationWorkerSecret: workerToken,
    batchSize: getEnv("MODERATION_BATCH_SIZE") || "10",
    leaseSeconds: getEnv("MODERATION_LEASE_SECONDS") || "60",
  };

  const parsedConfig = WorkerConfigSchema.safeParse(rawEnv);
  if (!parsedConfig.success) {
    return new Response(JSON.stringify({ error: "Missing or invalid worker configuration" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const config = parsedConfig.data;
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fail closed before any moderation claim or listing update.
  if (!(await authorizeModerationWorkerRequest(req, supabase))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return handleModerationWorkerRequest(req, config, supabase);
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(processListingModerationHandler);
}
