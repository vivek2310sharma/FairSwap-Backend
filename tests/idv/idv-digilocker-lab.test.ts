// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleDigiLockerDiagnostic } from "../../supabase/functions/idv-digilocker-diagnostic/index";
import {
  LAB_ERROR_CODES, buildLabResult, labResultSchema, labStateHash, readLabRuntime,
} from "../../supabase/functions/_shared/idv/digilocker-lab";
import {
  DIAG_TOKEN_PATH, DIGILOCKER_OIDC_ISSUER, DIGILOCKER_OIDC_JWKS_URL, deriveDiagNonce, deriveDiagPkceVerifier, deriveLabNonce, deriveLabPkceVerifier,
} from "../../supabase/functions/_shared/idv/digilocker-oidc-diag";
import { DIGILOCKER_HOST, pkceChallenge, sha256Hex } from "../../supabase/functions/_shared/idv/digilocker-client";

const LAB_KEY = "l".repeat(40);
const PRIMARY_KEY = "p".repeat(40);
const TESTER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LAB_REDIRECT = "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/lab/callback";
const PRIMARY_REDIRECT = "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback";
const CLIENT = "lab-client";
const NOW = 1_800_000_000_000;
const SENTINEL = "SENTINEL-Ravi-Kumar-01011990-999999990019";
const TOKEN = "tok-secret-SENTINEL";

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  FAIRSWAP_DIGILOCKER_LAB_ENABLED: "true",
  SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  DIGILOCKER_LAB_CLIENT_ID: CLIENT,
  DIGILOCKER_LAB_CLIENT_SECRET: "lab-secret-value",
  DIGILOCKER_LAB_REDIRECT_URI: LAB_REDIRECT,
  DIGILOCKER_LAB_STATE_KEY: LAB_KEY,
  DIGILOCKER_LAB_TESTER_IDS: TESTER,
  DIGILOCKER_LAB_ACR_SEMANTICS_CONFIRMED: "true",
  // primary Authpartner + diagnostic values are present and DIFFERENT; the Lab must never read them
  DIGILOCKER_CLIENT_ID: "primary-client", DIGILOCKER_CLIENT_SECRET: "primary-secret", DIGILOCKER_REDIRECT_URI: PRIMARY_REDIRECT,
  IDV_DIGILOCKER_STATE_KEY: PRIMARY_KEY,
  ...over,
});

