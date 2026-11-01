import { createHash } from "node:crypto";
import { evaluateIndiaRules } from "./india/checker";
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
      modelVersions: { rulesetVersion: "india_v1.0.0" },
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
      modelVersions: { rulesetVersion: "india_v1.0.0" },
      scannedMediaCount: job.media.length,
      evaluatedAt: new Date().toISOString(),
    };
  }

  // --- CHECK 1: Versioned English India Fraud Rules ---
  try {
    const rulesResult = evaluateIndiaRules({
      title: job.title,
      description: job.description,
    });
    completedChecks.push("check_india_fraud_rules");
    for (const flag of rulesResult.flags) {
      flags.push({
        check: "india_fraud_rules",
        field: flag.field,
        code: flag.code,
        reason: flag.reason,
        severity: flag.severity,
        boundedEvidence: flag.boundedEvidence,
      });
    }
  } catch {
    failedChecks.push("check_india_fraud_rules");
  }

  // --- CHECK 2: External OpenAI Moderation API ---
  let openAiModel = "omni-moderation-latest";
  try {
    const multimodalInputs: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: `Title: ${job.title}\n\nDescription: ${job.description}` },
    ];

    for (const item of job.media) {
      multimodalInputs.push({
        type: "image_url",
        image_url: { url: item.scopedSignedUrl },
      });
    }

    const openAiResponse = await fetch(`${config.openAiApiBase}/moderations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openAiApiKey}`,
      },
      body: JSON.stringify({
        input: multimodalInputs,
        model: openAiModel,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!openAiResponse.ok) {
      failedChecks.push("check_openai_moderation");
    } else {
      const data = await openAiResponse.json();
      const resultsArray = data.results;
      if (!Array.isArray(resultsArray) || resultsArray.length === 0) {
        failedChecks.push("check_openai_moderation");
      } else {
        completedChecks.push("check_openai_moderation");
        for (const res of resultsArray) {
          if (res.flagged) {
            flags.push({
              check: "openai_moderation",
              field: "media",
              code: "OPENAI_POLICY_FLAGGED",
              reason: "Content flagged by OpenAI automated policy screening.",
              severity: "critical",
              boundedEvidence: Object.entries(res.categories || {})
                .filter(([_, flagged]) => Boolean(flagged))
                .map(([cat]) => cat)
                .join(", "),
            });
          }
        }
      }
    }
  } catch {
    failedChecks.push("check_openai_moderation");
  }

  // --- CHECK 3 & CHECK 4: Node Vision Worker ---
  let nsfwjsModel = "nsfwjs-v2.4.2";
  let mobilenetModel = "mobilenet-v2.1.1";
  let visionScanPassed = true;

  if (job.media.length > 0) {
    try {
      const visionRes = await fetch(`${config.nodeVisionServiceUrl}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": config.moderationSecret,
        },
        body: JSON.stringify({
          media: job.media,
          expectedCategory: job.categorySlug,
        }),
        signal: AbortSignal.timeout(config.timeoutMs * 2),
      });

      if (!visionRes.ok) {
        visionScanPassed = false;
        failedChecks.push("check_vision_nsfw", "check_vision_category");
      } else {
        const rawData = await visionRes.json();
        const parsedVision = NodeVisionScanResponseSchema.safeParse(rawData);

        if (!parsedVision.success || parsedVision.data.status !== "completed") {
          visionScanPassed = false;
          failedChecks.push("check_vision_nsfw", "check_vision_category");
        } else {
          // Verify exact scannedCount and exact unique IDs
          const visionResults = parsedVision.data.results;
          const returnedIds = new Set(visionResults.map((r) => r.mediaId));
          const expectedIds = new Set(job.media.map((m) => m.id));

          if (
            parsedVision.data.scannedCount !== job.media.length ||
            visionResults.length !== job.media.length ||
            returnedIds.size !== job.media.length ||
            ![...returnedIds].every((id) => expectedIds.has(id))
          ) {
            visionScanPassed = false;
          }

          for (const itemResult of visionResults) {
            const entry = perImageMap.get(itemResult.mediaId);
            if (entry) {
              entry.visionStatus = itemResult.status;
              if (itemResult.sha256Verified) entry.hashVerified = true;
            }
            if (itemResult.status !== "success" || !itemResult.sha256Verified) {
              visionScanPassed = false;
            }
          }

          if (visionScanPassed) {
            completedChecks.push("check_vision_nsfw", "check_vision_category");
            for (const f of parsedVision.data.flags) {
              flags.push(f);
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

  // --- CHECK 5: Python OCR & QR Worker ---
  let paddleOcrModel = "paddleocr-v2.9.1-en";
  let qrDetector = "opencv-wechat-qr-v4.11.0";
  let ocrScanPassed = true;

  if (job.media.length > 0) {
    try {
      const ocrRes = await fetch(`${config.pythonOcrServiceUrl}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": config.moderationSecret,
        },
        body: JSON.stringify({ media: job.media }),
        signal: AbortSignal.timeout(config.timeoutMs * 2),
      });

      if (!ocrRes.ok) {
        ocrScanPassed = false;
        failedChecks.push("check_ocr_qr");
      } else {
        const rawOcr = await ocrRes.json();
        const parsedOcr = PythonOcrScanResponseSchema.safeParse(rawOcr);

        if (!parsedOcr.success || parsedOcr.data.status !== "completed") {
          ocrScanPassed = false;
          failedChecks.push("check_ocr_qr");
        } else {
          // Verify exact scannedCount and exact unique IDs
          const ocrResults = parsedOcr.data.results;
          const returnedIds = new Set(ocrResults.map((r) => r.mediaId));
          const expectedIds = new Set(job.media.map((m) => m.id));

          if (
            parsedOcr.data.scannedCount !== job.media.length ||
            ocrResults.length !== job.media.length ||
            returnedIds.size !== job.media.length ||
            ![...returnedIds].every((id) => expectedIds.has(id))
          ) {
            ocrScanPassed = false;
          }

          for (const itemResult of ocrResults) {
            const entry = perImageMap.get(itemResult.mediaId);
            if (entry) {
              entry.ocrStatus = itemResult.status;
              if (itemResult.sha256Verified) entry.hashVerified = true;
            }
            if (itemResult.status !== "success" || !itemResult.sha256Verified) {
              ocrScanPassed = false;
            }
          }

          if (ocrScanPassed) {
            completedChecks.push("check_ocr_qr");
            const ocrRulesResult = evaluateIndiaRules({
              title: "",
              description: "",
              ocrTexts: parsedOcr.data.extractedTexts,
              qrPayloads: parsedOcr.data.qrPayloads,
            });

            for (const flag of ocrRulesResult.flags) {
              flags.push({
                check: "ocr_qr_rules",
                field: flag.field,
                code: flag.code,
                reason: flag.reason,
                severity: flag.severity,
                boundedEvidence: flag.boundedEvidence,
              });
            }
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

  // --- FAIL-CLOSED VERDICT AGGREGATION ---
  const requiredChecks = [
    "check_india_fraud_rules",
    "check_openai_moderation",
    "check_vision_nsfw",
    "check_vision_category",
    "check_ocr_qr",
  ];

  const allRequiredCompleted = requiredChecks.every((c) => completedChecks.includes(c));
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
      rulesetVersion: "india_v1.0.0",
      openaiModerationModel: openAiModel,
      nsfwjsModel,
      mobilenetModel,
      paddleOcrModel,
      qrDetector,
    },
    scannedMediaCount: job.media.length,
    evaluatedAt: new Date().toISOString(),
  };
}
