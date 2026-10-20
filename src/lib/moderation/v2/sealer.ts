import type { SnapshotV2 } from "./contract";

type Media = SnapshotV2["media"][number];
type Format = "jpeg" | "png" | "webp";
type Variant = "original" | "canonical" | "thumb" | "medium" | "large";
type FailureCode = "UNSUPPORTED_MEDIA" | "DIGEST_MISMATCH" | "SEAL_INVALID" | "TIMEOUT";
type Failure = { ok: false; code: FailureCode };
const VARIANTS: readonly Variant[] = ["original", "canonical", "thumb", "medium", "large"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const SEAL_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, maxAxis: 8000, maxPixels: 64_000_000 });
export const SEAL_RECIPE = Object.freeze({
  id: "seal_v1" as const, orientation: "apply" as const, metadata: "strip_all" as const,
  canonical: Object.freeze({ format: "webp" as const, fit: "full_frame" as const, resize: false, crop: false }),
  thumb: Object.freeze({ format: "webp" as const, width: 200, height: 200, fit: "cover_center" as const }),
  medium: Object.freeze({ format: "webp" as const, maxEdge: 800, fit: "inside" as const, upscale: false }),
  large: Object.freeze({ format: "webp" as const, maxEdge: 1400, fit: "inside" as const, upscale: false }),
  rounding: "nearest_min_one" as const,
});

/** The integration owner must approve an exact deployed implementation/profile.
 * No Sharp, codec version, quality setting or runtime compatibility is assumed.
 * encoderProfile identifies fixed deterministic codec settings, not a latest alias.
 */
export type ProcessorDescriptor = Readonly<{
  implementation: string; version: string; webpCodec: string; codecVersion: string; encoderProfile: string;
}>;
type Inspection = {
  format: Format; width: number; height: number; frames: number; orientation: number; hasMetadata: boolean;
};
export type RenderRequest = Readonly<{
  variant: Exclude<Variant, "original">; format: "webp"; width: number; height: number;
  fit: "full_frame" | "cover_center" | "inside"; metadata: "strip_all";
}>;
type Operation = { signal: AbortSignal; limits: typeof SEAL_LIMITS };
/** Trusted native/remote processing adapter. It must enforce limits BEFORE any
 * full decode/allocation, reject all animation/multipage formats, orient once,
 * remove all metadata and render ONLY from the supplied immutable frame handle.
 * Inspection must validate containers, not just sniff signatures. No source URLs
 * or Storage capability are exposed by this interface. Tests use mocks only.
 */
export interface ImageProcessor {
  readonly descriptor: ProcessorDescriptor;
  inspect(bytes: Uint8Array, operation: Operation): Promise<Inspection>;
  decode(bytes: Uint8Array, operation: Operation & { recipe: typeof SEAL_RECIPE }): Promise<{
    frame: object; sourceSha256: string; width: number; height: number;
    frames: number; orientationApplied: boolean; metadataRemoved: boolean;
  }>;
  render(frame: object, request: RenderRequest, operation: Operation): Promise<{ frame: object; bytes: Uint8Array }>;
  release(frame: object): Promise<void>;
}
export type SealInput = {
  listing_id: string; listing_revision: number; generation_id: string; media_id: string;
  display_order: number; source_sha256: string; source: Uint8Array; created_at: string;
};
/** Local preparation/write INTENT, not evidence that any upload occurred. */
type PreparedObject = {
  object_id: string; bucket: "listing-originals" | "listing-derivatives";
  key: string; contentType: "image/jpeg" | "image/png" | "image/webp"; bytes: Uint8Array;
  writeOptions: Readonly<{ upsert: false }>;
};
/** Untrusted download observations. They contain neither authenticated writer
 * receipts nor proof of upsert=false or namespace enforcement. Any such claims
 * supplied as extra fields are ignored by the byte-identity verifier.
 */
