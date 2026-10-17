/**
 * FairSwap Outbox Worker (Shared Core Logic)
 * Authoritative single source of truth for processing transactional listing emails.
 * Shared by both the Supabase Edge Function runner and integration/unit tests.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export interface OutboxRow {
  id: string;
  event_type: "listing_submitted_for_review" | "listing_approved" | "listing_rejected";
  recipient_user_id: string;
  listing_id: string;
  transition_id: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "retry" | "sent" | "dead_letter";
  attempt_count: number;
  max_attempts?: number;
  next_attempt_at: string;
  locked_at: string | null;
  lock_token: string | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  last_error_status: number | null;
  last_error_message: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const WorkerConfigSchema = z.object({
  supabaseUrl: z
    .string()
    .url({ message: "SUPABASE_URL must be a valid URL" })
    .refine((url) => /^https?:\/\//i.test(url), {
      message: "SUPABASE_URL must be an HTTP(S) URL",
    }),
  supabaseServiceRoleKey: z.string().min(1, { message: "SUPABASE_SERVICE_ROLE_KEY is required" }),
  resendApiKey: z.string().min(1, { message: "RESEND_API_KEY is required" }),
  emailFrom: z.string().min(1, { message: "EMAIL_FROM is required" }),
  siteUrl: z
    .string()
    .url({ message: "SITE_URL must be a valid absolute HTTP(S) URL" })
    .refine((url) => /^https?:\/\//i.test(url), {
      message: "SITE_URL must be an HTTP(S) URL",
    })
    .transform((url) => url.replace(/\/+$/, "")),
  emailWorkerSecret: z.string().min(1, { message: "EMAIL_WORKER_SECRET is required" }),
  maxAttempts: z.number().int().positive().optional().default(5),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const WebhookPayloadSchema = z.object({
  type: z.string().optional(),
  table: z.string().optional(),
  schema: z.string().optional(),
  record: z.object({
    id: z.string().uuid("record.id must be a valid UUID"),
  }).passthrough(),
  old_record: z.unknown().optional(),
});

export const DirectPayloadSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
}).strict();

export const BatchPayloadSchema = z.object({}).strict();

export function parseInvocationPayload(body: unknown): { targetJobId?: string } | { error: string } {
  if (body === undefined || body === null || body === "") {
    return { targetJobId: undefined };
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invocation payload must be a JSON object" };
  }

  const recordObj = body as Record<string, unknown>;

  if ("record" in recordObj) {
    const parsed = WebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return { error: "Malformed webhook payload: record.id must be a valid UUID" };
    }
    return { targetJobId: parsed.data.record.id };
  }

  if ("id" in recordObj) {
    const parsed = DirectPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return { error: "Malformed direct payload: id must be a valid UUID" };
    }
    return { targetJobId: parsed.data.id };
  }

  const keys = Object.keys(recordObj);
  if (keys.length === 0) {
    return { targetJobId: undefined };
  }

  return { error: `Unrecognized payload format with unexpected keys: ${keys.join(", ")}` };
}

export async function assertRpcSuccess(
  rpcPromise: PromiseLike<{ data: boolean | null; error: { message: string } | null }>,
  actionDescription: string
): Promise<void> {
  const { data, error } = await rpcPromise;
  if (error) {
    throw new Error(`${actionDescription}: ${error.message}`);
  }
  if (data !== true) {
    throw new Error(`${actionDescription}: database updated zero rows`);
  }
}

export interface JobResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface BatchResult {
  processed: number;
  succeeded: number;
  failed: number;
}

/**
 * Escapes dangerous HTML special characters to prevent injection.
 */
export function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitizes error messages so recipient email addresses or provider tokens are never exposed.
 */
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Redact email addresses
  const redactedEmails = raw.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]");
  // Redact bearer tokens or secrets
  return redactedEmails.replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
}

/**
 * Validates and sanitizes a relative URL link path, rejecting malicious schemes or protocol-relative paths.
 */
export function sanitizeLinkPath(rawPath: unknown, fallback: string): string {
  if (typeof rawPath !== "string") return fallback;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  if (/[\r\n\t]/.test(trimmed)) return fallback;
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return fallback;
  return trimmed;
}

