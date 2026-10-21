import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleImageShadowRequest } from "../../supabase/functions/moderation-v2-image-shadow-probe/index.ts";
import {
  isSyntheticImageConnectivityRequest,
  runSyntheticImageConnectivity,
} from "../../src/lib/moderation/v2/synthetic-image-connectivity.ts";

const secret = "s".repeat(96);
const env = Object.freeze({
  SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: secret,
  OPENAI_API_KEY: "sk-test-not-a-real-api-key-000000000000",
});
const model = "omni-moderation-2024-09-26";
const expectedSha = "866a9ba5828a55c5ea2c0b581f9795906669be3ffa181cfc9fd4b40f2b61f080";
function fixtureRuntime(overrides = {}) {
  const calls = { provider: 0, db: 0, storage: 0 };
  const runtime = {
    getEnv: key => env[key],
    loadSnapshot: async () => { calls.db++; throw Error("unexpected DB read"); },
    readMedium: async () => { calls.storage++; throw Error("unexpected Storage read"); },
    moderateImage: async (bytes, sha) => {
      calls.provider++;
      assert.equal(bytes.length, 376);
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "RIFF");
      assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), "WEBP");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
      assert.equal(sha, expectedSha);
      return { state: "clear", model, categoryFlags: {} };
    },
    ...overrides,
  };
  return { calls, runtime };
}
function request(body = { probe: "synthetic_connectivity" }, auth = secret) {
  return new Request("https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/moderation-v2-image-shadow-probe", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("image synthetic probe is exact-shape only and uses a pinned valid WebP", async () => {
  assert.equal(isSyntheticImageConnectivityRequest({ probe: "synthetic_connectivity" }), true);
  assert.equal(isSyntheticImageConnectivityRequest({ probe: "synthetic_connectivity", listingId: "forged" }), false);
  assert.equal(isSyntheticImageConnectivityRequest(null), false);
  const { calls, runtime } = fixtureRuntime();
  const response = await handleImageShadowRequest(request(), runtime);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.deepEqual(result, {
    code: "OPENAI_IMAGE_MODERATION_CONNECTED",
    authority: "SYNTHETIC_CONNECTIVITY_ONLY",
    scope: "BENIGN_SYNTHETIC_IMAGE_NOT_LISTING_REVIEW",
    model,
    provider: "clear",
  });
  assert.equal(calls.provider, 1);
  assert.equal(calls.db, 0);
  assert.equal(calls.storage, 0);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("image synthetic probe cannot bypass service role, project check or OpenAI config", async () => {
  const { calls, runtime } = fixtureRuntime();
  const unauth = await handleImageShadowRequest(request(undefined, "wrong"), runtime);
  assert.equal(unauth.status, 401);
  assert.equal((await unauth.json()).code, "UNAUTHORIZED");
  const other = await handleImageShadowRequest(request(), {
    ...runtime,
    getEnv: key => key === "SUPABASE_URL" ? "https://other-project.supabase.co" : env[key],
  });
  assert.equal(other.status, 503);
  assert.equal((await other.json()).code, "PRODUCTION_TARGET_REQUIRED");
  const missing = await handleImageShadowRequest(request(), {
    ...runtime,
    getEnv: key => key === "OPENAI_API_KEY" ? undefined : env[key],
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "OPENAI_NOT_CONFIGURED");
  assert.equal(calls.provider, 0);
  assert.equal(calls.db, 0);
  assert.equal(calls.storage, 0);
});

test("image provider failures or unexpected model return only sanitized 503", async () => {
  const unavailable = fixtureRuntime({
    moderateImage: async () => ({ state: "failed", reason: "PROVIDER_AUTH" }),
  });
  const denied = await handleImageShadowRequest(request(), unavailable.runtime);
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), {
    code: "OPENAI_IMAGE_MODERATION_CHECK_FAILED",
    authority: "SYNTHETIC_CONNECTIVITY_ONLY",
    reason: "PROVIDER_AUTH",
  });
  const mismatch = await handleImageShadowRequest(request(), fixtureRuntime({
    moderateImage: async () => ({ state: "clear", model: "unexpected-model", categoryFlags: {} }),
  }).runtime);
  assert.equal(mismatch.status, 503);
  assert.equal((await mismatch.json()).reason, "PROVIDER_SCHEMA");
  const thrown = await runSyntheticImageConnectivity(async () => { throw Error("private provider details"); });
  assert.deepEqual(thrown, { ok: false, reason: "PROVIDER_UNAVAILABLE" });
});

test("synthetic payload with listing or untrusted fields never reads DB or provider", async () => {
  const { calls, runtime } = fixtureRuntime();
  for (const body of [
    { probe: "synthetic_connectivity", listingId: "attacker" },
    { probe: "synthetic_connectivity", url: "https://example.invalid" },
    { probe: "other" },
  ]) {
    const response = await handleImageShadowRequest(request(body), runtime);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  assert.equal(calls.db, 0);
  assert.equal(calls.storage, 0);
  assert.equal(calls.provider, 0);
});
