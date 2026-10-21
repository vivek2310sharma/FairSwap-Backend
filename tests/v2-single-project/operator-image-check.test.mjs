import test from "node:test";
import assert from "node:assert/strict";
import { invokeShadow, parseShadowCommand } from "../../scripts/moderation/v2-shadow-invoke.mjs";

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.not_real_signature_123456789";
const expectedEndpoint = "https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/moderation-v2-image-shadow-probe";
const okBody = {
  code: "OPENAI_IMAGE_MODERATION_CONNECTED",
  authority: "SYNTHETIC_CONNECTIVITY_ONLY",
  scope: "BENIGN_SYNTHETIC_IMAGE_NOT_LISTING_REVIEW",
  model: "omni-moderation-2024-09-26",
  provider: "clear",
};

function fakeResponse(body, status = 200, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
  };
}
const env = name => name === "SUPABASE_SERVICE_ROLE_KEY" ? jwt : undefined;

test("image-check accepts only exact no-listing operator command", () => {
  assert.deepEqual(parseShadowCommand(["image-check"]), {
    mode: "image-check", body: { probe: "synthetic_connectivity" },
  });
  for (const args of [["image-check", "123"], ["image-check", "--url"], ["image-check", "listing", "media"]]) {
    assert.equal(parseShadowCommand(args), null);
  }
});

test("image-check posts synthetic bytes request to pinned Production endpoint only", async () => {
  const calls = [];
  const result = await invokeShadow(["image-check"], {
    getEnv: env,
    fetcher: fakeResponse({ ...okBody, injectedSecrets: "private data" }, 200, calls),
  });
  assert.deepEqual(result, {
    ok: true,
    mode: "image-check",
    connected: true,
    authority: "SYNTHETIC_CONNECTIVITY_ONLY",
    model: "omni-moderation-2024-09-26",
    provider: "clear",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, expectedEndpoint);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + jwt);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.deepEqual(JSON.parse(calls[0].options.body), { probe: "synthetic_connectivity" });
  assert.ok(!JSON.stringify(result).includes(jwt));
  assert.ok(!JSON.stringify(result).includes("private data"));
});

test("image-check rejects provider failure but never echoes raw provider output", async () => {
  const error = await invokeShadow(["image-check"], {
    getEnv: env,
    fetcher: fakeResponse({
      code: "OPENAI_IMAGE_MODERATION_CHECK_FAILED",
      authority: "SYNTHETIC_CONNECTIVITY_ONLY",
      reason: "PROVIDER_AUTH",
      providerRawMessage: "never echo",
    }, 503),
  });
  assert.deepEqual(error, { ok: false, code: "PROVIDER_CHECK_FAILED", reason: "PROVIDER_AUTH" });
  const notConfigured = await invokeShadow(["image-check"], {
    getEnv: env,
    fetcher: fakeResponse({ code: "OPENAI_NOT_CONFIGURED" }, 503),
  });
  assert.deepEqual(notConfigured, { ok: false, code: "OPENAI_NOT_CONFIGURED" });
  const forged = await invokeShadow(["image-check"], {
    getEnv: env,
    fetcher: fakeResponse({
      code: "OPENAI_IMAGE_MODERATION_CHECK_FAILED",
      authority: "SYNTHETIC_CONNECTIVITY_ONLY",
      reason: "PRIVATE_SERVER_KEY",
    }, 503),
  });
  assert.deepEqual(forged, { ok: false, code: "SHADOW_UNAVAILABLE", status: 503 });
  assert.ok(!JSON.stringify(error).includes("never echo"));
});

test("image-check rejects forged success codes, scope, provider or model", async () => {
  for (const bad of [
    { ...okBody, code: "OPENAI_MODERATION_CONNECTED" },
    { ...okBody, scope: "FULL_LISTING_APPROVAL" },
    { ...okBody, authority: "PUBLISH_LISTING" },
    { ...okBody, provider: "approved" },
    { ...okBody, model: "unapproved-model" },
  ]) {
    assert.deepEqual(await invokeShadow(["image-check"], {
      getEnv: env, fetcher: fakeResponse(bad),
    }), { ok: false, code: "INVALID_RESPONSE" });
  }
});

test("image-check refuses missing/invalid service JWT without provider or listing IO", async () => {
  let networkCalls = 0;
  for (const secret of ["", "sb_secret_abcdef", undefined]) {
    const result = await invokeShadow(["image-check"], {
      getEnv: () => secret,
      fetcher: async () => { networkCalls++; throw Error("not called"); },
    });
    assert.deepEqual(result, { ok: false, code: "SERVICE_ROLE_JWT_NOT_CONFIGURED" });
  }
  assert.equal(networkCalls, 0);
});