export type ImageSealReadback = Pick<PreparedObject, "object_id" | "bucket" | "key" | "contentType" | "bytes">;
type ReadbackVerification = {
  ok: true;
  scope: "downloaded_byte_identity_only";
  create_only_writes: "unverified";
  storage_immutability: "unverified";
} | Failure;
/** Prepared bytes are NOT a registered/immutable seal or an integrity check pass.
 * Registry/Storage orchestration must enforce create-only writes, readback,
 * provenance, retirement/invalidation and equality to the DB-owned manifest.
 */
export type PreparedImageSeal = {
  listing_id: string; listing_revision: number; generation_id: string; created_at: string;
  recipe: typeof SEAL_RECIPE; processor: ProcessorDescriptor; recipe_sha256: string;
  media: Media; objects: Record<Variant, PreparedObject>;
};
type Options = {
  processor: ImageProcessor; approvedProcessor: ProcessorDescriptor;
  // Trusted caller supplies fresh CSPRNG UUID v4s (deterministic factory in tests).
  newUuid: () => string; timeoutMs: number;
};
export class ImageProcessingError extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
function requireSeal(condition: unknown, code: FailureCode): asserts condition {
  if (!condition) throw new ImageProcessingError(code);
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
function descriptorTuple(d: ProcessorDescriptor): string[] {
  return [d.implementation, d.version, d.webpCodec, d.codecVersion, d.encoderProfile];
}
function signature(bytes: Uint8Array): Format | null {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return "png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp";
  return null;
}
function bounded(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= SEAL_LIMITS.maxAxis && height <= SEAL_LIMITS.maxAxis && width * height <= SEAL_LIMITS.maxPixels;
}
function boundedBytes(bytes: Uint8Array): boolean {
  return bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= SEAL_LIMITS.maxBytes;
}
function inside(width: number, height: number, max: number): [number, number] {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export async function prepareImageSeal(input: SealInput, options: Options): Promise<{ ok: true; bundle: PreparedImageSeal } | Failure> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<{ ok: true; bundle: PreparedImageSeal } | Failure> => {
    let frame: object | undefined;
    try {
      requireSeal([input.listing_id, input.generation_id, input.media_id].every(id => UUID.test(id))
        && Number.isSafeInteger(input.listing_revision) && input.listing_revision >= 0
        && Number.isSafeInteger(input.display_order) && input.display_order >= 0 && HASH.test(input.source_sha256)
        && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(input.created_at)
        && Number.isFinite(Date.parse(input.created_at)), "SEAL_INVALID");
      requireSeal(boundedBytes(input.source), "UNSUPPORTED_MEDIA");
      const source = new Uint8Array(input.source);
      input = { ...input, source };
      const detectedFormat = signature(source);
      requireSeal(detectedFormat, "UNSUPPORTED_MEDIA");
      const format: Format = detectedFormat;
      requireSeal(await digest(source) === input.source_sha256, "DIGEST_MISMATCH");
      const approved = structuredClone(options.approvedProcessor);
      requireSeal(descriptorTuple(approved).every(s => typeof s === "string" && /^[A-Za-z0-9_.:+-]{1,120}$/.test(s))
        && JSON.stringify(descriptorTuple(approved)) === JSON.stringify(descriptorTuple(options.processor.descriptor)), "SEAL_INVALID");
      const operation = { signal: controller.signal, limits: SEAL_LIMITS };
      const active = () => requireSeal(!controller.signal.aborted, "TIMEOUT");
      active();
      const inspection = await options.processor.inspect(new Uint8Array(source), operation);
      requireSeal(inspection.format === format && inspection.frames === 1 && bounded(inspection.width, inspection.height)
        && Number.isInteger(inspection.orientation) && inspection.orientation >= 1 && inspection.orientation <= 8, "UNSUPPORTED_MEDIA");
      active();
      const decoded = await options.processor.decode(new Uint8Array(source), { ...operation, recipe: SEAL_RECIPE });
      frame = decoded.frame;
      active();
      requireSeal(frame && typeof frame === "object", "SEAL_INVALID");
      requireSeal(decoded.sourceSha256 === input.source_sha256, "DIGEST_MISMATCH");
      requireSeal(decoded.frames === 1, "UNSUPPORTED_MEDIA");
      const swapped = inspection.orientation >= 5;
      const width = swapped ? inspection.height : inspection.width;
      const height = swapped ? inspection.width : inspection.height;
      requireSeal(decoded.width === width && decoded.height === height && decoded.orientationApplied === true
        && decoded.metadataRemoved === true, "SEAL_INVALID");
      const identities = Array.from({ length: 6 }, () => options.newUuid());
      requireSeal(identities.every(id => UUID.test(id)) && new Set(identities).size === 6, "SEAL_INVALID");
      const assetVersion = identities[0];
      const objects = {} as Record<Variant, PreparedObject>;
      const media: Media = { media_id: input.media_id, asset_version: assetVersion, display_order: input.display_order,
        source_sha256: input.source_sha256, recipe: "seal_v1", original: null!, canonical: null!, thumb: null!, medium: null!, large: null! };
      async function add(variant: Variant, bytes: Uint8Array, w: number, h: number, index: number) {
        requireSeal(boundedBytes(bytes) && bounded(w, h), "UNSUPPORTED_MEDIA");
        const owned = new Uint8Array(bytes);
        const sha = await digest(owned);
        media[variant] = { object_id: identities[index], sha256: sha, bytes: owned.length, width: w, height: h };
        const ext = variant === "original" ? format === "jpeg" ? "jpg" : format : "webp";
        objects[variant] = { object_id: identities[index], bucket: variant === "original" || variant === "canonical"
          ? "listing-originals" : "listing-derivatives",
        key: `${input.listing_id}/${input.media_id}/v2/${assetVersion}/${sha}/${variant}.${ext}`,
        contentType: variant === "original" ? `image/${format}` : "image/webp", bytes: owned,
        writeOptions: Object.freeze({ upsert: false }) };
      }
      await add("original", source, inspection.width, inspection.height, 1);
      const sizes: Record<Exclude<Variant, "original">, [number, number]> = {
        canonical: [width, height], thumb: [200, 200], medium: inside(width, height, 800), large: inside(width, height, 1400),
      };
      for (const [i, variant] of (["canonical", "thumb", "medium", "large"] as const).entries()) {
        active();
        const [w, h] = sizes[variant];
        const request: RenderRequest = Object.freeze({ variant, format: "webp", width: w, height: h,
          fit: variant === "canonical" ? "full_frame" : variant === "thumb" ? "cover_center" : "inside", metadata: "strip_all" });
        const rendered = await options.processor.render(frame, request, operation);
        active();
        requireSeal(rendered.frame === frame, "SEAL_INVALID");
        requireSeal(boundedBytes(rendered.bytes), "UNSUPPORTED_MEDIA");
        const bytes = new Uint8Array(rendered.bytes);
        requireSeal(signature(bytes) === "webp", "UNSUPPORTED_MEDIA");
        active();
        const output = await options.processor.inspect(new Uint8Array(bytes), operation);
        requireSeal(output.format === "webp" && output.frames === 1 && output.width === w && output.height === h
          && output.orientation === 1 && output.hasMetadata === false, "SEAL_INVALID");
        await add(variant, bytes, w, h, i + 2);
      }
      active();
      const recipeHash = await digest(new TextEncoder().encode(JSON.stringify(["fairswap:v2:seal_v1", SEAL_RECIPE, descriptorTuple(approved)])));
      return { ok: true, bundle: { listing_id: input.listing_id, listing_revision: input.listing_revision,
        generation_id: input.generation_id, created_at: input.created_at, recipe: SEAL_RECIPE,
        processor: approved, recipe_sha256: recipeHash, media, objects } };
    } catch (error) { return { ok: false, code: error instanceof ImageProcessingError ? error.code : "SEAL_INVALID" }; }
    finally { if (frame) await options.processor.release(frame); }
  };
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000) return { ok: false, code: "SEAL_INVALID" };
  const timeout = new Promise<Failure>(resolve => {
    timer = setTimeout(() => { resolve({ ok: false, code: "TIMEOUT" }); controller.abort(); }, options.timeoutMs);
  });
  try { return await Promise.race([work(), timeout]); }
  catch { return { ok: false, code: "SEAL_INVALID" }; }
  finally { clearTimeout(timer); }
}