/**
 * Calculates bounded exponential backoff in seconds for retries.
 */
export function calculateBackoffSeconds(attemptCount: number): number {
  const backoffs = [60, 300, 900, 3600, 7200];
  const idx = Math.min(Math.max(attemptCount - 1, 0), backoffs.length - 1);
  return backoffs[idx];
}

/**
 * Renders the email subject, HTML, and text content for supported listing events.
 */
export function renderEmailTemplate(
  eventType: string,
  payload: Record<string, unknown>,
  siteUrl: string
): RenderedEmail {
  const normalizedSiteUrl = siteUrl.replace(/\/+$/, "");
  const listingTitle = typeof payload.listing_title === "string" ? payload.listing_title : "FairSwap Listing";
  const safeTitle = escapeHtml(listingTitle);

  switch (eventType) {
    case "listing_submitted_for_review": {
      const linkPath = sanitizeLinkPath(payload.link_path, "/admin/listings");
      const safeLink = `${normalizedSiteUrl}${linkPath}`;
      const revision = typeof payload.revision === "number" ? payload.revision : 1;

      return {
        subject: `[FairSwap Moderation] New listing pending review: "${listingTitle}"`,
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Listing Pending Review</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; line-height: 1.5; padding: 20px;">
  <h2 style="color: #065f46;">FairSwap Moderation Review</h2>
  <p>A seller has submitted a listing for moderation review.</p>
  <table style="border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 6px 12px 6px 0; font-weight: 600;">Title:</td><td style="padding: 6px 0;">${safeTitle}</td></tr>
    <tr><td style="padding: 6px 12px 6px 0; font-weight: 600;">Revision:</td><td style="padding: 6px 0;">${revision}</td></tr>
  </table>
  <p>
    <a href="${safeLink}" style="display: inline-block; background-color: #059669; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 500;">Review Listing</a>
  </p>
  <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">FairSwap India &bull; Trust and Safety Operations</p>
</body>
</html>`,
        text: `FairSwap Moderation Review\n\nA seller has submitted a listing for moderation review.\n\nTitle: ${listingTitle}\nRevision: ${revision}\n\nReview listing: ${safeLink}\n\nFairSwap India - Trust and Safety Operations`,
      };
    }

    case "listing_approved": {
      const linkPath = sanitizeLinkPath(payload.link_path, "/account/listings");
      const safeLink = `${normalizedSiteUrl}${linkPath}`;

      return {
        subject: `Your FairSwap listing "${listingTitle}" has been approved!`,
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Listing Approved</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; line-height: 1.5; padding: 20px;">
  <h2 style="color: #065f46;">Great news! Your listing is approved.</h2>
  <p>Your FairSwap listing &ldquo;<strong>${safeTitle}</strong>&rdquo; has been approved by our moderation team and is now live on the marketplace.</p>
  <p>
    <a href="${safeLink}" style="display: inline-block; background-color: #059669; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 500;">View Your Live Listing</a>
  </p>
  <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">Thank you for selling on FairSwap. Safe trading!</p>
</body>
</html>`,
        text: `Great news! Your listing is approved.\n\nYour FairSwap listing "${listingTitle}" has been approved by our moderation team and is now live on the marketplace.\n\nView listing: ${safeLink}\n\nThank you for selling on FairSwap. Safe trading!`,
      };
    }

    case "listing_rejected": {
      const fallbackEdit = payload.listing_id
        ? `/account/listings/${payload.listing_id}/edit`
        : "/account/listings";
      const linkPath = sanitizeLinkPath(payload.link_path, fallbackEdit);
      const safeLink = `${normalizedSiteUrl}${linkPath}`;
      const rawReason = typeof payload.rejection_reason === "string" ? payload.rejection_reason : "Moderation requirements not met.";
      const safeReason = escapeHtml(rawReason);

      return {
        subject: `Update regarding your FairSwap listing "${listingTitle}"`,
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Listing Update</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; line-height: 1.5; padding: 20px;">
  <h2 style="color: #991b1b;">Your listing was not approved</h2>
  <p>Your listing &ldquo;<strong>${safeTitle}</strong>&rdquo; was reviewed by our moderation team and could not be approved at this time.</p>
  <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <p style="margin: 0; font-weight: 600; color: #991b1b;">Reason:</p>
    <p style="margin: 4px 0 0 0; color: #7f1d1d;">${safeReason}</p>
  </div>
  <p>You can review and update your listing in your account dashboard to address the feedback and resubmit for review:</p>
  <p>
    <a href="${safeLink}" style="display: inline-block; background-color: #374151; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 500;">Update Your Listing</a>
  </p>
  <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">FairSwap India &bull; Trust and Safety Operations</p>
</body>
</html>`,
        text: `Your listing "${listingTitle}" was not approved.\n\nReason:\n${rawReason}\n\nUpdate your listing:\n${safeLink}\n\nFairSwap India - Trust and Safety Operations`,
      };
    }

    default:
      throw new Error(`Unsupported email outbox event type: ${eventType}`);
  }
}

/**
 * Claims jobs from the database. Throws on RPC failure so invocations fail with HTTP 5xx.
 */
export async function claimJobs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  targetJobId?: string | null,
  lockToken: string = crypto.randomUUID(),
  staleTimeoutSeconds: number = 600
): Promise<OutboxRow[]> {
  if (targetJobId) {
    const { data, error } = await supabase.rpc("claim_email_outbox_job_by_id", {
      p_job_id: targetJobId,
      p_lock_token: lockToken,
      p_stale_timeout_seconds: staleTimeoutSeconds,
    });
    if (error) {
      throw new Error(`Failed to claim email job by ID: ${error.message}`);
    }
    return Array.isArray(data) ? (data as OutboxRow[]) : [];
  }

  const { data, error } = await supabase.rpc("claim_email_outbox_batch", {
    p_batch_size: 10,
    p_lock_token: lockToken,
    p_stale_timeout_seconds: staleTimeoutSeconds,
  });
  if (error) {
    throw new Error(`Failed to claim email outbox batch: ${error.message}`);
  }
  return Array.isArray(data) ? (data as OutboxRow[]) : [];
}

/**
 * Processes a single claimed outbox row. Surfaces persistence failures.
 */
export async function processSingleJob(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  job: OutboxRow,
  config: WorkerConfig,
  fetchImpl: typeof fetch = fetch
): Promise<JobResult> {
  const maxAttempts = config.maxAttempts ?? 5;

  // 1. Resolve recipient email via Supabase Auth Admin API
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
    job.recipient_user_id
  );

  if (userError || !userData?.user?.email) {
    await assertRpcSuccess(
      supabase.rpc("fail_email_outbox_job", {
        p_job_id: job.id,
        p_lock_token: job.lock_token,
        p_error_code: "RECIPIENT_NOT_FOUND",
        p_error_status: 404,
        p_error_message: "User or email not found in auth.users",
        p_is_permanent: true,
        p_max_attempts: maxAttempts,
        p_backoff_seconds: 0,
      }),
      `Failed to persist failure status for job ${job.id}`
    );
    return { success: false, error: "RECIPIENT_NOT_FOUND" };
  }

  const recipientEmail = userData.user.email;

  // 2. Render template
  let rendered: RenderedEmail;
  try {
    rendered = renderEmailTemplate(job.event_type, job.payload, config.siteUrl);
  } catch (err: unknown) {
    await assertRpcSuccess(
      supabase.rpc("fail_email_outbox_job", {
        p_job_id: job.id,
        p_lock_token: job.lock_token,
        p_error_code: "TEMPLATE_ERROR",
        p_error_status: 500,
        p_error_message: sanitizeErrorMessage(err),
        p_is_permanent: true,
        p_max_attempts: maxAttempts,
        p_backoff_seconds: 0,
      }),
      `Failed to persist template failure for job ${job.id}`
    );
    return { success: false, error: "TEMPLATE_ERROR" };
  }

  // 3. Dispatch through Resend using immutable job ID as idempotency key
  const idempotencyKey = `fairswap/listing-email/${job.id}`;
  const backoff = calculateBackoffSeconds(job.attempt_count);

  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [recipientEmail],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });
  } catch (networkErr: unknown) {
    await assertRpcSuccess(
      supabase.rpc("fail_email_outbox_job", {
        p_job_id: job.id,
        p_lock_token: job.lock_token,
        p_error_code: "NETWORK_ERROR",
        p_error_status: 0,
        p_error_message: sanitizeErrorMessage(networkErr),
        p_is_permanent: false,
        p_max_attempts: maxAttempts,
        p_backoff_seconds: backoff,
      }),
      `Failed to record network failure for job ${job.id}`
    );
    return { success: false, error: "NETWORK_ERROR" };
  }

  // 4. Inspect Resend response outside fetch catch (persistence failures are surfaced and never reclassified as NETWORK_ERROR)
  const resJson = await res.json().catch(() => ({}));

  if (res.ok && resJson && typeof resJson.id === "string") {
    await assertRpcSuccess(
      supabase.rpc("complete_email_outbox_job", {
        p_job_id: job.id,
        p_lock_token: job.lock_token,
        p_provider_message_id: resJson.id,
      }),
      `Email delivered by provider, but failed to mark sent in outbox for job ${job.id}`
    );
    return { success: true, providerMessageId: resJson.id };
  }

  const status = res.status;
  const isRetryable = status === 429 || status >= 500;
  const isPermanent = !isRetryable;
  const resendErrorCode =
    typeof resJson?.name === "string" ? resJson.name : `HTTP_${status}`;
  const resendErrorMessage =
    typeof resJson?.message === "string" ? resJson.message : `Resend returned status ${status}`;

  await assertRpcSuccess(
    supabase.rpc("fail_email_outbox_job", {
      p_job_id: job.id,
      p_lock_token: job.lock_token,
      p_error_code: resendErrorCode,
      p_error_status: status,
      p_error_message: sanitizeErrorMessage(resendErrorMessage),
      p_is_permanent: isPermanent,
      p_max_attempts: maxAttempts,
      p_backoff_seconds: backoff,
    }),
    `Failed to record provider failure for job ${job.id}`
  );
  return { success: false, error: resendErrorCode };
}

/**
 * Claims and processes outbox jobs. Throws if claiming or persistence fails.
 */
export async function processOutboxJobs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  config: WorkerConfig,
  targetJobId?: string,
  fetchImpl: typeof fetch = fetch
): Promise<BatchResult> {
  const lockToken = crypto.randomUUID();
  const claimedJobs = await claimJobs(supabase, targetJobId, lockToken, 600);

  let succeeded = 0;
  let failed = 0;

  for (const job of claimedJobs) {
    const res = await processSingleJob(supabase, job, config, fetchImpl);
    if (res.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  return {
    processed: claimedJobs.length,
    succeeded,
    failed,
  };
}

/**
 * HTTP handler for Edge Function invocation.
 * Handles configuration validation, secret check, body validation, job processing, and returns HTTP 5xx on claim/operational errors.
 */
export async function handleOutboxWorkerRequest(
  req: Request,
  rawConfig: WorkerConfig | Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  // 1. Fail closed on worker environment configuration (safe error, no secret disclosure)
  const parsedConfig = WorkerConfigSchema.safeParse(rawConfig);
  if (!parsedConfig.success) {
    return new Response(
      JSON.stringify({
        error: "Invalid or missing worker configuration",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  const config = parsedConfig.data;

  // 2. Authenticate worker request using secret
  const customHeader = req.headers.get("x-email-worker-secret") || "";
  const authHeader = req.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  const secretMatches =
    customHeader === config.emailWorkerSecret || bearerToken === config.emailWorkerSecret;

  if (!secretMatches) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Parse and validate invocation payload
  let targetJobId: string | undefined;
  if (req.method === "POST") {
    let rawBody: unknown;
    try {
      const text = await req.text();
      rawBody = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({ error: "Bad Request: Malformed JSON body in request" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const payloadResult = parseInvocationPayload(rawBody);
    if ("error" in payloadResult) {
      return new Response(
        JSON.stringify({
          error: "Bad Request: Malformed invocation payload",
          details: payloadResult.error,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    targetJobId = payloadResult.targetJobId;
  }

  // 4. Claim and process jobs, surfacing any operational/RPC errors as HTTP 500
  try {
    const result = await processOutboxJobs(supabase, config, targetJobId, fetchImpl);
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (opErr: unknown) {
    return new Response(
      JSON.stringify({
        error: "Internal operational failure in email worker",
        message: sanitizeErrorMessage(opErr),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
