// supabase/functions/_shared/azure-moderation-worker.ts
// Authoritative Moderation Dispatcher for FairSwap India V1.
// Supports Provider-Switchable Moderation across 4 combinations:
// 1. Supabase + OpenAI (baseline two-check)
// 2. Supabase + OpenAI + Azure (multimodal five-check)
// 3. Supabase + OpenAI + Google (multimodal five-check)
// 4. Supabase + OpenAI + Azure + Google (multimodal seven-check / dual-cloud)
// Computes real byte-level SHA-256 hashes of private originals from 'listing-originals'.
// Registers verifiable scan receipts before finalization.
// Supabase authoritatively executes India fraud rules and OpenAI moderation for all listings.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateListingText } from "../../../src/lib/moderation/checker";
import { evaluateIndiaRules } from "../../../src/lib/moderation/india/checker";
import { evaluateOpenAiModeration } from "./openai-moderation-adapter";

export const INDIA_AZURE_RULESET_VERSION = "india_azure_v1.0.0" as const;
export const INDIA_AZURE_EVALUATION_SCOPE = "multimodal_five_check" as const;
export const INDIA_RULESET_VERSION = "india_v1.0.0" as const;
export const INDIA_EVALUATION_SCOPE = "multimodal_five_check" as const;

export const INDIA_GOOGLE_RULESET_VERSION = "india_google_v1.0.0" as const;
export const INDIA_GOOGLE_EVALUATION_SCOPE = "multimodal_five_check" as const;
export const INDIA_GOOGLE_CLOUD_RULESET_VERSION = "india_google_v1.0.0" as const;
export const INDIA_GOOGLE_CLOUD_EVALUATION_SCOPE = "multimodal_five_check" as const;

export const INDIA_DUAL_CLOUD_RULESET_VERSION = "india_dual_cloud_v1.0.0" as const;
export const INDIA_DUAL_CLOUD_EVALUATION_SCOPE = "multimodal_eight_check" as const;

export const INDIA_BASELINE_RULESET_VERSION = "india_baseline_v1.0.0" as const;
export const INDIA_BASELINE_EVALUATION_SCOPE = "baseline_two_check" as const;

export const AzureWorkerConfigSchema = z.object({
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(1),
  azureModerationEndpoint: z.string().url().optional(),
  azureModerationSecret: z.string().min(16).optional(),
  googleCloudModerationEndpoint: z.string().url().optional(),
  googleCloudModerationSecret: z.string().min(16).optional(),
  openAiApiKey: z.string().optional(),
  batchSize: z.coerce.number().int().positive().max(100).default(10),
  leaseSeconds: z.coerce.number().int().positive().max(600).default(60),
  azureTimeoutMs: z.coerce.number().int().positive().max(50000).optional(),
  googleCloudTimeoutMs: z.coerce.number().int().positive().max(50000).optional(),
});

export type AzureWorkerConfig = z.infer<typeof AzureWorkerConfigSchema>;

export const ClaimedAzureJobSchema = z.object({
  request_id: z.string().uuid(),
  listing_id: z.string().uuid(),
  listing_revision: z.number().int(),
  generation_id: z.string().uuid(),
  claim_token: z.string().uuid(),
  attempt_count: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
});

export type ClaimedAzureJob = z.infer<typeof ClaimedAzureJobSchema>;

