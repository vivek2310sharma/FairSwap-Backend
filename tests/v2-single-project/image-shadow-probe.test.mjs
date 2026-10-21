import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  isMetadataFreeStaticWebp,
  runImageShadowProbe,
} from "../../src/lib/moderation/v2/image-shadow-probe.ts";
import {
  handleImageShadowRequest,
} from "../../supabase/functions/moderation-v2-image-shadow-probe/index.ts";

const listingId = randomUUID();
const mediaId = randomUUID();
// Unit tests simulate the already JWT-verified Supabase gateway; signature
// authenticity is enforced separately by deployed verify_jwt=true.
const secret = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
  Buffer.from(JSON.stringify({
    role: "service_role",
    ref: "kriuhwppxgxsyyrbjsau",
    iat: 1700000000,
    exp: 1950000000,
  })).toString("base64url"),
  "s".repeat(43),
].join(".");
const prodEnv = {
  SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: secret,
  OPENAI_API_KEY: "sk-test-not-a-real-api-key-000000000000",
};

function structuralWebp() {
  // A structural RIFF/WEBP fixture, not decoded pixels; the live provider
  // must independently decode the real WebP and may reject malformed pixels.
  const bytes = new Uint8Array(22);
  bytes.set([82,73,70,70,14,0,0,0,87,69,66,80,86,80,56,32,2,0,0,0,1,2]);
  return bytes;
}
const goodWebp = structuralWebp();
const sha = b => createHash("sha256").update(b).digest("hex");
const prefix = listingId + "/" + mediaId + "/";

function snapshot(changes = {}) {
  const s = {
    listing: {
      id: listingId,
      status: "pending_review",
      revision: 3,
      updated_at: "2026-10-21T16:25:00+00:00",
    },
    media: {
      id: mediaId,
      listing_id: listingId,
      original_storage_path: prefix + "original.jpg",
      thumbnail_storage_path: prefix + "thumb.webp",
      medium_storage_path: prefix + "medium.webp",
      large_storage_path: prefix + "large.webp",
      processing_status: "ready",
      display_order: 0,
      created_at: "2026-10-21T16:00:00+00:00",
    },
  };
  return {
    listing: { ...s.listing, ...(changes.listing ?? {}) },
    media: { ...s.media, ...(changes.media ?? {}) },
  };
}

const clear = { state: "clear", model: "omni-moderation-2024-09-26", categoryFlags: {} };

function makeDeps(overrides = {}) {
  const calls = { db: 0, storage: [], moderation: [] };
  const deps = {
    async loadSnapshot() {
      calls.db++;
      return snapshot();
    },
    async readMedium(key) {
      calls.storage.push(key);
      return Uint8Array.from(goodWebp);
    },
    async moderateImage(bytes, digest) {
      calls.moderation.push({ bytes: Uint8Array.from(bytes), digest });
      return clear;
    },
    ...overrides,
  };
  return { calls, deps };
}
function runtime(overrides = {}) {
  const { calls, deps } = makeDeps();
  return {
    calls,
    deps: {
      ...deps,
      getEnv: key => prodEnv[key],
      ...overrides,
    },
  };
}
function request(input = { listingId, mediaId }, overrides = {}) {
  return new Request("https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/moderation-v2-image-shadow-probe", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
      ...(overrides.headers ?? {}),
    },
    body: overrides.rawBody ?? JSON.stringify(input),
  });
}
async function probe(deps = makeDeps().deps) {
  return runImageShadowProbe({ listingId, mediaId }, deps);
}

test("single-image free review reports honest unsealed source and never publishes", async () => {
  const { calls, deps } = makeDeps();
  const result = await probe(deps);
  assert.equal(result.ok, true);
  assert.equal(result.authority, "SHADOW_IMAGE_ONLY_NEVER_PUBLISH");
  assert.equal(result.source, "LEGACY_MEDIUM_WEBP_UNSEALED");
  assert.equal(result.scope, "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE");
  assert.equal(result.imageReview, "HARM_CATEGORIES_ONLY_NOT_MARKETPLACE_FRAUD");
  assert.equal(result.route, "image_no_harm_flags");
  assert.equal(result.sameBytesOnSecondRead, true);
  assert.equal(result.stale, false);
  assert.equal(result.sampleSha256, sha(goodWebp));
  assert.equal(result.sampleBytes, goodWebp.byteLength);
  assert.deepEqual(calls.storage, [prefix + "medium.webp", prefix + "medium.webp"]);
  assert.equal(calls.db, 2);
  assert.equal(calls.moderation.length, 1);
  assert.equal(calls.moderation[0].digest, sha(goodWebp));
  assert.equal("approved" in result, false);
  assert.equal("published" in result, false);
});

