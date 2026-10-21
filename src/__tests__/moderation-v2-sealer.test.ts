import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageProcessingError, prepareImageSeal, verifyImageSealReadback, SEAL_LIMITS, SEAL_RECIPE,
  type ImageProcessor, type ProcessorDescriptor, type PreparedImageSeal, type SealInput } from "../lib/moderation/v2/sealer";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const uuid = (n: number) => `00000000-0000-4000-a000-${n.toString(16).padStart(12, "0")}`;
type Inspection = Awaited<ReturnType<ImageProcessor["inspect"]>>;
const descriptor: ProcessorDescriptor = Object.freeze({ implementation: "synthetic-processor", version: "1.0.0",
  webpCodec: "synthetic-webp", codecVersion: "1.0.0", encoderProfile: "synthetic-profile-v1" });
// Signature-shaped synthetic byte arrays, not valid real images. Only the mock
// processor interprets them. These tests do not certify a decoder or codec.
function bytes(format: Inspection["format"], marker: number): Uint8Array {
  return new Uint8Array([...(format === "jpeg" ? [255, 216, 255] : format === "png"
    ? [137, 80, 78, 71, 13, 10, 26, 10] : [82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80]), marker, 69, 88, 73, 70]);
}
function fixture(format: Inspection["format"] = "jpeg", orientation = 1, width = 2400, height = 1600) {
  const source = bytes(format, 200);
  const frame = Object.freeze({ syntheticFrame: true });
  const inspected: Inspection = { format, width, height, frames: 1, orientation, hasMetadata: true };
  const decoded = { frame, sourceSha256: sha(source), width: orientation >= 5 ? height : width,
    height: orientation >= 5 ? width : height, frames: 1, orientationApplied: true, metadataRemoved: true };
  const outputInspections = new Map<string, Inspection>();
  let counter = 10;
  let marker = 0;
  const inspect = vi.fn(async (data: Uint8Array) => {
    if (sha(data) === sha(source)) return { ...inspected };
    const output = outputInspections.get(sha(data));
    if (!output) throw new ImageProcessingError("UNSUPPORTED_MEDIA");
    return { ...output };
  });
  const render = vi.fn<ImageProcessor["render"]>(async (handle, request) => {
    const output = bytes("webp", ++marker);
    outputInspections.set(sha(output), { format: "webp", width: request.width, height: request.height,
      frames: 1, orientation: 1, hasMetadata: false });
    return { frame: handle, bytes: output };
  });
  const processor = { descriptor, inspect, decode: vi.fn(async () => ({ ...decoded })), render,
    release: vi.fn(async () => {}) } satisfies ImageProcessor;
  const input: SealInput = { listing_id: uuid(1), listing_revision: 2, generation_id: uuid(2), media_id: uuid(3),
    display_order: 0, source_sha256: sha(source), source, created_at: "2026-10-18T12:00:00Z" };
  const options = { processor, approvedProcessor: { ...descriptor }, newUuid: vi.fn(() => uuid(counter++)), timeoutMs: 1000 };
  return { input, options, processor, inspected, decoded, outputInspections, frame };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const result = await prepareImageSeal(f.input, f.options);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Synthetic sealing preparation failed");
  return result.bundle;
}
const downloads = (bundle: PreparedImageSeal) => Object.values(bundle.objects).map(({ object_id, bucket, key, contentType, bytes }) =>
  ({ object_id, bucket, key, contentType, bytes: new Uint8Array(bytes) }));
const byteIdentityOnly = { ok: true, scope: "downloaded_byte_identity_only", create_only_writes: "unverified", storage_immutability: "unverified" } as const;
afterEach(() => vi.useRealTimers());

