import { describe, it, expect, vi } from "vitest";
import { orchestrateModerationJob } from "../../services/moderation-azure/controller/src/orchestrator";
import type { ControllerConfig, ModerationJobRequest } from "../../services/moderation-azure/controller/src/types";

const mockConfig: ControllerConfig = {
  port: 8080,
  moderationSecret: "test-secret-min-16-chars",
  openAiApiKey: "test-openai-key",
  openAiApiBase: "https://api.openai.com/v1",
  nodeVisionServiceUrl: "http://node-vision:8081",
  pythonOcrServiceUrl: "http://python-ocr:8082",
  timeoutMs: 1000,
  environment: "test",
  allowedStorageHost: "wpppxlnbzqynvhpeuavd.supabase.co",
};

describe("Azure Moderation V1 - Orchestration, Integrity & Security Scenarios", () => {
  const baseJob: ModerationJobRequest = {
    listingId: "11111111-1111-1111-1111-111111111111",
    listingRevision: 1,
    generationId: "22222222-2222-2222-2222-222222222222",
    title: "Brand new gaming headset",
    description: "Original box, sealed pack with bill.",
    mediaDigest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // Will be matched by test
    media: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        originalStoragePath: "listings/photo.jpg",
        scopedSignedUrl: "https://wpppxlnbzqynvhpeuavd.supabase.co/storage/v1/object/sign/listing-originals/listings/photo.jpg?token=abc",
        mediaSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ],
  };

  it("fails closed when media manifest digest does not match computed manifest (media-swap / forged receipt)", async () => {
    const maliciousJob: ModerationJobRequest = {
      ...baseJob,
      mediaDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const res = await orchestrateModerationJob(maliciousJob, mockConfig);
    expect(res.verdict).toBe("INCOMPLETE");
    expect(res.flags.some((f) => f.code === "MEDIA_DIGEST_MISMATCH")).toBe(true);
  });

  it("fails closed (verdict: INCOMPLETE) when signed image origin violates environment Supabase boundary or path (SSRF protection)", async () => {
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256")
      .update("44444444-4444-4444-4444-444444444444:listings/photo.jpg:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
      .digest("hex");

    const maliciousJob: ModerationJobRequest = {
      ...baseJob,
      mediaDigest: digest,
      media: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          originalStoragePath: "listings/photo.jpg",
          scopedSignedUrl: "https://attacker-controlled-server.com/malicious.jpg",
          mediaSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ],
    };

    const res = await orchestrateModerationJob(maliciousJob, mockConfig);
    expect(res.verdict).toBe("INCOMPLETE");
    expect(res.flags.some((f) => f.code === "INVALID_MEDIA_ORIGIN")).toBe(true);
  });

  it("fails closed when zero photos are submitted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("moderations")) {
        return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected call"));
    });

    try {
      const zeroPhotoJob: ModerationJobRequest = {
        ...baseJob,
        media: [],
        mediaDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      };

      const res = await orchestrateModerationJob(zeroPhotoJob, mockConfig);
      expect(res.verdict).toBe("INCOMPLETE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when an image fails download or SHA-256 integrity verification", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("moderations")) {
        return Promise.resolve(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
      }
      if (url.includes("node-vision")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "incomplete",
              scannedCount: 0,
              results: [
                {
                  mediaId: "33333333-3333-3333-3333-333333333333",
                  sha256Verified: false,
                  status: "hash_mismatch",
                },
              ],
              flags: [],
            }),
            { status: 200 }
          )
        );
      }
      if (url.includes("python-ocr")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "completed",
              scannedCount: 1,
              results: [{ mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" }],
              extractedTexts: [],
              qrPayloads: [],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error("Unhandled route"));
    });

    try {
      // Calculate matching manifest digest for test
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256")
        .update("33333333-3333-3333-3333-333333333333:listings/photo.jpg:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        .digest("hex");

      const validDigestJob = { ...baseJob, mediaDigest: digest };
      const res = await orchestrateModerationJob(validDigestJob, mockConfig);
      expect(res.verdict).toBe("INCOMPLETE");
      expect(res.failedChecks).toContain("check_vision_nsfw");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when vision service times out or fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("node-vision")) {
        return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "completed",
            scannedCount: 1,
            results: [{ mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" }],
            flags: [],
            extractedTexts: [],
            qrPayloads: [],
          }),
          { status: 200 }
        )
      );
    });

    try {
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256")
        .update("33333333-3333-3333-3333-333333333333:listings/photo.jpg:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        .digest("hex");

      const validDigestJob = { ...baseJob, mediaDigest: digest };
      const res = await orchestrateModerationJob(validDigestJob, mockConfig);
      expect(res.verdict).toBe("INCOMPLETE");
      expect(res.failedChecks).toContain("check_vision_nsfw");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns APPROVE and extracted text/QR when all 3 image checks succeed with clean content", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("node-vision")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "completed",
              scannedCount: 1,
              results: [{ mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" }],
              flags: [],
            }),
            { status: 200 }
          )
        );
      }
      if (url.includes("python-ocr")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "completed",
              scannedCount: 1,
              results: [{ mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" }],
              extractedTexts: ["Sony WH-1000XM4 Wireless Noise Cancelling"],
              qrPayloads: [],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error("Unhandled route"));
    });

    try {
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256")
        .update("33333333-3333-3333-3333-333333333333:listings/photo.jpg:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        .digest("hex");

      const validDigestJob = { ...baseJob, mediaDigest: digest };
      const res = await orchestrateModerationJob(validDigestJob, mockConfig);
      expect(res.verdict).toBe("APPROVE");
      expect(res.failedChecks).toHaveLength(0);
      expect(res.completedChecks).toEqual([
        "check_vision_nsfw",
        "check_vision_category",
        "check_ocr_qr",
      ]);
      expect(res.extractedTexts).toEqual(["Sony WH-1000XM4 Wireless Noise Cancelling"]);
      expect(res.perImageResults[0].hashVerified).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects Vision response with duplicate media ID or count mismatch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("node-vision")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "completed",
              scannedCount: 2,
              // Duplicate media ID returned!
              results: [
                { mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" },
                { mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" },
              ],
              flags: [],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "completed",
            scannedCount: 1,
            results: [{ mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" }],
            extractedTexts: [],
            qrPayloads: [],
          }),
          { status: 200 }
        )
      );
    });

    try {
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256")
        .update("33333333-3333-3333-3333-333333333333:listings/photo.jpg:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        .digest("hex");

      const validDigestJob = { ...baseJob, mediaDigest: digest };
      const res = await orchestrateModerationJob(validDigestJob, mockConfig);
      expect(res.verdict).toBe("INCOMPLETE");
      expect(res.failedChecks).toContain("check_vision_nsfw");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects OCR response with missing or unexpected media ID", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("node-vision")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "completed",
              scannedCount: 1,
              results: [{ mediaId: "33333333-3333-3333-3333-333333333333", sha256Verified: true, status: "success" }],
              flags: [],
            }),
            { status: 200 }
          )
        );
      }
      if (url.includes("python-ocr")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "completed",
              scannedCount: 1,
              // Wrong/unexpected media ID returned!
              results: [{ mediaId: "99999999-9999-9999-9999-999999999999", sha256Verified: true, status: "success" }],
              extractedTexts: [],
              qrPayloads: [],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error("Unhandled route"));
    });

    try {
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256")
        .update("33333333-3333-3333-3333-333333333333:listings/photo.jpg:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        .digest("hex");

      const validDigestJob = { ...baseJob, mediaDigest: digest };
      const res = await orchestrateModerationJob(validDigestJob, mockConfig);
      expect(res.verdict).toBe("INCOMPLETE");
      expect(res.failedChecks).toContain("check_ocr_qr");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
