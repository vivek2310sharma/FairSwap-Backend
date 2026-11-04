// supabase/functions/_shared/azure-moderation-worker.ts
// Authoritative Azure Moderation Dispatcher for FairSwap India V1.
// Computes real byte-level SHA-256 hashes of private originals from 'listing-originals'.
// Registers verifiable scan receipt before finalization.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const INDIA_RULESET_VERSION = "india_v1.0.0" as const;
export const INDIA_EVALUATION_SCOPE = "multimodal_five_check" as const;

export const AzureWorkerConfigSchema = z.object({
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(1),
  azureModerationEndpoint: z.string().url(),
  azureModerationSecret: z.string().min(16),
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

export async function processClaimedAzureJob(
  rawJob: unknown,
  supabase: SupabaseClient,
  config: AzureWorkerConfig
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

  // Canonical media manifest digest
  const manifestEntries = mediaItems
    .map((item) => `${item.id}:${item.originalStoragePath}:${item.mediaSha256}`)
    .sort()
    .join("\n");
  const computedMediaDigest = createHash("sha256").update(manifestEntries).digest("hex");

  // 2. Dispatch to Azure Moderation Controller
  let azureVerdict = "INCOMPLETE";
  let completedChecks: string[] = [];
  let failedChecks: string[] = [];
  let flags: unknown[] = [];
  let modelVersions: Record<string, string> = {};
  let returnedMediaDigest = "";

  try {
    const azureRes = await fetch(config.azureModerationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Moderation-Secret": config.azureModerationSecret,
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
        // Rigorous response identity validation
        const az = parsedAzure.data;
        if (
          az.listingId !== job.listing_id ||
          az.listingRevision !== job.listing_revision ||
          az.generationId !== job.generation_id ||
          az.scannedMediaCount !== mediaItems.length ||
          az.manifest.length !== mediaItems.length
        ) {
          failedChecks.push("azure_response_identity_mismatch");
          azureVerdict = "INCOMPLETE";
        } else {
          // Require equal lengths, unique image IDs, identical ID sets, exact original paths, and exact SHA-256 values
          const returnedIds = az.manifest.map((m) => m.id ?? m.mediaId);
          const uniqueReturnedIds = new Set(returnedIds);
          const expectedIds = new Set(mediaItems.map((m) => m.id));

          // Reject duplicates, omissions, and extras
          const idsAreUnique = uniqueReturnedIds.size === az.manifest.length;
          const idsMatchExactly =
            idsAreUnique &&
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
            azureVerdict = "INCOMPLETE";
          } else {
            azureVerdict = az.verdict;
            completedChecks = az.completedChecks;
            failedChecks = az.failedChecks;
            flags = az.flags;
            modelVersions = az.modelVersions;
            returnedMediaDigest = az.mediaDigest;
          }
        }
      } else {
        failedChecks.push("azure_response_schema_invalid");
      }
    } else {
      failedChecks.push(`azure_http_${azureRes.status}`);
    }
  } catch (err: any) {
    failedChecks.push("azure_dispatch_network_timeout");
  }

  if (mediaItems.length > 0 && returnedMediaDigest !== computedMediaDigest) {
    failedChecks.push("media_digest_mismatch");
    azureVerdict = "INCOMPLETE";
  }

  // 3. Register trusted scan receipt in app_security before finalization
  const { error: registerError } = await supabase.rpc("register_moderation_scan_receipt", {
    p_request_id: job.request_id,
    p_claim_token: job.claim_token,
    p_listing_id: job.listing_id,
    p_listing_revision: job.listing_revision,
    p_generation_id: job.generation_id,
    p_media_digest: computedMediaDigest,
    p_verdict: azureVerdict,
    p_ruleset_version: INDIA_RULESET_VERSION,
    p_scope: INDIA_EVALUATION_SCOPE,
    p_completed_checks: completedChecks,
    p_failed_checks: failedChecks,
    p_flags: flags,
    p_model_versions: modelVersions,
    p_manifest: mediaItems.map((m) => ({ id: m.id, path: m.originalStoragePath, sha256: m.mediaSha256 })),
    p_scanned_media_count: mediaItems.length,
  });

  if (registerError) {
    // If lease expired during slow scan/dispatch, fail closed gracefully without attempting finalizer
    if (registerError.message.includes("LEASE_EXPIRED")) {
      return { success: false, error: "LEASE_EXPIRED_DURING_SCAN" };
    }
    return { success: false, error: `RECEIPT_REGISTRATION_FAILED: ${registerError.message}` };
  }

  // 4. Map verdict to publication outcome
  let outcome = "checks_incomplete";
  if (azureVerdict === "APPROVE") {
    outcome = "no_review_flags";
  } else if (azureVerdict === "REJECT" || azureVerdict === "FLAG") {
    outcome = "needs_review";
  }

  // 5. Commit into authoritative publication gate (verifies registered receipt under lock)
  const { data, error } = await supabase.rpc("impl_finalize_moderation_result", {
    p_request_id: job.request_id,
    p_claim_token: job.claim_token,
    p_outcome: outcome,
    p_ruleset_version: INDIA_RULESET_VERSION,
    p_scope: INDIA_EVALUATION_SCOPE,
    p_completed_rules: completedChecks,
    p_failed_rules: failedChecks,
    p_flags: flags,
    p_errors: {
      media_digest: computedMediaDigest,
      scanned_media_count: mediaItems.length,
    },
  });

  if (error) {
    return { success: false, error: `FINALIZER_RPC_FAILED: ${error.message}` };
  }

  return { success: true, decision: (data as any)?.decision };
}