describe("local image seal preparation with a trusted mocked processor", () => {
  it.each(["jpeg", "png", "webp"] as const)("prepares five independently identified objects from %s while preserving original bytes", async format => {
    const f = fixture(format);
    const before = structuredClone(f.input);
    const bundle = await prepared(f);
    expect(Object.keys(bundle.objects)).toEqual(["original", "canonical", "thumb", "medium", "large"]);
    expect(bundle.objects.original.bytes).toEqual(before.source);
    expect(bundle.objects.original.bytes).not.toBe(f.input.source);
    expect(bundle.media.original.sha256).toBe(before.source_sha256);
    expect(bundle.media.source_sha256).toBe(before.source_sha256);
    expect(new Set(Object.values(bundle.objects).map(o => o.object_id)).size).toBe(5);
    expect(bundle.objects.original.key).toMatch(new RegExp(`/original\\.${format === "jpeg" ? "jpg" : format}$`));
    for (const [variant, object] of Object.entries(bundle.objects)) {
      const identity = bundle.media[variant as keyof typeof bundle.objects];
      expect(object.key).toBe(`${f.input.listing_id}/${f.input.media_id}/v2/${bundle.media.asset_version}/${sha(object.bytes)}/${variant}.${variant === "original" && format !== "webp" ? format === "jpeg" ? "jpg" : "png" : "webp"}`);
      expect(identity).toMatchObject({ object_id: object.object_id, sha256: sha(object.bytes), bytes: object.bytes.length });
      expect(object.bucket).toBe(variant === "original" || variant === "canonical" ? "listing-originals" : "listing-derivatives");
      expect(object.writeOptions).toEqual({ upsert: false });
    }
    expect(f.processor.decode).toHaveBeenCalledTimes(1);
    expect(f.processor.render).toHaveBeenCalledTimes(4);
    for (const [handle, request, operation] of f.processor.render.mock.calls) {
      expect(handle).toBe(f.frame);
      expect(request).toMatchObject({ format: "webp", metadata: "strip_all" });
      expect(operation.limits).toBe(SEAL_LIMITS);
    }
    expect(f.processor.release).toHaveBeenCalledExactlyOnceWith(f.frame);
    expect(f.input).toEqual(before);
    expect(await verifyImageSealReadback(bundle, downloads(bundle))).toEqual(byteIdentityOnly);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("requires orientation %i to be applied once without canonical crop/downscale", async orientation => {
    const f = fixture("jpeg", orientation);
    const bundle = await prepared(f);
    const w = orientation >= 5 ? 1600 : 2400;
    const h = orientation >= 5 ? 2400 : 1600;
    expect(bundle.media.original).toMatchObject({ width: 2400, height: 1600 });
    expect(bundle.media.canonical).toMatchObject({ width: w, height: h });
    expect(f.processor.render.mock.calls[0][1]).toMatchObject({ variant: "canonical", fit: "full_frame", width: w, height: h });
    expect(bundle.media.thumb).toMatchObject({ width: 200, height: 200 });
    expect(Math.max(bundle.media.medium.width, bundle.media.medium.height)).toBe(800);
    expect(Math.max(bundle.media.large.width, bundle.media.large.height)).toBe(1400);
  });
  it("keeps small canonical/inside dimensions and crops only the thumbnail", async () => {
    const f = fixture("png", 1, 90, 60);
    const bundle = await prepared(f);
    expect(bundle.media.canonical).toMatchObject({ width: 90, height: 60 });
    expect(bundle.media.medium).toMatchObject({ width: 90, height: 60 });
    expect(bundle.media.large).toMatchObject({ width: 90, height: 60 });
    expect(f.processor.render.mock.calls.map(c => c[1].fit)).toEqual(["full_frame", "cover_center", "inside", "inside"]);
  });
  it("records deterministic recipe/profile metadata independently of object IDs", async () => {
    const a = await prepared(fixture());
    const f = fixture(); f.options.newUuid.mockImplementationOnce(() => uuid(500));
    const b = await prepared(f);
    expect(a.recipe).toEqual(SEAL_RECIPE);
    expect(a.processor).toEqual(descriptor);
    expect(b.recipe_sha256).toBe(a.recipe_sha256);
    expect(a.media.asset_version).not.toBe(b.media.asset_version);
    expect(Object.isFrozen(SEAL_RECIPE.canonical)).toBe(true);
  });
  it("binds the recipe digest to approved codec/profile changes", async () => {
    const a = await prepared(fixture());
    const f = fixture();
    const changed = { ...descriptor, codecVersion: "1.0.1", encoderProfile: "synthetic-profile-v2" };
    f.processor.descriptor = changed; f.options.approvedProcessor = changed;
    expect((await prepared(f)).recipe_sha256).not.toBe(a.recipe_sha256);
  });
  it.each(["version", "codecVersion", "encoderProfile"] as const)("rejects an unapproved processor %s", async field => {
    const f = fixture(); f.options.approvedProcessor[field] = "different";
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
    expect(f.processor.decode).not.toHaveBeenCalled();
  });
  it.each([new Uint8Array(), new Uint8Array([0, 1, 2]), new Uint8Array(SEAL_LIMITS.maxBytes + 1)])("rejects unsupported/oversize source %# before decode", async source => {
    const f = fixture(); f.input.source = source; f.input.source_sha256 = sha(source);
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA" });
    expect(f.processor.inspect).not.toHaveBeenCalled(); expect(f.processor.decode).not.toHaveBeenCalled();
  });
  it("rejects source digest mismatch before processing", async () => {
    const f = fixture(); f.input.source_sha256 = "a".repeat(64);
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
    expect(f.processor.inspect).not.toHaveBeenCalled();
  });
  it.each(["jpeg", "png", "webp"] as const)("rejects animated/multipage %s at preflight", async format => {
    const f = fixture(format); f.inspected.frames = 2;
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA" });
    expect(f.processor.decode).not.toHaveBeenCalled();
  });
  it.each([[8001, 10], [10, 8001], [9000, 9000], [0, 100], [1.5, 100], [NaN, 100]])("rejects invalid/oversize dimensions %s x %s before full decode", async (width, height) => {
    const f = fixture(); Object.assign(f.inspected, { width, height });
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA" });
    expect(f.processor.decode).not.toHaveBeenCalled();
  });
  it("allows exactly 8000 axes and 64 megapixels without canonical resize", async () => {
    const bundle = await prepared(fixture("webp", 1, 8000, 8000));
    expect(bundle.media.canonical).toMatchObject({ width: 8000, height: 8000 });
  });
  it("rejects corrupt containers via the trusted processor without echoing its details", async () => {
    const f = fixture(); f.processor.inspect.mockRejectedValueOnce(new ImageProcessingError("UNSUPPORTED_MEDIA"));
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA" });
  });
  it.each(["frames", "orientationApplied", "metadataRemoved", "width", "sourceSha256"])("rejects inconsistent decoded %s and releases the frame", async field => {
    const f = fixture();
    Object.assign(f.decoded, { [field]: field === "frames" ? 2 : field === "width" ? 10 : field === "sourceSha256" ? "a".repeat(64) : false });
    expect((await prepareImageSeal(f.input, f.options)).ok).toBe(false);
    expect(f.processor.release).toHaveBeenCalledExactlyOnceWith(f.frame);
    expect(f.processor.render).not.toHaveBeenCalled();
  });
  it.each(["hasMetadata", "orientation", "frames", "width", "format"])("rejects output with incorrect %s", async field => {
    const f = fixture();
    const original = f.processor.inspect.getMockImplementation()!;
    f.processor.inspect.mockImplementation(async data => {
      const inspected = await original(data);
      return sha(data) === f.input.source_sha256 ? inspected : { ...inspected,
        [field]: field === "hasMetadata" ? true : field === "format" ? "png" : 2 };
    });
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
    expect(f.processor.release).toHaveBeenCalledTimes(1);
  });
  it("rejects a renderer that returns an unrelated frame", async () => {
    const f = fixture(); f.processor.render.mockResolvedValueOnce({ frame: {}, bytes: bytes("webp", 1) });
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
  });
  it.each([new Uint8Array(), new Uint8Array([1, 2, 3]), new Uint8Array(SEAL_LIMITS.maxBytes + 1)])("rejects empty/invalid/oversize canonical output %# without downscaling or retry", async output => {
    const f = fixture(); f.processor.render.mockResolvedValueOnce({ frame: f.frame, bytes: output });
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA" });
    expect(f.processor.render).toHaveBeenCalledTimes(1);
  });
  it.each(["listing_id", "generation_id", "media_id", "created_at", "display_order", "listing_revision"])("rejects invalid identity %s", async field => {
    const f = fixture(); Object.assign(f.input, { [field]: field.endsWith("order") || field.endsWith("revision") ? -1 : "invalid" });
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
    expect(f.processor.inspect).not.toHaveBeenCalled();
  });
  it.each(["duplicate", "invalid"])("rejects %s allocated identifiers", async mode => {
    const f = fixture(); f.options.newUuid.mockReturnValue(mode === "duplicate" ? uuid(20) : "invalid");
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
    expect(f.processor.release).toHaveBeenCalledTimes(1);
  });
  it.each(["inspect", "decode", "render", "release"] as const)("sanitizes thrown %s failures and never returns a partial bundle", async stage => {
    const f = fixture(); f.processor[stage].mockRejectedValueOnce(new Error("synthetic private bytes and credentials"));
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
    expect(f.processor.release).toHaveBeenCalledTimes(stage === "inspect" || stage === "decode" ? 0 : 1);
  });
  it.each([0, Infinity, 120001])("rejects invalid timeout %s", async timeoutMs => {
    const f = fixture(); f.options.timeoutMs = timeoutMs;
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
    expect(f.processor.inspect).not.toHaveBeenCalled();
  });
  it("bounds stalled rendering, aborts, and stops subsequent variants", async () => {
    vi.useFakeTimers(); const f = fixture(); f.options.timeoutMs = 10;
    let started!: () => void;
    let finish!: (value: Awaited<ReturnType<ImageProcessor["render"]>>) => void;
    const rendering = new Promise<void>(resolve => { started = resolve; });
    f.processor.render.mockImplementationOnce(async () => {
      started();
      return new Promise(resolve => { finish = resolve; });
    });
    const result = prepareImageSeal(f.input, f.options);
    await rendering;
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual({ ok: false, code: "TIMEOUT" });
    expect(f.processor.render.mock.calls[0][2].signal.aborted).toBe(true);
    expect(f.processor.render).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    finish({ frame: f.frame, bytes: bytes("webp", 1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.processor.release).toHaveBeenCalledExactlyOnceWith(f.frame);
    expect(f.processor.render).toHaveBeenCalledTimes(1);
  });
  it.each(["canonical", "thumb", "medium", "large"] as const)("rejects metadata retained in %s", async variant => {
    const f = fixture();
    const render = f.processor.render.getMockImplementation()!;
    f.processor.render.mockImplementation(async (frame, request, operation) => {
      const result = await render(frame, request, operation);
      if (request.variant === variant) f.outputInspections.get(sha(result.bytes))!.hasMetadata = true;
      return result;
    });
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
  });
  it.each(["canonical", "thumb", "medium", "large"] as const)("rejects unrelated frame lineage in %s", async variant => {
    const f = fixture();
    const render = f.processor.render.getMockImplementation()!;
    f.processor.render.mockImplementation(async (frame, request, operation) => {
      const result = await render(frame, request, operation);
      return request.variant === variant ? { ...result, frame: {} } : result;
    });
    expect(await prepareImageSeal(f.input, f.options)).toEqual({ ok: false, code: "SEAL_INVALID" });
  });
  it("preserves an original exactly at the 5-MiB limit", async () => {
    const f = fixture();
    const source = new Uint8Array(SEAL_LIMITS.maxBytes); source.set(f.input.source);
    f.input.source = source; f.input.source_sha256 = sha(source); f.decoded.sourceSha256 = sha(source);
    f.processor.inspect.mockResolvedValueOnce({ ...f.inspected });
    const bundle = await prepared(f);
    expect(bundle.media.original.bytes).toBe(SEAL_LIMITS.maxBytes);
    expect(bundle.objects.original.bytes.length).toBe(source.length);
    expect(bundle.objects.original.bytes.every((byte, i) => byte === source[i])).toBe(true);
  });
  it("allows canonical bytes exactly at the 5-MiB limit without resizing", async () => {
    const f = fixture();
    const render = f.processor.render.getMockImplementation()!;
    f.processor.render.mockImplementationOnce(async (frame, request, operation) => {
      const rendered = await render(frame, request, operation);
      const output = new Uint8Array(SEAL_LIMITS.maxBytes); output.set(rendered.bytes);
      f.outputInspections.set(sha(output), f.outputInspections.get(sha(rendered.bytes))!);
      return { frame, bytes: output };
    });
    const bundle = await prepared(f);
    expect(bundle.media.canonical).toMatchObject({ bytes: SEAL_LIMITS.maxBytes, width: 2400, height: 1600 });
  });
  it("isolates the original source from decoder mutations", async () => {
    const f = fixture(); const before = new Uint8Array(f.input.source);
    f.processor.decode.mockImplementationOnce(async () => {
      f.input.source[0] = 0;
      return { ...f.decoded };
    });
    const bundle = await prepared(f);
    expect(bundle.objects.original.bytes).toEqual(before);
    expect(bundle.media.original.sha256).toBe(sha(before));
  });
  it.each(["missing", "duplicate", "bucket", "key", "contentType", "bytes", "expected bytes"])("rejects %s readback discrepancy", async change => {
    const bundle = await prepared(fixture()); const readbacks = downloads(bundle);
    if (change === "missing") readbacks.pop();
    if (change === "duplicate") readbacks[1] = readbacks[0];
    if (change === "bucket") readbacks[0].bucket = "listing-derivatives";
    if (change === "key") readbacks[0].key += "-changed";
    if (change === "contentType") readbacks[0].contentType = "image/png";
    if (change === "bytes") readbacks[0].bytes[0] = 0;
    if (change === "expected bytes") bundle.objects.original.bytes[0] = 0;
    expect((await verifyImageSealReadback(bundle, readbacks)).ok).toBe(false);
  });
  it.each(["object identity", "recipe digest", "processor profile", "write policy"])("rejects a prepared bundle with changed %s", async change => {
    const bundle = await prepared(fixture());
    const readbacks = downloads(bundle);
    if (change === "object identity") bundle.objects.canonical.object_id = uuid(999);
    if (change === "recipe digest") bundle.recipe_sha256 = "a".repeat(64);
    if (change === "processor profile") bundle.processor = { ...bundle.processor, encoderProfile: "changed" };
    if (change === "write policy") Object.assign(bundle.objects.canonical, { writeOptions: { upsert: true } });
    expect(await verifyImageSealReadback(bundle, readbacks)).toEqual({ ok: false, code: "SEAL_INVALID" });
  });
  it.each(["seal_v2", "", undefined, null])("rejects unsupported/missing media recipe %# with otherwise matching bytes and recipe hash", async recipe => {
    const bundle = await prepared(fixture());
    const readbacks = downloads(bundle);
    Object.assign(bundle.media, { recipe });
    expect(await verifyImageSealReadback(bundle, readbacks)).toEqual({ ok: false, code: "SEAL_INVALID" });
  });
  it("accepts matching downloads without write-policy fields and reports byte identity only", async () => {
    const bundle = await prepared(fixture());
    const readbacks = downloads(bundle);
    expect(readbacks.every(o => !Object.hasOwn(o, "writeOptions"))).toBe(true);
    expect(await verifyImageSealReadback(bundle, readbacks)).toEqual(byteIdentityOnly);
  });
  it.each([false, true])("does not promote downloaded upsert=%s or immutability claims to trusted evidence", async upsert => {
    const bundle = await prepared(fixture());
    const readbacks = downloads(bundle);
    for (const readback of readbacks) Object.assign(readback, {
      writeOptions: { upsert }, create_only_writes: "verified", storage_immutability: "verified", trusted: true,
    });
    expect(await verifyImageSealReadback(bundle, readbacks)).toEqual(byteIdentityOnly);
  });
  it("does not let forged downloaded write evidence bypass a byte mismatch", async () => {
    const bundle = await prepared(fixture());
    const readbacks = downloads(bundle);
    Object.assign(readbacks[1], { writeOptions: { upsert: false }, storage_immutability: "verified" });
    readbacks[1].bytes[12] ^= 1;
    expect(await verifyImageSealReadback(bundle, readbacks)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
  });
  it("a successful comparison is point-in-time evidence and never certifies future object immutability", async () => {
    const bundle = await prepared(fixture());
    const readbacks = downloads(bundle);
    const before = await verifyImageSealReadback(bundle, readbacks);
    expect(before).toEqual(byteIdentityOnly);
    readbacks[1].bytes[12] ^= 1;
    expect(await verifyImageSealReadback(bundle, readbacks)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
    expect(before).toMatchObject({ create_only_writes: "unverified", storage_immutability: "unverified" });
  });
});
