import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  processClaimedModerationJob,
  INDIA_BASELINE_RULESET_VERSION,
  INDIA_BASELINE_EVALUATION_SCOPE,
  INDIA_AZURE_RULESET_VERSION,
  INDIA_AZURE_EVALUATION_SCOPE,
  INDIA_GOOGLE_RULESET_VERSION,
  INDIA_GOOGLE_EVALUATION_SCOPE,
  INDIA_DUAL_CLOUD_RULESET_VERSION,
  INDIA_DUAL_CLOUD_EVALUATION_SCOPE,
  type ModerationJobOptions,
} from "../../supabase/functions/_shared/azure-moderation-worker";

describe("FairSwap Google Cloud Moderation V1 - Scoped Automated Tests", () => {
  const mockJob = {
    request_id: "11111111-1111-1111-1111-111111111111",
    listing_id: "22222222-2222-2222-2222-222222222222",
    listing_revision: 1,
    generation_id: "33333333-3333-3333-3333-333333333333",
    claim_token: "44444444-4444-4444-4444-444444444444",
    attempt_count: 1,
    title: "OnePlus Nord 3 5G",
    description: "Mint condition, 128GB, bill and box available.",
  };

  const sampleBytes = new Uint8Array([1, 2, 3, 4]);
  const realMediaSha256 = createHash("sha256").update(sampleBytes).digest("hex");
  const mediaId = "55555555-5555-5555-5555-555555555555";
  const realManifestDigest = createHash("sha256")
    .update(`${mediaId}:listings/photo1.jpg:${realMediaSha256}`)
    .digest("hex");

  const createMockSupabase = (options: {
    categorySlug?: string;
    mediaList?: Array<{ id: string; original_storage_path: string; processing_status: string }>;
    registerReceiptError?: any;
    finalizerDecision?: string;
  } = {}) => {
    const categorySlug = options.categorySlug ?? "electronics";
    const mediaList = options.mediaList ?? [
      {
        id: mediaId,
        original_storage_path: "listings/photo1.jpg",
        processing_status: "ready",
      },
    ];

    const rpcCalls: Record<string, any[]> = {};

    const client: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "listings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: {
                  category_id: "77777777-7777-7777-7777-777777777777",
                  categories: { slug: categorySlug },
                },
                error: null,
              }),
            }),
          };
        }
        if (table === "listing_media") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: mediaList,
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: { arrayBuffer: () => Promise.resolve(sampleBytes.buffer) },
            error: null,
          }),
          createSignedUrl: vi.fn().mockResolvedValue({
            data: { signedUrl: "https://wpppxlnbzqynvhpeuavd.supabase.co/storage/v1/object/sign/listing-originals/photo1.jpg?token=abc" },
            error: null,
          }),
        }),
      },
      rpc: vi.fn().mockImplementation((fn: string, params: any) => {
        if (!rpcCalls[fn]) rpcCalls[fn] = [];
        rpcCalls[fn].push(params);

        if (fn === "register_moderation_scan_receipt") {
          if (options.registerReceiptError) {
            return Promise.resolve({ error: options.registerReceiptError });
          }
          return Promise.resolve({ data: "receipt-uuid-1", error: null });
        }
        if (fn === "impl_finalize_moderation_result") {
          return Promise.resolve({
            data: { decision: options.finalizerDecision ?? "auto_approved" },
            error: null,
          });
        }
        return Promise.resolve({ error: null });
      }),
      _rpcCalls: rpcCalls,
    };

    return client;
  };

  const createCleanScanResponse = (job: typeof mockJob) => ({
    verdict: "APPROVE",
    listingId: job.listing_id,
    listingRevision: job.listing_revision,
    generationId: job.generation_id,
    mediaDigest: realManifestDigest,
    completedChecks: ["check_vision_nsfw", "check_vision_category", "check_ocr_qr"],
    failedChecks: [],
    flags: [],
    modelVersions: { nsfw: "nsfw-v2", ocr: "pp-ocr-v3" },
    scannedMediaCount: 1,
    extractedTexts: ["OnePlus Phone"],
    qrPayloads: [],
    manifest: [
      {
        id: mediaId,
        path: "listings/photo1.jpg",
        sha256: realMediaSha256,
      },
    ],
  });

  // ---------------------------------------------------------------------------
  // 1. COMBINATION 1: Supabase + OpenAI (Baseline Two-Check)
  // ---------------------------------------------------------------------------
  describe("Combination 1: Supabase + OpenAI (Baseline Mode)", () => {
    it("approves clean ad without making any remote cloud calls", async () => {
      const mockSupabase = createMockSupabase();
      const mockFetch = vi.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const options: ModerationJobOptions = {
          mode: "baseline",
          openAiApiKey: "test-openai-key",
        };

        mockFetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [{ flagged: false, categories: {}, category_scores: {} }],
              model: "omni-moderation-latest",
            }),
            { status: 200 }
          )
        );

        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);
        expect(res.decision).toBe("auto_approved");

        // Remote cloud providers must NOT be called in baseline mode
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toContain("api.openai.com");

        const receipts = mockSupabase._rpcCalls["register_moderation_scan_receipt"];
        expect(receipts).toHaveLength(1);
        expect(receipts[0].p_ruleset_version).toBe(INDIA_BASELINE_RULESET_VERSION);
        expect(receipts[0].p_scope).toBe(INDIA_BASELINE_EVALUATION_SCOPE);
        expect(receipts[0].p_verdict).toBe("APPROVE");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("flags fraudulent text and avoids any cloud calls", async () => {
      const mockSupabase = createMockSupabase();
      const fraudJob = {
        ...mockJob,
        title: "Apple iPhone 15 Pro",
        description: "Send Rs 500 advance before viewing the phone.", // Triggers advance payment rule
      };

      const options: ModerationJobOptions = {
        mode: "baseline",
        openAiApiKey: "test-openai-key",
      };

      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ flagged: false, categories: {} }],
          }),
          { status: 200 }
        )
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await processClaimedModerationJob(fraudJob, mockSupabase, options);
        expect(res.success).toBe(true);

        const finalizerCalls = mockSupabase._rpcCalls["impl_finalize_moderation_result"];
        expect(finalizerCalls).toHaveLength(1);
        expect(finalizerCalls[0].p_outcome).toBe("needs_review");
        expect(finalizerCalls[0].p_flags.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. COMBINATION 2: Supabase + OpenAI + Azure
  // ---------------------------------------------------------------------------
  describe("Combination 2: Supabase + OpenAI + Azure", () => {
    it("fails closed when Azure configuration is missing", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "azure",
        openAiApiKey: "test-key",
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 })
      );

      try {
        await processClaimedModerationJob(mockJob, mockSupabase, options);
        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("checks_incomplete");
        expect(finalizer.p_failed_rules).toContain("azure_missing_configuration");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("skips Azure remote call when baseline checks flag content", async () => {
      const mockSupabase = createMockSupabase();
      const fraudJob = {
        ...mockJob,
        description: "Send Rs 500 advance before viewing the phone.",
      };

      const options: ModerationJobOptions = {
        mode: "azure",
        azureEndpoint: "https://azure-mod.internal/v1/moderate",
        azureSecret: "secret1234567890",
        openAiApiKey: "test-key",
      };

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        return Promise.reject(new Error("Azure should not be called!"));
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await processClaimedModerationJob(fraudJob, mockSupabase, options);
        expect(res.success).toBe(true);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toContain("api.openai.com");

        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("needs_review");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. COMBINATION 3: Supabase + OpenAI + Google Cloud Run
  // ---------------------------------------------------------------------------
  describe("Combination 3: Supabase + OpenAI + Google Cloud Run", () => {
    it("successfully approves clean ad when Google Cloud Run returns APPROVE", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "google_cloud",
        googleCloudEndpoint: "https://cr-moderation-controller-test-xyz.a.run.app/v1/moderate",
        googleCloudSecret: "gcp-secret-16chars-minimum",
        openAiApiKey: "test-key",
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        if (url.includes("run.app")) {
          return Promise.resolve(
            new Response(JSON.stringify(createCleanScanResponse(mockJob)), { status: 200 })
          );
        }
        return Promise.reject(new Error("Unknown route"));
      });

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);
        expect(res.decision).toBe("auto_approved");

        const receipts = mockSupabase._rpcCalls["register_moderation_scan_receipt"];
        expect(receipts).toHaveLength(1);
        expect(receipts[0].p_ruleset_version).toBe(INDIA_GOOGLE_RULESET_VERSION);
        expect(receipts[0].p_scope).toBe(INDIA_GOOGLE_EVALUATION_SCOPE);
        expect(receipts[0].p_verdict).toBe("APPROVE");
        expect(receipts[0].p_completed_checks).toEqual(
          expect.arrayContaining([
            "check_india_fraud_rules",
            "check_openai_moderation",
            "check_google_vision_nsfw",
            "check_google_vision_category",
            "check_google_ocr_qr",
          ])
        );

        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("no_review_flags");
        expect(finalizer.p_ruleset_version).toBe(INDIA_GOOGLE_RULESET_VERSION);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("routes to staff review when Google Cloud Run flags an image check", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "google_cloud",
        googleCloudEndpoint: "https://cr-moderation-controller-test-xyz.a.run.app/v1/moderate",
        googleCloudSecret: "gcp-secret-16chars-minimum",
        openAiApiKey: "test-key",
      };

      const flaggedGoogleResponse = {
        ...createCleanScanResponse(mockJob),
        verdict: "FLAG",
        flags: [
          {
            check: "check_vision_nsfw",
            field: "image",
            code: "NSFW_EXPLICIT",
            reason: "Explicit content detected",
            severity: "critical",
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        if (url.includes("run.app")) {
          return Promise.resolve(new Response(JSON.stringify(flaggedGoogleResponse), { status: 200 }));
        }
        return Promise.reject(new Error("Unknown route"));
      });

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);

        const receipts = mockSupabase._rpcCalls["register_moderation_scan_receipt"];
        expect(receipts[0].p_verdict).toBe("FLAG");

        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("needs_review");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("fails closed when Google Cloud Run times out or returns HTTP error", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "google_cloud",
        googleCloudEndpoint: "https://cr-moderation-controller-test-xyz.a.run.app/v1/moderate",
        googleCloudSecret: "gcp-secret-16chars-minimum",
        openAiApiKey: "test-key",
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        if (url.includes("run.app")) {
          return Promise.resolve(new Response("Service Unavailable", { status: 500 }));
        }
        return Promise.reject(new Error("Unknown route"));
      });

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);

        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("checks_incomplete");
        expect(finalizer.p_failed_rules).toContain("google_http_500");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. COMBINATION 4: Dual Cloud (Supabase + OpenAI + Azure + Google Cloud)
  // ---------------------------------------------------------------------------
  describe("Combination 4: Dual Cloud (Azure + Google Cloud Run)", () => {
    it("approves only when BOTH Azure and Google Cloud Run succeed independently", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "dual_cloud",
        azureEndpoint: "https://ca-azure-mod.azurecontainerapps.io/v1/moderate",
        azureSecret: "azure-secret-16chars",
        googleCloudEndpoint: "https://cr-moderation-controller-xyz.a.run.app/v1/moderate",
        googleCloudSecret: "google-secret-16chars",
        openAiApiKey: "test-key",
      };

      const originalFetch = globalThis.fetch;
      const calledEndpoints: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        calledEndpoints.push(url);
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        if (url.includes("azurecontainerapps") || url.includes("run.app")) {
          return Promise.resolve(
            new Response(JSON.stringify(createCleanScanResponse(mockJob)), { status: 200 })
          );
        }
        return Promise.reject(new Error("Unknown route"));
      });

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);

        // Verify BOTH cloud endpoints were called
        expect(calledEndpoints.some((u) => u.includes("azurecontainerapps"))).toBe(true);
        expect(calledEndpoints.some((u) => u.includes("run.app"))).toBe(true);

        const receipts = mockSupabase._rpcCalls["register_moderation_scan_receipt"];
        expect(receipts).toHaveLength(2);

        // Receipt 1: Azure independent attestation
        expect(receipts[0].p_ruleset_version).toBe(INDIA_AZURE_RULESET_VERSION);
        expect(receipts[0].p_scope).toBe(INDIA_AZURE_EVALUATION_SCOPE);
        expect(receipts[0].p_verdict).toBe("APPROVE");
        expect(receipts[0].p_completed_checks).toEqual(
          expect.arrayContaining([
            "check_india_fraud_rules",
            "check_openai_moderation",
            "check_azure_vision_nsfw",
            "check_azure_vision_category",
            "check_azure_ocr_qr",
          ])
        );

        // Receipt 2: Google Cloud independent attestation
        expect(receipts[1].p_ruleset_version).toBe(INDIA_GOOGLE_RULESET_VERSION);
        expect(receipts[1].p_scope).toBe(INDIA_GOOGLE_EVALUATION_SCOPE);
        expect(receipts[1].p_verdict).toBe("APPROVE");
        expect(receipts[1].p_completed_checks).toEqual(
          expect.arrayContaining([
            "check_india_fraud_rules",
            "check_openai_moderation",
            "check_google_vision_nsfw",
            "check_google_vision_category",
            "check_google_ocr_qr",
          ])
        );

        // Finalizer receives all 8 distinct attestations
        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_ruleset_version).toBe(INDIA_DUAL_CLOUD_RULESET_VERSION);
        expect(finalizer.p_scope).toBe(INDIA_DUAL_CLOUD_EVALUATION_SCOPE);
        expect(finalizer.p_completed_rules).toHaveLength(8);
        expect(finalizer.p_completed_rules).toEqual(
          expect.arrayContaining([
            "check_india_fraud_rules",
            "check_openai_moderation",
            "check_azure_vision_nsfw",
            "check_azure_vision_category",
            "check_azure_ocr_qr",
            "check_google_vision_nsfw",
            "check_google_vision_category",
            "check_google_ocr_qr",
          ])
        );
        expect(new Set(finalizer.p_completed_rules).size).toBe(8);
        expect(finalizer.p_outcome).toBe("no_review_flags");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("never auto-approves if Azure succeeds but Google Cloud flags content", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "dual_cloud",
        azureEndpoint: "https://ca-azure-mod.azurecontainerapps.io/v1/moderate",
        azureSecret: "azure-secret-16chars",
        googleCloudEndpoint: "https://cr-moderation-controller-xyz.a.run.app/v1/moderate",
        googleCloudSecret: "google-secret-16chars",
        openAiApiKey: "test-key",
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        if (url.includes("azurecontainerapps")) {
          return Promise.resolve(
            new Response(JSON.stringify(createCleanScanResponse(mockJob)), { status: 200 })
          );
        }
        if (url.includes("run.app")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...createCleanScanResponse(mockJob),
                verdict: "FLAG",
                flags: [{ check: "check_ocr_qr", field: "qr", code: "PHISHING_URL", severity: "critical" }],
              }),
              { status: 200 }
            )
          );
        }
        return Promise.reject(new Error("Unknown route"));
      });

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);

        const receipts = mockSupabase._rpcCalls["register_moderation_scan_receipt"];
        expect(receipts).toHaveLength(2);
        expect(receipts[0].p_verdict).toBe("APPROVE"); // Azure was clean
        expect(receipts[1].p_verdict).toBe("FLAG"); // Google flagged

        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("needs_review");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("fails closed when one provider times out or errors", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "dual_cloud",
        azureEndpoint: "https://ca-azure-mod.azurecontainerapps.io/v1/moderate",
        azureSecret: "azure-secret-16chars",
        googleCloudEndpoint: "https://cr-moderation-controller-xyz.a.run.app/v1/moderate",
        googleCloudSecret: "google-secret-16chars",
        openAiApiKey: "test-key",
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        if (url.includes("azurecontainerapps")) {
          return Promise.resolve(
            new Response(JSON.stringify(createCleanScanResponse(mockJob)), { status: 200 })
          );
        }
        if (url.includes("run.app")) {
          return Promise.reject(new Error("Connection timeout"));
        }
        return Promise.reject(new Error("Unknown route"));
      });

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);

        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("checks_incomplete");
        expect(finalizer.p_failed_rules).toContain("google_dispatch_network_timeout");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. INVARIANTS & GUARDS: Zero Media, Expired Lease, Security Gates
  // ---------------------------------------------------------------------------
  describe("Invariants & Security Gates", () => {
    it("disallows zero media for multimodal policies (Azure / Google / Dual Cloud)", async () => {
      const mockSupabase = createMockSupabase({ mediaList: [] }); // 0 photos
      const options: ModerationJobOptions = {
        mode: "google_cloud",
        googleCloudEndpoint: "https://cr.run.app/v1/moderate",
        googleCloudSecret: "secret1234567890",
      };

      const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
      expect(res.success).toBe(false);
      expect(res.error).toBe("ZERO_MEDIA_DISALLOWED_FOR_MULTIMODAL_POLICY");
    });

    it("handles lease expiration during scan gracefully", async () => {
      const mockSupabase = createMockSupabase({
        registerReceiptError: { message: "LEASE_EXPIRED" },
      });
      const options: ModerationJobOptions = {
        mode: "baseline",
        openAiApiKey: "test-key",
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 })
      );

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(false);
        expect(res.error).toBe("LEASE_EXPIRED_DURING_SCAN");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rejects corrupted manifest response from cloud provider (SHA mismatch)", async () => {
      const mockSupabase = createMockSupabase();
      const options: ModerationJobOptions = {
        mode: "google_cloud",
        googleCloudEndpoint: "https://cr.run.app/v1/moderate",
        googleCloudSecret: "secret1234567890",
        openAiApiKey: "test-key",
      };

      const corruptedManifestResponse = {
        ...createCleanScanResponse(mockJob),
        manifest: [
          {
            id: mediaId,
            path: "listings/photo1.jpg",
            sha256: "0000000000000000000000000000000000000000000000000000000000000000", // Tampered SHA
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify(corruptedManifestResponse), { status: 200 }));
      });

      try {
        const res = await processClaimedModerationJob(mockJob, mockSupabase, options);
        expect(res.success).toBe(true);

        const finalizer = mockSupabase._rpcCalls["impl_finalize_moderation_result"][0];
        expect(finalizer.p_outcome).toBe("checks_incomplete");
        expect(finalizer.p_failed_rules).toContain("google_manifest_mismatch");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. INFRASTRUCTURE & WORKFLOW CONTRACTS
  // ---------------------------------------------------------------------------
  describe("Infrastructure & Workflow Contracts", () => {
    const fs = require("node:fs");
    const path = require("node:path");

    it("verifies Cloud Run Terraform specifies IAM authentication and scale-to-zero", () => {
      const tfPath = path.join(process.cwd(), "infra/gcp/moderation/cloudrun.tf");
      expect(fs.existsSync(tfPath)).toBe(true);
      const tf = fs.readFileSync(tfPath, "utf-8");

      // Region: Mumbai (asia-south1)
      expect(tf).toContain('"asia-south1"');

      // Scale-to-zero on all services
      const minInstances = tf.match(/min_instance_count\s*=\s*0/g);
      expect(minInstances?.length).toBe(3);

      // Ingress configuration
      expect(tf).toContain('ingress  = "INGRESS_TRAFFIC_ALL"');

      // IAM invoker restriction: only controller SA can invoke workers
      expect(tf).toContain('google_cloud_run_v2_service_iam_member" "controller_invoke_vision"');
      expect(tf).toContain('google_cloud_run_v2_service_iam_member" "controller_invoke_ocr"');
      expect(tf).toContain('member   = "serviceAccount:${google_service_account.controller_sa.email}"');
    });

    it("verifies GitHub Actions deployment workflow postflight gates and healthz alignment", () => {
      const wfPath = path.join(process.cwd(), ".github/workflows/deploy-google-moderation.yml");
      expect(fs.existsSync(wfPath)).toBe(true);
      const wf = fs.readFileSync(wfPath, "utf-8");

      // Aligned /healthz check expecting 'healthy'
      expect(wf).toContain("expected 'healthy'");

      // Workers verify 403 Forbidden on unauthenticated public requests
      expect(wf).toContain('V_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$V_URL/healthz" || true)');
      expect(wf).toContain('O_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$O_URL/healthz" || true)');
      expect(wf).toContain('expected 403');

      // Controller-to-worker authenticated integration test gate
      expect(wf).toContain("Verify Test Controller Authenticated Integration");
      expect(wf).toContain("Verify Production Controller Authenticated Integration");

      // No unnecessary GHCR_PULL_TOKEN or Artifact Registry
      expect(wf).not.toContain("GHCR_PULL_TOKEN");
      expect(wf).not.toContain("artifactregistry");
    });
  });
});