test("harmful image routes to review and only returns flagged harm categories", async () => {
  const { deps } = makeDeps({
    moderateImage: async () => ({
      state: "flagged",
      model: "omni-moderation-2024-09-26",
      categoryFlags: { violence: true, sexual: false },
    }),
  });
  const result = await probe(deps);
  assert.equal(result.ok, true);
  assert.equal(result.route, "review");
  assert.deepEqual(result.harmCategories, ["violence"]);
});

test("free provider error never results in clean image or approval", async () => {
  const result = await probe(makeDeps({
    moderateImage: async () => { throw Error("private provider diagnostics"); },
  }).deps);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "failed");
  assert.equal(result.route, "retry");
  assert.ok(!JSON.stringify(result).includes("private provider diagnostics"));
});

test("same-path physical overwrite between OpenAI and re-read produces stale retry", async () => {
  let n = 0;
  const { deps } = makeDeps({
    readMedium: async () => {
      n++;
      const bytes = Uint8Array.from(goodWebp);
      if (n === 2) bytes[bytes.length - 1] ^= 1;
      return bytes;
    },
  });
  const result = await probe(deps);
  assert.equal(result.ok, true);
  assert.equal(result.sameBytesOnSecondRead, false);
  assert.equal(result.stale, true);
  assert.equal(result.route, "retry");
});

test("listing revision, status and changed source path after evaluation produce stale retry", async () => {
  for (const changes of [
    { listing: { revision: 4 } },
    { listing: { updated_at: "2026-10-21T17:00:00+00:00" } },
    { listing: { status: "removed" } },
    { media: { display_order: 1 } },
    { media: { original_storage_path: prefix + "original.png" } },
    { media: { processing_status: "error" } },
    { media: { medium_storage_path: prefix + "v2/forged/medium.webp" } },
  ]) {
    let i = 0;
    const { deps } = makeDeps({
      loadSnapshot: async () => (++i === 1 ? snapshot() : snapshot(changes)),
    });
    const result = await probe(deps);
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.equal(result.route, "retry");
  }
});

test("unexpected/mixed V2 or cross-listing keys never reach Storage or OpenAI", async () => {
  for (const changes of [
    { media: { medium_storage_path: prefix + "v2/other/medium.webp" } },
    { media: { original_storage_path: prefix + "v2/another/original.jpg" } },
    { media: { thumbnail_storage_path: "elsewhere/thumb.webp" } },
    { media: { large_storage_path: prefix + "large.webp/other" } },
    { media: { processing_status: "failed" } },
    { listing: { status: "removed" } },
  ]) {
    const { calls, deps } = makeDeps({
      loadSnapshot: async () => snapshot(changes),
    });
    const result = await probe(deps);
    assert.deepEqual(result, { ok: false, code: "UNSUPPORTED_SOURCE" });
    assert.equal(calls.storage.length, 0);
    assert.equal(calls.moderation.length, 0);
  }
});

test("invalid IDs, extra request fields and foreign media identities never trigger reads", async () => {
  const { calls, deps } = makeDeps();
  for (const payload of [
    { listingId: "not-a-uuid", mediaId },
    { listingId, mediaId: "not-a-uuid" },
    { listingId, mediaId, key: "attacker-selected-storage-url" },
    { listingId, mediaId, sha256: "a".repeat(64) },
  ]) {
    assert.deepEqual(await runImageShadowProbe(payload, deps),
      { ok: false, code: "INVALID_REQUEST" });
  }
  assert.equal(calls.db, 0);
  assert.equal(calls.storage.length, 0);
  assert.equal(calls.moderation.length, 0);
  const wrong = makeDeps({
    loadSnapshot: async () => snapshot({ media: { id: randomUUID() } }),
  });
  assert.deepEqual(await probe(wrong.deps), { ok: false, code: "NOT_FOUND" });
  assert.equal(wrong.calls.moderation.length, 0);
});

