import { describe, it, expect, vi } from "vitest";
import {
  processClaimedJob,
  handleModerationWorkerRequest,
  WorkerConfigSchema,
  type ClaimedModerationJob,
} from "../../supabase/functions/_shared/listing-moderation-worker";
import { evaluateListingText } from "@/lib/moderation/checker";

describe("Listing Moderation Worker Unit Tests", () => {
  it("validates worker configuration schema", () => {
    const validConfig = {
      supabaseUrl: "https://example.supabase.co",
      supabaseServiceRoleKey: "service-role-secret-key-xyz",
      moderationWorkerSecret: "worker-secret-12345",
      batchSize: "5",
      leaseSeconds: "30",
    };
    const parsed = WorkerConfigSchema.safeParse(validConfig);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.batchSize).toBe(5);
      expect(parsed.data.leaseSeconds).toBe(30);
    }
  });

  it("processes clean eligible listing and maps to no_review_flags outcome", async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: true, decision: "auto_approved" },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const job: ClaimedModerationJob = {
      request_id: "11111111-1111-4111-8111-111111111111",
      listing_id: "22222222-2222-4222-8222-222222222222",
      listing_revision: 1,
      generation_id: "33333333-3333-4333-8333-333333333333",
      claim_token: "44444444-4444-4444-8444-444444444444",
      attempt_count: 1,
      title: "Royal Enfield Classic 350 in mint condition",
      description: "Well maintained bike with regular service records. Genuine buyers only.",
    };

    const res = await processClaimedJob(job, mockSupabase);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("auto_approved");

    expect(mockRpc).toHaveBeenCalledWith("impl_finalize_moderation_result", {
      p_request_id: "11111111-1111-4111-8111-111111111111",
      p_claim_token: "44444444-4444-4444-8444-444444444444",
      p_outcome: "no_review_flags",
      p_ruleset_version: "prototype_v0.1.1",
      p_scope: "title_description",
      p_completed_rules: [
        "rule_prohibited_item_wording",
        "rule_shortened_link",
        "rule_payment_before_viewing",
      ],
      p_failed_rules: [],
      p_flags: [],
      p_errors: [],
    });
  });

  it("processes flagged listing and maps to needs_review outcome with flags", async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: true, decision: "routed_to_admin" },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const job: ClaimedModerationJob = {
      request_id: "11111111-1111-4111-8111-111111111112",
      listing_id: "22222222-2222-4222-8222-222222222223",
      listing_revision: 1,
      generation_id: "33333333-3333-4333-8333-333333333334",
      claim_token: "44444444-4444-4444-8444-444444444445",
      attempt_count: 1,
      title: "Licensed handgun holster only",
      description: "Leather holster in great shape. No actual firearm included.",
    };

    const res = await processClaimedJob(job, mockSupabase);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("routed_to_admin");

    expect(mockRpc).toHaveBeenCalledWith(
      "impl_finalize_moderation_result",
      expect.objectContaining({
        p_outcome: "needs_review",
        p_flags: expect.arrayContaining([
          expect.objectContaining({
            ruleId: "rule_prohibited_item_wording",
          }),
        ]),
      })
    );
  });

  it("processes invalid short input and maps to invalid_input outcome", async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: true, decision: "rejected_invalid" },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const job: ClaimedModerationJob = {
      request_id: "11111111-1111-4111-8111-111111111113",
      listing_id: "22222222-2222-4222-8222-222222222224",
      listing_revision: 1,
      generation_id: "33333333-3333-4333-8333-333333333335",
      claim_token: "44444444-4444-4444-8444-444444444446",
      attempt_count: 1,
      title: "a", // too short
      description: "short", // too short
    };

    const res = await processClaimedJob(job, mockSupabase);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("rejected_invalid");

    expect(mockRpc).toHaveBeenCalledWith(
      "impl_finalize_moderation_result",
      expect.objectContaining({
        p_outcome: "invalid_input",
        p_errors: expect.any(Array),
      })
    );
  });

  it("evaluates interrupted example (bit.ly link) through evaluateListingText and worker", async () => {
    const input = {
      title: "Cheap Phone - bit.ly/deal123",
      description: "Genuine used phone in great condition. Call for pickup.",
    };

    // 1. Direct evaluateListingText assertion
    const evalResult = evaluateListingText(input);
    expect(evalResult.outcome).toBe("needs_review");
    if (evalResult.outcome === "needs_review") {
      expect(evalResult.flags).toHaveLength(1);
      expect(evalResult.flags[0].ruleId).toBe("rule_shortened_link");
      expect(evalResult.flags[0].field).toBe("title");
    }

    // 2. Process through worker
    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: true, decision: "routed_to_admin" },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const job: ClaimedModerationJob = {
      request_id: "11111111-1111-4111-8111-111111111114",
      listing_id: "22222222-2222-4222-8222-222222222225",
      listing_revision: 1,
      generation_id: "33333333-3333-4333-8333-333333333336",
      claim_token: "44444444-4444-4444-8444-444444444447",
      attempt_count: 1,
      title: input.title,
      description: input.description,
    };

    const res = await processClaimedJob(job, mockSupabase);
    expect(res.success).toBe(true);
    expect(res.decision).toBe("routed_to_admin");

    expect(mockRpc).toHaveBeenCalledWith(
      "impl_finalize_moderation_result",
      expect.objectContaining({
        p_outcome: "needs_review",
        p_flags: [
          {
            ruleId: "rule_shortened_link",
            field: "title",
            reason: "Known shortened link found.",
          },
        ],
      })
    );
  });

  it("handles business-level finalizer rejection without reporting success", async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: false, error: "LEASE_TOKEN_MISMATCH" },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const job: ClaimedModerationJob = {
      request_id: "11111111-1111-4111-8111-111111111115",
      listing_id: "22222222-2222-4222-8222-222222222226",
      listing_revision: 1,
      generation_id: "33333333-3333-4333-8333-333333333337",
      claim_token: "44444444-4444-4444-8444-444444444448",
      attempt_count: 1,
      title: "Clean Chair",
      description: "Solid wooden chair in good shape.",
    };

    const res = await processClaimedJob(job, mockSupabase);
    expect(res.success).toBe(false);
    expect(res.error).toBe("LEASE_TOKEN_MISMATCH");
  });

  it("rejects malformed claimed job shapes immediately", async () => {
    const mockRpc = vi.fn();
    const mockSupabase = { rpc: mockRpc } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const badJob = {
      request_id: "not-a-uuid",
      title: "Bad Job",
    };

    const res = await processClaimedJob(badJob, mockSupabase);
    expect(res.success).toBe(false);
    expect(res.error).toContain("INVALID_CLAIMED_JOB_SHAPE");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  describe("handleModerationWorkerRequest HTTP handler tests", () => {
    const validConfig = {
      supabaseUrl: "https://example.supabase.co",
      supabaseServiceRoleKey: "service-role-secret-key-xyz",
      moderationWorkerSecret: "correct-worker-secret-42",
      batchSize: 10,
      leaseSeconds: 60,
    };

    it("rejects requests missing x-moderation-worker-secret header with 401", async () => {
      const mockSupabase = {} as unknown as import("@supabase/supabase-js").SupabaseClient;
      const req = new Request("https://example.com/process-listing-moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const res = await handleModerationWorkerRequest(req, validConfig, mockSupabase);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Unauthorized: Invalid worker secret");
    });

    it("rejects requests with incorrect x-moderation-worker-secret header with 401", async () => {
      const mockSupabase = {} as unknown as import("@supabase/supabase-js").SupabaseClient;
      const req = new Request("https://example.com/process-listing-moderation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-moderation-worker-secret": "wrong-secret",
        },
      });

      const res = await handleModerationWorkerRequest(req, validConfig, mockSupabase);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Unauthorized: Invalid worker secret");
    });

    it("accepts valid secret and claims and processes jobs through worker", async () => {
      const mockRpc = vi.fn().mockImplementation((fnName: string) => {
        if (fnName === "claim_moderation_batch") {
          return Promise.resolve({
            data: [
              {
                request_id: "11111111-1111-4111-8111-111111111119",
                listing_id: "22222222-2222-4222-8222-222222222229",
                listing_revision: 1,
                generation_id: "33333333-3333-4333-8333-333333333339",
                claim_token: "44444444-4444-4444-8444-444444444449",
                attempt_count: 1,
                title: "Teak Dining Table",
                description: "Handcrafted solid teak dining table in pristine condition.",
              },
            ],
            error: null,
          });
        }
        if (fnName === "impl_finalize_moderation_result") {
          return Promise.resolve({
            data: { success: true, decision: "auto_approved" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: new Error("UNKNOWN_RPC") });
      });
      const mockSupabase = { rpc: mockRpc } as unknown as import("@supabase/supabase-js").SupabaseClient;

      const req = new Request("https://example.com/process-listing-moderation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-moderation-worker-secret": "correct-worker-secret-42",
        },
      });

      const res = await handleModerationWorkerRequest(req, validConfig, mockSupabase);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.processed).toBe(1);
      expect(body.results[0].success).toBe(true);
      expect(body.results[0].decision).toBe("auto_approved");
    });
  });
});