export const CloudScanResponseSchema = z.object({
  verdict: z.enum(["APPROVE", "REJECT", "FLAG", "INCOMPLETE"]),
  listingId: z.string().uuid(),
  listingRevision: z.number().int(),
  generationId: z.string().uuid(),
  mediaDigest: z.string(),
  completedChecks: z.array(z.string()),
  failedChecks: z.array(z.string()),
  flags: z.array(z.unknown()),
  modelVersions: z.record(z.string()),
  scannedMediaCount: z.number().int(),
  extractedTexts: z.array(z.string()).optional(),
  qrPayloads: z.array(z.string()).optional(),
  manifest: z.array(
    z.object({
      id: z.string().uuid().optional(),
      mediaId: z.string().uuid().optional(),
      path: z.string().optional(),
      originalStoragePath: z.string().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      mediaSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
  ),
});

export const AzureScanResponseSchema = CloudScanResponseSchema;

export interface ModerationJobOptions {
  mode: "baseline" | "azure" | "google_cloud" | "dual_cloud";
  azureEndpoint?: string;
  azureSecret?: string;
  googleCloudEndpoint?: string;
  googleCloudSecret?: string;
  openAiApiKey?: string;
  azureTimeoutMs?: number;
  googleCloudTimeoutMs?: number;
  snapshotSettings?: {
    automationEnabled: boolean;
    azureEnabled: boolean;
    googleCloudEnabled: boolean;
  };
}

interface CloudScanDispatchResult {
  success: boolean;
  verdict: "APPROVE" | "REJECT" | "FLAG" | "INCOMPLETE";
  completedChecks: string[];
  failedChecks: string[];
  flags: unknown[];
  modelVersions: Record<string, string>;
  returnedMediaDigest: string;
  extractedTexts: string[];
  qrPayloads: string[];
  manifest: any[];
}

async function executeCloudProviderScan(
  provider: "azure" | "google_cloud",
  endpoint: string,
  secret: string,
  job: ClaimedAzureJob,
  categorySlug: string,
  computedMediaDigest: string,
  mediaItems: Array<{ id: string; originalStoragePath: string; scopedSignedUrl: string; mediaSha256: string }>,
  timeoutBudgetMs: number
): Promise<CloudScanDispatchResult> {
  const prefix = provider === "google_cloud" ? "google" : "azure";
  const deadline = Date.now() + timeoutBudgetMs;
  const MIN_RETRY_THRESHOLD_MS = 5000;
  const RETRY_BACKOFF_MS = 2000;
  const maxAttempts = 2;

  const result: CloudScanDispatchResult = {
    success: false,
    verdict: "INCOMPLETE",
    completedChecks: [],
    failedChecks: [],
    flags: [],
    modelVersions: {},
    returnedMediaDigest: "",
    extractedTexts: [],
    qrPayloads: [],
    manifest: [],
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingBudgetMs = deadline - Date.now();
    if (remainingBudgetMs < MIN_RETRY_THRESHOLD_MS) {
      result.failedChecks.push(`${prefix}_dispatch_deadline_exceeded`);
      result.verdict = "INCOMPLETE";
      return result;
    }

    const attemptTimeoutMs = Math.min(remainingBudgetMs, 15000);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Moderation-Secret": secret,
        },
        body: JSON.stringify({
          listingId: job.listing_id,
          listingRevision: job.listing_revision,
          generationId: job.generation_id,
          title: job.title,
          description: job.description,
          categorySlug,
          mediaDigest: computedMediaDigest,
          media: mediaItems,
        }),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });

      // Handle transient cold-start gateway wake-up responses (502/503/504)
      if (!res.ok && [502, 503, 504].includes(res.status) && attempt < maxAttempts) {
        const timeAfterBackoff = (deadline - Date.now()) - RETRY_BACKOFF_MS;
        if (timeAfterBackoff >= MIN_RETRY_THRESHOLD_MS) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        } else {
          result.failedChecks.push(`${prefix}_http_${res.status}`, `${prefix}_retry_budget_exceeded`);
          result.verdict = "INCOMPLETE";
          return result;
        }
      }

      if (res.ok) {
        const parsed = CloudScanResponseSchema.safeParse(await res.json());
        if (parsed.success) {
          const scanData = parsed.data;
          result.manifest = scanData.manifest;
          result.returnedMediaDigest = scanData.mediaDigest;

          if (
            scanData.listingId !== job.listing_id ||
            scanData.listingRevision !== job.listing_revision ||
            scanData.generationId !== job.generation_id ||
            scanData.scannedMediaCount !== mediaItems.length ||
            scanData.manifest.length !== mediaItems.length
          ) {
            result.failedChecks.push(`${prefix}_response_identity_mismatch`);
            result.verdict = "INCOMPLETE";
            return result;
          }

          const returnedIds = scanData.manifest.map((m) => m.id ?? m.mediaId);
          const uniqueReturnedIds = new Set(returnedIds);
          const expectedIds = new Set(mediaItems.map((m) => m.id));

          const idsMatchExactly =
            uniqueReturnedIds.size === scanData.manifest.length &&
            uniqueReturnedIds.size === expectedIds.size &&
            [...uniqueReturnedIds].every((id) => expectedIds.has(id!));

          let allMediaMatched = idsMatchExactly;
          if (allMediaMatched) {
            for (const expectedItem of mediaItems) {
              const matchedEntry = scanData.manifest.find(
                (m) => (m.id ?? m.mediaId) === expectedItem.id
              );
              if (!matchedEntry) {
                allMediaMatched = false;
                break;
              }
              const returnedPath = matchedEntry.path ?? matchedEntry.originalStoragePath;
              const returnedSha = matchedEntry.sha256 ?? matchedEntry.mediaSha256;
              if (
                returnedPath !== expectedItem.originalStoragePath ||
                returnedSha !== expectedItem.mediaSha256
              ) {
                allMediaMatched = false;
                break;
              }
            }
          }

          if (!allMediaMatched) {
            result.failedChecks.push(`${prefix}_manifest_mismatch`);
            result.verdict = "INCOMPLETE";
            return result;
          }

          result.completedChecks.push(...scanData.completedChecks);
          result.failedChecks.push(...scanData.failedChecks);
          result.flags.push(...scanData.flags);
          result.modelVersions = { ...scanData.modelVersions };
          result.extractedTexts = scanData.extractedTexts || [];
          result.qrPayloads = scanData.qrPayloads || [];
          result.verdict = scanData.verdict;
          result.success = true;
          return result;
        } else {
          result.failedChecks.push(`${prefix}_response_schema_invalid`);
          result.verdict = "INCOMPLETE";
          return result;
        }
      } else {
        result.failedChecks.push(`${prefix}_http_${res.status}`);
        result.verdict = "INCOMPLETE";
        return result;
      }
    } catch {
      result.failedChecks.push(`${prefix}_dispatch_network_timeout`);
      result.verdict = "INCOMPLETE";
      return result;
    }
  }

  return result;
}

