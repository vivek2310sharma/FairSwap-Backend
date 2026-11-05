// supabase/functions/process-listing-moderation/index.ts
// FairSwap Edge Function: process-listing-moderation
// Authorizes callers via service-role Vault token, claims batch of pending jobs,
// resolves moderation provider mode server-side, and executes authoritative moderation.
// Fail-closed invariants:
// - Conflicts (both Azure and Google Cloud enabled) fail closed.
// - Google Cloud enabled without implemented adapter fails closed.
// - Provider failures never auto-approve; always route to review or retry.

import { createClient } from "@supabase/supabase-js";
import {
  authorizeModerationWorkerRequest,
  WorkerConfigSchema,
} from "../_shared/listing-moderation-worker";
import {
  processClaimedModerationJob,
  type ModerationJobOptions,
} from "../_shared/azure-moderation-worker";
import { resolveModerationMode } from "../_shared/moderation-mode-selector";

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

  // 1. Authoritative Server-Side Mode Resolution
  const modeResolution = await resolveModerationMode(supabase);
  if (modeResolution.error) {
    return new Response(
      JSON.stringify({
        error: `MODERATION_MODE_RESOLUTION_FAILED: ${modeResolution.error}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!modeResolution.enabled) {
    return new Response(
      JSON.stringify({
        processedCount: 0,
        enabled: false,
        reason: modeResolution.reason,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!modeResolution.mode) {
    return new Response(
      JSON.stringify({
        error: "MODERATION_MODE_RESOLUTION_FAILED: Missing mode",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (modeResolution.mode === "google_cloud") {
    return new Response(
      JSON.stringify({
        error: "GOOGLE_CLOUD_PROVIDER_NOT_IMPLEMENTED_FAIL_CLOSED",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2. Snapshot Provider Mode and Configuration for this batch
  const selectedMode = modeResolution.mode;
  const azureEndpoint = getEnv("AZURE_MODERATION_ENDPOINT");
  const azureSecret = getEnv("AZURE_MODERATION_SECRET");
  const openAiApiKey = getEnv("OPENAI_API_KEY");

  if (selectedMode === "azure" && (!azureEndpoint || !azureSecret)) {
    return new Response(
      JSON.stringify({
        error: "AZURE_PROVIDER_ENABLED_BUT_UNCONFIGURED_FAIL_CLOSED",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const jobOptions: ModerationJobOptions = {
    mode: selectedMode,
    azureEndpoint,
    azureSecret,
    openAiApiKey,
  };

  // 3. Claim batch under transaction lock
  const { data: jobs, error: claimError } = await supabase.rpc("claim_moderation_batch", {
    p_batch_size: config.batchSize,
    p_lease_seconds: config.leaseSeconds,
  });

  if (claimError) {
    return new Response(JSON.stringify({ error: claimError.message }), { status: 500 });
  }

  // 4. Authoritatively process each claimed job with snapshotted mode
  const results = [];
  for (const job of (jobs as any[]) || []) {
    results.push(await processClaimedModerationJob(job, supabase, jobOptions));
  }

  return new Response(
    JSON.stringify({
      processedCount: results.length,
      mode: selectedMode,
      results,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(processListingModerationHandler);
}
