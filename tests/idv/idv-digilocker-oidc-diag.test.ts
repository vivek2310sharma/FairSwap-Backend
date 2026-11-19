// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleDigiLockerDiagnostic } from "../../supabase/functions/idv-digilocker-diagnostic/index";
import {
  readDiagRuntime, deriveDiagNonce, deriveDiagPkceVerifier, DIAG_TOKEN_PATH,
} from "../../supabase/functions/_shared/idv/digilocker-oidc-diag";
import { DIGILOCKER_HOST, pkceChallenge, sha256Hex } from "../../supabase/functions/_shared/idv/digilocker-client";

const KEY = "s".repeat(40);
const TESTER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STAGE_REDIRECT = "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback";
const JWKS_URL = `${DIGILOCKER_HOST}/public/oauth2/1/certs`;
const ISSUER = DIGILOCKER_HOST;
const CLIENT = "stage-client";
const NOW = 1_800_000_000_000;

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  FAIRSWAP_DIGILOCKER_DIAG_ENABLED: "true",
  SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  DIGILOCKER_CLIENT_ID: CLIENT,
  DIGILOCKER_CLIENT_SECRET: "stage-secret-value",
  DIGILOCKER_REDIRECT_URI: STAGE_REDIRECT,
  IDV_DIGILOCKER_STATE_KEY: KEY,
  DIGILOCKER_DIAG_TESTER_IDS: `${TESTER}`,
  DIGILOCKER_DIAG_JWKS_URL: JWKS_URL,
  DIGILOCKER_DIAG_EXPECTED_ISSUER: ISSUER,
  DIGILOCKER_DIAG_ACR_SEMANTICS_CONFIRMED: "true",
  ...over,
});

