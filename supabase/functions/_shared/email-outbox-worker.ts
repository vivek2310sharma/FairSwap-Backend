/**
 * FairSwap Outbox Worker (Shared Core Logic)
 * Authoritative single source of truth for processing transactional listing emails.
 * Shared by both the Supabase Edge Function runner and integration/unit tests.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export interface OutboxRow {
  id: string;
  event_type:
    | "listing_submitted_for_review"
    | "listing_approved"
    | "listing_rejected"
    | "account_security_digilocker"
    | string;
  recipient_user_id: string;
  listing_id?: string | null;
  transition_id?: string | null;
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
  queue_type?: "listing" | "security";
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
 * Apply the shared FairSwap branding to listing-event HTML without changing
 * subjects, plaintext fallbacks, recipients, idempotency or RLS/worker behavior.
 * The public logo is deliberately served from FairSwap.in, not a third-party pixel.
 */
export function brandListingEmail(innerEmailHtml: string): string {
  const match = innerEmailHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) throw new Error("Missing email body");
  const body = match[1]
    .replace(/#065f46/gi, "#0b438e")
    .replace(/#059669/gi, "#0b58b6");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<title>FairSwap notification</title>
<style>@media only screen and (max-width:600px){.mail-header{padding:24px !important}.mail-main{padding:26px 24px !important}.mail-footer{padding:22px 24px !important}}</style></head>
<body style="margin:0; padding:0; background-color:#f5f8fd; color:#182c48; font-family:Arial,Helvetica,sans-serif; -webkit-text-size-adjust:100%;">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%; border-collapse:collapse; background-color:#f5f8fd;"><tr><td align="center" style="padding:32px 14px;">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%; max-width:600px; background-color:#ffffff; border:1px solid #dfe8f4; border-radius:14px; border-collapse:separate;">
<tr><td class="mail-header" style="padding:28px 40px 22px; border-bottom:1px solid #dfe8f4;">
<img src="https://fairswap.in/brand/FairSwap_Web_Logo_Transparent.png" alt="FairSwap" width="236" height="72" style="display:block; width:236px; max-width:100%; height:auto; border:0;">
<p style="margin:5px 0 0; color:#28466d; font-size:12px; font-weight:600;">Give. Get. Grow Together.</p></td></tr>
<tr><td class="mail-main" style="padding:30px 40px 34px;">${body}</td></tr>
<tr><td class="mail-footer" style="padding:24px 40px; background-color:#f8fbff; border-top:1px solid #dfe8f4;">
<p style="margin:0; color:#415775; font-size:13px;">FairSwap.in &middot; Give. Get. Grow Together.</p>
<p style="margin:8px 0 0; color:#65758c; font-size:12px; line-height:19px;">Safety: Never share OTPs or pay an advance to verify a transaction. OTP किसी को न बताएं।</p>
<p style="margin:8px 0 0; color:#65758c; font-size:12px;">Help: https://help.fairswap.in</p>
</td></tr></table></td></tr></table></body></html>`;
}

/**
 * Renders approved FairSwap Account Security HTML email.
 */
export function renderAccountSecurityHtml(siteUrl: string): string {
  const normalizedSiteUrl = siteUrl.replace(/\/+$/, "");
  const safeAccountUrl = escapeHtml(`${normalizedSiteUrl}/account`);
  const safeDigiLockerLogoUrl = escapeHtml(`${normalizedSiteUrl}/brand/digilocker-logo.png`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>FairSwap account security — DigiLocker verification</title>
  <style>
    @media only screen and (max-width: 600px) {
      .email-content { padding:30px 24px !important; }
      .email-header { padding:28px 24px 22px !important; }
      .email-footer { padding:24px !important; }
      .email-outer { padding:16px 10px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f5f8fd;color:#111827;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;color:#f5f8fd;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">For account security, please verify your identity with DigiLocker from My Account.</div>
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;background-color:#f5f8fd;">
    <tr><td class="email-outer" align="center" style="padding:36px 16px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;max-width:600px;border-collapse:separate;background-color:#ffffff;border:1px solid #dfe8f4;border-radius:14px;">
        <tr><td class="email-header" style="padding:32px 40px 24px;border-bottom:1px solid #dfe8f4;">
          <img src="https://fairswap.in/brand/FairSwap_Web_Logo_Transparent.png" width="236" height="72" alt="FairSwap" style="display:block;width:236px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;">
          <p style="margin:5px 0 0;color:#28466d;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.2px;">Give. Get. Grow Together.</p>
        </td></tr>
        <tr><td class="email-content" style="padding:36px 40px 40px;">
          <p style="margin:0 0 12px;color:#0b58b6;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1.2px;">FAIRSWAP ACCOUNT SECURITY</p>
          <h1 style="margin:0 0 18px;color:#111827;font-size:27px;line-height:35px;font-weight:700;">Please verify your account</h1>
          <p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:25px;">Hello,</p>
          <p style="margin:0 0 18px;color:#374151;font-size:16px;line-height:25px;">For security reasons, we ask FairSwap members to confirm their identity through <strong>DigiLocker</strong>. This helps us protect our community against impersonation and fraudulent accounts.</p>
          <p style="margin:0 0 24px;color:#374151;font-size:16px;line-height:25px;">We may ask you to complete verification again from time to time.</p>
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;background-color:#f8fbff;border-left:3px solid #0b58b6;">
            <tr><td style="padding:18px 20px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;margin:0 0 18px;border-collapse:collapse;">
                <tr><td style="padding:0;">
                  <p style="margin:0 0 9px;color:#65509d;font-size:11px;line-height:17px;font-weight:700;letter-spacing:1px;">IDENTITY VERIFICATION THROUGH</p>
                  <img src="${safeDigiLockerLogoUrl}" width="180" height="44" alt="DigiLocker" style="display:block;width:180px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;color:#6132ee;font-size:18px;font-weight:700;">
                </td></tr>
              </table>
              <p style="margin:0 0 9px;color:#111827;font-size:15px;line-height:22px;font-weight:700;">How to verify</p>
              <p style="margin:0;color:#374151;font-size:15px;line-height:24px;">1. Sign in to FairSwap.<br>2. Open <strong>My Account</strong>.<br>3. Find <strong>Verify with DigiLocker</strong> and follow the instructions.</p>
            </td></tr>
          </table>
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin-top:26px;">
            <tr><td align="center" bgcolor="#0b58b6" style="background-color:#0b58b6;border-radius:8px;">
              <a id="account-security-link" href="${safeAccountUrl}" style="display:inline-block;padding:15px 26px;border-radius:8px;color:#ffffff;font-size:16px;line-height:20px;font-weight:700;text-decoration:none;">Go to My Account</a>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;color:#374151;font-size:14px;line-height:23px;"><strong>Important:</strong> Until your account has been verified by FairSwap, access to certain FairSwap features will be limited.</p>
          <p style="margin:18px 0 0;color:#4b5563;font-size:14px;line-height:22px;">FairSwap will never ask for your DigiLocker PIN, OTP or password by email, chat or phone.</p>
          <p style="margin:24px 0 0;color:#374151;font-size:15px;line-height:23px;">Thank you for helping us make FairSwap safer for everyone.<br><strong>Team FairSwap</strong></p>
        </td></tr>
        <tr><td class="email-footer" style="padding:26px 40px;background-color:#f8fbff;border-top:1px solid #dfe8f4;border-radius:0 0 14px 14px;">
          <p style="margin:0;color:#6b7280;font-size:13px;line-height:20px;">FairSwap.in &middot; Give. Get. Grow Together.</p>
          <p style="margin:8px 0 0;color:#6b7280;font-size:12px;line-height:19px;">Security tip: Never share OTPs or pay an advance to verify a transaction. OTP किसी को न बताएं।</p>
          <p style="margin:8px 0 0;color:#6b7280;font-size:12px;line-height:19px;">This is an account-security notice, not a payment request.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Renders approved FairSwap Account Security plain-text email.
 */
export function renderAccountSecurityText(siteUrl: string): string {
  const normalizedSiteUrl = siteUrl.replace(/\/+$/, "");
  const accountUrl = `${normalizedSiteUrl}/account`;

  return `FairSwap — Account Security
Subject: FairSwap account security: Please verify your account

Hello,

For security reasons, we ask FairSwap members to confirm their identity through DigiLocker. This helps protect our community against impersonation and fraudulent accounts. We may ask you to verify again from time to time.

How to verify:
1. Sign in to FairSwap.
2. Open My Account.
3. Find Verify with DigiLocker and follow the instructions.

Go to My Account: ${accountUrl}

Important: Until your account has been verified by FairSwap, access to certain FairSwap features will be limited.

FairSwap will never ask for your DigiLocker PIN, OTP or password by email, chat or phone.

Thank you for helping us make FairSwap safer for everyone.
Team FairSwap

FairSwap.in — Give. Get. Grow Together.
Security tip: Never share OTPs or pay an advance to verify a transaction.`;
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

  const rendered = (() => {
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

    case "account_security_digilocker": {
      return {
        subject: "FairSwap account security: Please verify your account",
        html: renderAccountSecurityHtml(normalizedSiteUrl),
        text: renderAccountSecurityText(normalizedSiteUrl),
      };
    }

    default:
      throw new Error(`Unsupported email outbox event type: ${eventType}`);
  }
  })();
  if (eventType === "account_security_digilocker") {
    return rendered;
  }
  return { ...rendered, html: brandListingEmail(rendered.html) };
}

function isMissingRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  const code = typeof err.code === "string" ? err.code : "";
  const msg = typeof err.message === "string" ? err.message : "";
  return (
    code === "42883" ||
    code === "PGRST202" ||
    msg.includes("Could not find the function") ||
    msg.includes("does not exist")
  );
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
      throw new Error(`Failed to claim email job by ID: ${sanitizeErrorMessage(error.message)}`);
    }
    if (Array.isArray(data) && data.length > 0) {
      return data as OutboxRow[];
    }

    const { data: secData, error: secError } = await supabase.rpc(
      "claim_security_email_outbox_job_by_id",
      {
        p_job_id: targetJobId,
        p_lock_token: lockToken,
        p_stale_timeout_seconds: staleTimeoutSeconds,
      }
    );
    if (secError) {
      if (!isMissingRpcError(secError)) {
        throw new Error(
          `Failed to claim security email job by ID: ${sanitizeErrorMessage(secError.message)}`
        );
      }
    } else if (Array.isArray(secData) && secData.length > 0) {
      return (secData as OutboxRow[]).map((j) => ({ ...j, queue_type: "security" }));
    }
    return [];
  }

  const { data, error } = await supabase.rpc("claim_email_outbox_batch", {
    p_batch_size: 10,
    p_lock_token: lockToken,
    p_stale_timeout_seconds: staleTimeoutSeconds,
  });
  if (error) {
    throw new Error(`Failed to claim email outbox batch: ${sanitizeErrorMessage(error.message)}`);
  }
  const listingRows = Array.isArray(data) ? (data as OutboxRow[]) : [];

  let secRows: OutboxRow[] = [];
  const { data: secData, error: secError } = await supabase.rpc(
    "claim_security_email_outbox_batch",
    {
      p_batch_size: 10,
      p_lock_token: lockToken,
      p_stale_timeout_seconds: staleTimeoutSeconds,
    }
  );
  if (secError) {
    if (!isMissingRpcError(secError)) {
      throw new Error(
        `Failed to claim security email outbox batch: ${sanitizeErrorMessage(secError.message)}`
      );
    }
  } else if (Array.isArray(secData)) {
    secRows = (secData as OutboxRow[]).map((j) => ({ ...j, queue_type: "security" as const }));
  }

  return [...listingRows, ...secRows];
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
  const isSecurity = job.queue_type === "security" || job.event_type === "account_security_digilocker";
  const failRpcName = isSecurity ? "fail_security_email_outbox_job" : "fail_email_outbox_job";
  const completeRpcName = isSecurity ? "complete_security_email_outbox_job" : "complete_email_outbox_job";

  // 1. Resolve recipient email via Supabase Auth Admin API
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
    job.recipient_user_id
  );

  if (userError || !userData?.user?.email) {
    await assertRpcSuccess(
      supabase.rpc(failRpcName, {
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
      supabase.rpc(failRpcName, {
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
  const idempotencyKey = isSecurity
    ? `fairswap/security-email/${job.id}`
    : `fairswap/listing-email/${job.id}`;
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
      supabase.rpc(failRpcName, {
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
      supabase.rpc(completeRpcName, {
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
    supabase.rpc(failRpcName, {
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
