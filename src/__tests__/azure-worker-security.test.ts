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
});

