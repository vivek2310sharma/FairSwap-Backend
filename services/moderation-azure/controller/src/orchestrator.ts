import { createHash } from "node:crypto";
import {
  type ControllerConfig,
  type ModerationJobRequest,
  type ModerationDecisionRecord,
  NodeVisionScanResponseSchema,
  PythonOcrScanResponseSchema,
} from "./types";

function validateStorageOrigin(urls: string[], allowedHost: string): boolean {
  for (const rawUrl of urls) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:") return false;
      if (parsed.hostname.toLowerCase() !== allowedHost.toLowerCase()) return false;
      if (!parsed.pathname.includes("/storage/v1/object/sign/listing-originals/")) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Helper to retrieve Google Cloud Run ID token from metadata server when running on GCP
async function getGcpIdToken(targetUrl: string): Promise<string | null> {
  if (process.env.K_SERVICE || process.env.GOOGLE_CLOUD_PROJECT) {
    try {
      const metadataUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(targetUrl)}`;
      const res = await fetch(metadataUrl, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        return (await res.text()).trim();
      }
    } catch {
      // Non-GCP or local fallback
    }
  }
  return null;
}

export async function orchestrateModerationJob(
  job: ModerationJobRequest,
  config: ControllerConfig
): Promise<ModerationDecisionRecord> {
  const completedChecks: string[] = [];
  const failedChecks: string[] = [];
  const flags: ModerationDecisionRecord["flags"] = [];

  interface ImageTracking {
    visionStatus: string;
    ocrStatus: string;
    visionHashVerified: boolean;
    ocrHashVerified: boolean;
  }

  const perImageTracking = new Map<string, ImageTracking>();

  for (const m of job.media) {
    perImageTracking.set(m.id, {
      visionStatus: "pending",
      ocrStatus: "pending",
      visionHashVerified: false,
      ocrHashVerified: false,
    });
  }

  // Verify canonical media manifest digest
  const manifestEntries = job.media
    .map((item) => `${item.id}:${item.originalStoragePath}:${item.mediaSha256}`)
    .sort()
    .join("\n");
  const computedMediaDigest = createHash("sha256").update(manifestEntries).digest("hex");

  if (job.media.length > 0 && computedMediaDigest !== job.mediaDigest) {
    return {
      verdict: "INCOMPLETE",
      listingId: job.listingId,
      listingRevision: job.listingRevision,
      generationId: job.generationId,
      mediaDigest: computedMediaDigest,
      completedChecks: [],
      failedChecks: ["check_media_manifest_integrity"],
      flags: [{
        check: "media_manifest_integrity",
        field: "media",
        code: "MEDIA_DIGEST_MISMATCH",
        reason: "Supplied media digest does not match computed manifest of original paths and hashes.",
        severity: "critical",
      }],
      manifest: [],
      perImageResults: [],
      modelVersions: { rulesetVersion: "india_azure_v1.0.0" },
      scannedMediaCount: job.media.length,
      evaluatedAt: new Date().toISOString(),
    };
  }

  // Exact Storage Origin Check
  const signedUrls = job.media.map((m) => m.scopedSignedUrl);
  if (!validateStorageOrigin(signedUrls, config.allowedStorageHost)) {
    return {
      verdict: "INCOMPLETE",
      listingId: job.listingId,
      listingRevision: job.listingRevision,
      generationId: job.generationId,
      mediaDigest: computedMediaDigest,
      completedChecks: [],
      failedChecks: ["check_security_origin_validation"],
      flags: [{
        check: "security_origin_validation",
        field: "media",
        code: "INVALID_MEDIA_ORIGIN",
        reason: "Media URLs violate exact environment Supabase Storage origin.",
        severity: "critical",
      }],
      manifest: [],
      perImageResults: [],
      modelVersions: { rulesetVersion: "india_azure_v1.0.0" },
      scannedMediaCount: job.media.length,
      evaluatedAt: new Date().toISOString(),
    };
  }

  // --- AZURE 3 IMAGE CHECKS ---
  // (Baseline India text fraud rules and OpenAI safety moderation are executed in Supabase)
  let nsfwjsModel = "nsfwjs-v2.4.0";
  let mobilenetModel = "mobilenet_v2-1.0-224";
  let paddleOcrModel = "ch_PP-OCRv4_xx";
  let qrDetector = "wechat_qrcode-opencv4";
  let extractedTexts: string[] = [];
  let qrPayloads: string[] = [];

  // Concurrently execute independent downstream worker requests (Node Vision + Python OCR)
  if (job.media.length > 0) {
    const runVision = async () => {
      try {
        const visionPayload = {
          media: job.media.map((m) => ({
            id: m.id,
            originalStoragePath: m.originalStoragePath,
            scopedSignedUrl: m.scopedSignedUrl,
            mediaSha256: m.mediaSha256,
          })),
          expectedCategory: job.categorySlug,
        };

        const visionHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "x-internal-secret": config.moderationSecret,
        };
        const visionIdToken = await getGcpIdToken(config.nodeVisionServiceUrl);
        if (visionIdToken) {
          visionHeaders["Authorization"] = `Bearer ${visionIdToken}`;
        }

        const visionRes = await fetch(`${config.nodeVisionServiceUrl}/scan`, {
          method: "POST",
          headers: visionHeaders,
          body: JSON.stringify(visionPayload),
          signal: AbortSignal.timeout(config.timeoutMs),
        });

        if (!visionRes.ok) {
          failedChecks.push("check_vision_nsfw", "check_vision_category");
        } else {
          const rawVisionData = await visionRes.json();
          const parsedVision = NodeVisionScanResponseSchema.safeParse(rawVisionData);

          if (!parsedVision.success) {
            failedChecks.push("check_vision_nsfw", "check_vision_category");
          } else {
            const vData = parsedVision.data;
            const expectedMediaIds = new Set(job.media.map((m) => m.id));
            const seenVisionIds = new Set<string>();
            let visionAllGood = vData.status === "completed" && vData.results.length === job.media.length;

            for (const item of vData.results) {
              if (!expectedMediaIds.has(item.mediaId) || seenVisionIds.has(item.mediaId)) {
                visionAllGood = false;
                break;
              }
              seenVisionIds.add(item.mediaId);

              const track = perImageTracking.get(item.mediaId);
              if (track) {
                track.visionStatus = item.status;
                track.visionHashVerified = item.sha256Verified === true;
              }
              if (item.status !== "success" || !item.sha256Verified) {
                visionAllGood = false;
              }
            }

            if (seenVisionIds.size !== expectedMediaIds.size) {
              visionAllGood = false;
            }

            if (visionAllGood) {
              completedChecks.push("check_vision_nsfw", "check_vision_category");
              for (const flag of vData.flags) {
                flags.push({
                  check: flag.check,
                  field: flag.field,
                  code: flag.code,
                  reason: flag.reason,
                  severity: flag.severity,
                  boundedEvidence: flag.boundedEvidence,
                });
              }
            } else {
              failedChecks.push("check_vision_nsfw", "check_vision_category");
            }
          }
        }
      } catch {
        failedChecks.push("check_vision_nsfw", "check_vision_category");
      }
    };

    const runOcr = async () => {
      try {
        const ocrPayload = {
          media: job.media.map((m) => ({
            id: m.id,
            originalStoragePath: m.originalStoragePath,
            scopedSignedUrl: m.scopedSignedUrl,
            mediaSha256: m.mediaSha256,
          })),
        };

        const ocrHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "x-internal-secret": config.moderationSecret,
        };
        const ocrIdToken = await getGcpIdToken(config.pythonOcrServiceUrl);
        if (ocrIdToken) {
          ocrHeaders["Authorization"] = `Bearer ${ocrIdToken}`;
        }

        const ocrRes = await fetch(`${config.pythonOcrServiceUrl}/scan`, {
          method: "POST",
          headers: ocrHeaders,
          body: JSON.stringify(ocrPayload),
          signal: AbortSignal.timeout(config.timeoutMs),
        });

        if (!ocrRes.ok) {
          failedChecks.push("check_ocr_qr");
        } else {
          const rawOcrData = await ocrRes.json();
          const parsedOcr = PythonOcrScanResponseSchema.safeParse(rawOcrData);

          if (!parsedOcr.success) {
            failedChecks.push("check_ocr_qr");
          } else {
            const oData = parsedOcr.data;
            const expectedMediaIds = new Set(job.media.map((m) => m.id));
            const seenOcrIds = new Set<string>();
            let ocrAllGood = oData.status === "completed" && oData.results.length === job.media.length;

            for (const item of oData.results) {
              if (!expectedMediaIds.has(item.mediaId) || seenOcrIds.has(item.mediaId)) {
                ocrAllGood = false;
                break;
              }
              seenOcrIds.add(item.mediaId);

              const track = perImageTracking.get(item.mediaId);
              if (track) {
                track.ocrStatus = item.status;
                track.ocrHashVerified = item.sha256Verified === true;
              }
              if (item.status !== "success" || !item.sha256Verified) {
                ocrAllGood = false;
              }
            }

            if (seenOcrIds.size !== expectedMediaIds.size) {
              ocrAllGood = false;
            }

            if (ocrAllGood) {
              completedChecks.push("check_ocr_qr");
              extractedTexts = oData.extractedTexts || [];
              qrPayloads = oData.qrPayloads || [];
            } else {
              failedChecks.push("check_ocr_qr");
            }
          }
        }
      } catch {
        failedChecks.push("check_ocr_qr");
      }
    };

    // Concurrently execute independent downstream worker requests
    await Promise.all([runVision(), runOcr()]);
  } else {
    failedChecks.push("check_vision_nsfw", "check_vision_category", "check_ocr_qr");
  }

  // Calculate final deterministic per-image verification: visionHashVerified && ocrHashVerified
  const perImageResults = job.media.map((m) => {
    const track = perImageTracking.get(m.id);
    const visionHashVerified = track?.visionHashVerified === true;
    const ocrHashVerified = track?.ocrHashVerified === true;
    const hashVerified = visionHashVerified && ocrHashVerified;

    return {
      mediaId: m.id,
      visionStatus: track?.visionStatus ?? "pending",
      ocrStatus: track?.ocrStatus ?? "pending",
      hashVerified,
    };
  });

  const allImagesHashVerified =
    job.media.length > 0 &&
    perImageResults.length === job.media.length &&
    perImageResults.every((r) => r.hashVerified === true);

  // Aggregate verdict for Azure's 3 checks
  const requiredAzureChecks = [
    "check_vision_nsfw",
    "check_vision_category",
    "check_ocr_qr",
  ];

  const allRequiredCompleted = requiredAzureChecks.every((c) => completedChecks.includes(c));
  let verdict: ModerationDecisionRecord["verdict"];

  if (
    !allRequiredCompleted ||
    failedChecks.length > 0 ||
    job.media.length === 0 ||
    !allImagesHashVerified
  ) {
    verdict = "INCOMPLETE";
  } else if (flags.some((f) => f.severity === "critical")) {
    verdict = "REJECT";
  } else if (flags.some((f) => f.severity === "warning")) {
    verdict = "FLAG";
  } else {
    verdict = "APPROVE";
  }

  const manifest = job.media.map((m) => ({
    mediaId: m.id,
    originalStoragePath: m.originalStoragePath,
    mediaSha256: m.mediaSha256,
  }));

  return {
    verdict,
    listingId: job.listingId,
    listingRevision: job.listingRevision,
    generationId: job.generationId,
    mediaDigest: computedMediaDigest,
    completedChecks,
    failedChecks,
    flags,
    manifest,
    perImageResults,
    modelVersions: {
      rulesetVersion: "india_azure_v1.0.0",
      nsfwjsModel,
      mobilenetModel,
      paddleOcrModel,
      qrDetector,
    },
    scannedMediaCount: job.media.length,
    evaluatedAt: new Date().toISOString(),
    extractedTexts,
    qrPayloads,
  };
}
