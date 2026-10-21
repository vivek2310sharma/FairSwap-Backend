import { z } from "zod";
import type { ModerationOutcome } from "./free-moderation.ts";

/**
 * FairSwapProd: one-image, read-only OpenAI Moderation SHADOW probe.
 *
 * The source is a legacy medium-sized, metadata-stripped WebP derivative.
 * It is NOT the full-frame sealed canonical, and its SHA-256 is sampled at
 * read time, NOT attested by any V2 database registry. This function NEVER
 * publishes, rejects, changes status, binds an image, or claims full coverage.
 */

const UUID = z.string().uuid();
export const ImageShadowRequestSchema = z.object({
  listingId: UUID,
  mediaId: UUID,
}).strict();

const ListingSchema = z.object({
  id: UUID,
  status: z.enum([
    "draft", "pending_review", "active", "reserved", "sold", "rejected",
    "paused", "expired", "removed",
  ]),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updated_at: z.string().min(1).max(80),
}).strict();

const MediaSchema = z.object({
  id: UUID,
  listing_id: UUID,
  original_storage_path: z.string().nullable(),
  thumbnail_storage_path: z.string().nullable(),
  medium_storage_path: z.string().nullable(),
  large_storage_path: z.string().nullable(),
  processing_status: z.string(),
  display_order: z.number().int().min(0).max(7),
  created_at: z.string().min(1).max(80),
}).strict();

const SnapshotSchema = z.object({
  listing: ListingSchema,
  media: MediaSchema,
}).strict();

type Snapshot = z.infer<typeof SnapshotSchema>;

export type ImageShadowResult =
  | Readonly<{
      ok: true;
      authority: "SHADOW_IMAGE_ONLY_NEVER_PUBLISH";
      source: "LEGACY_MEDIUM_WEBP_UNSEALED";
      scope: "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE";
      imageReview: "HARM_CATEGORIES_ONLY_NOT_MARKETPLACE_FRAUD";
      listingId: string;
      mediaId: string;
      revision: number;
      sampleSha256: string;
      sampleBytes: number;
      sameBytesOnSecondRead: boolean;
      stale: boolean;
      route: "review" | "retry" | "image_no_harm_flags";
      provider: "clear" | "flagged" | "failed";
      harmCategories: readonly string[];
    }>
  | Readonly<{
      ok: false;
      code: "INVALID_REQUEST" | "NOT_FOUND" | "INVALID_SNAPSHOT" |
        "UNSUPPORTED_SOURCE" | "STORAGE_UNAVAILABLE" | "INVALID_WEBP";
    }>;

export interface ImageShadowDeps {
  /** Read immutable-in-memory listing/media projection. No caller-supplied path. */
  loadSnapshot(listingId: string, mediaId: string): Promise<unknown>;
  /** Private server-side Storage download of the expected medium key only. */
  readMedium(key: string): Promise<Uint8Array>;
  /** Use only the free OpenAI Moderation API; NO paid GPT/Responses. */
  moderateImage(bytes: Uint8Array, sha256: string): Promise<ModerationOutcome>;
}

const MAX_WEBP_BYTES = 5 * 1024 * 1024;

function isValidSource(s: Snapshot): boolean {
  const listing = s.listing, media = s.media;
  const prefix = listing.id + "/" + media.id + "/";
  return listing.status !== "removed" &&
    media.listing_id === listing.id &&
    media.processing_status === "ready" &&
    [
      prefix + "original.jpg",
      prefix + "original.png",
      prefix + "original.webp",
    ].includes(media.original_storage_path ?? "") &&
    media.thumbnail_storage_path === prefix + "thumb.webp" &&
    media.medium_storage_path === prefix + "medium.webp" &&
    media.large_storage_path === prefix + "large.webp";
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.listing.id === b.listing.id &&
    a.listing.revision === b.listing.revision &&
    a.listing.status === b.listing.status &&
    a.listing.updated_at === b.listing.updated_at &&
    a.media.id === b.media.id &&
    a.media.listing_id === b.media.listing_id &&
    a.media.processing_status === b.media.processing_status &&
    a.media.created_at === b.media.created_at &&
    a.media.display_order === b.media.display_order &&
    a.media.original_storage_path === b.media.original_storage_path &&
    a.media.thumbnail_storage_path === b.media.thumbnail_storage_path &&
    a.media.medium_storage_path === b.media.medium_storage_path &&
    a.media.large_storage_path === b.media.large_storage_path;
}

function read32(b: Uint8Array, pos: number): number {
  return (
    b[pos]! + b[pos + 1]! * 256 + b[pos + 2]! * 65536 +
    b[pos + 3]! * 16777216
  ) >>> 0;
}

function fourCC(b: Uint8Array, pos: number): string {
  return String.fromCharCode(b[pos]!, b[pos + 1]!, b[pos + 2]!, b[pos + 3]!);
}

/**
 * Reject any RIFF chunk that could contain location/EXIF/XMP/ICC metadata,
 * animation or unknown payloads, without decoding or editing user pixels.
 *
 * This structural check is NOT a full WebP decoder; images reaching OpenAI
 * are still treated as untrusted, and provider decode errors fail closed.
 */