/** Point-in-time equality check against a trusted prepared bundle, using five
 * UNTRUSTED downloaded-byte observations. Prepared writeOptions describe intent.
 * Authentic create-only write evidence must come separately from the trusted
 * writer and bind the exact objects/bytes; it cannot be inferred from downloads
 * or this result. Even authentic upsert=false receipts do not establish namespace
 * immutability against other writers. Storage enforcement, registry/provenance,
 * retirement and publication gates remain external and are NOT certified here.
 */
export async function verifyImageSealReadback(bundle: PreparedImageSeal, readbacks: readonly ImageSealReadback[]): Promise<ReadbackVerification> {
  try {
    requireSeal(bundle.media.recipe === "seal_v1", "SEAL_INVALID");
    requireSeal(readbacks.length === 5, "SEAL_INVALID");
    requireSeal(new Set(VARIANTS.map(v => bundle.objects[v].object_id)).size === 5, "SEAL_INVALID");
    const recipeHash = await digest(new TextEncoder().encode(JSON.stringify(["fairswap:v2:seal_v1", SEAL_RECIPE, descriptorTuple(bundle.processor)])));
    requireSeal(recipeHash === bundle.recipe_sha256 && JSON.stringify(bundle.recipe) === JSON.stringify(SEAL_RECIPE), "SEAL_INVALID");
    for (const variant of VARIANTS) {
      const expected = bundle.objects[variant];
      const identity = bundle.media[variant];
      requireSeal(expected.object_id === identity.object_id && expected.writeOptions.upsert === false
        && bounded(identity.width, identity.height), "SEAL_INVALID");
      const format = variant === "original" ? signature(expected.bytes) : "webp";
      requireSeal(format && expected.contentType === `image/${format}`
        && expected.bucket === (variant === "original" || variant === "canonical" ? "listing-originals" : "listing-derivatives")
        && expected.key === `${bundle.listing_id}/${bundle.media.media_id}/v2/${bundle.media.asset_version}/${identity.sha256}/${variant}.${format === "jpeg" ? "jpg" : format}`,
      "SEAL_INVALID");
      const matches = readbacks.filter(o => o.object_id === expected.object_id);
      requireSeal(matches.length === 1, "SEAL_INVALID");
      const actual = matches[0];
      requireSeal(actual.bucket === expected.bucket && actual.key === expected.key
        && actual.contentType === expected.contentType, "SEAL_INVALID");
      requireSeal(actual.bytes.length === bundle.media[variant].bytes
        && actual.bytes.length === expected.bytes.length && actual.bytes.every((byte, i) => byte === expected.bytes[i])
        && await digest(actual.bytes) === bundle.media[variant].sha256
        && await digest(expected.bytes) === bundle.media[variant].sha256, "DIGEST_MISMATCH");
    }
    requireSeal(bundle.media.original.sha256 === bundle.media.source_sha256, "DIGEST_MISMATCH");
    return { ok: true, scope: "downloaded_byte_identity_only", create_only_writes: "unverified", storage_immutability: "unverified" };
  } catch (error) { return { ok: false, code: error instanceof ImageProcessingError ? error.code : "SEAL_INVALID" }; }
}