test("WebP container check allows only static image chunks without metadata", () => {
  assert.equal(isMetadataFreeStaticWebp(goodWebp), true);
  assert.equal(isMetadataFreeStaticWebp(new Uint8Array(0)), false);
  const changedSize = Uint8Array.from(goodWebp);
  changedSize[4] = 30;
  assert.equal(isMetadataFreeStaticWebp(changedSize), false);
  const exif = Uint8Array.from(goodWebp);
  exif.set([69, 88, 73, 70], 12);
  assert.equal(isMetadataFreeStaticWebp(exif), false);
  const animation = Uint8Array.from(goodWebp);
  animation.set([65, 78, 73, 77], 12);
  assert.equal(isMetadataFreeStaticWebp(animation), false);
  const unknown = Uint8Array.from(goodWebp);
  unknown.set([66, 65, 68, 33], 12);
  assert.equal(isMetadataFreeStaticWebp(unknown), false);
});

test("tampered RIFF and malformed WebP bytes are rejected BEFORE calling OpenAI", async () => {
  const { calls, deps } = makeDeps({
    readMedium: async () => Uint8Array.from([1,2,3,4,5,6,7,8]),
  });
  assert.deepEqual(await probe(deps), { ok: false, code: "INVALID_WEBP" });
  assert.equal(calls.moderation.length, 0);
});

test("Storage unavailable on first fetch rejects; unavailable on second fetch retries", async () => {
  const noSource = makeDeps({ readMedium: async () => { throw Error("storage private"); } });
  assert.deepEqual(await probe(noSource.deps), { ok: false, code: "STORAGE_UNAVAILABLE" });
  const late = makeDeps({
    readMedium: async () => {
      if (!late._first) { late._first = true; return goodWebp; }
      throw Error("storage unavailable");
    },
  });
  const result = await probe(late.deps);
  assert.equal(result.ok, true);
  assert.equal(result.route, "retry");
  assert.equal(result.sameBytesOnSecondRead, false);
});

test("JWT+service-role gate stops unauthorized callers before DB or provider", async () => {
  const { calls, deps } = runtime();
  const result = await handleImageShadowRequest(
    request(undefined, { headers: { authorization: "Bearer stolen" } }),
    deps,
  );
  assert.equal(result.status, 401);
  assert.equal((await result.json()).code, "UNAUTHORIZED");
  assert.equal(calls.db, 0);
  assert.equal(calls.moderation.length, 0);
});

test("wrong project or missing OpenAI secret fail before any DB read", async () => {
  const { calls, deps } = runtime();
  const wrong = await handleImageShadowRequest(request(), {
    ...deps,
    getEnv: key => key === "SUPABASE_URL"
      ? "https://another-project.supabase.co" : prodEnv[key],
  });
  assert.equal(wrong.status, 503);
  assert.equal((await wrong.json()).code, "PRODUCTION_TARGET_REQUIRED");
  const missing = await handleImageShadowRequest(request(), {
    ...deps,
    getEnv: key => key === "OPENAI_API_KEY" ? undefined : prodEnv[key],
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "OPENAI_NOT_CONFIGURED");
  assert.equal(calls.db, 0);
});

test("POST with legitimate secrets returns no-store sanitized data", async () => {
  const { calls, deps } = runtime();
  const response = await handleImageShadowRequest(request(), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json();
  assert.equal(payload.code, "SHADOW_IMAGE_ONLY");
  assert.equal(payload.result.route, "image_no_harm_flags");
  assert.equal(payload.result.sampleSha256, sha(goodWebp));
  assert.equal(payload.result.scope, "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE");
  assert.ok(!JSON.stringify(payload).includes(secret));
  assert.equal(calls.moderation.length, 1);
});

test("oversized body, invalid JSON, wrong HTTP method or content type cannot read DB", async () => {
  const { calls, deps } = runtime();
  const invalid = await handleImageShadowRequest(
    request(null, { rawBody: "{invalid" }), deps,
  );
  assert.equal(invalid.status, 400);
  const huge = await handleImageShadowRequest(
    request(null, { rawBody: "x".repeat(900) }), deps,
  );
  assert.equal(huge.status, 400);
  const contentType = await handleImageShadowRequest(
    request(null, { headers: { "content-type": "text/plain" } }), deps,
  );
  assert.equal(contentType.status, 415);
  const get = await handleImageShadowRequest(
    new Request("https://fairswap.in/functions/v1/moderation-v2-image-shadow-probe", {
      method: "GET",
    }),
    deps,
  );
  assert.equal(get.status, 405);
  assert.equal(calls.db, 0);
  assert.equal(calls.moderation.length, 0);
});
