import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasProductionServiceRoleClaims } from "../../src/lib/moderation/v2/production-operator-jwt.ts";
import { handleTextShadowProbeRequest } from "../../supabase/functions/moderation-v2-text-shadow-probe/index.ts";
import { handleImageShadowRequest } from "../../supabase/functions/moderation-v2-image-shadow-probe/index.ts";

const PROD = "https://kriuhwppxgxsyyrbjsau.supabase.co";
const NOW = 1800000000;
const EXPIRES = 1950000000;
const payload = Object.freeze({
  role: "service_role", ref: "kriuhwppxgxsyyrbjsau", iat: 1700000000, exp: EXPIRES,
});
function makeToken(claims = payload, header = { alg: "HS256", typ: "JWT" }, signature = "s".repeat(43)) {
  return [
    Buffer.from(JSON.stringify(header)).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    signature,
  ].join(".");
}
function request(token) {
  return new Request(PROD + "/functions/v1/moderation-v2-text-shadow-probe", {
    method: "POST",
    headers: {
      Authorization: token ? "Bearer " + token : "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ probe: "synthetic_connectivity" }),
  });
}
function offlineRuntime() {
  const calls = { text: 0, image: 0, db: 0, storage: 0 };
  return {
    calls,
    deps: {
      getEnv: key => ({
        SUPABASE_URL: PROD,
        // Deliberately NOT the gateway-accepted operator JWT.
        SUPABASE_SERVICE_ROLE_KEY: "outdated-managed-legacy-environment-placeholder",
        OPENAI_API_KEY: "sk-test-only-test-not-real-provider-key",
      })[key],
      loadListing: async () => { calls.db++; throw Error("no customer read"); },
      loadSnapshot: async () => { calls.db++; throw Error("no customer read"); },
      readMedium: async () => { calls.storage++; throw Error("no storage"); },
      moderateText: async () => {
        calls.text++;
        return { state: "clear", model: "omni-moderation-2024-09-26", categoryFlags: {} };
      },
      moderateImage: async () => {
        calls.image++;
        return { state: "clear", model: "omni-moderation-2024-09-26", categoryFlags: {} };
      },
    },
  };
}

test("role restriction accepts only signed-claim shape after upstream gateway verifies JWT", () => {
  const valid = makeToken();
  assert.equal(hasProductionServiceRoleClaims(request(valid), NOW), true);
  for (const token of [
    null, "", "not-a-jwt", "x.y.z",
    makeToken({ ...payload, role: "anon" }),
    makeToken({ ...payload, role: "authenticated" }),
    makeToken({ ...payload, ref: "wpppxlnbzqynvhpeuavd" }),
    makeToken({ ...payload, ref: undefined }),
    makeToken({ ...payload, exp: NOW }),
    makeToken({ ...payload, exp: "1950000000" }),
    makeToken({ ...payload, exp: undefined }),
    makeToken({ ...payload, nbf: NOW + 1 }),
    makeToken({ ...payload, iat: NOW + 1 }),
    makeToken(payload, { alg: "none", typ: "JWT" }),
    makeToken(payload, { alg: "RS256", typ: "JWT" }),
    makeToken(payload, undefined, "short"),
    makeToken(payload, undefined, "s".repeat(513)),
    makeToken(payload).replaceAll(".", ". "),
  ]) {
    assert.equal(hasProductionServiceRoleClaims(request(token), NOW), false);
  }
});

test("both synthetic handlers accept Production role with outdated runtime key without customer IO", async () => {
  const token = makeToken();
  const text = offlineRuntime();
  const textResponse = await handleTextShadowProbeRequest(request(token), text.deps);
  assert.equal(textResponse.status, 200);
  assert.equal((await textResponse.json()).code, "OPENAI_MODERATION_CONNECTED");
  assert.deepEqual(text.calls, { text: 1, image: 0, db: 0, storage: 0 });

  const image = offlineRuntime();
  const imageResponse = await handleImageShadowRequest(request(token), image.deps);
  assert.equal(imageResponse.status, 200);
  assert.equal((await imageResponse.json()).code, "OPENAI_IMAGE_MODERATION_CONNECTED");
  assert.deepEqual(image.calls, { text: 0, image: 1, db: 0, storage: 0 });
});

test("invalid role, wrong project or expired JWT is denied before provider/DB/storage", async () => {
  for (const bad of [
    makeToken({ ...payload, role: "authenticated" }),
    makeToken({ ...payload, role: "anon" }),
    makeToken({ ...payload, ref: "wpppxlnbzqynvhpeuavd" }),
    makeToken({ ...payload, exp: 1700000000 }),
    "malformed",
  ]) {
    const text = offlineRuntime(), image = offlineRuntime();
    const textOut = await handleTextShadowProbeRequest(request(bad), text.deps);
    const imageOut = await handleImageShadowRequest(request(bad), image.deps);
    assert.equal(textOut.status, 401);
    assert.equal(imageOut.status, 401);
    assert.equal((await textOut.json()).code, "UNAUTHORIZED");
    assert.equal((await imageOut.json()).code, "UNAUTHORIZED");
    assert.deepEqual(text.calls, { text: 0, image: 0, db: 0, storage: 0 });
    assert.deepEqual(image.calls, { text: 0, image: 0, db: 0, storage: 0 });
  }
});

test("gateway JWT verification cannot be disabled for either deployed probe", () => {
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
  for (const slug of ["moderation-v2-text-shadow-probe","moderation-v2-image-shadow-probe"]) {
    const block = config.match(new RegExp(
      "\\[functions\\." + slug + "\\]\\s*\\n([^\\[]*)"
    ));
    assert.ok(block, "Missing config.toml gate for " + slug);
    assert.match(block[1], /^\s*verify_jwt\s*=\s*true\s*$/m);
  }
  // Tests only simulate the gateway. Never interpret unverified JS decoding as signature checking.
  const helper = readFileSync(
    new URL("../../src/lib/moderation/v2/production-operator-jwt.ts", import.meta.url), "utf8"
  );
  assert.match(helper, /MUST validate/);
  const textSource = readFileSync(new URL(
    "../../supabase/functions/moderation-v2-text-shadow-probe/index.ts", import.meta.url), "utf8");
  const imageSource = readFileSync(new URL(
    "../../supabase/functions/moderation-v2-image-shadow-probe/index.ts", import.meta.url), "utf8");
  for (const source of [textSource, imageSource]) {
    assert.match(source, /hasProductionServiceRoleClaims/);
    assert.doesNotMatch(source, /constantTimeEqual\(bearer/);
  }
});
