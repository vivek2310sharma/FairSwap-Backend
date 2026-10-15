// supabase/functions/_shared/listing-moderation-worker.ts
// Shared core logic for server-side moderation worker.
// Runs the accepted MOD-01A text checker, handles lease claiming,
// maps outcomes, validates RPC outputs, and invokes the atomic service-role publication gate.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateListingText } from "../../../src/lib/moderation/checker";
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

  // 1. Run canonical MOD-01A evaluator on claimed listing text
  const evalResult: ModerationEvaluationResult = evaluateListingText({
    title: job.title,
    description: job.description,
  });

  // 2. Prepare payload for atomic publication gate RPC
  let completedRules: string[] = [];
  let failedRules: string[] = [];
  let flags: unknown[] = [];
  let errors: unknown[] = [];

  if (evalResult.outcome === "no_review_flags") {
    completedRules = [...evalResult.completedRules];
    flags = [];
    errors = [];
  } else if (evalResult.outcome === "needs_review") {
    completedRules = [...evalResult.completedRules];
    flags = [...evalResult.flags];
    errors = [];
  } else if (evalResult.outcome === "checks_incomplete") {
    completedRules = [...evalResult.completedRules];
    failedRules = [...evalResult.failedRules];
    flags = [...evalResult.flags];
    errors = [];
  } else if (evalResult.outcome === "invalid_input") {
    errors = [...evalResult.errors];
  }

  // 3. Call atomic publication gate (service-role only via public wrapper)
  const { data, error } = await supabase.rpc("impl_finalize_moderation_result", {
    p_request_id: job.request_id,
    p_claim_token: job.claim_token,
    p_outcome: evalResult.outcome,
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
