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

export async function orchestrateModerationJob(
  job: ModerationJobRequest,
  config: ControllerConfig
): Promise<ModerationDecisionRecord> {
  const completedChecks: string[] = [];
  const failedChecks: string[] = [];
  const flags: ModerationDecisionRecord["flags"] = [];
  const perImageMap = new Map<string, { visionStatus: string; ocrStatus: string; hashVerified: boolean }>();

  for (const m of job.media) {
    perImageMap.set(m.id, { visionStatus: "pending", ocrStatus: "pending", hashVerified: false });
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

  // 1. Vision Services: NSFW + Category
  if (job.media.length > 0) {
    try {
      const visionPayload = {
        listingId: job.listingId,
        media: job.media.map((m) => ({
          mediaId: m.id,
          scopedSignedUrl: m.scopedSignedUrl,
          mediaSha256: m.mediaSha256,
        })),
        categorySlug: job.categorySlug,
      };

      const visionRes = await fetch(`${config.nodeVisionServiceUrl}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-moderation-internal-secret": config.moderationSecret,
        },
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

            const current = perImageMap.get(item.mediaId);
            if (current) {
              current.visionStatus = item.status;
              current.hashVerified = current.hashVerified || item.sha256Verified;
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
  } else {
    failedChecks.push("check_vision_nsfw", "check_vision_category");
  }

  // 2. Python OCR + QR Service
  if (job.media.length > 0) {
    try {
      const ocrPayload = {
        listingId: job.listingId,
        media: job.media.map((m) => ({
          mediaId: m.id,
          scopedSignedUrl: m.scopedSignedUrl,
          mediaSha256: m.mediaSha256,
        })),
      };

      const ocrRes = await fetch(`${config.pythonOcrServiceUrl}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-moderation-internal-secret": config.moderationSecret,
        },
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

            const current = perImageMap.get(item.mediaId);
            if (current) {
              current.ocrStatus = item.status;
              current.hashVerified = current.hashVerified && item.sha256Verified;
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
  } else {
    failedChecks.push("check_ocr_qr");
  }

  // Aggregate verdict for Azure's 3 checks
  const requiredAzureChecks = [
    "check_vision_nsfw",
    "check_vision_category",
    "check_ocr_qr",
  ];

  const allRequiredCompleted = requiredAzureChecks.every((c) => completedChecks.includes(c));
  let verdict: ModerationDecisionRecord["verdict"];

  if (!allRequiredCompleted || failedChecks.length > 0 || job.media.length === 0) {
    verdict = "INCOMPLETE";
  } else if (flags.some((f) => f.severity === "critical")) {
    verdict = "REJECT";
  } else if (flags.some((f) => f.severity === "warning")) {
    verdict = "FLAG";
  } else {
    verdict = "APPROVE";
  }

  const perImageResults = Array.from(perImageMap.entries()).map(([id, info]) => ({
    mediaId: id,
    visionStatus: info.visionStatus,
    ocrStatus: info.ocrStatus,
    hashVerified: info.hashVerified,
  }));

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
