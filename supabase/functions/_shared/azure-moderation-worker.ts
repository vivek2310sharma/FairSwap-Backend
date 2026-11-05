// supabase/functions/_shared/azure-moderation-worker.ts
// Authoritative Moderation Dispatcher for FairSwap India V1.
// Supports Provider-Switchable Moderation (Baseline Two-Check vs Azure Five-Check).
// Computes real byte-level SHA-256 hashes of private originals from 'listing-originals'.
// Registers verifiable scan receipts before finalization.
// Supabase authoritatively executes India fraud rules and OpenAI moderation for all listings.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateListingText } from "../../../src/lib/moderation/checker";
import { evaluateIndiaRules } from "../../../src/lib/moderation/india/checker";
import { evaluateOpenAiModeration } from "./openai-moderation-adapter";
import type { ModerationModeResolution } from "./moderation-mode-selector";

export const INDIA_AZURE_RULESET_VERSION = "india_azure_v1.0.0" as const;
export const INDIA_AZURE_EVALUATION_SCOPE = "multimodal_five_check" as const;
export const INDIA_RULESET_VERSION = "india_v1.0.0" as const;
export const INDIA_EVALUATION_SCOPE = "multimodal_five_check" as const;

export const INDIA_BASELINE_RULESET_VERSION = "india_baseline_v1.0.0" as const;
export const INDIA_BASELINE_EVALUATION_SCOPE = "baseline_two_check" as const;

export const AzureWorkerConfigSchema = z.object({
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(1),
  azureModerationEndpoint: z.string().url(),
  azureModerationSecret: z.string().min(16),
  openAiApiKey: z.string().optional(),
  batchSize: z.coerce.number().int().positive().max(100).default(10),
  leaseSeconds: z.coerce.number().int().positive().max(600).default(60),
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

export const AzureScanResponseSchema = z.object({
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

export interface ModerationJobOptions {
  mode: "baseline" | "azure";
  azureEndpoint?: string;
  azureSecret?: string;
  openAiApiKey?: string;
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

  // Five-check mode requires at least 1 photo
  if (options.mode === "azure" && readyMedia.length === 0) {
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
    const realSha256 = createHash("sha256").update(Buffer.from(arrayBuffer)).digest("hex");

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

  // 2. Authoritative Supabase Check 1: India Fraud Rules on title & description (Both Modes)
  const completedChecks: string[] = [];
  const failedChecks: string[] = [];
  const flags: unknown[] = [];
  let modelVersions: Record<string, string> = {};

  // Execute full India fraud rules engine
  const indiaFraudResult = evaluateIndiaRules({
    title: job.title,
    description: job.description,
  });
  if (indiaFraudResult.flags && indiaFraudResult.flags.length > 0) {
    flags.push(...indiaFraudResult.flags);
  }

  // Execute canonical MOD-01A listing text checker
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
    // Missing OpenAI API key must never count as a completed moderation check
    failedChecks.push("check_openai_moderation");
  }

  let verdict: "APPROVE" | "REJECT" | "FLAG" | "INCOMPLETE" = "APPROVE";
  let rulesetVersion: string = INDIA_BASELINE_RULESET_VERSION;
  let scope: string = INDIA_BASELINE_EVALUATION_SCOPE;

  // 4. Branch based on Mode: Baseline Two-Check vs Azure Five-Check
  if (options.mode === "azure") {
    rulesetVersion = INDIA_AZURE_RULESET_VERSION;
    scope = INDIA_AZURE_EVALUATION_SCOPE;

    if (!options.azureEndpoint || !options.azureSecret) {
      failedChecks.push("azure_missing_configuration");
      verdict = "INCOMPLETE";
    } else {
      let returnedMediaDigest = "";
      try {
        const azureRes = await fetch(options.azureEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Moderation-Secret": options.azureSecret,
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
          signal: AbortSignal.timeout(15000),
        });

        if (azureRes.ok) {
          const parsedAzure = AzureScanResponseSchema.safeParse(await azureRes.json());
          if (parsedAzure.success) {
            const az = parsedAzure.data;
            if (
              az.listingId !== job.listing_id ||
              az.listingRevision !== job.listing_revision ||
              az.generationId !== job.generation_id ||
              az.scannedMediaCount !== mediaItems.length ||
              az.manifest.length !== mediaItems.length
            ) {
              failedChecks.push("azure_response_identity_mismatch");
              verdict = "INCOMPLETE";
            } else {
              const returnedIds = az.manifest.map((m) => m.id ?? m.mediaId);
              const uniqueReturnedIds = new Set(returnedIds);
              const expectedIds = new Set(mediaItems.map((m) => m.id));

              const idsMatchExactly =
                uniqueReturnedIds.size === az.manifest.length &&
                uniqueReturnedIds.size === expectedIds.size &&
                [...uniqueReturnedIds].every((id) => expectedIds.has(id!));

              let allMediaMatched = idsMatchExactly;
              if (allMediaMatched) {
                for (const expectedItem of mediaItems) {
                  const matchedEntry = az.manifest.find(
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
                failedChecks.push("azure_manifest_mismatch");
                verdict = "INCOMPLETE";
              } else {
                // Add Azure completed checks (excluding checks Supabase authoritatively evaluated)
                for (const c of az.completedChecks) {
                  if (!completedChecks.includes(c)) completedChecks.push(c);
                }
                for (const f of az.failedChecks) {
                  if (!failedChecks.includes(f)) failedChecks.push(f);
                }
                flags.push(...az.flags);
                modelVersions = { ...modelVersions, ...az.modelVersions };
                returnedMediaDigest = az.mediaDigest;

                // Evaluate OCR text and QR payloads with Supabase India fraud rules
                const ocrTexts = az.extractedTexts || [];
                const qrPayloads = az.qrPayloads || [];
                const mediaFraud = evaluateIndiaRules({
                  title: job.title,
                  description: job.description,
                  ocrTexts,
                  qrPayloads,
                });
                if (mediaFraud.flags.length > 0) {
                  flags.push(...mediaFraud.flags);
                }
                for (const text of [...ocrTexts, ...qrPayloads]) {
                  const ocrFraud = evaluateListingText({ title: "Media Text", description: text });
                  if (ocrFraud.outcome === "needs_review") {
                    flags.push(...ocrFraud.flags);
                  }
                }

                if (az.verdict === "REJECT" || az.verdict === "FLAG" || flags.length > 0) {
                  verdict = "FLAG";
                } else if (az.verdict === "INCOMPLETE" || failedChecks.length > 0) {
                  verdict = "INCOMPLETE";
                } else {
                  verdict = "APPROVE";
                }
              }
            }
          } else {
            failedChecks.push("azure_response_schema_invalid");
            verdict = "INCOMPLETE";
          }
        } else {
          failedChecks.push(`azure_http_${azureRes.status}`);
          verdict = "INCOMPLETE";
        }
      } catch (err: any) {
        failedChecks.push("azure_dispatch_network_timeout");
        verdict = "INCOMPLETE";
      }

      if (mediaItems.length > 0 && returnedMediaDigest !== computedMediaDigest) {
        failedChecks.push("media_digest_mismatch");
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
  });
}