export function isMetadataFreeStaticWebp(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 22 ||
    value.byteLength > MAX_WEBP_BYTES) return false;
  const b = value;
  if (fourCC(b, 0) !== "RIFF" || fourCC(b, 8) !== "WEBP" ||
    read32(b, 4) !== b.length - 8) return false;

  let pos = 12;
  let imageChunks = 0;
  let hasExtended = false;
  let sawAlpha = false;
  while (pos + 8 <= b.length) {
    const code = fourCC(b, pos);
    const length = read32(b, pos + 4);
    const dataAt = pos + 8;
    if (!length || length > b.length - dataAt) return false;
    const padding = length % 2;
    const next = dataAt + length + padding;
    if (next > b.length) return false;
    if (code === "VP8X") {
      if (pos !== 12 || hasExtended || length !== 10) return false;
      hasExtended = true;
      // ICCP, EXIF, XMP or ANIMATION feature bits are prohibited.
      if ((b[dataAt]! & 0x2e) !== 0) return false;
    } else if (code === "ALPH") {
      if (!hasExtended || sawAlpha || imageChunks > 0) return false;
      sawAlpha = true;
    } else if (code === "VP8 " || code === "VP8L") {
      if (++imageChunks !== 1) return false;
    } else {
      // EXIF, XMP, ICCP, ANIM, ANMF, metadata and unknown chunks.
      return false;
    }
    pos = next;
  }
  return pos === b.length && imageChunks === 1;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest).map(n => n.toString(16).padStart(2, "0")).join("");
}

export async function runImageShadowProbe(
  rawRequest: unknown,
  deps: ImageShadowDeps,
): Promise<ImageShadowResult> {
  const input = ImageShadowRequestSchema.safeParse(rawRequest);
  if (!input.success) return { ok: false, code: "INVALID_REQUEST" };
  const { listingId, mediaId } = input.data;

  let firstRaw: unknown;
  try {
    firstRaw = await deps.loadSnapshot(listingId, mediaId);
  } catch {
    return { ok: false, code: "STORAGE_UNAVAILABLE" };
  }
  if (firstRaw === null) return { ok: false, code: "NOT_FOUND" };
  const first = SnapshotSchema.safeParse(firstRaw);
  if (!first.success) return { ok: false, code: "INVALID_SNAPSHOT" };
  if (first.data.listing.id !== listingId || first.data.media.id !== mediaId) {
    return { ok: false, code: "NOT_FOUND" };
  }
  if (!isValidSource(first.data)) return { ok: false, code: "UNSUPPORTED_SOURCE" };

  // Never accept a Storage key/URL/digest provided by an API caller.
  const key = first.data.media.medium_storage_path!;
  let before: Uint8Array;
  try {
    before = await deps.readMedium(key);
  } catch {
    return { ok: false, code: "STORAGE_UNAVAILABLE" };
  }
  if (!isMetadataFreeStaticWebp(before)) return { ok: false, code: "INVALID_WEBP" };
  const immutableBytes = Uint8Array.from(before);
  const inputHash = await sha256(immutableBytes);

  let outcome: ModerationOutcome;
  try {
    outcome = await deps.moderateImage(immutableBytes, inputHash);
  } catch {
    outcome = { state: "failed", reason: "PROVIDER_UNAVAILABLE" };
  }
  // Not an independent WORM proof. Detect point-in-time physical swaps,
  // including a same-path privileged Storage overwrite during provider work.
  let sameBytes = false;
  try {
    const after = await deps.readMedium(key);
    sameBytes = isMetadataFreeStaticWebp(after) &&
      after.byteLength === immutableBytes.length &&
      (await sha256(after)) === inputHash;
  } catch {
    sameBytes = false;
  }

  let sameRow = false;
  try {
    const again = SnapshotSchema.safeParse(
      await deps.loadSnapshot(listingId, mediaId),
    );
    sameRow = again.success && isValidSource(again.data) &&
      sameSnapshot(first.data, again.data);
  } catch {
    sameRow = false;
  }
  const stale = !sameBytes || !sameRow;
  const flagged = outcome.state === "flagged";
  return {
    ok: true,
    authority: "SHADOW_IMAGE_ONLY_NEVER_PUBLISH",
    source: "LEGACY_MEDIUM_WEBP_UNSEALED",
    scope: "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE",
    imageReview: "HARM_CATEGORIES_ONLY_NOT_MARKETPLACE_FRAUD",
    listingId,
    mediaId,
    revision: first.data.listing.revision,
    sampleSha256: inputHash,
    sampleBytes: immutableBytes.length,
    sameBytesOnSecondRead: sameBytes,
    stale,
    route: stale || outcome.state === "failed" ? "retry" :
      flagged ? "review" : "image_no_harm_flags",
    provider: outcome.state,
    harmCategories: flagged
      ? Object.entries(outcome.categoryFlags)
          .filter(([, v]) => v === true)
          .map(([name]) => name)
          .sort()
          .slice(0, 16)
      : [],
  };
}