let priv: CryptoKey;
let pubJwk: JsonWebKey;
let otherPriv: CryptoKey;
beforeAll(async () => {
  const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const kp = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  priv = kp.privateKey;
  pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  otherPriv = ((await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
});
const b64u = (s: string | Uint8Array) =>
  Buffer.from(typeof s === "string" ? Buffer.from(s) : s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function signJwt(claims: Record<string, unknown>, key?: CryptoKey) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key ?? priv, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const goodClaims = async (state: string, over: Record<string, unknown> = {}) => ({
  iss: DIGILOCKER_OIDC_ISSUER, aud: CLIENT, sub: SENTINEL, exp: NOW / 1000 + 300, iat: NOW / 1000 - 5,
  nonce: await deriveLabNonce(LAB_KEY, state), acr: "aadhaar",
  digilockerid: "123e4567-e89b-12d3-a456-426655440000", eaadhaar: "Y", masked_aadhaar: "XXXXXXXX1234", name: SENTINEL, dob: "01011990", gender: "M", ...over,
});

function makeWorld() {
  const states = new Map<string, { user: string; exp: number; used: boolean }>();
  const calls: string[] = [];
  const clock = { now: NOW };
  const rpc = async (name: string, a: any) => {
    calls.push(name);
    if (name === "server_idv_dl_diag_start") {
      if (clock.now < 0) return { data: { success: false, error: "RATE_LIMIT_EXCEEDED" }, error: null };
      states.set(a.p_state_hash, { user: a.p_user_id, exp: NOW + a.p_ttl_seconds * 1000, used: false });
      return { data: { success: true }, error: null };
    }
    if (name === "server_idv_dl_diag_consume") {
      const s = states.get(a.p_state_hash);
      if (!s || s.user !== a.p_user_id) return { data: { success: false, error: "ATTEMPT_NOT_FOUND" }, error: null };
      if (s.used) return { data: { success: false, error: "STATE_ALREADY_USED" }, error: null };
      s.used = true;
      if (s.exp < clock.now) return { data: { success: false, error: "ATTEMPT_EXPIRED" }, error: null };
      return { data: { success: true }, error: null };
    }
    return { data: null, error: { message: "unexpected rpc" } };
  };
  const deps = {
    makeClient: (_u: string, _k: string, auth?: string) => auth
      ? { auth: { getUser: async () => { const id = auth.replace("Bearer ", ""); return id === "bad" ? { data: null, error: {} } : { data: { user: { id } }, error: null }; } } }
      : { rpc },
  };
  return { deps, calls, states, clock };
}

function provider(opts: { idToken?: string | null; tokenStatus?: number; extra?: Record<string, unknown>; bigBody?: boolean; jwks?: unknown } = {}) {
  const log: { url: string; body?: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body as string });
    if (url.endsWith(DIAG_TOKEN_PATH)) {
      if (opts.bigBody) return new Response(JSON.stringify({ access_token: TOKEN, pad: "x".repeat(70 * 1024) }), { status: 200 });
      const body: Record<string, unknown> = { access_token: TOKEN, token_type: "Bearer", refresh_token: "refresh-SENTINEL", ...opts.extra };
      if (opts.idToken !== null) body.id_token = opts.idToken;
      return new Response(JSON.stringify(body), { status: opts.tokenStatus ?? 200 });
    }
    if (url === DIGILOCKER_OIDC_JWKS_URL) return new Response(JSON.stringify(opts.jwks ?? { keys: [{ ...pubJwk, kid: "k1", use: "sig" }] }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
  return { f: f as unknown as typeof fetch, log };
}

const req = (body: unknown, user = TESTER) =>
  new Request("https://x/f", { method: "POST", headers: { Authorization: `Bearer ${user}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const run = (w: ReturnType<typeof makeWorld>, body: unknown, f: typeof fetch, e = env(), user = TESTER) =>
  handleDigiLockerDiagnostic(req(body, user), e, f, w.deps, () => w.clock.now);
async function start(w: ReturnType<typeof makeWorld>, e = env(), user = TESTER) {
  const res = await run(w, { action: "start", flow: "lab" }, provider().f, e, user);
  const body = await res.json();
  const state = body.redirectUrl ? new URL(body.redirectUrl).searchParams.get("state")! : "";
  return { res, body, state };
}
async function complete(w: ReturnType<typeof makeWorld>, f: typeof fetch, state: string, extra: any = { code: "auth-code" }, e = env(), user = TESTER) {
  const res = await run(w, { action: "complete", flow: "lab", state, ...extra }, f, e, user);
  return { status: res.status, text: await res.clone().text(), body: await res.json() };
}
const NO_BADGE_RPCS = ["server_idv_dl_complete", "server_idv_dl_start_attempt", "server_idv_dl_consume_state", "server_idv_dl_fail_attempt"];
const verified = async (over: Record<string, unknown> = {}, extra?: Record<string, unknown>) => {
  const w = makeWorld();
  const { state } = await start(w);
  const p = provider({ idToken: await signJwt(await goodClaims(state, over)), extra });
  return { w, state, p, r: await complete(w, p.f, state) };
};

describe("Lab runtime guard (separate env, fail closed)", () => {
  it("is OFF by default and for Production; misconfiguration is reported, never falls back to primary credentials", () => {
    expect(readLabRuntime(env({ FAIRSWAP_DIGILOCKER_LAB_ENABLED: "false" })).kind).toBe("off");
    const { FAIRSWAP_DIGILOCKER_LAB_ENABLED: _o, ...noFlag } = env();
    expect(readLabRuntime(noFlag).kind).toBe("off");
    expect(readLabRuntime(env({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co" })).kind).toBe("off");
    expect(readLabRuntime(env()).kind).toBe("ready");
    for (const missing of ["DIGILOCKER_LAB_CLIENT_ID", "DIGILOCKER_LAB_CLIENT_SECRET", "DIGILOCKER_LAB_REDIRECT_URI", "DIGILOCKER_LAB_STATE_KEY", "DIGILOCKER_LAB_TESTER_IDS"]) {
      expect(readLabRuntime(env({ [missing]: "" })).kind).toBe("misconfigured");
    }
    expect(readLabRuntime(env({ DIGILOCKER_LAB_REDIRECT_URI: PRIMARY_REDIRECT })).kind).toBe("misconfigured"); // exact Lab URI only
    expect(readLabRuntime(env({ DIGILOCKER_LAB_REDIRECT_URI: LAB_REDIRECT + "?x=1" })).kind).toBe("misconfigured");
    expect(readLabRuntime(env({ DIGILOCKER_LAB_STATE_KEY: "short" })).kind).toBe("misconfigured");
    expect(readLabRuntime(env({ DIGILOCKER_LAB_TESTER_IDS: "not-a-uuid" })).kind).toBe("misconfigured");
  });
  it("rejects cross-client mixing: Lab credentials equal to the primary ones", () => {
    expect(readLabRuntime(env({ DIGILOCKER_LAB_CLIENT_ID: "primary-client" })).kind).toBe("misconfigured");
    expect(readLabRuntime(env({ DIGILOCKER_LAB_CLIENT_SECRET: "primary-secret" })).kind).toBe("misconfigured");
    expect(readLabRuntime(env({ DIGILOCKER_LAB_STATE_KEY: PRIMARY_KEY })).kind).toBe("misconfigured");
  });
  it("flag off, Production project and missing config answer in the Lab shape without any RPC or provider call", async () => {
    const w = makeWorld(); const p = provider();
    const off = await run(w, { action: "start", flow: "lab" }, p.f, env({ FAIRSWAP_DIGILOCKER_LAB_ENABLED: "false" }));
    expect(off.status).toBe(404); expect(await off.json()).toEqual({ success: false, flow: "lab", error: "NOT_FOUND" });
    const prod = await run(w, { action: "start", flow: "lab" }, p.f, env({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co" }));
    expect(prod.status).toBe(404);
    const cfg = await run(w, { action: "start", flow: "lab" }, p.f, env({ DIGILOCKER_LAB_CLIENT_SECRET: "" }));
    expect(cfg.status).toBe(503); expect(await cfg.json()).toEqual({ success: false, flow: "lab", error: "LAB_NOT_CONFIGURED" });
    expect(w.calls).toEqual([]); expect(p.log).toEqual([]);
  });
});

describe("Lab access control and contract", () => {
  it("unauthenticated is 401, a non-allowlisted user is 403, neither writes state", async () => {
    const w = makeWorld();
    const anon = await handleDigiLockerDiagnostic(new Request("https://x/f", { method: "POST", body: JSON.stringify({ action: "start", flow: "lab" }) }), env(), provider().f, w.deps);
    expect(anon.status).toBe(401);
    expect((await run(w, { action: "start", flow: "lab" }, provider().f, env(), "bad")).status).toBe(401);
    const other = await start(w, env(), OTHER);
    expect(other.res.status).toBe(403); expect(other.body).toEqual({ success: false, flow: "lab", error: "FORBIDDEN" });
    expect(w.calls).toEqual([]);
  });
  it("rejects malformed contract requests: extra fields, both code and error, neither, bad error enum, bad state", async () => {
    const w = makeWorld(); const p = provider();
    const { state } = await start(w);
    for (const bad of [
      { action: "start", flow: "lab", extra: 1 },
      { action: "complete", flow: "lab", state, code: "a", error: "access_denied" },
      { action: "complete", flow: "lab", state },
      { action: "complete", flow: "lab", state, error: "free text" },
      { action: "complete", flow: "lab", state: "short", code: "a" },
      { action: "complete", flow: "lab", state, code: "a", error_description: "x" },
    ]) {
      const res = await run(w, bad, p.f);
      expect(res.status).toBe(400); expect((await res.json()).success).toBe(false);
    }
    expect(w.calls).toEqual(["server_idv_dl_diag_start"]); expect(p.log).toEqual([]);
  });
  it("start: Lab credentials, exact Lab redirect, avs + acr=aadhaar + PKCE S256, Lab-domain PKCE and nonce", async () => {
    const w = makeWorld();
    const { res, body, state } = await start(w);
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["flow", "redirectUrl", "success"]);
    expect(body.flow).toBe("lab");
    const u = new URL(body.redirectUrl);
    expect(u.origin).toBe(DIGILOCKER_HOST);
    expect(u.searchParams.get("client_id")).toBe(CLIENT);
    expect(u.searchParams.get("redirect_uri")).toBe(LAB_REDIRECT);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("avs");
    expect(u.searchParams.get("acr")).toBe("aadhaar");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(await deriveLabPkceVerifier(LAB_KEY, state)));
    expect(u.searchParams.get("nonce")).toBe(await deriveLabNonce(LAB_KEY, state));
    expect(u.searchParams.has("req_doctype")).toBe(false);
    // only the Lab-namespaced hash is stored; never the plain or diagnostic hash
    expect([...w.states.keys()]).toEqual([await labStateHash(state)]);
    expect(w.states.has(await sha256Hex(state))).toBe(false);
    // domain separation of derivations
    expect(await deriveLabPkceVerifier(LAB_KEY, state)).not.toBe(await deriveDiagPkceVerifier(LAB_KEY, state));
    expect(await deriveLabNonce(LAB_KEY, state)).not.toBe(await deriveDiagNonce(LAB_KEY, state));
  });
  it("rate limiting is surfaced as 429 in the Lab shape", async () => {
    const w = makeWorld(); w.clock.now = -1;
    const { res, body } = await start(w);
    expect(res.status).toBe(429); expect(body).toEqual({ success: false, flow: "lab", error: "RATE_LIMIT_EXCEEDED" });
  });
});

describe("Lab complete: verdicts and strict value-free result", () => {
  it("VERIFIED only with signed, nonce-matched acr=aadhaar; result matches the strict schema and nothing else", async () => {
    const { r, p, state } = await verified();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["flow", "result", "success"]);
    expect(labResultSchema.safeParse(r.body.result).success).toBe(true);
    expect(r.body.result).toMatchObject({
      outcome: "VERIFIED", errorCode: null, httpStatusBucket: "2xx",
      checks: { signature: "verified", issuer: "verified", audience: "verified", expiry: "verified", issuedAt: "verified", nonce: "match", acr: "aadhaar" },
      presence: { digilockerid: "present", eaadhaar: "present", masked_aadhaar: "present", name: "present", dob: "present", gender: "present" },
    });
    expect(r.body.result.tokenResponseFields).toEqual([
      { name: "access_token", type: "string" }, { name: "id_token", type: "string" }, { name: "refresh_token", type: "string" }, { name: "token_type", type: "string" },
    ]);
    expect(r.body.result.idTokenClaims).toContainEqual({ name: "sub", type: "string" });
    // token exchange used the Lab client, Lab redirect and Lab verifier; access token revoked with Lab credentials
    const sent = new URLSearchParams(p.log.find((l) => l.url.endsWith(DIAG_TOKEN_PATH))!.body);
    expect(sent.get("client_id")).toBe(CLIENT); expect(sent.get("client_secret")).toBe("lab-secret-value");
    expect(sent.get("redirect_uri")).toBe(LAB_REDIRECT);
    expect(sent.get("code_verifier")).toBe(await deriveLabPkceVerifier(LAB_KEY, state));
  });
  it("never returns tokens, codes, claim values, identifiers, secrets or keys, and makes no badge/binding RPC", async () => {
    const { r, w } = await verified();
    for (const leak of [SENTINEL, "Ravi", "01011990", "999999990019", "XXXXXXXX1234", "123e4567", TOKEN, "refresh-SENTINEL", "auth-code", "lab-secret-value", "primary-secret", LAB_KEY, PRIMARY_KEY, "service", "eyJ"]) {
      expect(r.text).not.toContain(leak);
    }
    for (const n of NO_BADGE_RPCS) expect(w.calls).not.toContain(n);
    expect(w.calls).toEqual(["server_idv_dl_diag_start", "server_idv_dl_diag_consume"]);
  });
  it("revokes the access token with Lab credentials", async () => {
    const { p } = await verified();
    const revoke = p.log.find((l) => l.url.endsWith("/oauth2/1/revoke"))!;
    expect(revoke).toBeDefined();
    expect(String(revoke.body)).toContain("token=" + encodeURIComponent(TOKEN));
    expect(String(revoke.body)).not.toContain("primary-secret");
  });
  it("wrong audience / wrong client is FAILED", async () => {
    for (const over of [{ aud: "primary-client" }, { aud: [CLIENT, "primary-client"] }, { aud: CLIENT, azp: "primary-client" }]) {
      const { r } = await verified(over);
      expect(r.body.result).toMatchObject({ outcome: "FAILED", checks: { audience: "failed" } });
      expect(r.body.result.outcome).not.toBe("VERIFIED");
    }
  });
  it("invalid signature (other key) is FAILED; wrong issuer is FAILED", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const bad = await complete(w, provider({ idToken: await signJwt(await goodClaims(state), otherPriv) }).f, state);
    expect(bad.body.result).toMatchObject({ outcome: "FAILED", errorCode: "TOKEN_EXCHANGE_FAILED", checks: { signature: "failed" } });
    const { r } = await verified({ iss: "https://evil.example" });
    expect(r.body.result).toMatchObject({ outcome: "FAILED", checks: { issuer: "failed" } });
  });
  it("absent ACR is UNCONFIRMED; non-aadhaar ACR is NOT_VERIFIED; non-string ACR is reported invalid, never VERIFIED", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const claims = await goodClaims(state); delete (claims as any).acr;
    const absent = await complete(w, provider({ idToken: await signJwt(claims) }).f, state);
    expect(absent.body.result).toMatchObject({ outcome: "UNCONFIRMED", errorCode: null, checks: { acr: "missing" } });
    const other = await verified({ acr: "other-level" });
    expect(other.r.body.result).toMatchObject({ outcome: "NOT_VERIFIED", checks: { acr: "other" } });
    const invalid = await verified({ acr: 5 });
    expect(invalid.r.body.result.checks.acr).toBe("invalid");
    expect(invalid.r.body.result.outcome).not.toBe("VERIFIED");
  });
  it("absent or mismatched nonce is never VERIFIED (a nonce from the diagnostic domain is a mismatch)", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const claims = await goodClaims(state); delete (claims as any).nonce;
    const absent = await complete(w, provider({ idToken: await signJwt(claims) }).f, state);
    expect(absent.body.result).toMatchObject({ outcome: "UNCONFIRMED", checks: { nonce: "absent" } });
    const { r } = await verified({ nonce: await deriveDiagNonce(LAB_KEY, "x") });
    expect(r.body.result).toMatchObject({ outcome: "FAILED", checks: { nonce: "mismatch" } });
  });
  it("without owner attestation of acr semantics a signed acr=aadhaar token stays UNCONFIRMED", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const r = await complete(w, provider({ idToken: await signJwt(await goodClaims(state)) }).f, state, { code: "c" }, env({ DIGILOCKER_LAB_ACR_SEMANTICS_CONFIRMED: "false" }));
    expect(r.body.result.outcome).toBe("UNCONFIRMED");
  });
  it("field presence distinguishes absent, null, empty and invalid without values; a fully visible Aadhaar number is only 'invalid'", async () => {
    const { r } = await verified({ eaadhaar: null, name: "", dob: "not-a-date", masked_aadhaar: "999999990019" }, undefined);
    expect(r.body.result.presence).toEqual({ digilockerid: "present", eaadhaar: "null", masked_aadhaar: "invalid", name: "empty", dob: "invalid", gender: "present" });
    expect(r.text).not.toContain("999999990019");
    const w = makeWorld(); const { state } = await start(w);
    const claims = await goodClaims(state); delete (claims as any).gender;
    const absent = await complete(w, provider({ idToken: await signJwt(claims) }).f, state);
    expect(absent.body.result.presence.gender).toBe("absent");
  });
  it("token-response-only fields count as present; claim names that are not plain lowercase are never listed", async () => {
    const { r } = await verified({ "Weird-Name": SENTINEL, UPPER: 1 }, { digilockerid_extra: 1 });
    const claimNames = r.body.result.idTokenClaims.map((c: any) => c.name);
    expect(claimNames).not.toContain("Weird-Name"); expect(claimNames).not.toContain("UPPER");
    expect(r.text).not.toContain("Weird-Name");
  });
  it("oversized token response is RESPONSE_TOO_LARGE with no names or values", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const r = await complete(w, provider({ bigBody: true }).f, state);
    expect(r.body.result).toMatchObject({ outcome: "FAILED", errorCode: "RESPONSE_TOO_LARGE", tokenResponseFields: [], idTokenClaims: [] });
    expect(r.text).not.toContain("access_token");
  });
  it("provider errors: access_denied is CANCELLED, others FAILED; no provider text is relayed; no provider call is made", async () => {
    const w = makeWorld(); const p = provider();
    const s1 = (await start(w)).state;
    const denied = await complete(w, p.f, s1, { error: "access_denied" });
    expect(denied.body.result).toMatchObject({ outcome: "CANCELLED", errorCode: "PROVIDER_DENIED" });
    const s2 = (await start(w)).state;
    const failed = await complete(w, p.f, s2, { error: "server_error" });
    expect(failed.body.result).toMatchObject({ outcome: "FAILED", errorCode: "PROVIDER_ERROR" });
    expect(p.log).toEqual([]);
  });
  it("rejects an HTTP error even when it includes a valid signed ID token", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const idToken = await signJwt(await goodClaims(state));
    const rejected = await complete(w, provider({ tokenStatus: 400, idToken }).f, state);
    expect(rejected.body.result).toMatchObject({ outcome: "FAILED", errorCode: "TOKEN_EXCHANGE_FAILED", httpStatusBucket: "4xx" });
    expect(rejected.body.result.outcome).not.toBe("VERIFIED");
  });
  it("provider unavailable is a sanitized failure and a rejected token exchange reports the status bucket only", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const down = vi.fn(async () => { throw new Error(SENTINEL); }) as unknown as typeof fetch;
    const r = await complete(w, down, state);
    expect(r.body.result).toMatchObject({ outcome: "FAILED", errorCode: "PROVIDER_ERROR", httpStatusBucket: "none" });
    expect(r.text).not.toContain("SENTINEL");
    const w2 = makeWorld(); const s2 = (await start(w2)).state;
    const rej = await complete(w2, provider({ tokenStatus: 400, idToken: null }).f, s2);
    expect(rej.body.result).toMatchObject({ outcome: "FAILED", errorCode: "TOKEN_EXCHANGE_FAILED", httpStatusBucket: "4xx" });
  });
});

describe("Lab state: replay, mismatch, isolation from the diagnostic and primary flows", () => {
  it("state is single-use (replay never reaches the provider) and an unknown state is STATE_INVALID", async () => {
    const { w, state } = await verified();
    const p = provider({ idToken: await signJwt(await goodClaims(state)) });
    const replay = await complete(w, p.f, state);
    expect(replay.status).toBe(409); expect(replay.body).toEqual({ success: false, flow: "lab", error: "STATE_ALREADY_USED" });
    const unknown = await complete(w, p.f, "f".repeat(64));
    expect(unknown.status).toBe(404); expect(unknown.body.error).toBe("STATE_INVALID");
    expect(p.log).toEqual([]);
  });
  it("an expired state is STATE_EXPIRED and another tester cannot consume it", async () => {
    const w = makeWorld(); const { state } = await start(w);
    const p = provider();
    w.clock.now = NOW + 301_000;
    const exp = await complete(w, p.f, state);
    expect(exp.status).toBe(410); expect(exp.body.error).toBe("STATE_EXPIRED");
    const w2 = makeWorld(); const s2 = (await start(w2)).state;
    const both = env({ DIGILOCKER_LAB_TESTER_IDS: `${TESTER},${OTHER}` });
    const cross = await complete(w2, p.f, s2, { code: "c" }, both, OTHER);
    expect(cross.body.error).toBe("STATE_INVALID");
  });
  it("a diagnostic (non-lab) state cannot be completed by the Lab, and a Lab state cannot be completed by the diagnostic", async () => {
    const w = makeWorld();
    const diagEnv = {
      FAIRSWAP_DIGILOCKER_DIAG_ENABLED: "true", DIGILOCKER_CLIENT_ID: CLIENT, DIGILOCKER_CLIENT_SECRET: "diag-secret", DIGILOCKER_REDIRECT_URI: PRIMARY_REDIRECT,
      IDV_DIGILOCKER_STATE_KEY: PRIMARY_KEY, DIGILOCKER_DIAG_TESTER_IDS: TESTER, SUPABASE_URL: env().SUPABASE_URL, SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s",
    };
    const ds = await handleDigiLockerDiagnostic(req({ action: "start" }), diagEnv, provider().f, w.deps, () => NOW);
    const dState = new URL((await ds.json()).redirectUrl).searchParams.get("state")!;
    const asLab = await complete(w, provider().f, dState);
    expect(asLab.body).toEqual({ success: false, flow: "lab", error: "STATE_INVALID" });

    const { state: lState } = await start(w);
    const asDiag = await handleDigiLockerDiagnostic(req({ action: "complete", state: lState, code: "c" }), diagEnv, provider().f, w.deps, () => NOW);
    expect(asDiag.status).toBe(404); // ATTEMPT_NOT_FOUND: the diagnostic hashes states without the Lab namespace
  });
  it("the existing diagnostic still works with Lab env present (no regression) and ignores Lab credentials", async () => {
    const w = makeWorld();
    const diagEnv = {
      ...env(), FAIRSWAP_DIGILOCKER_DIAG_ENABLED: "true", DIGILOCKER_CLIENT_ID: "diag-client", DIGILOCKER_CLIENT_SECRET: "diag-secret",
      DIGILOCKER_DIAG_TESTER_IDS: TESTER, DIGILOCKER_REDIRECT_URI: PRIMARY_REDIRECT,
    };
    const res = await handleDigiLockerDiagnostic(req({ action: "start" }), diagEnv, provider().f, w.deps, () => NOW);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["redirectUrl", "success"]); // old shape: no flow
    const u = new URL(body.redirectUrl);
    expect(u.searchParams.get("client_id")).toBe("diag-client");
    expect(u.searchParams.get("redirect_uri")).toBe(PRIMARY_REDIRECT);
    // a request without flow:"lab" never reaches the Lab, even when the Lab is enabled
    const noLab = await handleDigiLockerDiagnostic(req({ action: "start", flow: "other" }), diagEnv, provider().f, w.deps, () => NOW);
    expect(noLab.status).toBe(400);
  });
});

describe("buildLabResult (pure)", () => {
  it("every error code the Backend can emit is in the Web-agreed enum", () => {
    expect(LAB_ERROR_CODES).toHaveLength(18);
    const r = buildLabResult({ response: { httpStatus: 200, json: null }, idToken: null, failure: "INVALID_PROVIDER_RESPONSE" }, null);
    expect(labResultSchema.safeParse(r).success).toBe(true);
    expect(LAB_ERROR_CODES).toContain(r.errorCode);
  });
});