/**
 * Authoritatively executes provider-switchable moderation on a claimed listing job.
 */
export async function processClaimedModerationJob(
  rawJob: unknown,
  supabase: SupabaseClient,
  options: ModerationJobOptions
): Promise<{ success: boolean; decision?: string; error?: string }> {
  const parsedJob = ClaimedAzureJobSchema.safeParse(rawJob);
  if (!parsedJob.success) {
    return {
      success: false,
      error: `INVALID_CLAIMED_JOB_SHAPE: ${JSON.stringify(parsedJob.error.issues)}`,
    };
  }
  const job = parsedJob.data;
  const jobStartTime = Date.now();

  // 1. Fetch attached listing media and category from database
  const listingQuery = supabase
    .from("listings")
    .select("category_id, categories!inner (slug)")
    .eq("id", job.listing_id);

  const listingRes = typeof (listingQuery as any).single === "function" ? await (listingQuery as any).single() : await listingQuery;
  if (listingRes?.error) {
    return { success: false, error: `LISTING_FETCH_FAILED: ${listingRes.error.message}` };
  }

  const categorySlug = (listingRes?.data as any)?.categories?.slug;
  if (!categorySlug) {
    return { success: false, error: "LISTING_CATEGORY_UNRESOLVED" };
  }

  const { data: mediaRows, error: mediaError } = await supabase
    .from("listing_media")
    .select("id, original_storage_path, processing_status")
    .eq("listing_id", job.listing_id)
    .order("display_order", { ascending: true });

  if (mediaError) {
    return { success: false, error: `MEDIA_FETCH_FAILED: ${mediaError.message}` };
  }

  const readyMedia = (mediaRows || []).filter(
    (m) => Boolean(m.original_storage_path) && m.processing_status === "ready"
  );

  // Multimodal policies (Azure, Google Cloud, Dual Cloud) require at least 1 ready photo
  const isMultimodal = options.mode !== "baseline";
  if (isMultimodal && readyMedia.length === 0) {
    return { success: false, error: "ZERO_MEDIA_DISALLOWED_FOR_MULTIMODAL_POLICY" };
  }

  const mediaItems: Array<{
    id: string;
    originalStoragePath: string;
    scopedSignedUrl: string;
    mediaSha256: string;
  }> = [];

  for (const m of readyMedia) {
    const { data: blobData, error: downloadError } = await supabase.storage
      .from("listing-originals")
      .download(m.original_storage_path!);

    if (downloadError || !blobData) {
      return { success: false, error: `MEDIA_DOWNLOAD_FAILED: ${m.id}` };
    }

    const arrayBuffer = await blobData.arrayBuffer();
    const realSha256 = createHash("sha256").update(new Uint8Array(arrayBuffer)).digest("hex");

    const { data: signData, error: signError } = await supabase.storage
      .from("listing-originals")
      .createSignedUrl(m.original_storage_path!, 600);

    if (signError || !signData?.signedUrl) {
      return { success: false, error: `SIGNED_URL_FAILED: ${m.id}` };
    }

    mediaItems.push({
      id: m.id,
      originalStoragePath: m.original_storage_path!,
      scopedSignedUrl: signData.signedUrl,
      mediaSha256: realSha256,
    });
  }

  // Media manifest digest
  const manifestEntries = mediaItems
    .map((item) => `${item.id}:${item.originalStoragePath}:${item.mediaSha256}`)
    .sort()
    .join("\n");
  const computedMediaDigest = mediaItems.length > 0
    ? createHash("sha256").update(manifestEntries).digest("hex")
    : "";

  // 2. Authoritative Supabase Check 1: India Fraud Rules on title & description
  const completedChecks: string[] = [];
  const failedChecks: string[] = [];
  const flags: unknown[] = [];
  let modelVersions: Record<string, string> = {};

  const indiaFraudResult = evaluateIndiaRules({
    title: job.title,
    description: job.description,
  });
  if (indiaFraudResult.flags && indiaFraudResult.flags.length > 0) {
    flags.push(...indiaFraudResult.flags);
  }

  const textCheckerResult = evaluateListingText({
    title: job.title,
    description: job.description,
  });
  if ("flags" in textCheckerResult && textCheckerResult.flags && textCheckerResult.flags.length > 0) {
    flags.push(...textCheckerResult.flags);
  }

  if (
    textCheckerResult.outcome === "invalid_input" ||
    textCheckerResult.outcome === "checks_incomplete"
  ) {
    failedChecks.push("check_india_fraud_rules");
  } else {
    completedChecks.push("check_india_fraud_rules");
  }

  // 3. Authoritative Supabase Check 2: OpenAI Moderation
  if (options.openAiApiKey) {
    const openAiRes = await evaluateOpenAiModeration({
      text: `${job.title}\n\n${job.description}`,
      imageUrls: mediaItems.map((m) => m.scopedSignedUrl),
      apiKey: options.openAiApiKey,
    });

    if (openAiRes.completed) {
      completedChecks.push("check_openai_moderation");
      modelVersions.openAiModel = openAiRes.model;
      if (openAiRes.flagged) {
        flags.push(...openAiRes.flags.map((f) => ({ rule: "check_openai_moderation", ...f })));
      }
    } else {
      failedChecks.push("check_openai_moderation");
    }
  } else {
    failedChecks.push("check_openai_moderation");
  }

  let verdict: "APPROVE" | "REJECT" | "FLAG" | "INCOMPLETE" = "APPROVE";
  let rulesetVersion: string = INDIA_BASELINE_RULESET_VERSION;
  let scope: string = INDIA_BASELINE_EVALUATION_SCOPE;

  // BASELINE OPTIMIZATION: If baseline flags content or has failed checks, avoid unnecessary cloud calls
  const baselineFlagged = flags.length > 0;
  const baselineIncomplete = failedChecks.length > 0;

  if (baselineFlagged) {
    verdict = "FLAG";
  } else if (baselineIncomplete) {
    verdict = "INCOMPLETE";
  }

  // 4. Branch based on Mode
  if (options.mode === "azure") {
    rulesetVersion = INDIA_AZURE_RULESET_VERSION;
    scope = INDIA_AZURE_EVALUATION_SCOPE;

    if (!options.azureEndpoint || !options.azureSecret) {
      failedChecks.push("azure_missing_configuration");
      verdict = "INCOMPLETE";
    } else if (!baselineFlagged && !baselineIncomplete) {
      // Execute Azure only if baseline passed cleanly
      const maxJobBudgetMs = 50000;
      const remainingFromJobStart = maxJobBudgetMs - (Date.now() - jobStartTime);
      const configuredTimeout = options.azureTimeoutMs ?? 30000;
      const budgetMs = Math.min(configuredTimeout, Math.max(0, remainingFromJobStart));

      const azResult = await executeCloudProviderScan(
        "azure",
        options.azureEndpoint,
        options.azureSecret,
        job,
        categorySlug,
        computedMediaDigest,
        mediaItems,
        budgetMs
      );

      for (const c of azResult.completedChecks) {
        if (!completedChecks.includes(c)) completedChecks.push(c);
      }
      for (const f of azResult.failedChecks) {
        if (!failedChecks.includes(f)) failedChecks.push(f);
      }
      flags.push(...azResult.flags);
      modelVersions = { ...modelVersions, ...azResult.modelVersions };

      if (mediaItems.length > 0 && azResult.returnedMediaDigest !== computedMediaDigest) {
        failedChecks.push("azure_media_digest_mismatch");
        verdict = "INCOMPLETE";
      }

      // Supabase evaluates OCR texts and QR payloads
      const mediaFraud = evaluateIndiaRules({
        title: job.title,
        description: job.description,
        ocrTexts: azResult.extractedTexts,
        qrPayloads: azResult.qrPayloads,
      });
      if (mediaFraud.flags.length > 0) {
        flags.push(...mediaFraud.flags);
      }
      for (const text of [...azResult.extractedTexts, ...azResult.qrPayloads]) {
        const ocrFraud = evaluateListingText({ title: "Media Text", description: text });
        if (ocrFraud.outcome === "needs_review") {
          flags.push(...ocrFraud.flags);
        }
      }

      if (azResult.verdict === "REJECT" || azResult.verdict === "FLAG" || flags.length > 0) {
        verdict = "FLAG";
      } else if (azResult.verdict === "INCOMPLETE" || failedChecks.length > 0 || !azResult.success) {
        verdict = "INCOMPLETE";
      } else {
        verdict = "APPROVE";
      }
    }
  } else if (options.mode === "google_cloud") {
    rulesetVersion = INDIA_GOOGLE_RULESET_VERSION;
    scope = INDIA_GOOGLE_EVALUATION_SCOPE;

    if (!options.googleCloudEndpoint || !options.googleCloudSecret) {
      failedChecks.push("google_cloud_missing_configuration");
      verdict = "INCOMPLETE";
    } else if (!baselineFlagged && !baselineIncomplete) {
      // Execute Google Cloud Run only if baseline passed cleanly
      const maxJobBudgetMs = 50000;
      const remainingFromJobStart = maxJobBudgetMs - (Date.now() - jobStartTime);
      const configuredTimeout = options.googleCloudTimeoutMs ?? 30000;
      const budgetMs = Math.min(configuredTimeout, Math.max(0, remainingFromJobStart));

      const gResult = await executeCloudProviderScan(
        "google_cloud",
        options.googleCloudEndpoint,
        options.googleCloudSecret,
        job,
        categorySlug,
        computedMediaDigest,
        mediaItems,
        budgetMs
      );

      const gCheckMapping: Record<string, string> = {
        check_vision_nsfw: "check_google_vision_nsfw",
        check_vision_category: "check_google_vision_category",
        check_ocr_qr: "check_google_ocr_qr",
      };
      for (const c of gResult.completedChecks) {
        const mapped = gCheckMapping[c] || c;
        if (!completedChecks.includes(mapped)) completedChecks.push(mapped);
      }
      for (const f of gResult.failedChecks) {
        const mapped = gCheckMapping[f] || f;
        if (!failedChecks.includes(mapped)) failedChecks.push(mapped);
      }
      flags.push(...gResult.flags);
      modelVersions = { ...modelVersions, ...gResult.modelVersions };

      if (mediaItems.length > 0 && gResult.returnedMediaDigest !== computedMediaDigest) {
        failedChecks.push("google_media_digest_mismatch");
        verdict = "INCOMPLETE";
      }

      // Supabase evaluates OCR texts and QR payloads
      const mediaFraud = evaluateIndiaRules({
        title: job.title,
        description: job.description,
        ocrTexts: gResult.extractedTexts,
        qrPayloads: gResult.qrPayloads,
      });
      if (mediaFraud.flags.length > 0) {
        flags.push(...mediaFraud.flags);
      }
      for (const text of [...gResult.extractedTexts, ...gResult.qrPayloads]) {
        const ocrFraud = evaluateListingText({ title: "Media Text", description: text });
        if (ocrFraud.outcome === "needs_review") {
          flags.push(...ocrFraud.flags);
        }
      }

      if (gResult.verdict === "REJECT" || gResult.verdict === "FLAG" || flags.length > 0) {
        verdict = "FLAG";
      } else if (gResult.verdict === "INCOMPLETE" || failedChecks.length > 0 || !gResult.success) {
        verdict = "INCOMPLETE";
      } else {
        verdict = "APPROVE";
      }
    }
  }

  // Provider check mappings for independent dual-cloud attestations
  const azCheckMapping: Record<string, string> = {
    check_vision_nsfw: "check_azure_vision_nsfw",
    check_vision_category: "check_azure_vision_category",
    check_ocr_qr: "check_azure_ocr_qr",
  };
  const gCheckMapping: Record<string, string> = {
    check_vision_nsfw: "check_google_vision_nsfw",
    check_vision_category: "check_google_vision_category",
    check_ocr_qr: "check_google_ocr_qr",
  };
  const mapAzureCheck = (name: string) => {
    if (azCheckMapping[name]) return azCheckMapping[name];
    if (name.startsWith("azure_") || name.startsWith("check_azure_")) return name;
    if (name.startsWith("check_")) return `check_azure_${name.replace(/^check_/, "")}`;
    return `azure_${name}`;
  };
  const mapGoogleCheck = (name: string) => {
    if (gCheckMapping[name]) return gCheckMapping[name];
    if (name.startsWith("google_") || name.startsWith("check_google_")) return name;
    if (name.startsWith("check_")) return `check_google_${name.replace(/^check_/, "")}`;
    return `google_${name}`;
  };
  let dualCloudScans: { az: any; g: any } | null = null;

  if (options.mode === "dual_cloud") {
    rulesetVersion = INDIA_DUAL_CLOUD_RULESET_VERSION;
    scope = INDIA_DUAL_CLOUD_EVALUATION_SCOPE;

    const missingAzure = !options.azureEndpoint || !options.azureSecret;
    const missingGoogle = !options.googleCloudEndpoint || !options.googleCloudSecret;

    if (missingAzure) failedChecks.push("azure_missing_configuration");
    if (missingGoogle) failedChecks.push("google_cloud_missing_configuration");

    if (missingAzure || missingGoogle) {
      verdict = "INCOMPLETE";
    } else if (!baselineFlagged && !baselineIncomplete) {
      // Execute BOTH Azure and Google Cloud Run concurrently and independently
      const maxJobBudgetMs = 50000;
      const remainingFromJobStart = maxJobBudgetMs - (Date.now() - jobStartTime);
      const budgetMs = Math.min(30000, Math.max(0, remainingFromJobStart));

      const [azResult, gResult] = await Promise.all([
        executeCloudProviderScan(
          "azure",
          options.azureEndpoint!,
          options.azureSecret!,
          job,
          categorySlug,
          computedMediaDigest,
          mediaItems,
          budgetMs
        ),
        executeCloudProviderScan(
          "google_cloud",
          options.googleCloudEndpoint!,
          options.googleCloudSecret!,
          job,
          categorySlug,
          computedMediaDigest,
          mediaItems,
          budgetMs
        ),
      ]);

      dualCloudScans = { az: azResult, g: gResult };

      // Maintain provider-specific completed/failed check identities (8 distinct attestations: 2 baseline + 3 Azure + 3 Google)
      for (const c of azResult.completedChecks) {
        const named = mapAzureCheck(c);
        if (!completedChecks.includes(named)) completedChecks.push(named);
      }
      for (const c of gResult.completedChecks) {
        const named = mapGoogleCheck(c);
        if (!completedChecks.includes(named)) completedChecks.push(named);
      }

      for (const f of azResult.failedChecks) {
        const named = mapAzureCheck(f);
        if (!failedChecks.includes(named)) failedChecks.push(named);
      }
      for (const f of gResult.failedChecks) {
        const named = mapGoogleCheck(f);
        if (!failedChecks.includes(named)) failedChecks.push(named);
      }

      flags.push(...azResult.flags, ...gResult.flags);
      modelVersions = {
        ...modelVersions,
        azure: azResult.modelVersions as any,
        googleCloud: gResult.modelVersions as any,
      };

      if (mediaItems.length > 0 && azResult.returnedMediaDigest !== computedMediaDigest) {
        failedChecks.push("azure_media_digest_mismatch");
      }
      if (mediaItems.length > 0 && gResult.returnedMediaDigest !== computedMediaDigest) {
        failedChecks.push("google_media_digest_mismatch");
      }

      // Evaluate combined OCR/QR content
      const allExtractedTexts = [...azResult.extractedTexts, ...gResult.extractedTexts];
      const allQrPayloads = [...azResult.qrPayloads, ...gResult.qrPayloads];
      const mediaFraud = evaluateIndiaRules({
        title: job.title,
        description: job.description,
        ocrTexts: allExtractedTexts,
        qrPayloads: allQrPayloads,
      });
      if (mediaFraud.flags.length > 0) {
        flags.push(...mediaFraud.flags);
      }
      for (const text of [...allExtractedTexts, ...allQrPayloads]) {
        const ocrFraud = evaluateListingText({ title: "Media Text", description: text });
        if (ocrFraud.outcome === "needs_review") {
          flags.push(...ocrFraud.flags);
        }
      }

      // Both enabled cloud providers must complete independently and successfully
      const eitherFlagged = azResult.verdict === "FLAG" || gResult.verdict === "FLAG" || flags.length > 0;
      const eitherFailed = !azResult.success || !gResult.success || azResult.verdict === "INCOMPLETE" || gResult.verdict === "INCOMPLETE" || failedChecks.length > 0;

      if (eitherFlagged) {
        verdict = "FLAG";
      } else if (eitherFailed) {
        verdict = "INCOMPLETE";
      } else if (azResult.verdict === "APPROVE" && gResult.verdict === "APPROVE") {
        verdict = "APPROVE";
      } else {
        verdict = "INCOMPLETE";
      }
    }
  } else {
    // Baseline Two-Check Mode
    if (flags.length > 0) {
      verdict = "FLAG";
    } else if (failedChecks.length > 0) {
      verdict = "INCOMPLETE";
    } else {
      verdict = "APPROVE";
    }
  }

  // 5. Register trusted scan receipt in app_security
  if (options.mode === "dual_cloud" && dualCloudScans) {
    // 5a. Register independent Azure scan receipt
    const azCompleted = [
      "check_india_fraud_rules",
      "check_openai_moderation",
      ...dualCloudScans.az.completedChecks.map(mapAzureCheck),
    ];
    const { error: azRegError } = await supabase.rpc("register_moderation_scan_receipt", {
      p_request_id: job.request_id,
      p_claim_token: job.claim_token,
      p_listing_id: job.listing_id,
      p_listing_revision: job.listing_revision,
      p_generation_id: job.generation_id,
      p_media_digest: computedMediaDigest,
      p_verdict: dualCloudScans.az.verdict,
      p_ruleset_version: INDIA_AZURE_RULESET_VERSION,
      p_scope: INDIA_AZURE_EVALUATION_SCOPE,
      p_completed_checks: azCompleted,
      p_failed_checks: dualCloudScans.az.failedChecks.map(mapAzureCheck),
      p_flags: dualCloudScans.az.flags,
      p_model_versions: dualCloudScans.az.modelVersions as any,
      p_manifest: mediaItems.map((m) => ({ id: m.id, path: m.originalStoragePath, sha256: m.mediaSha256 })),
      p_scanned_media_count: mediaItems.length,
    });
    if (azRegError) {
      if (azRegError.message.includes("LEASE_EXPIRED")) return { success: false, error: "LEASE_EXPIRED_DURING_SCAN" };
      return { success: false, error: `AZURE_RECEIPT_REGISTRATION_FAILED: ${azRegError.message}` };
    }

    // 5b. Register independent Google Cloud scan receipt
    const gCompleted = [
      "check_india_fraud_rules",
      "check_openai_moderation",
      ...dualCloudScans.g.completedChecks.map(mapGoogleCheck),
    ];
    const { error: gRegError } = await supabase.rpc("register_moderation_scan_receipt", {
      p_request_id: job.request_id,
      p_claim_token: job.claim_token,
      p_listing_id: job.listing_id,
      p_listing_revision: job.listing_revision,
      p_generation_id: job.generation_id,
      p_media_digest: computedMediaDigest,
      p_verdict: dualCloudScans.g.verdict,
      p_ruleset_version: INDIA_GOOGLE_CLOUD_RULESET_VERSION,
      p_scope: INDIA_GOOGLE_CLOUD_EVALUATION_SCOPE,
      p_completed_checks: gCompleted,
      p_failed_checks: dualCloudScans.g.failedChecks.map(mapGoogleCheck),
      p_flags: dualCloudScans.g.flags,
      p_model_versions: dualCloudScans.g.modelVersions as any,
      p_manifest: mediaItems.map((m) => ({ id: m.id, path: m.originalStoragePath, sha256: m.mediaSha256 })),
      p_scanned_media_count: mediaItems.length,
    });
    if (gRegError) {
      if (gRegError.message.includes("LEASE_EXPIRED")) return { success: false, error: "LEASE_EXPIRED_DURING_SCAN" };
      return { success: false, error: `GOOGLE_RECEIPT_REGISTRATION_FAILED: ${gRegError.message}` };
    }
  } else {
    // Single receipt for azure_only, google_cloud_only, or baseline
    const { error: registerError } = await supabase.rpc("register_moderation_scan_receipt", {
      p_request_id: job.request_id,
      p_claim_token: job.claim_token,
      p_listing_id: job.listing_id,
      p_listing_revision: job.listing_revision,
      p_generation_id: job.generation_id,
      p_media_digest: computedMediaDigest,
      p_verdict: verdict,
      p_ruleset_version: rulesetVersion,
      p_scope: scope,
      p_completed_checks: completedChecks,
      p_failed_checks: failedChecks,
      p_flags: flags,
      p_model_versions: modelVersions,
      p_manifest: mediaItems.map((m) => ({ id: m.id, path: m.originalStoragePath, sha256: m.mediaSha256 })),
      p_scanned_media_count: mediaItems.length,
    });

    if (registerError) {
      if (registerError.message.includes("LEASE_EXPIRED")) {
        return { success: false, error: "LEASE_EXPIRED_DURING_SCAN" };
      }
      return { success: false, error: `RECEIPT_REGISTRATION_FAILED: ${registerError.message}` };
    }
  }

  // 6. Map verdict to publication outcome
  let outcome = "checks_incomplete";
  if (verdict === "APPROVE") {
    outcome = "no_review_flags";
  } else if (verdict === "REJECT" || verdict === "FLAG") {
    outcome = "needs_review";
  }

  // 7. Commit into authoritative publication gate
  const { data, error } = await supabase.rpc("impl_finalize_moderation_result", {
    p_request_id: job.request_id,
    p_claim_token: job.claim_token,
    p_outcome: outcome,
    p_ruleset_version: rulesetVersion,
    p_scope: scope,
    p_completed_rules: completedChecks,
    p_failed_rules: failedChecks,
    p_flags: flags,
    p_errors: {
      media_digest: computedMediaDigest,
      scanned_media_count: mediaItems.length,
      mode: options.mode,
    },
  });

  if (error) {
    return { success: false, error: `FINALIZER_RPC_FAILED: ${error.message}` };
  }

  return { success: true, decision: (data as any)?.decision };
}

/**
 * Drop-in backward-compatible entry point for Azure Moderation V1 tests and dispatchers.
 */
export async function processClaimedAzureJob(
  rawJob: unknown,
  supabase: SupabaseClient,
  config: AzureWorkerConfig
): Promise<{ success: boolean; decision?: string; error?: string }> {
  return processClaimedModerationJob(rawJob, supabase, {
    mode: "azure",
    azureEndpoint: config.azureModerationEndpoint,
    azureSecret: config.azureModerationSecret,
    openAiApiKey: config.openAiApiKey,
    azureTimeoutMs: config.azureTimeoutMs,
  });
}
