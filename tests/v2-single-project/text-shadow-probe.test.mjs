import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runTextShadowProbe } from "../../src/lib/moderation/v2/text-shadow-probe.ts";
import { handleTextShadowProbeRequest } from "../../supabase/functions/moderation-v2-text-shadow-probe/index.ts";

const id = randomUUID();
const secret = "j".repeat(96);
const env = Object.freeze({
  SUPABASE_SERVICE_ROLE_KEY: secret,
  SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
  OPENAI_API_KEY: "sk-test-not-a-real-api-key-000000000000",
});

const listing = (changes = {}) => ({
  id,
  title: "Selling a used iPhone",
  description: "Available in Bengaluru, inspection welcome",
  status: "pending_review",
  revision: 7,
  updated_at: "2026-10-21T15:00:00+00:00",
  ...changes,
});
const clear = { state: "clear", model: "omni-moderation-2024-09-26", categoryFlags: {} };
function makeDeps(overrides = {}) {
  const calls = { read: 0, moderate: [] };
  const deps = {
    async loadListing() {
      calls.read++;
      return listing();
    },
    async moderateText(input) {
      calls.moderate.push(input);
      return clear;
    },
    ...overrides,
  };
  return { calls, deps };
}
function runtime(overrides = {}) {
  const state = makeDeps();
  return {
    state,
    runtime: {
      ...state.deps,
      getEnv: (key) => env[key],
      ...overrides,
    },
  };
}
function request(body = { listingId: id }, options = {}) {
  return new Request(
    "https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/moderation-v2-text-shadow-probe",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      body: options.rawBody ?? JSON.stringify(body),
    },
  );
}

test("shadow output never declares approval or returns input text", async () => {
  const { calls, deps } = makeDeps();
  const result = await runTextShadowProbe({ listingId: id }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.authority, "SHADOW_TEXT_ONLY_NEVER_PUBLISH");
  assert.equal(result.imageModeration, "NOT_PERFORMED");
  assert.equal(result.route, "text_no_flags");
  assert.equal(result.stale, false);
  assert.equal(calls.read, 2);
  assert.deepEqual(calls.moderate, [
    "Selling a used iPhone",
    "Available in Bengaluru, inspection welcome",
  ]);
  const body = JSON.stringify(result);
  assert.ok(!body.includes("Bengaluru"));
  assert.ok(!body.includes("iPhone"));
});

test("India UPI OTP signal triggers review even when OpenAI clear", async () => {
  const { deps } = makeDeps({
    async loadListing() {
      return listing({
        title: "Used phone",
        description: "Share your OTP to receive the payment via UPI",
      });
    },
  });
  const result = await runTextShadowProbe({ listingId: id }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.route, "review");
  assert.ok(result.indiaFraudSignals.includes("OTP_PIN"));
});

test("flagged OpenAI category routes to review, never approval", async () => {
  const { deps } = makeDeps({
    async moderateText(text) {
      return text.includes("Selling")
        ? { state: "flagged", model: "omni-moderation-2024-09-26", categoryFlags: { violence: true } }
        : clear;
    },
  });
  const result = await runTextShadowProbe({ listingId: id }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.route, "review");
  assert.deepEqual(result.harmCategories, ["violence"]);
  assert.equal("approved" in result, false);
  assert.equal("published" in result, false);
});