// ---- RSA signing fixture ----
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
async function signJwt(claims: Record<string, unknown>, opts: { key?: CryptoKey; header?: Record<string, unknown> } = {}) {
  const h = b64u(JSON.stringify(opts.header ?? { alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? priv, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const goodClaims = async (state: string, over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: CLIENT, sub: "provider-subject-not-returned", exp: NOW / 1000 + 300, iat: NOW / 1000 - 5,
  nonce: await deriveDiagNonce(KEY, state), acr: "aadhaar", aadhaar: "999999990019", pan: "ABCDE1234F", ...over,
});

// ---- In-memory fake of the Test-only SQL contract ----
function makeWorld() {
  const states = new Map<string, { user: string; exp: number; used: boolean }>();
  const calls: string[] = [];
  const rpc = async (name: string, a: any) => {
    calls.push(name);
    if (name === "server_idv_dl_diag_start") {
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
  const clock = { now: NOW };
  const deps = {
    makeClient: (_u: string, _k: string, auth?: string) => auth
      ? { auth: { getUser: async () => { const id = auth.replace("Bearer ", ""); return id === "bad" ? { data: null, error: {} } : { data: { user: { id } }, error: null }; } } }
      : { rpc },
  };
  return { deps, calls, states, clock };
}

function provider(opts: { idToken?: string | null; tokenStatus?: number; jwksStatus?: number; jwks?: unknown; timeout?: boolean } = {}) {
  const log: { url: string; body?: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body as string });
    if (opts.timeout) { const e = new Error("t"); e.name = "AbortError"; throw e; }
    if (url.endsWith(DIAG_TOKEN_PATH)) {
      const body: Record<string, unknown> = { access_token: "tok-secret", token_type: "Bearer", digilockerid: "123e4567-e89b-12d3-a456-426655440000" };
      if (opts.idToken !== null) body.id_token = opts.idToken;
      return new Response(JSON.stringify(body), { status: opts.tokenStatus ?? 200 });
    }
    if (url === JWKS_URL) return new Response(JSON.stringify(opts.jwks ?? { keys: [{ ...pubJwk, kid: "k1", use: "sig" }] }), { status: opts.jwksStatus ?? 200 });
    return new Response("{}", { status: 200 }); // revoke
  });
  return { f: f as unknown as typeof fetch, log };
}

const req = (body: unknown, user = TESTER) =>
  new Request("https://x/f", { method: "POST", headers: { Authorization: `Bearer ${user}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function start(w: ReturnType<typeof makeWorld>, e = env(), user = TESTER) {
  const res = await handleDigiLockerDiagnostic(req({ action: "start" }, user), e, provider().f, w.deps, () => w.clock.now);
  const body = await res.json();
  const state = body.redirectUrl ? new URL(body.redirectUrl).searchParams.get("state")! : "";
  return { res, body, state };
}
async function complete(w: ReturnType<typeof makeWorld>, f: typeof fetch, state: string, extra: any = { code: "auth-code" }, e = env(), user = TESTER) {
  const res = await handleDigiLockerDiagnostic(req({ action: "complete", state, ...extra }, user), e, f, w.deps, () => w.clock.now);
  return { status: res.status, text: await res.clone().text(), body: await res.json() };
}
const NO_BADGE_RPCS = ["server_idv_dl_complete", "server_idv_dl_start_attempt", "server_idv_dl_consume_state", "server_idv_dl_fail_attempt"];

describe("DigiLocker OIDC v2 Stage diagnostic", () => {
  it("guard: default OFF, Production ref, wrong redirect, no testers and off-host JWKS all close the endpoint", async () => {
    expect(readDiagRuntime(env({ FAIRSWAP_DIGILOCKER_DIAG_ENABLED: "" }))).toBeNull();
    const { FAIRSWAP_DIGILOCKER_DIAG_ENABLED: _omit, ...noFlag } = env();
    expect(readDiagRuntime(noFlag)).toBeNull();
    expect(readDiagRuntime(env({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co", DIGILOCKER_REDIRECT_URI: "https://fairswap.in/api/idv/digilocker/callback" }))).toBeNull();
    expect(readDiagRuntime(env({ DIGILOCKER_REDIRECT_URI: STAGE_REDIRECT + "?diag=1" }))).toBeNull();
    expect(readDiagRuntime(env({ DIGILOCKER_DIAG_TESTER_IDS: "" }))).toBeNull();
    expect(readDiagRuntime(env({ DIGILOCKER_DIAG_TESTER_IDS: "not-a-uuid" }))).toBeNull();
    expect(readDiagRuntime(env({ DIGILOCKER_DIAG_JWKS_URL: "https://evil.example/jwks" }))).toBeNull();
    expect(readDiagRuntime(env({ DIGILOCKER_DIAG_AUTHORIZE_VERSION: "3" }))).toBeNull();
    const w = makeWorld();
    const res = await handleDigiLockerDiagnostic(req({ action: "start" }), env({ FAIRSWAP_DIGILOCKER_DIAG_ENABLED: "false" }), provider().f, w.deps);
    expect(res.status).toBe(404);
    expect(w.calls).toEqual([]);
  });

  it("unauthorized access: no session is 401, non-allowlisted user is 403, and neither writes state", async () => {
    const w = makeWorld();
    const anon = await handleDigiLockerDiagnostic(new Request("https://x/f", { method: "POST", body: "{}" }), env(), provider().f, w.deps);
    expect(anon.status).toBe(401);
    const bad = await handleDigiLockerDiagnostic(req({ action: "start" }, "bad"), env(), provider().f, w.deps);
    expect(bad.status).toBe(401);
    const other = await start(w, env(), OTHER);
    expect(other.res.status).toBe(403);
    expect(w.calls).toEqual([]);
  });

  it("start: v1 authorize per MeriPehchaan spec, openid + acr=aadhaar + PKCE S256 + nonce, exact redirect", async () => {
    const w = makeWorld();
    const { res, body, state } = await start(w);
    expect(res.status).toBe(200);
    const u = new URL(body.redirectUrl);
    expect(u.origin).toBe(DIGILOCKER_HOST);
    expect(u.pathname).toBe("/public/oauth2/1/authorize");
    expect(u.searchParams.get("scope")).toBe("openid");
    expect(u.searchParams.get("acr")).toBe("aadhaar");
    expect(u.searchParams.get("dl_flow")).toBe("signin");
    expect(u.searchParams.get("redirect_uri")).toBe(STAGE_REDIRECT);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(await deriveDiagPkceVerifier(KEY, state)));
    expect(u.searchParams.get("nonce")).toBe(await deriveDiagNonce(KEY, state));
    expect(u.searchParams.has("req_doctype")).toBe(false);
    expect([...w.states.keys()]).toEqual([await sha256Hex(state)]); // only the hash is stored
    const v2 = await start(makeWorld(), env({ DIGILOCKER_DIAG_AUTHORIZE_VERSION: "2" }));
    expect(new URL(v2.body.redirectUrl).pathname).toBe("/public/oauth2/2/authorize");
  });

  it("successful assurance: signed token with acr=aadhaar is VERIFIED; v2 token endpoint, exact redirect and verifier", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const p = provider({ idToken: await signJwt(await goodClaims(state)) });
    const r = await complete(w, p.f, state);
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({
      outcome: "VERIFIED", code: null, endpoints: { authorize: "1", token: "2" },
      checks: { signature: "verified", issuer: "verified", audience: true, expiry: true, subject: true, issuedAt: true, nonce: "match", acr: "aadhaar" },
    });
    const tok = p.log.find((l) => l.url === `${DIGILOCKER_HOST}${DIAG_TOKEN_PATH}`)!;
    const sent = new URLSearchParams(tok.body);
    expect(sent.get("redirect_uri")).toBe(STAGE_REDIRECT);
    expect(sent.get("code_verifier")).toBe(await deriveDiagPkceVerifier(KEY, state));
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/revoke"))).toBe(true); // access token revoked, never kept
  });

  it("never leaks tokens, codes, provider ids, Aadhaar, PAN or raw claims, and issues no badge", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const idToken = await signJwt(await goodClaims(state));
    const r = await complete(w, provider({ idToken }).f, state, { code: "secret-auth-code" });
    for (const s of ["tok-secret", "secret-auth-code", idToken, "999999990019", "ABCDE1234F", "provider-subject-not-returned", "123e4567", ISSUER]) {
      expect(r.text).not.toContain(s);
    }
    expect(r.body).not.toHaveProperty("verified");
    for (const n of NO_BADGE_RPCS) expect(w.calls).not.toContain(n);
    expect(w.calls).toEqual(["server_idv_dl_diag_start", "server_idv_dl_diag_consume"]);
  });

  it("unsuccessful assurance: acr other than aadhaar is NOT_VERIFIED", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const r = await complete(w, provider({ idToken: await signJwt(await goodClaims(state, { acr: "mobile" })) }).f, state);
    expect(r.body.result.outcome).toBe("NOT_VERIFIED");
    expect(r.body.result.code).toBe("ACR_NOT_AADHAAR");
  });

  it("missing ACR is UNCONFIRMED, never VERIFIED", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const claims = await goodClaims(state);
    delete (claims as Record<string, unknown>).acr;
    const r = await complete(w, provider({ idToken: await signJwt(claims) }).f, state);
    expect(r.body.result).toMatchObject({ outcome: "UNCONFIRMED", code: "ACR_MISSING" });
  });

  it("unverifiable signing keys (no JWKS configured, JWKS unreachable, unknown kid) are UNCONFIRMED, never VERIFIED", async () => {
    for (const [e, p] of [
      [env({ DIGILOCKER_DIAG_JWKS_URL: "" }), {}],
      [env(), { jwksStatus: 503 }],
      [env(), { jwks: { keys: [{ ...pubJwk, kid: "other" }] } }],
    ] as const) {
      const w = makeWorld();
      const { state } = await start(w, e);
      const r = await complete(w, provider({ ...p, idToken: await signJwt(await goodClaims(state)) }).f, state, undefined, e);
      expect(r.body.result).toMatchObject({ outcome: "UNCONFIRMED", code: "SIGNING_KEYS_UNCONFIRMED" });
    }
    const w = makeWorld();
    const e = env({ DIGILOCKER_DIAG_EXPECTED_ISSUER: "" });
    const { state } = await start(w, e);
    const r = await complete(w, provider({ idToken: await signJwt(await goodClaims(state)) }).f, state, undefined, e);
    expect(r.body.result).toMatchObject({ outcome: "UNCONFIRMED", code: "ISSUER_UNCONFIRMED" });
  });

  it("invalid token: forged signature, alg none, wrong issuer, wrong audience, expired, nonce mismatch, malformed", async () => {
    const cases: Array<(s: string) => Promise<string>> = [
      async (s) => signJwt(await goodClaims(s), { key: otherPriv }),
      async (s) => { const t = await signJwt(await goodClaims(s), { header: { alg: "none" } }); return t.split(".").slice(0, 2).join(".") + ".x"; },
      async (s) => signJwt(await goodClaims(s), { header: { alg: "HS256", kid: "k1" } }),
      async (s) => signJwt(await goodClaims(s, { iss: "https://evil.example" })),
      async (s) => signJwt(await goodClaims(s, { aud: "other-client" })),
      async (s) => signJwt(await goodClaims(s, { exp: NOW / 1000 - 3600 })),
      async (s) => signJwt(await goodClaims(s, { nonce: "replayed-nonce" })),
      async () => "not-a-jwt",
    ];
    for (const make of cases) {
      const w = makeWorld();
      const { state } = await start(w);
      const r = await complete(w, provider({ idToken: await make(state) }).f, state);
      expect(r.body.result.outcome).toBe("FAILED");
      expect(r.body.result.code).toBe("INVALID_ID_TOKEN");
    }
    const w = makeWorld();
    const { state } = await start(w);
    const r = await complete(w, provider({ idToken: null }).f, state);
    expect(r.body.result).toMatchObject({ outcome: "FAILED", code: "INVALID_PROVIDER_RESPONSE" });
  });

  // undefined values are dropped by JSON.stringify, i.e. the claim is absent from the token.
  it.each([
    ["sub missing", { sub: undefined }],
    ["sub empty", { sub: "" }],
    ["sub whitespace", { sub: "   " }],
    ["sub not a string", { sub: 12345 }],
    ["sub too long", { sub: "x".repeat(256) }],
    ["iat missing", { iat: undefined }],
    ["iat not a number", { iat: "1800000000" }],
    ["iat in the future", { iat: NOW / 1000 + 3600 }],
    ["iat older than the state lifetime", { iat: NOW / 1000 - 3600, exp: NOW / 1000 + 300 }],
    ["exp missing", { exp: undefined }],
    ["exp not after iat", { iat: NOW / 1000 - 5, exp: NOW / 1000 - 5 }],
    ["aud missing", { aud: undefined }],
    ["aud not strings", { aud: [CLIENT, 7] }],
    ["multiple audiences without azp", { aud: [CLIENT, "other-client"] }],
    ["multiple audiences with foreign azp", { aud: [CLIENT, "other-client"], azp: "other-client" }],
    ["single audience with foreign azp", { azp: "other-client" }],
    ["nonce not a string", { nonce: 123 }],
  ])("invalid claim (%s) is FAILED, never VERIFIED", async (_name, over) => {
    const w = makeWorld();
    const { state } = await start(w);
    const r = await complete(w, provider({ idToken: await signJwt(await goodClaims(state, over)) }).f, state);
    expect(r.body.result).toMatchObject({ outcome: "FAILED", code: "INVALID_ID_TOKEN" });
  });

  it("multiple audiences with azp = client_id are accepted", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const t = await signJwt(await goodClaims(state, { aud: [CLIENT, "other-client"], azp: CLIENT }));
    expect((await complete(w, provider({ idToken: t }).f, state)).body.result.outcome).toBe("VERIFIED");
  });

  it("absent nonce is UNCONFIRMED, never VERIFIED, even with a verified signature and acr=aadhaar", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const r = await complete(w, provider({ idToken: await signJwt(await goodClaims(state, { nonce: undefined })) }).f, state);
    expect(r.body.result).toMatchObject({ outcome: "UNCONFIRMED", code: "NONCE_MISSING" });
    expect(r.body.result.checks).toMatchObject({ signature: "verified", acr: "aadhaar", nonce: "absent" });
  });

  it("unconfirmed provider assurance semantics (default) are UNCONFIRMED, never VERIFIED", async () => {
    const { DIGILOCKER_DIAG_ACR_SEMANTICS_CONFIRMED: _drop, ...noAttest } = env();
    for (const e of [noAttest, env({ DIGILOCKER_DIAG_ACR_SEMANTICS_CONFIRMED: "false" })]) {
      const w = makeWorld();
      const { state } = await start(w, e);
      const r = await complete(w, provider({ idToken: await signJwt(await goodClaims(state)) }).f, state, undefined, e);
      expect(r.body.result).toMatchObject({ outcome: "UNCONFIRMED", code: "ASSURANCE_SEMANTICS_UNCONFIRMED" });
    }
  });

  it("cancelled login: provider error is CANCELLED, consumes the state and never calls the token endpoint", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const p = provider();
    const r = await complete(w, p.f, state, { error: "denied" });
    expect(r.body.result).toMatchObject({ outcome: "CANCELLED", code: "CONSENT_DENIED" });
    expect(p.log).toEqual([]);
    expect((await complete(w, p.f, state)).status).toBe(409);
  });

  it("provider rejection and timeout are sanitized FAILED results", async () => {
    let w = makeWorld();
    let s = (await start(w)).state;
    expect((await complete(w, provider({ tokenStatus: 400 }).f, s)).body.result).toMatchObject({ outcome: "FAILED", code: "PROVIDER_REJECTED" });
    w = makeWorld();
    s = (await start(w)).state;
    expect((await complete(w, provider({ timeout: true }).f, s)).body.result).toMatchObject({ outcome: "FAILED", code: "PROVIDER_TIMEOUT" });
  });

  it("wrong state, replay, expired state and another user's state never reach the provider", async () => {
    const w = makeWorld();
    const { state } = await start(w);
    const p = provider({ idToken: await signJwt(await goodClaims(state)) });

    expect((await complete(w, p.f, "a".repeat(64))).status).toBe(404); // wrong state
    expect((await complete(w, p.f, "not-hex")).status).toBe(400);
    expect((await complete(w, p.f, state, { code: "c" }, env({ DIGILOCKER_DIAG_TESTER_IDS: `${TESTER},${OTHER}` }), OTHER)).status).toBe(404);
    expect(p.log).toEqual([]);

    expect((await complete(w, p.f, state)).status).toBe(200);
    const calls = p.log.length;
    expect((await complete(w, p.f, state)).status).toBe(409); // replay
    expect(p.log.length).toBe(calls);

    const w2 = makeWorld();
    const s2 = (await start(w2)).state;
    w2.clock.now = NOW + 301_000;
    const p2 = provider();
    expect((await complete(w2, p2.f, s2)).status).toBe(410); // expired (5 minute TTL)
    expect(p2.log).toEqual([]);
  });

  it("v1 states cannot be completed by the diagnostic (separate store, domain-separated PKCE)", async () => {
    const w = makeWorld();
    const p = provider();
    expect((await complete(w, p.f, "b".repeat(64))).status).toBe(404);
    expect(await deriveDiagPkceVerifier(KEY, "b".repeat(64))).not.toBe(
      await (await import("../../supabase/functions/_shared/idv/digilocker-client")).derivePkceVerifier(KEY, "b".repeat(64)),
    );
  });
});
