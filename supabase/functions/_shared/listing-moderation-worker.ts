// supabase/functions/_shared/listing-moderation-worker.ts
// Shared core logic for server-side moderation worker.
// Runs the accepted MOD-01A text checker, handles lease claiming,
// maps outcomes, validates RPC outputs, and invokes the atomic service-role publication gate.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateListingText } from "../../../src/lib/moderation/checker";
import { reviewListingContentSafety } from "./listing-media-safety";

declare const Deno: { env: { get(name: string): string | undefined } };
import {
  MODERATION_RULESET_VERSION,
  MODERATION_EVALUATION_SCOPE,
  type ModerationEvaluationResult,
} from "../../../src/lib/moderation/contract";

export const WorkerConfigSchema = z.object({
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(1),
  moderationWorkerSecret: z.string().min(1),
  batchSize: z.coerce.number().int().positive().max(100).default(10),
  leaseSeconds: z.coerce.number().int().positive().max(600).default(60),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const ClaimedModerationJobSchema = z.object({
  request_id: z.string().uuid(),
  listing_id: z.string().uuid(),
  listing_revision: z.number().int(),
  generation_id: z.string().uuid(),
  claim_token: z.string().uuid(),
  attempt_count: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
});

export type ClaimedModerationJob = z.infer<typeof ClaimedModerationJobSchema>;

export const FinalizeResultSchema = z.object({
  success: z.boolean(),
  decision: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  errors: z.unknown().optional(),
  next_attempt_at: z.string().optional(),
});

export type FinalizeResult = z.infer<typeof FinalizeResultSchema>;

export async function processClaimedJob(
  rawJob: unknown,
  supabase: SupabaseClient
): Promise<{ success: boolean; decision?: string; error?: string }> {
  // Validate claimed job contract strictly
  const parsedJob = ClaimedModerationJobSchema.safeParse(rawJob);
  if (!parsedJob.success) {
    return {
      success: false,
      error: `INVALID_CLAIMED_JOB_SHAPE: ${JSON.stringify(parsedJob.error.issues)}`,
    };
  }
  const job = parsedJob.data;

  // Legacy three-rule evaluation is retained WITHOUT modifying keyword/regex
  // rules; the SQL V1 finalizer requires its unchanged version and scope.
  const legacy = evaluateListingText({
    title: job.title,
    description: job.description,
  });

  let outcome = legacy.outcome;
  const completedRules = "completedRules" in legacy ? [...legacy.completedRules] : [];
  const failedRules = "failedRules" in legacy ? [...legacy.failedRules] : [];
  const flags: unknown[] = "flags" in legacy ? [...legacy.flags] : [];
  const errors: unknown[] = "errors" in legacy ? [...legacy.errors] : [];

  // OpenAI Moderation runs for both text and ALL attached images before
  // otherwise clean listings can be automatically approved. The separate
  // OpenAI marketplace-policy check handles firearm sales and fraud, which
  // the harm-oriented moderation categories do not guarantee to detect.
  if (legacy.outcome !== "invalid_input") {
    const key = typeof Deno !== "undefined"
      ? Deno.env.get("OPENAI_API_KEY")
      : process.env.OPENAI_API_KEY;
    const ai = await reviewListingContentSafety({
      listingId: job.listing_id,
      revision: job.listing_revision,
      title: job.title,
      description: job.description,
    }, supabase, key);

    if (ai.state === "review") {
      outcome = "needs_review";
      flags.push({
        ruleId: "openai_content_review",
        source: ai.source,
        reason: ai.reason,
      });
    } else if (ai.state === "incomplete" && outcome === "no_review_flags") {
      // Never translate OpenAI errors or missing images into a clear verdict.
      outcome = "checks_incomplete";
      errors.push({ source: "openai", code: ai.reason });
    }
  }

  // 3. Call atomic publication gate (service-role only via public wrapper)
  const { data, error } = await supabase.rpc("impl_finalize_moderation_result", {
    p_request_id: job.request_id,
    p_claim_token: job.claim_token,
    p_outcome: outcome,
    p_ruleset_version: MODERATION_RULESET_VERSION,
    p_scope: MODERATION_EVALUATION_SCOPE,
    p_completed_rules: completedRules,
    p_failed_rules: failedRules,
    p_flags: flags,
    p_errors: errors,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const parsedFinalize = FinalizeResultSchema.safeParse(data);
  if (!parsedFinalize.success) {
    return {
      success: false,
      error: `MALFORMED_FINALIZATION_RESPONSE: ${JSON.stringify(parsedFinalize.error.issues)}`,
    };
  }

  const fin = parsedFinalize.data;
  if (!fin.success) {
    return {
      success: false,
      error: fin.error || "FINALIZATION_REJECTED",
      decision: fin.decision,
    };
  }

  return { success: true, decision: fin.decision };
}

export async function handleModerationWorkerRequest(
  req: Request,
  config: WorkerConfig,
  supabase: SupabaseClient
): Promise<Response> {
  // Enforce worker secret authentication boundary
  const secretHeader = req.headers.get("x-moderation-worker-secret");
  if (!secretHeader || secretHeader !== config.moderationWorkerSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized: Invalid worker secret" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Claim batch of jobs
    const { data: rawJobs, error: claimError } = await supabase.rpc("claim_moderation_batch", {
      p_batch_size: config.batchSize,
      p_lease_seconds: config.leaseSeconds,
    });

    if (claimError) {
      return new Response(JSON.stringify({ error: "Claim error: " + claimError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const claimedJobs: unknown[] = Array.isArray(rawJobs) ? rawJobs : [];
    const results = [];

    for (const rawJob of claimedJobs) {
      const outcome = await processClaimedJob(rawJob, supabase);
      const jobRecord = typeof rawJob === "object" && rawJob !== null ? (rawJob as Record<string, unknown>) : {};
      results.push({
        request_id: typeof jobRecord.request_id === "string" ? jobRecord.request_id : undefined,
        listing_id: typeof jobRecord.listing_id === "string" ? jobRecord.listing_id : undefined,
        ...outcome,
      });
    }

    return new Response(
      JSON.stringify({
        processed: results.length,
        results,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: "Worker error: " + message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}


/**
 * Validates a dispatch token against the encrypted Supabase Vault copy, without
 * exposing the secret to the Edge Function's environment or API callers.
 * The database RPC is executable by service_role only and returns a boolean.
 * Never invoke moderation claim/finalization on a failed or unavailable check.
 */
export async function authorizeModerationWorkerRequest(
  req: Request,
  supabase: SupabaseClient
): Promise<boolean> {
  const candidate = req.headers.get("x-moderation-worker-secret");
  if (!candidate || !/^[a-f0-9]{64}$/.test(candidate)) {
    return false;
  }

  try {
    const { data, error } = await supabase.rpc("verify_moderation_worker_secret", {
      p_candidate: candidate,
    });
    return error === null && data === true;
  } catch {
    return false;
  }
}