test("revision, text or timestamp mutations between reads produce retry", async () => {
  for (const change of [
    { revision: 8 },
    { updated_at: "2026-10-21T15:30:00+00:00" },
    { title: "Replacement advertisement" },
    { status: "active" },
  ]) {
    let read = 0;
    const { deps } = makeDeps({
      async loadListing() {
        read++;
        return read === 1 ? listing() : listing(change);
      },
    });
    const result = await runTextShadowProbe({ listingId: id }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.equal(result.route, "retry");
  }
});

test("provider and database failures and missing descriptions never become clear", async () => {
  const failed = makeDeps({
    async moderateText() { throw new Error("private seller data: never log"); },
  });
  const error = await runTextShadowProbe({ listingId: id }, failed.deps);
  assert.equal(error.ok, true);
  assert.equal(error.route, "retry");
  assert.ok(!JSON.stringify(error).includes("private seller data"));

  const missing = makeDeps({
    async loadListing() { return listing({ description: null }); },
  });
  const noDescription = await runTextShadowProbe({ listingId: id }, missing.deps);
  assert.equal(noDescription.ok, true);
  assert.equal(noDescription.route, "retry");
  assert.equal(noDescription.provider.description, "missing");
  assert.equal(missing.calls.moderate.length, 1);

  assert.deepEqual(await runTextShadowProbe({ listingId: id }, makeDeps({
    async loadListing() { throw new Error("sensitive db error"); },
  }).deps), { ok: false, code: "SOURCE_UNAVAILABLE" });
});

test("malformed, removed and mismatched listings never reach provider", async () => {
  let providerCount = 0;
  const { deps } = makeDeps({
    async moderateText() { providerCount++; return clear; },
  });
  assert.deepEqual(await runTextShadowProbe({ listingId: "invalid" }, deps), {
    ok: false, code: "INVALID_REQUEST",
  });
  assert.deepEqual(await runTextShadowProbe({ listingId: id, secret: "ignored" }, deps), {
    ok: false, code: "INVALID_REQUEST",
  });
  for (const row of [null, listing({ status: "removed" }), listing({ id: randomUUID() })]) {
    const ret = await runTextShadowProbe({ listingId: id }, {
      ...deps, loadListing: async () => row,
    });
    assert.equal(ret.ok, false);
    assert.equal(ret.code, "NOT_FOUND");
  }
  assert.equal(providerCount, 0);
});

test("unauthorized requests never access DB or OpenAI", async () => {
  const { state, runtime: deps } = runtime();
  const badToken = request({ listingId: id }, {
    headers: { Authorization: "Bearer not-the-service-role" },
  });
  const res = await handleTextShadowProbeRequest(badToken, deps);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "UNAUTHORIZED");
  assert.equal(state.calls.read, 0);
  assert.equal(state.calls.moderate.length, 0);
});

test("wrong project, missing OpenAI key and oversized body fail closed", async () => {
  const { state, runtime: deps } = runtime();
  const wrong = await handleTextShadowProbeRequest(request(), {
    ...deps,
    getEnv: (k) => k === "SUPABASE_URL" ? "https://another-project.supabase.co" : env[k],
  });
  assert.equal(wrong.status, 503);
  assert.equal((await wrong.json()).code, "PRODUCTION_TARGET_REQUIRED");

  const missing = await handleTextShadowProbeRequest(request(), {
    ...deps,
    getEnv: (k) => k === "OPENAI_API_KEY" ? undefined : env[k],
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "OPENAI_NOT_CONFIGURED");

  const oversized = await handleTextShadowProbeRequest(
    request({ listingId: id }, { rawBody: "x".repeat(600) }), deps,
  );
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).code, "INVALID_REQUEST");
  assert.equal(state.calls.read, 0);
});

