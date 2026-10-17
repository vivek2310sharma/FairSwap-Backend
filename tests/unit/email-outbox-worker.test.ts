// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import {
  escapeHtml,
  sanitizeLinkPath,
  sanitizeErrorMessage,
  calculateBackoffSeconds,
  renderEmailTemplate,
  claimJobs,
  processSingleJob,
  handleOutboxWorkerRequest,
  type OutboxRow,
  type WorkerConfig,
} from "../../supabase/functions/_shared/email-outbox-worker";

const baseConfig: WorkerConfig = {
  supabaseUrl: "https://test.supabase.co",
  supabaseServiceRoleKey: "test-service-key",
  resendApiKey: "re_test_key_12345",
  emailFrom: "FairSwap <notifications@fairswap.in>",
  siteUrl: "https://fairswap.in",
  emailWorkerSecret: "test-worker-secret-42",
  maxAttempts: 5,
};

const sampleJob: OutboxRow = {
  id: "job-00000000-0000-0000-0000-000000000001",
  event_type: "listing_approved",
  recipient_user_id: "user-123",
  listing_id: "listing-456",
  transition_id: "trans-789",
  payload: { listing_title: "Test Item", link_path: "/listings/test" },
  status: "processing",
  attempt_count: 1,
  max_attempts: 5,
  next_attempt_at: new Date().toISOString(),
  locked_at: new Date().toISOString(),
  lock_token: "token-abc",
  provider_message_id: null,
  last_error_code: null,
  last_error_status: null,
  last_error_message: null,
  sent_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("Email Outbox Worker - Unit Tests", () => {
  describe("escapeHtml", () => {
    it("escapes dangerous HTML special characters", () => {
      const malicious = `<script>alert("XSS & attack")</script> 'hello'`;
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe(
        "&lt;script&gt;alert(&quot;XSS &amp; attack&quot;)&lt;/script&gt; &#39;hello&#39;"
      );
      expect(escaped).not.toContain("<script>");
      expect(escaped).not.toContain('"');
    });

    it("handles empty or falsy strings gracefully", () => {
      expect(escapeHtml("")).toBe("");
    });
  });

  describe("sanitizeLinkPath", () => {
    it("accepts valid internal paths starting with /", () => {
      expect(sanitizeLinkPath("/listings/teak-table-123", "/fallback")).toBe(
        "/listings/teak-table-123"
      );
      expect(sanitizeLinkPath("/admin/listings/uuid-1", "/fallback")).toBe(
        "/admin/listings/uuid-1"
      );
    });

    it("rejects protocol-relative paths", () => {
      expect(sanitizeLinkPath("//attacker.com/evil", "/fallback")).toBe("/fallback");
    });

    it("rejects javascript: and other malicious schemes", () => {
      expect(sanitizeLinkPath("/javascript:alert(1)", "/fallback")).toBe("/fallback");
    });

    it("rejects non-strings and paths without leading /", () => {
      expect(sanitizeLinkPath(null, "/fallback")).toBe("/fallback");
      expect(sanitizeLinkPath(undefined, "/fallback")).toBe("/fallback");
      expect(sanitizeLinkPath("https://external.com", "/fallback")).toBe("/fallback");
    });
  });

  describe("calculateBackoffSeconds", () => {
    it("returns bounded exponential backoff intervals", () => {
      expect(calculateBackoffSeconds(1)).toBe(60);
      expect(calculateBackoffSeconds(2)).toBe(300);
      expect(calculateBackoffSeconds(3)).toBe(900);
      expect(calculateBackoffSeconds(4)).toBe(3600);
      expect(calculateBackoffSeconds(5)).toBe(7200);
      expect(calculateBackoffSeconds(10)).toBe(7200); // capped
    });
  });

  describe("renderEmailTemplate", () => {
    it("renders listing_submitted_for_review template correctly", () => {
      const rendered = renderEmailTemplate(
        "listing_submitted_for_review",
        {
          listing_title: `Vintage Chair <script>`,
          listing_slug: "vintage-chair",
          revision: 2,
          link_path: "/admin/listings/abc-123",
        },
        "https://fairswap.in"
      );

      expect(rendered.subject).toContain("Vintage Chair <script>");
      expect(rendered.html).toContain("Vintage Chair &lt;script&gt;");
      expect(rendered.html).not.toContain("<script>");
      expect(rendered.html).toContain("Revision:</td><td style=\"padding: 6px 0;\">2</td>");
      expect(rendered.html).toContain("https://fairswap.in/admin/listings/abc-123");
      expect(rendered.text).toContain("https://fairswap.in/admin/listings/abc-123");
    });

    it("renders listing_approved template correctly", () => {
      const rendered = renderEmailTemplate(
        "listing_approved",
        {
          listing_title: `Hero Bicycle "Blue"`,
          listing_slug: "hero-bicycle-blue",
          link_path: "/listings/hero-bicycle-blue",
        },
        "https://fairswap.in"
      );

      expect(rendered.subject).toContain("approved");
      expect(rendered.html).toContain("Hero Bicycle &quot;Blue&quot;");
      expect(rendered.html).toContain("https://fairswap.in/listings/hero-bicycle-blue");
      expect(rendered.text).toContain("is approved");
    });

    it("renders listing_rejected template with moderation reason and exact seller edit link", () => {
      const listingId = "00000000-0000-0000-0000-000000000001";
      const rendered = renderEmailTemplate(
        "listing_rejected",
        {
          listing_id: listingId,
          listing_title: "Suspect Watch",
          rejection_reason: "Counterfeit items are prohibited <alert>",
          link_path: `/account/listings/${listingId}/edit`,
        },
        "https://fairswap.in"
      );

      expect(rendered.subject).toContain("Suspect Watch");
      expect(rendered.html).toContain("Counterfeit items are prohibited &lt;alert&gt;");
      expect(rendered.html).toContain(`https://fairswap.in/account/listings/${listingId}/edit`);
      expect(rendered.text).toContain(`https://fairswap.in/account/listings/${listingId}/edit`);
      expect(rendered.text).toContain("Reason:\nCounterfeit items are prohibited <alert>");
    });

    it("falls back to /account/listings/<listing-id>/edit if link_path is missing", () => {
      const listingId = "11111111-1111-1111-1111-111111111111";
      const rendered = renderEmailTemplate(
        "listing_rejected",
        {
          listing_id: listingId,
          listing_title: "Another Listing",
          rejection_reason: "Prohibited item.",
        },
        "https://fairswap.in"
      );

      expect(rendered.html).toContain(`https://fairswap.in/account/listings/${listingId}/edit`);
      expect(rendered.text).toContain(`https://fairswap.in/account/listings/${listingId}/edit`);
    });

    it("throws error for unsupported event type", () => {
      expect(() =>
        renderEmailTemplate("unknown_event", {}, "https://fairswap.in")
      ).toThrow(/Unsupported email outbox event type/);
    });
  });

  describe("processSingleJob", () => {
    function createMockSupabase(overrides: {
      user?: { id: string; email: string } | null;
      userError?: Error | null;
      rpcMock?: (fn: string, args: any) => Promise<{ data: any; error: any }>;
    }) {
      const rpcMock = overrides.rpcMock || vi.fn().mockResolvedValue({ data: true, error: null });
      return {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
               data: overrides.user ? { user: overrides.user } : { user: null },
               error: overrides.userError || null,
            }),
          },
        },
        rpc: rpcMock,
      } as unknown as any;
    }

    it("sends email with Resend idempotency key and marks job completed on 200", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = createMockSupabase({
        user: { id: "user-123", email: "seller@example.com" },
        rpcMock: vi.fn().mockImplementation(async (fn, args) => {
          rpcCalls.push({ fn, args });
          return { data: true, error: null };
        }),
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "msg_resend_live_12345" }),
      });

      const result = await processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any);

      expect(result.success).toBe(true);
      expect(result.providerMessageId).toBe("msg_resend_live_12345");

      // Verify fetch call to Resend
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.resend.com/emails");
      expect(options.headers["Idempotency-Key"]).toBe(
        `fairswap/listing-email/${sampleJob.id}`
      );
      expect(options.headers["Authorization"]).toBe(`Bearer ${baseConfig.resendApiKey}`);
      const body = JSON.parse(options.body);
      expect(body.to).toEqual(["seller@example.com"]);
      expect(body.subject).toContain("approved");

      // Verify complete_email_outbox_job called
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe("complete_email_outbox_job");
      expect(rpcCalls[0].args.p_provider_message_id).toBe("msg_resend_live_12345");
      expect(rpcCalls[0].args.p_lock_token).toBe("token-abc");
    });

    it("marks as permanent failure (dead_letter) when recipient email cannot be resolved", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = createMockSupabase({
        user: null,
        userError: new Error("User not found"),
        rpcMock: vi.fn().mockImplementation(async (fn, args) => {
          rpcCalls.push({ fn, args });
          return { data: true, error: null };
        }),
      });

      const mockFetch = vi.fn();
      const result = await processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any);

      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();

      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe("fail_email_outbox_job");
      expect(rpcCalls[0].args.p_is_permanent).toBe(true);
      expect(rpcCalls[0].args.p_error_code).toBe("RECIPIENT_NOT_FOUND");
    });

    it("retries on HTTP 429 Rate Limit from Resend with backoff", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = createMockSupabase({
        user: { id: "user-123", email: "seller@example.com" },
        rpcMock: vi.fn().mockImplementation(async (fn, args) => {
          rpcCalls.push({ fn, args });
          return { data: true, error: null };
        }),
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ name: "rate_limit_exceeded", message: "Too many requests" }),
      });

      const result = await processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any);

      expect(result.success).toBe(false);
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe("fail_email_outbox_job");
      expect(rpcCalls[0].args.p_is_permanent).toBe(false);
      expect(rpcCalls[0].args.p_error_status).toBe(429);
      expect(rpcCalls[0].args.p_backoff_seconds).toBe(60); // attempt 1 = 60s
    });

    it("retries on HTTP 5xx Server Error from Resend", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = createMockSupabase({
        user: { id: "user-123", email: "seller@example.com" },
        rpcMock: vi.fn().mockImplementation(async (fn, args) => {
          rpcCalls.push({ fn, args });
          return { data: true, error: null };
        }),
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ message: "Service unavailable" }),
      });

      const result = await processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any);

      expect(result.success).toBe(false);
      expect(rpcCalls[0].fn).toBe("fail_email_outbox_job");
      expect(rpcCalls[0].args.p_is_permanent).toBe(false);
      expect(rpcCalls[0].args.p_error_status).toBe(503);
    });

    it("marks permanent 4xx client errors (invalid domain/credentials) as dead-letter", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = createMockSupabase({
        user: { id: "user-123", email: "seller@example.com" },
        rpcMock: vi.fn().mockImplementation(async (fn, args) => {
          rpcCalls.push({ fn, args });
          return { data: true, error: null };
        }),
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ name: "forbidden", message: "Domain not verified" }),
      });

      const result = await processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any);

      expect(result.success).toBe(false);
      expect(rpcCalls[0].fn).toBe("fail_email_outbox_job");
      expect(rpcCalls[0].args.p_is_permanent).toBe(true);
      expect(rpcCalls[0].args.p_error_code).toBe("forbidden");
    });

    it("handles fetch network exceptions as retryable", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = createMockSupabase({
        user: { id: "user-123", email: "seller@example.com" },
        rpcMock: vi.fn().mockImplementation(async (fn, args) => {
          rpcCalls.push({ fn, args });
          return { data: true, error: null };
        }),
      });

      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection reset by peer"));
      const result = await processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any);

      expect(result.success).toBe(false);
      expect(rpcCalls[0].fn).toBe("fail_email_outbox_job");
      expect(rpcCalls[0].args.p_is_permanent).toBe(false);
      expect(rpcCalls[0].args.p_error_code).toBe("NETWORK_ERROR");
    });
  });

  describe("handleOutboxWorkerRequest HTTP Handler", () => {
    function createMockSupabase() {
      return {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: { user: { id: "u1", email: "test@example.com" } },
              error: null,
            }),
          },
        },
        rpc: vi.fn().mockImplementation(async (fn: string) => {
          if (fn.startsWith("claim_email_outbox")) {
            return {
              data: [
                {
                  id: "00000000-0000-0000-0000-000000000001",
                  event_type: "listing_approved",
                  recipient_user_id: "u1",
                  listing_id: "l1",
                  transition_id: "t1",
                  payload: { listing_title: "Title" },
                  status: "processing",
                  attempt_count: 1,
                },
              ],
              error: null,
            };
          }
          // complete_email_outbox_job or fail_email_outbox_job returns boolean true
          return { data: true, error: null };
        }),
      } as unknown as any;
    }

    it("fails with HTTP 500 when worker configuration is missing or invalid", async () => {
      const invalidConfigs = [
        { ...baseConfig, emailWorkerSecret: "" },
        { ...baseConfig, siteUrl: "not-a-valid-url" },
        { ...baseConfig, emailFrom: "" },
        { ...baseConfig, resendApiKey: "" },
        { ...baseConfig, supabaseUrl: "not-a-valid-url" },
      ];

      for (const config of invalidConfigs) {
        const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
          method: "POST",
          headers: { "Authorization": "Bearer test-worker-secret-42" },
        });

        const res = await handleOutboxWorkerRequest(req, config as any, createMockSupabase(), vi.fn() as any);
        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json.error).toContain("Invalid or missing worker configuration");
      }
    });

    it("rejects unauthorized requests with HTTP 401 when secret does not match", async () => {
      const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: { "Authorization": "Bearer wrong-secret" },
      });

      const res = await handleOutboxWorkerRequest(req, baseConfig, createMockSupabase(), vi.fn() as any);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("enforces worker-secret authentication before parsing invocation payload", async () => {
      // Even if payload is completely malformed, an unauthorized caller gets 401, not 400
      const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer wrong-secret",
        },
        body: JSON.stringify({ record: { id: "not-a-uuid" } }),
      });

      const res = await handleOutboxWorkerRequest(req, baseConfig, createMockSupabase(), vi.fn() as any);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("rejects malformed invocation payloads with HTTP 400", async () => {
      const malformedPayloads = [
        { record: { id: "not-a-uuid" } },
        { record: {} },
        { id: "not-a-uuid" },
        { id: "12345" },
        { foo: "bar" },
        { unknown_field: 42 },
      ];

      for (const payload of malformedPayloads) {
        const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-email-worker-secret": "test-worker-secret-42",
          },
          body: JSON.stringify(payload),
        });

        const res = await handleOutboxWorkerRequest(req, baseConfig, createMockSupabase(), vi.fn() as any);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toBe("Bad Request: Malformed invocation payload");
      }

      // Malformed JSON text
      const badJsonReq = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-email-worker-secret": "test-worker-secret-42",
        },
        body: "{ malformed json",
      });
      const badJsonRes = await handleOutboxWorkerRequest(badJsonReq, baseConfig, createMockSupabase(), vi.fn() as any);
      expect(badJsonRes.status).toBe(400);
    });

    it("authenticates with Authorization Bearer header and processes webhook payload", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "provider-1" }),
      });

      const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-worker-secret-42",
        },
        body: JSON.stringify({ record: { id: "00000000-0000-0000-0000-000000000001" } }),
      });

      const res = await handleOutboxWorkerRequest(req, baseConfig, createMockSupabase(), mockFetch as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.processed).toBe(1);
      expect(json.result.succeeded).toBe(1);
    });

    it("authenticates with x-email-worker-secret header and processes direct targeted payload", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "provider-1" }),
      });

      const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-email-worker-secret": "test-worker-secret-42",
        },
        body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000002" }),
      });

      const res = await handleOutboxWorkerRequest(req, baseConfig, createMockSupabase(), mockFetch as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.processed).toBe(1);
      expect(json.result.succeeded).toBe(1);
    });

    it("processes scheduled batch on empty object or empty body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "provider-1" }),
      });

      const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-email-worker-secret": "test-worker-secret-42",
        },
        body: JSON.stringify({}),
      });

      const res = await handleOutboxWorkerRequest(req, baseConfig, createMockSupabase(), mockFetch as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.processed).toBe(1);
    });

    it("returns HTTP 500 when claim_email_outbox_batch RPC fails", async () => {
      const failingSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "database connection timeout" },
        }),
      } as unknown as any;

      const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-email-worker-secret": "test-worker-secret-42",
        },
        body: JSON.stringify({}),
      });

      const res = await handleOutboxWorkerRequest(req, baseConfig, failingSupabase);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Internal operational failure in email worker");
      expect(json.message).toContain("Failed to claim email outbox batch");
    });

    it("returns HTTP 500 when claim_email_outbox_job_by_id RPC fails", async () => {
      const failingSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "deadlock detected" },
        }),
      } as unknown as any;

      const req = new Request("https://edge.supabase.test/functions/v1/process-email-outbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-email-worker-secret": "test-worker-secret-42",
        },
        body: JSON.stringify({ record: { id: "00000000-0000-0000-0000-000000000001" } }),
      });

      const res = await handleOutboxWorkerRequest(req, baseConfig, failingSupabase);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Internal operational failure in email worker");
      expect(json.message).toContain("Failed to claim email job by ID");
    });

    it("claimJobs claims by batch or by ID and throws on RPC error", async () => {
      const mockSupabase = {
        rpc: vi.fn().mockImplementation(async (fn: string) => {
          if (fn === "claim_email_outbox_batch") {
            return { data: [sampleJob], error: null };
          }
          if (fn === "claim_email_outbox_job_by_id") {
            return { data: [sampleJob], error: null };
          }
          return { data: null, error: null };
        }),
      } as unknown as any;

      const batchJobs = await claimJobs(mockSupabase, null, "lock-1", 300);
      expect(batchJobs).toEqual([sampleJob]);
      expect(mockSupabase.rpc).toHaveBeenCalledWith("claim_email_outbox_batch", {
        p_batch_size: 10,
        p_lock_token: "lock-1",
        p_stale_timeout_seconds: 300,
      });

      const singleJob = await claimJobs(mockSupabase, "job-123", "lock-2", 300);
      expect(singleJob).toEqual([sampleJob]);
      expect(mockSupabase.rpc).toHaveBeenCalledWith("claim_email_outbox_job_by_id", {
        p_job_id: "job-123",
        p_lock_token: "lock-2",
        p_stale_timeout_seconds: 300,
      });
    });
  });

  describe("RPC failure handling, boolean checking, and error separation in processSingleJob", () => {
    it("treats complete_email_outbox_job data === false as an operational persistence failure", async () => {
      const supabase = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: { user: { id: "u1", email: "seller@example.com" } },
              error: null,
            }),
          },
        },
        rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
      } as unknown as any;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "msg-resend-success-123" }),
      });

      await expect(
        processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any)
      ).rejects.toThrow(/database updated zero rows/);
    });

    it("treats fail_email_outbox_job data === false as an operational persistence failure", async () => {
      const supabase = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: null,
              error: new Error("User not found"),
            }),
          },
        },
        rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
      } as unknown as any;

      await expect(
        processSingleJob(supabase, sampleJob, baseConfig, vi.fn() as any)
      ).rejects.toThrow(/database updated zero rows/);
    });

    it("Case A: Resend returns HTTP 403, fail_email_outbox_job returns RPC error -> surfaces error without second call", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: { user: { id: "u1", email: "seller@example.com" } },
              error: null,
            }),
          },
        },
        rpc: vi.fn().mockImplementation(async (fn: string, args: any) => {
          rpcCalls.push({ fn, args });
          return { data: null, error: { message: "database deadlock on fail" } };
        }),
      } as unknown as any;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ name: "forbidden", message: "API key restricted" }),
      });

      // Must surface the provider persistence failure directly
      await expect(
        processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any)
      ).rejects.toThrow(/Failed to record provider failure for job.*database deadlock on fail/);

      // Must NOT convert to NETWORK_ERROR and must NOT call fail_email_outbox_job a second time
      expect(rpcCalls.length).toBe(1);
      expect(rpcCalls[0].fn).toBe("fail_email_outbox_job");
      expect(rpcCalls[0].args.p_error_code).toBe("forbidden");
      expect(rpcCalls[0].args.p_error_code).not.toBe("NETWORK_ERROR");
    });

    it("Case B: Resend returns HTTP 503, fail_email_outbox_job returns { data: false, error: null } -> operational failure", async () => {
      const rpcCalls: { fn: string; args: any }[] = [];
      const supabase = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: { user: { id: "u1", email: "seller@example.com" } },
              error: null,
            }),
          },
        },
        rpc: vi.fn().mockImplementation(async (fn: string, args: any) => {
          rpcCalls.push({ fn, args });
          return { data: false, error: null };
        }),
      } as unknown as any;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ name: "service_unavailable", message: "Resend unavailable" }),
      });

      await expect(
        processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any)
      ).rejects.toThrow(/Failed to record provider failure for job.*database updated zero rows/);

      // Single failure write attempt only
      expect(rpcCalls.length).toBe(1);
      expect(rpcCalls[0].args.p_error_code).toBe("service_unavailable");
    });

    it("Case C: Resend succeeds, complete_email_outbox_job returns { data: false, error: null } -> operational failure with idempotency key intact", async () => {
      const supabase = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: { user: { id: "u1", email: "seller@example.com" } },
              error: null,
            }),
          },
        },
        rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
      } as unknown as any;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "msg-resend-success-case-c" }),
      });

      await expect(
        processSingleJob(supabase, sampleJob, baseConfig, mockFetch as any)
      ).rejects.toThrow(/Email delivered by provider, but failed to mark sent in outbox.*database updated zero rows/);

      // Confirm Resend was called with the immutable job ID idempotency key
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["Idempotency-Key"]).toBe(`fairswap/listing-email/${sampleJob.id}`);
    });

    it("sanitizeErrorMessage redacts email addresses and authorization tokens", () => {
      const err = new Error("Failed to deliver to user_bob@domain.in with Authorization: Bearer secret_token_xyz");
      const sanitized = sanitizeErrorMessage(err);
      expect(sanitized).not.toContain("user_bob@domain.in");
      expect(sanitized).not.toContain("secret_token_xyz");
      expect(sanitized).toContain("[REDACTED_EMAIL]");
      expect(sanitized).toContain("Bearer [REDACTED]");
    });
  });
});
