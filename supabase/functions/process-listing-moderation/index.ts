// supabase/functions/process-listing-moderation/index.ts
// FairSwap Edge Function: process-listing-moderation
// Authorizes callers via service-role Vault token, claims batch of pending jobs,
// and routes them to Azure Moderation V1 dispatcher.
// Fail-closed invariant: If Azure is configured and fails or is unavailable, jobs fail closed to 'retry' / 'review';
// never revert to legacy 3-rule automatic approval.

import { createClient } from "@supabase/supabase-js";
import {
  authorizeModerationWorkerRequest,
  WorkerConfigSchema,
} from "../_shared/listing-moderation-worker";
import {
  processClaimedAzureJob,
  AzureWorkerConfigSchema,
} from "../_shared/azure-moderation-worker";

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

  const workerToken = req.headers.get("x-moderation-worker-secret");
  if (!workerToken || !/^[a-f0-9]{64}$/.test(workerToken)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  if (!(await authorizeModerationWorkerRequest(req, supabase))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Azure Moderation V1 configuration check
  const azureEndpoint = getEnv("AZURE_MODERATION_ENDPOINT");
  const azureSecret = getEnv("AZURE_MODERATION_SECRET");

  if (azureEndpoint && azureSecret) {
    const azureConfigResult = AzureWorkerConfigSchema.safeParse({
      supabaseUrl: config.supabaseUrl,
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
      azureModerationEndpoint: azureEndpoint,
      azureModerationSecret: azureSecret,
      batchSize: config.batchSize,
      leaseSeconds: config.leaseSeconds,
    });

    if (azureConfigResult.success) {
      const { data: jobs, error: claimError } = await supabase.rpc("claim_moderation_batch", {
        p_batch_size: config.batchSize,
        p_lease_seconds: config.leaseSeconds,
      });

      if (claimError) {
        return new Response(JSON.stringify({ error: claimError.message }), { status: 500 });
      }

      const results = [];
      for (const job of (jobs as any[]) || []) {
        results.push(await processClaimedAzureJob(job, supabase, azureConfigResult.data));
      }

      return new Response(JSON.stringify({ processedCount: results.length, results }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // If Azure is not configured, fall back to legacy prototype worker
  // Note: Database finalizer impl_finalize_moderation_result strictly prevents prototype_v0.1.1 from auto-approving.
  const { handleModerationWorkerRequest } = await import("../_shared/listing-moderation-worker");
  return handleModerationWorkerRequest(req, config, supabase);
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(processListingModerationHandler);
}
