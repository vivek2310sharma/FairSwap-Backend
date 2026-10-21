import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  invokeShadow,
  parseShadowCommand,
} from "../../scripts/moderation/v2-shadow-invoke.mjs";

const listingId = randomUUID(), mediaId = randomUUID();
const secretJwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.not_real_signature_123456789";
const hash = "a".repeat(64);

function fakeFetcher(response, status = 200, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
const getEnv = key => key === "SUPABASE_SERVICE_ROLE_KEY" ? secretJwt : undefined;

function imageResult(overrides = {}) {
  return {
    code: "SHADOW_IMAGE_ONLY",
    result: {
      authority: "SHADOW_IMAGE_ONLY_NEVER_PUBLISH",
      listingId, mediaId,
      route: "image_no_harm_flags",
      stale: false,
      sampleSha256: hash,
      scope: "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE",
      source: "LEGACY_MEDIUM_WEBP_UNSEALED",
      imageReview: "HARM_CATEGORIES_ONLY_NOT_MARKETPLACE_FRAUD",
      harmCategories: [],
      ...overrides,
    },
  };
}

test("parses only strict text/image commands and exact UUIDs", () => {
  assert.deepEqual(parseShadowCommand(["text", listingId]), {
    mode: "text", body: { listingId },
  });
  assert.deepEqual(parseShadowCommand(["image", listingId, mediaId]), {
    mode: "image", body: { listingId, mediaId },
  });
  for (const args of [
    [], ["image", listingId], ["image", listingId, mediaId, "ignore"],
    ["text", listingId, mediaId], ["delete", listingId],
    ["text", "not-valid"], ["image", listingId, "../media.webp"],
  ]) assert.equal(parseShadowCommand(args), null);
});

test("only pinned Production endpoint receives service-role bearer", async () => {
  const calls = [];
  const out = await invokeShadow(["image", listingId, mediaId], {
    fetcher: fakeFetcher(imageResult(), 200, calls),
    getEnv,
  });
  assert.equal(out.ok, true);
  assert.equal(out.authority, "SHADOW_IMAGE_ONLY_NEVER_PUBLISH");
  assert.equal(out.sampleSha256, hash);
  assert.equal(out.route, "image_no_harm_flags");
  assert.equal(out.stale, false);
  assert.equal(out.scope, "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url,
    "https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/moderation-v2-image-shadow-probe");
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + secretJwt);
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].options.body), { listingId, mediaId });
  assert.ok(!JSON.stringify(out).includes(secretJwt));
});

test("text operator call keeps image status explicitly not performed", async () => {
  const out = await invokeShadow(["text", listingId], {
    getEnv,
    fetcher: fakeFetcher({
      code: "SHADOW_TEXT_ONLY",
      result: {
        authority: "SHADOW_TEXT_ONLY_NEVER_PUBLISH", listingId,
        route: "review", stale: false,
        imageModeration: "NOT_PERFORMED",
        indiaFraudSignals: ["OTP_PIN"],
        harmCategories: ["violence"],
        description: "private user text that must never appear",
      },
    }),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.indiaFraudSignals, ["OTP_PIN"]);
  assert.equal(out.imageModeration, "NOT_PERFORMED");
  assert.ok(!JSON.stringify(out).includes("private user text"));
});

test("rejects absent secrets and malformed JWT before any network call", async () => {
  let calls = 0;
  for (const token of [undefined, "", "public_anon_key", "very_long_but_not_a_valid_jwt"]) {
    const out = await invokeShadow(["text", listingId], {
      getEnv: () => token,
      fetcher: async () => { calls++; throw Error("never"); },
    });
    assert.deepEqual(out, { ok: false, code: "SERVICE_ROLE_JWT_NOT_CONFIGURED" });
  }
  assert.equal(calls, 0);
});

test("malformed responses, wrong media and untrusted authority fail closed", async () => {
  for (const forged of [
    imageResult({ authority: "APPROVED" }),
    imageResult({ mediaId: randomUUID() }),
    imageResult({ sampleSha256: "bad-digest" }),
    imageResult({ scope: "FULL_COVERAGE" }),
    imageResult({ source: "SEALED_IMAGE" }),
    imageResult({ route: "approve" }),
    imageResult({ stale: "false" }),
  ]) {
    const out = await invokeShadow(["image", listingId, mediaId], {
      getEnv, fetcher: fakeFetcher(forged),
    });
    assert.deepEqual(out, { ok: false, code: "INVALID_RESPONSE" });
  }
});

test("provider/API failures never surface raw HTTP body or secrets", async () => {
  const out = await invokeShadow(["text", listingId], {
    getEnv,
    fetcher: fakeFetcher({ error: "provider exception and seller data" }, 503),
  });
  assert.deepEqual(out, { ok: false, code: "SHADOW_UNAVAILABLE", status: 503 });
  assert.ok(!JSON.stringify(out).includes("seller data"));
  const broken = await invokeShadow(["text", listingId], {
    getEnv,
    fetcher: async () => { throw Error("private key logged here? no"); },
  });
  assert.deepEqual(broken, { ok: false, code: "NETWORK_OR_TIMEOUT" });
});
