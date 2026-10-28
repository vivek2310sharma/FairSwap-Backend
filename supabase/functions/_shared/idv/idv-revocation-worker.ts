/**
 * FairSwap IDV Token Revocation Retry Worker (Shared Core Logic)
 * Safely processes failed or pending Setu DigiLocker token revocations with bounded retries,
 * exponential backoff, safe concurrency claims, and auditable logging without exposing secrets.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  readIdvEnvConfig,
  createSetuRevocationClient,
  isIdvRevocationCapable,
  type IdvEnvConfig,
} from "./idv-config.ts";

export const RevocationWorkerConfigSchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(50).default(10),
  workerSecret: z.string().optional(),
});

export type RevocationWorkerConfig = z.infer<typeof RevocationWorkerConfigSchema>;

export interface PendingRevocationItem {
  attempt_id: string;
  provider_request_id: string;
  retry_count: number;
  last_error: string | null;
  lease_token?: string;
}

export interface RevocationWorkerResult {
  claimed: number;
  succeeded: number;
  failed: number;
  exhausted: number;
  skippedDueToMissingCredentials: boolean;
  errors: Array<{ attemptId: string; error: string }>;
}

/**
 * Sanitizes error messages so secrets, authorization headers, or provider keys are never exposed.
 */
export function sanitizeRevocationError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]")
    .replace(/client_secret=[^&\s]+/gi, "client_secret=[REDACTED]")
    .replace(/apiKey=[^&\s]+/gi, "apiKey=[REDACTED]")
    .slice(0, 500);
}

/**
 * Calculates exponential backoff seconds based on retry count.
 * Attempt 1: 30s, Attempt 2: 120s, Attempt 3: 480s
 */
export function calculateRevocationBackoffSeconds(retryCount: number): number {
  return Math.min(30 * Math.pow(4, Math.max(0, retryCount)), 3600);
}

/**
 * Executes a single run of the revocation retry worker.
 * Operates safely even if FAIRSWAP_IDV_ENABLED=false, because previously granted provider access
 * must always remain withdrawable.
 */
export async function runIdvRevocationRetryWorker(
  env: Record<string, string | undefined>,
  supabase: SupabaseClient,
  options: { batchSize?: number; leaseSeconds?: number; fetchImpl?: typeof fetch } = {}
): Promise<RevocationWorkerResult> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 10, 50));
  const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 600));
  const fetchImpl = options.fetchImpl ?? fetch;

  const result: RevocationWorkerResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    exhausted: 0,
    skippedDueToMissingCredentials: false,
    errors: [],
  };

  // 1. Claim pending retry rows atomically with durable lease token using server_idv_claim_revocation_retries
  const { data: claimData, error: claimError } = await supabase.rpc(
    "server_idv_claim_revocation_retries",
    { p_limit: batchSize, p_lease_seconds: leaseSeconds }
  );

  if (claimError || !claimData?.success) {
    throw new Error(`Failed to claim pending revocation retries: ${claimError?.message || "Unknown error"}`);
  }

  const defaultLeaseToken = claimData.lease_token as string | undefined;
  const rawItems = Array.isArray(claimData.claimed_retries) ? claimData.claimed_retries : [];
  const items: PendingRevocationItem[] = rawItems.map((item: any) => ({
    attempt_id: item.attempt_id,
    provider_request_id: item.provider_request_id,
    retry_count: item.retry_count,
    last_error: item.last_error,
    lease_token: item.lease_token || defaultLeaseToken,
  }));

  result.claimed = items.length;
  if (items.length === 0) {
    return result;
  }

  // 2. Resolve Setu config and revocation client
  let config: IdvEnvConfig | null = null;
  try {
    config = readIdvEnvConfig(env);
  } catch {
    config = null;
  }

  const setuClient = config && isIdvRevocationCapable(config)
    ? createSetuRevocationClient(config, fetchImpl)
    : null;

  // If credentials are unavailable, do not drop or silently succeed;
  // record failure with p_consume_retry: false so retry quota is NOT consumed.
  if (!setuClient) {
    result.skippedDueToMissingCredentials = true;
    for (const item of items) {
      const sanitizedErr = "Setu provider credentials unavailable for revocation retry";
      const { data: failData, error: failErr } = await supabase.rpc("server_idv_record_token_revocation_failed", {
        p_attempt_id: item.attempt_id,
        p_error: sanitizedErr,
        p_lease_token: item.lease_token || null,
        p_consume_retry: false,
      });

      if (failErr || !failData?.success) {
        result.errors.push({ attemptId: item.attempt_id, error: failErr?.message || "Failed to record uncredentialed failure" });
      } else {
        result.failed++;
        if (failData?.retry_exhausted) {
          result.exhausted++;
        }
        result.errors.push({ attemptId: item.attempt_id, error: sanitizedErr });
      }
    }
    return result;
  }

  // 3. Process each claimed item with bounded retries and lease token validation
  for (const item of items) {
    try {
      const revoked = await setuClient.revokeToken(item.provider_request_id);

      if (revoked) {
        const { data: recordData, error: recordErr } = await supabase.rpc("server_idv_record_token_revoked", {
          p_attempt_id: item.attempt_id,
          p_lease_token: item.lease_token || null,
        });

        if (recordErr || !recordData?.success) {
          throw new Error(`Failed to record revoked status: ${recordErr?.message || recordData?.error || "Unknown error"}`);
        }
        result.succeeded++;
      } else {
        // Safe idempotent retry for provider rejection
        const errMsg = "Setu provider rejected or failed token revocation";
        const { data: failData, error: failErr } = await supabase.rpc("server_idv_record_token_revocation_failed", {
          p_attempt_id: item.attempt_id,
          p_error: errMsg,
          p_lease_token: item.lease_token || null,
          p_consume_retry: true,
        });

        result.failed++;
        if (failErr || !failData?.success) {
          result.errors.push({ attemptId: item.attempt_id, error: failErr?.message || "Failed to record failure" });
        } else {
          if (failData?.retry_exhausted) {
            result.exhausted++;
          }
          result.errors.push({ attemptId: item.attempt_id, error: errMsg });
        }
      }
    } catch (err: unknown) {
      // Safe, documented idempotent retry for ambiguous provider network errors
      const sanitized = sanitizeRevocationError(err);
      const { data: failData, error: failErr } = await supabase.rpc("server_idv_record_token_revocation_failed", {
        p_attempt_id: item.attempt_id,
        p_error: sanitized,
        p_lease_token: item.lease_token || null,
        p_consume_retry: true,
      });

      result.failed++;
      if (failErr || !failData?.success) {
        result.errors.push({ attemptId: item.attempt_id, error: failErr?.message || "Failed to record failure" });
      } else {
        if (failData?.retry_exhausted) {
          result.exhausted++;
        }
        result.errors.push({ attemptId: item.attempt_id, error: sanitized });
      }
    }
  }

  return result;
}