test("authorized request returns no-store output after exactly two free moderation calls", async () => {
  const { state, runtime: deps } = runtime();
  const res = await handleTextShadowProbeRequest(request(), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const payload = await res.json();
  assert.equal(payload.code, "SHADOW_TEXT_ONLY");
  assert.equal(payload.result.route, "text_no_flags");
  assert.equal(payload.result.imageModeration, "NOT_PERFORMED");
  assert.equal(payload.result.authority, "SHADOW_TEXT_ONLY_NEVER_PUBLISH");
  assert.equal(state.calls.read, 2);
  assert.equal(state.calls.moderate.length, 2);
  assert.ok(!JSON.stringify(payload).includes("Bengaluru"));
});

test("GET, invalid content type and invalid JSON never access the database", async () => {
  const { state, runtime: deps } = runtime();
  const get = new Request("https://fairswap.in/functions/v1/shadow", { method: "GET" });
  const getRes = await handleTextShadowProbeRequest(get, deps);
  assert.equal(getRes.status, 405);

  const wrong = await handleTextShadowProbeRequest(request(undefined, {
    headers: { "Content-Type": "text/plain" },
  }), deps);
  assert.equal(wrong.status, 415);

  const invalid = await handleTextShadowProbeRequest(request(undefined, {
    rawBody: "{invalid-json",
  }), deps);
  assert.equal(invalid.status, 400);
  assert.equal(state.calls.read, 0);
  assert.equal(state.calls.moderate.length, 0);
});

test("synthetic-only check reaches free moderation exactly once without reading a listing", async () => {
  const { state, runtime: deps } = runtime();
  const response = await handleTextShadowProbeRequest(
    request({ probe: "synthetic_connectivity" }),
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const json = await response.json();
  assert.deepEqual(json, {
    code: "OPENAI_MODERATION_CONNECTED",
    authority: "SYNTHETIC_CONNECTIVITY_ONLY",
    scope: "BENIGN_SYNTHETIC_TEXT_NOT_LISTING_REVIEW",
    model: "omni-moderation-2024-09-26",
    provider: "clear",
  });
  assert.equal(state.calls.read, 0);
  assert.equal(state.calls.moderate.length, 1);
  assert.match(state.calls.moderate[0], /used bicycle/i);
  assert.doesNotMatch(JSON.stringify(json), /listingId|seller|description|approved|published/);
});

test("synthetic OpenAI auth failure returns redacted 503, with zero database operations", async () => {
  const { state, runtime: deps } = runtime({
    moderateText: async () => ({ state: "failed", reason: "PROVIDER_AUTH" }),
  });
  const response = await handleTextShadowProbeRequest(
    request({ probe: "synthetic_connectivity" }),
    deps,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "OPENAI_MODERATION_CHECK_FAILED",
    authority: "SYNTHETIC_CONNECTIVITY_ONLY",
    reason: "PROVIDER_AUTH",
  });
  assert.equal(state.calls.read, 0);
});

test("synthetic probe cannot masquerade as user data or bypass service-role security", async () => {
  const { state, runtime: deps } = runtime();
  const unauthorized = await handleTextShadowProbeRequest(
    request({ probe: "synthetic_connectivity" }, {
      headers: { Authorization: "Bearer untrusted" },
    }),
    deps,
  );
  assert.equal(unauthorized.status, 401);
  const extra = await handleTextShadowProbeRequest(
    request({ probe: "synthetic_connectivity", listingId: id }),
    deps,
  );
  assert.equal(extra.status, 400);
  const unknown = await handleTextShadowProbeRequest(
    request({ probe: "dangerous_api" }),
    deps,
  );
  assert.equal(unknown.status, 400);
  assert.equal(state.calls.read, 0);
  assert.equal(state.calls.moderate.length, 0);
});

test("synthetic probe refuses wrong model and missing OpenAI secret without reading DB", async () => {
  const { state, runtime: deps } = runtime({
    moderateText: async () => ({ state: "clear", model: "unexpected-model", categoryFlags: {} }),
  });
  const wrongModel = await handleTextShadowProbeRequest(
    request({ probe: "synthetic_connectivity" }),
    deps,
  );
  assert.equal(wrongModel.status, 503);
  assert.equal((await wrongModel.json()).reason, "PROVIDER_SCHEMA");
  const missing = await handleTextShadowProbeRequest(
    request({ probe: "synthetic_connectivity" }),
    { ...deps, getEnv: key => key === "OPENAI_API_KEY" ? undefined : env[key] },
  );
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "OPENAI_NOT_CONFIGURED");
  assert.equal(state.calls.read, 0);
});
