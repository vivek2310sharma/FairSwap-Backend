/**
 * Candidate V1 OpenAI moderation preflight.
 *
 * Text and every attached image must pass the FREE OpenAI Moderation API.
 * India fraud and product-name risks are screened with deterministic
 * review-only rules. Weapon images without harmful content CANNOT be
 * reliably recognized by this free model. The limitation must remain
 * explicit to operators; photo-only weapons remain a residual risk.
 *
 * This worker-side guard is not an immutable DB publication gate.
 * V2 sealed media identity and atomic SQL evidence remain prerequisites
 * for full production enforcement. No customer-supplied URL is fetched.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  moderateText,
  moderateCanonicalWebp,
} from "../../../src/lib/moderation/v2/free-moderation";
import { evaluateFreeMarketplacePolicy } from "../../../src/lib/moderation/v2/free-marketplace-policy";

const UUID = z.string().uuid();
const MAX_MEDIA = 8;
const MAX_WEBP_BYTES = 5 * 1024 * 1024;

const Job = z.object({
  listingId: UUID,
  revision: z.number().int().nonnegative(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000),
}).strict();

const Listing = z.object({
  id: UUID,
  revision: z.number().int().nonnegative(),
  status: z.literal("pending_review"),
  title: z.string(),
  description: z.string(),
}).strict();

const Media = z.object({
  id: UUID,
  medium_storage_path: z.string().nullable(),
  processing_status: z.string(),
  display_order: z.number().int(),
  created_at: z.string(),
}).strict();

const MediaManifest = z.array(Media).min(1).max(MAX_MEDIA);

export type MediaEvidenceDigest = Readonly<{ id: string; medium_storage_path: string; sha256: string }>;

export type ContentSafetyResult =
  | Readonly<{ state: "clear"; reviewedImages: number; mediaDigests: readonly MediaEvidenceDigest[] }>
  | Readonly<{
      state: "review";
      source: "text" | "image";
      reason: "OPENAI_HARM" | "OPENAI_MARKETPLACE_POLICY" | "OPENAI_UNCERTAIN" | "FAIRSWAP_POLICY";
    }>
  | Readonly<{
      state: "incomplete";
      reason:
        | "INVALID_INPUT"
        | "PROVIDER_UNCONFIGURED"
        | "LISTING_STALE"
        | "MEDIA_MANIFEST_INVALID"
        | "MEDIA_NOT_READY"
        | "MEDIA_READ_FAILED"
        | "PROVIDER_FAILED"
        | "MANIFEST_CHANGED";
    }>;

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
    bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
}

function base64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 24_576) {
    let chars = "";
    for (const value of bytes.subarray(i, i + 24_576)) {
      chars += String.fromCharCode(value);
    }
    result += btoa(chars);
  }
  return result;
}

function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)).then(buffer =>
    Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("")
  );
}

type Snapshot = Readonly<{ listing: z.infer<typeof Listing>; media: z.infer<typeof Media>[] }>;

async function loadSnapshot(
  job: z.infer<typeof Job>,
  db: SupabaseClient,
): Promise<Snapshot | null> {
  const { data: listingData, error: listingError } = await db
    .from("listings")
    .select("id,revision,status,title,description")
    .eq("id", job.listingId)
    .maybeSingle();
  const listing = Listing.safeParse(listingData);
  if (listingError || !listing.success ||
      listing.data.revision !== job.revision ||
      listing.data.title !== job.title ||
      listing.data.description !== job.description) {
    return null;
  }
  const { data: mediaData, error: mediaError } = await db
    .from("listing_media")
    .select("id,medium_storage_path,processing_status,display_order,created_at")
    .eq("listing_id", job.listingId)
    .order("display_order", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_MEDIA + 1);
  const media = MediaManifest.safeParse(mediaData);
  if (mediaError || !media.success) {
    return { listing: listing.data, media: [] };
  }
  return { listing: listing.data, media: media.data };
}

export async function reviewListingContentSafety(
  rawJob: unknown,
  db: SupabaseClient,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<ContentSafetyResult> {
  const job = Job.safeParse(rawJob);
  if (!job.success) return { state: "incomplete", reason: "INVALID_INPUT" };
  if (!apiKey || apiKey.length < 20) {
    return { state: "incomplete", reason: "PROVIDER_UNCONFIGURED" };
  }
  const providerKey = apiKey;
  const listingJob = job.data;

  try {
    const snapshot = await loadSnapshot(listingJob, db);
    if (!snapshot) return { state: "incomplete", reason: "LISTING_STALE" };
    if (snapshot.media.length === 0) {
      return { state: "incomplete", reason: "MEDIA_MANIFEST_INVALID" };
    }
    if (snapshot.media.some(m => m.processing_status !== "ready" || !m.medium_storage_path)) {
      return { state: "incomplete", reason: "MEDIA_NOT_READY" };
    }

    // The Moderations endpoint explicitly scans TEXT, not only images.
    const text = "Title: " + listingJob.title + "\nDescription: " + listingJob.description;
    const textParts = text.length <= 5000
      ? [text]
      : ["Title: " + listingJob.title, listingJob.description];
    for (const part of textParts) {
      const textSafety = await moderateText(part, { apiKey: providerKey, fetcher, timeoutMs: 15_000 });
      if (textSafety.state === "failed") {
        return { state: "incomplete", reason: "PROVIDER_FAILED" };
      }
      if (textSafety.state === "flagged") {
        return { state: "review", source: "text", reason: "OPENAI_HARM" };
      }
    }

    // No paid model calls: local India-first marketplace signals are
    // REVIEW ONLY. The independent free OpenAI text scan ran above.
    const textPolicy = evaluateFreeMarketplacePolicy(
      listingJob.title, listingJob.description,
    );
    if (textPolicy.decision === "review") {
      return { state: "review", source: "text", reason: "FAIRSWAP_POLICY" };
    }

    // Every image must pass the free OpenAI Moderation API. Bounded
    // parallel batches respect Edge latency/memory; failure fails closed.
    // Harm classification is NOT a general image weapon/product classifier.
    async function inspect(media: z.infer<typeof Media>): Promise<ContentSafetyResult> {
      const expected = listingJob.listingId + "/" + media.id + "/medium.webp";
      if (media.medium_storage_path !== expected) {
        return { state: "incomplete", reason: "MEDIA_MANIFEST_INVALID" };
      }
      const { data: blob, error } = await db.storage
        .from("listing-derivatives").download(expected);
      if (error || !blob || blob.size < 12 || blob.size > MAX_WEBP_BYTES) {
        return { state: "incomplete", reason: "MEDIA_READ_FAILED" };
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!isWebp(bytes) || bytes.length > MAX_WEBP_BYTES) {
        return { state: "incomplete", reason: "MEDIA_READ_FAILED" };
      }
      const hash = await sha256(bytes);
      const imageSafety = await moderateCanonicalWebp(bytes, hash, {
        apiKey: providerKey, fetcher, timeoutMs: 15_000,
      });
      if (imageSafety.state === "failed") {
        return { state: "incomplete", reason: "PROVIDER_FAILED" };
      }
      if (imageSafety.state === "flagged") {
        return { state: "review", source: "image", reason: "OPENAI_HARM" };
      }
      return { state: "clear", reviewedImages: 1, mediaDigests: [{ id: media.id, medium_storage_path: expected, sha256: hash }] };
    }

    const mediaDigests: MediaEvidenceDigest[] = [];
    for (let start = 0; start < snapshot.media.length; start += 4) {
      const outcomes = await Promise.all(
        snapshot.media.slice(start, start + 4).map(inspect),
      );
      const review = outcomes.find(x => x.state === "review");
      if (review) return review;
      const incomplete = outcomes.find(x => x.state === "incomplete");
      if (incomplete) return incomplete;
      for (const checked of outcomes) if (checked.state === "clear") mediaDigests.push(...checked.mediaDigests);
    }

    // A revision change during external provider calls must not clear the
    // current listing. The SQL finalizer independently checks its row lock.
    const after = await loadSnapshot(listingJob, db);
    if (!after || JSON.stringify(after) !== JSON.stringify(snapshot)) {
      return { state: "incomplete", reason: "MANIFEST_CHANGED" };
    }
    return { state: "clear", reviewedImages: snapshot.media.length, mediaDigests };
  } catch {
    // Do not log private text, media, keys, URLs, or provider bodies.
    return { state: "incomplete", reason: "PROVIDER_FAILED" };
  }
}
