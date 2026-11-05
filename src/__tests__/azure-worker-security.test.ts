import { describe, it, expect, vi } from "vitest";
import { processClaimedAzureJob, type AzureWorkerConfig } from "../../supabase/functions/_shared/azure-moderation-worker";

const mockConfig: AzureWorkerConfig = {
  supabaseUrl: "https://wpppxlnbzqynvhpeuavd.supabase.co",
  supabaseServiceRoleKey: "service-role-test-key",
  azureModerationEndpoint: "http://ca-moderation-controller:8080/v1/moderate",
  azureModerationSecret: "azure-secret-min-16-chars",
  batchSize: 10,
  leaseSeconds: 60,
};

describe("Azure Moderation Worker - Response Validation & Security Gates", () => {
  const mockJob = {
    request_id: "11111111-1111-1111-1111-111111111111",
    listing_id: "22222222-2222-2222-2222-222222222222",
    listing_revision: 2,
    generation_id: "33333333-3333-3333-3333-333333333333",
    claim_token: "44444444-4444-4444-4444-444444444444",
    attempt_count: 1,
    title: "Gaming Laptop",
    description: "RTX 4060, excellent condition with invoice.",
  };

  it("fails closed when Azure returns response identity mismatch (different generation or revision)", async () => {
    // Mock Supabase client
    const mockSupabase: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "listings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: { category_id: "77777777-7777-7777-7777-777777777777", categories: { slug: "electronics" } },
                error: null,
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: "55555555-5555-5555-5555-555555555555",
                    original_storage_path: "listings/photo1.jpg",
                    processing_status: "ready",
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) },
            error: null,
          }),
          createSignedUrl: vi.fn().mockResolvedValue({
            data: { signedUrl: "https://wpppxlnbzqynvhpeuavd.supabase.co/storage/v1/object/sign/listing-originals/photo1.jpg" },
            error: null,
          }),
        }),
      },
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === "register_moderation_scan_receipt") return Promise.resolve({ error: null });
        if (fn === "impl_finalize_moderation_result") return Promise.resolve({ data: { decision: "routed_to_admin" }, error: null });
        return Promise.resolve({ error: null });
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          verdict: "APPROVE",
          listingId: mockJob.listing_id,
          listingRevision: 1, // Stale revision 1 returned instead of job's 2
          generationId: mockJob.generation_id,
          mediaDigest: "some-digest",
          completedChecks: ["check_india_fraud_rules", "check_openai_moderation", "check_vision_nsfw", "check_vision_category", "check_ocr_qr"],
          failedChecks: [],
          flags: [],
          modelVersions: { rulesetVersion: "india_v1.0.0" },
          scannedMediaCount: 1,
          manifest: [{ mediaId: "55555555-5555-5555-5555-555555555555", originalStoragePath: "listings/photo1.jpg", mediaSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }],
        }),
        { status: 200 }
      )
    );

    try {
      const res = await processClaimedAzureJob(mockJob, mockSupabase, mockConfig);
      expect(res.success).toBe(true);
      // Finalizer received checks_incomplete / routed to admin due to identity mismatch
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "impl_finalize_moderation_result",
        expect.objectContaining({ p_outcome: "checks_incomplete" })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when returned manifest media count does not match database media count", async () => {
    const mockSupabase: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "listings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: { category_id: "77777777-7777-7777-7777-777777777777", categories: { slug: "electronics" } },
                error: null,
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [
                  { id: "55555555-5555-5555-5555-555555555555", original_storage_path: "listings/photo1.jpg", processing_status: "ready" },
                  { id: "66666666-6666-6666-6666-666666666666", original_storage_path: "listings/photo2.jpg", processing_status: "ready" },
                ],
                error: null,
              }),
            }),
          }),
        };
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) },
            error: null,
          }),
          createSignedUrl: vi.fn().mockResolvedValue({
            data: { signedUrl: "https://wpppxlnbzqynvhpeuavd.supabase.co/storage/v1/object/sign/listing-originals/photo.jpg" },
            error: null,
          }),
        }),
      },
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === "register_moderation_scan_receipt") return Promise.resolve({ error: null });
        if (fn === "impl_finalize_moderation_result") return Promise.resolve({ data: { decision: "routed_to_admin" }, error: null });
        return Promise.resolve({ error: null });
      }),
    };

    const originalFetch = globalThis.fetch;
    // Azure only scanned 1 of the 2 photos
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          verdict: "APPROVE",
          listingId: mockJob.listing_id,
          listingRevision: mockJob.listing_revision,
          generationId: mockJob.generation_id,
          mediaDigest: "some-digest",
          completedChecks: ["check_india_fraud_rules", "check_openai_moderation", "check_vision_nsfw", "check_vision_category", "check_ocr_qr"],
          failedChecks: [],
          flags: [],
          modelVersions: { rulesetVersion: "india_v1.0.0" },
          scannedMediaCount: 1,
          manifest: [{ mediaId: "55555555-5555-5555-5555-555555555555", originalStoragePath: "listings/photo1.jpg", mediaSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }],
        }),
        { status: 200 }
      )
    );

    try {
      const res = await processClaimedAzureJob(mockJob, mockSupabase, mockConfig);
      expect(res.success).toBe(true);
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "impl_finalize_moderation_result",
        expect.objectContaining({ p_outcome: "checks_incomplete" })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("processes baseline two-check job with zero photos successfully", async () => {
    const { processClaimedModerationJob } = await import("../../supabase/functions/_shared/azure-moderation-worker");
    const mockSupabase: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "listings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: { category_id: "77777777-7777-7777-7777-777777777777", categories: { slug: "electronics" } },
                error: null,
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [], // 0 photos
                error: null,
              }),
            }),
          }),
        };
      }),
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === "register_moderation_scan_receipt") return Promise.resolve({ error: null });
        if (fn === "impl_finalize_moderation_result") return Promise.resolve({ data: { decision: "auto_approved" }, error: null });
        return Promise.resolve({ error: null });
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("moderations")) {
        return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }), { status: 200 }));
      }
      return Promise.reject(new Error("Unexpected URL"));
    });

    try {
      const res = await processClaimedModerationJob(mockJob, mockSupabase, {
        mode: "baseline",
        openAiApiKey: "test-openai-key",
      });
      expect(res.success).toBe(true);
      expect(res.decision).toBe("auto_approved");
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "register_moderation_scan_receipt",
        expect.objectContaining({
          p_ruleset_version: "india_baseline_v1.0.0",
          p_scope: "baseline_two_check",
          p_completed_checks: ["check_india_fraud_rules", "check_openai_moderation"],
          p_failed_checks: [],
          p_scanned_media_count: 0,
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when OpenAI API key is missing (never counts as completed check)", async () => {
    const { processClaimedModerationJob } = await import("../../supabase/functions/_shared/azure-moderation-worker");
    const mockSupabase: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "listings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: { category_id: "77777777-7777-7777-7777-777777777777", categories: { slug: "electronics" } },
                error: null,
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }),
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === "register_moderation_scan_receipt") return Promise.resolve({ error: null });
        if (fn === "impl_finalize_moderation_result") return Promise.resolve({ data: { decision: "awaiting_retry" }, error: null });
        return Promise.resolve({ error: null });
      }),
    };

    // Missing openAiApiKey
    const res = await processClaimedModerationJob(mockJob, mockSupabase, { mode: "baseline" });
    expect(res.success).toBe(true);
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      "register_moderation_scan_receipt",
      expect.objectContaining({
        p_failed_checks: ["check_openai_moderation"],
        p_verdict: "INCOMPLETE",
      })
    );
  });

  it("evaluates OCR and QR text with India fraud rules and flags suspicious payloads", async () => {
    const { processClaimedModerationJob } = await import("../../supabase/functions/_shared/azure-moderation-worker");
    const mockSupabase: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "listings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: { category_id: "77777777-7777-7777-7777-777777777777", categories: { slug: "electronics" } },
                error: null,
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [
                  { id: "55555555-5555-5555-5555-555555555555", original_storage_path: "listings/photo1.jpg", processing_status: "ready" },
                ],
                error: null,
              }),
            }),
          }),
        };
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) },
            error: null,
          }),
          createSignedUrl: vi.fn().mockResolvedValue({
            data: { signedUrl: "https://storage.test/photo1.jpg" },
            error: null,
          }),
        }),
      },
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === "register_moderation_scan_receipt") return Promise.resolve({ error: null });
        if (fn === "impl_finalize_moderation_result") return Promise.resolve({ data: { decision: "routed_to_admin" }, error: null });
        return Promise.resolve({ error: null });
      }),
    };

    const originalFetch = globalThis.fetch;
    // Azure returns extractedTexts containing suspicious payment demand; OpenAI returns clean
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("moderations")) {
        return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            verdict: "APPROVE",
            listingId: mockJob.listing_id,
            listingRevision: mockJob.listing_revision,
            generationId: mockJob.generation_id,
            mediaDigest: "e865150fede4cd97c9559a494b4258929bc2c39c78c18e4a5e4ef0b74168695b",
            completedChecks: ["check_vision_nsfw", "check_vision_category", "check_ocr_qr"],
            failedChecks: [],
            flags: [],
            modelVersions: { rulesetVersion: "india_azure_v1.0.0" },
            scannedMediaCount: 1,
            extractedTexts: ["Pay 500 advance via GPay to hold"],
            qrPayloads: ["upi://pay?pa=scam@upi"],
            manifest: [{ mediaId: "55555555-5555-5555-5555-555555555555", originalStoragePath: "listings/photo1.jpg", mediaSha256: "01d448afd928065458cf670b60f5a594d735af0172c8d67f22a81680132681ca" }],
          }),
          { status: 200 }
        )
      );
    });

    try {
      const res = await processClaimedModerationJob(mockJob, mockSupabase, {
        mode: "azure",
        azureEndpoint: "https://azure.mod/scan",
        azureSecret: "mock-azure-secret-12345",
        openAiApiKey: "test-openai-key",
      });
      expect(res.success).toBe(true);
      // Fraud rules flagged the extracted text -> outcome needs_review
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "impl_finalize_moderation_result",
        expect.objectContaining({
          p_outcome: "needs_review",
          p_scope: "multimodal_five_check",
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

