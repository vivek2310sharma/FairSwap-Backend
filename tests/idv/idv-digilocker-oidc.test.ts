// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleDigiLockerStart } from "../../supabase/functions/idv-digilocker-start/index";
import { handleDigiLockerComplete } from "../../supabase/functions/idv-digilocker-complete/index";
import { readDigiLockerRuntime } from "../../supabase/functions/_shared/idv/digilocker-config";
import { deriveOidcNonce, OIDC_EVIDENCE_METHOD, OIDC_ISSUER, OIDC_JWKS_URL, OIDC_TOKEN_PATH } from "../../supabase/functions/_shared/idv/digilocker-oidc";
import { DIGILOCKER_HOST, derivePkceVerifier, pkceChallenge, sha256Hex } from "../../supabase/functions/_shared/idv/digilocker-client";

const KEY = "s".repeat(40);
const FP1 = "f".repeat(40);
const DLID = "123e4567-e89b-12d3-a456-426655440000";
const STAGE_REDIRECT = "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback";
const PROD_REDIRECT = "https://fairswap.in/api/idv/digilocker/callback";
const CLIENT = "stage-client";
const USER = "u-1";

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  FAIRSWAP_DIGILOCKER_ENABLED: "true",
  DIGILOCKER_AUTH_MODE: "oidc_v2",
  SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  DIGILOCKER_CLIENT_ID: CLIENT,
  DIGILOCKER_CLIENT_SECRET: "stage-secret-value",
  DIGILOCKER_REDIRECT_URI: STAGE_REDIRECT,
  IDV_DIGILOCKER_STATE_KEY: KEY,
  IDV_DIGILOCKER_FP_KEY_V1: FP1,
  ...over,
});

let priv: CryptoKey; let pubJwk: JsonWebKey; let otherPriv: CryptoKey; let otherPubJwk: JsonWebKey;
beforeAll(async () => {
  const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const kp = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  priv = kp.privateKey; pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const other = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  otherPriv = other.privateKey; otherPubJwk = await crypto.subtle.exportKey("jwk", other.publicKey);
});
const b64u = (s: string | Uint8Array) =>
  Buffer.from(typeof s === "string" ? Buffer.from(s) : s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function signJwt(claims: Record<string, unknown>, o: { key?: CryptoKey; header?: Record<string, unknown> } = {}) {
  const h = b64u(JSON.stringify(o.header ?? { alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", o.key ?? priv, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const goodClaims = async (state: string, over: Record<string, unknown> = {}) => ({
  iss: OIDC_ISSUER, aud: CLIENT, sub: "subject", exp: nowS() + 300, iat: nowS() - 5,
  nonce: await deriveOidcNonce(KEY, state), digilockerid: DLID, acr: "aadhaar", ...over,
});

function makeWorld() {
  const attempts = new Map<string, { id: string; user: string; status: string }>();
  const bindings: { user: string; fp: string; evidence: string }[] = [];
  const verified = new Set<string>();
  const calls: string[] = [];
  const blocked = new Set<string>();
  let n = 0;
  const rpc = async (name: string, a: any) => {
    calls.push(name);
    if (name === "server_idv_dl_start_attempt") { attempts.set(a.p_state_hash, { id: `a${++n}`, user: a.p_user_id, status: "pending" }); return { data: { success: true }, error: null }; }
    if (name === "server_idv_dl_consume_state") {
      const at = attempts.get(a.p_state_hash);
      if (!at || at.user !== a.p_user_id) return { data: { success: false, error: "ATTEMPT_NOT_FOUND" }, error: null };
      if (at.status !== "pending") return { data: { success: false, error: "STATE_ALREADY_USED" }, error: null };
      at.status = "consumed"; return { data: { success: true, attempt_id: at.id }, error: null };
    }
    if (name === "server_idv_dl_fail_attempt") return { data: { success: true }, error: null };
    if (name === "server_idv_dl_complete") return { data: { success: false, error: "LEGACY_LINK_DISABLED" }, error: null };
    if (name === "server_idv_dl_complete_v2") {
      if (a.p_evidence_method !== OIDC_EVIDENCE_METHOD) return { data: { success: false, error: "INVALID_IDENTITY_EVIDENCE" }, error: null };
      if (blocked.has(a.p_id_fingerprint)) return { data: { success: false, error: "VERIFICATION_UNAVAILABLE" }, error: null };
      const b = bindings.find((x) => x.fp === a.p_id_fingerprint);
      if (b && b.user !== a.p_user_id) return { data: { success: false, error: "IDENTITY_ALREADY_LINKED" }, error: null };
      if (!b) bindings.push({ user: a.p_user_id, fp: a.p_id_fingerprint, evidence: a.p_evidence_method });
      verified.add(a.p_user_id); return { data: { success: true }, error: null };
    }
    return { data: null, error: { message: "unknown" } };
  };
  const deps = { makeClient: (_u: string, _k: string, auth?: string) => auth
    ? { auth: { getUser: async () => { const id = auth.replace("Bearer ", ""); return id === "bad" ? { data: null, error: {} } : { data: { user: { id } }, error: null }; } } }
    : { rpc } };
  return { deps, calls, verified, bindings, blocked };
}

function provider(o: { responseAcr?: string; idToken?: string | null; id?: string | null; tokenStatus?: number; jwks?: unknown; timeout?: boolean } = {}) {
  const log: { url: string; body?: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body as string });
    if (o.timeout) { const e = new Error("t"); e.name = "AbortError"; throw e; }
    if (url === `${DIGILOCKER_HOST}${OIDC_TOKEN_PATH}`) {
      const body: Record<string, unknown> = { access_token: "tok-secret", token_type: "Bearer" };
      if (o.id !== null) body.digilockerid = o.id ?? DLID;
      if (o.idToken !== null) body.id_token = o.idToken;
      if (o.responseAcr !== undefined) { body.acr = o.responseAcr; body.eaadhaar = "Y"; body.masked_aadhaar = "XXXXXXXX1234"; }
      return new Response(JSON.stringify(body), { status: o.tokenStatus ?? 200 });
    }
    if (url === OIDC_JWKS_URL) return new Response(JSON.stringify(o.jwks ?? { keys: [{ ...pubJwk, kid: "k1", use: "sig" }] }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
  return { f: f as unknown as typeof fetch, log };
}
const req = (body: unknown, user = USER) =>
  new Request("https://x/f", { method: "POST", headers: { Authorization: `Bearer ${user}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function begin(w: ReturnType<typeof makeWorld>, e = env(), user = USER) {
  const res = await handleDigiLockerStart(req({ consentAcknowledged: true }, user), e, w.deps);
  const body = await res.json();
  return { res, body, state: body.redirectUrl ? new URL(body.redirectUrl).searchParams.get("state")! : "" };
}
async function finish(w: ReturnType<typeof makeWorld>, f: typeof fetch, state: string, extra: any = { code: "auth-code" }, e = env(), user = USER) {
  const res = await handleDigiLockerComplete(req({ state, ...extra }, user), e, f, w.deps);
  return { status: res.status, text: await res.clone().text(), body: await res.json() };
}

const jwk = (k: JsonWebKey, extra: Record<string, unknown> = {}) => ({ ...k, use: "sig", ...extra });

describe("DigiLocker OIDC v2 verification (only badge-issuing flow)", () => {
  it("config: oidc_v2 must be explicit; no legacy fallback; Test and Production derived from the validated project ref", () => {
    expect(readDigiLockerRuntime(env())?.environment).toBe("test");
    const { DIGILOCKER_AUTH_MODE: _m, ...missing } = env();
    expect(readDigiLockerRuntime(missing)).toBeNull();
    expect(readDigiLockerRuntime(env({ DIGILOCKER_AUTH_MODE: "legacy" }))).toBeNull();
    expect(readDigiLockerRuntime(env({ DIGILOCKER_AUTH_MODE: "bogus" }))).toBeNull();
    const prod = env({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co", DIGILOCKER_REDIRECT_URI: PROD_REDIRECT });
    expect(readDigiLockerRuntime(prod)?.environment).toBe("production");
    // Cross-environment callbacks and unknown projects close the feature.
    expect(readDigiLockerRuntime(env({ DIGILOCKER_REDIRECT_URI: PROD_REDIRECT }))).toBeNull();
    expect(readDigiLockerRuntime(env({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co" }))).toBeNull();
    expect(readDigiLockerRuntime(env({ SUPABASE_URL: "https://unknownref.supabase.co" }))).toBeNull();
    // Obsolete knobs have no effect.
    expect(readDigiLockerRuntime(env({ DIGILOCKER_ACR_SEMANTICS_CONFIRMED: "false" }))?.environment).toBe("test");
    expect(Object.keys(readDigiLockerRuntime(env())!).sort()).toEqual(["client", "currentFpKey", "environment", "legacyFpKeys", "stateKey"]);
  });

  it("start requests openid, nonce and PKCE S256 on the registered redirect, and the fixed acr=aadhaar", async () => {
    const w = makeWorld();
    const { body, state } = await begin(w);
    const u = new URL(body.redirectUrl);
    expect(u.origin + u.pathname).toBe(`${DIGILOCKER_HOST}/public/oauth2/1/authorize`);
    expect(u.searchParams.getAll("acr")).toEqual(["aadhaar"]);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid");
    expect(u.searchParams.get("nonce")).toBe(await deriveOidcNonce(KEY, state));
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(await derivePkceVerifier(KEY, state)));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe(STAGE_REDIRECT);
  });

  it("Production project uses its own callback", async () => {
    const w = makeWorld();
    const prod = env({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co", DIGILOCKER_REDIRECT_URI: PROD_REDIRECT });
    const { body } = await begin(w, prod);
    expect(new URL(body.redirectUrl).searchParams.get("redirect_uri")).toBe(PROD_REDIRECT);
  });

  it("positive: signed DigiLocker identity binds after requested acr=aadhaar and issues the badge", async () => {
    const w = makeWorld();
    const { state } = await begin(w);
    const p = provider({ idToken: await signJwt(await goodClaims(state)) });
    const r = await finish(w, p.f, state);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, verified: true });
    expect(w.calls).toContain("server_idv_dl_complete_v2");
    expect(w.calls).not.toContain("server_idv_dl_complete");
    expect(w.verified.has(USER)).toBe(true);
    expect(w.bindings).toEqual([{ user: USER, fp: expect.stringMatching(/^[0-9a-f]{64}$/), evidence: OIDC_EVIDENCE_METHOD }]);
    expect(w.bindings[0].fp).not.toContain(DLID);
    const sent = new URLSearchParams(p.log.find((l) => l.url.endsWith(OIDC_TOKEN_PATH))!.body);
    expect(sent.get("code_verifier")).toBe(await derivePkceVerifier(KEY, state));
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/revoke"))).toBe(true);
    for (const s of ["tok-secret", "auth-code", DLID]) expect(r.text).not.toContain(s);
  });

  it("positive: digilockerid only in the signed ID token (token response omits it)", async () => {
    const w = makeWorld();
    const { state } = await begin(w);
    const r = await finish(w, provider({ idToken: await signJwt(await goodClaims(state)), id: null }).f, state);
    expect(r.status).toBe(200);
    expect(w.verified.has(USER)).toBe(true);
  });

  it("ids are compared case-insensitively and fingerprinted identically", async () => {
    const w = makeWorld();
    const { state } = await begin(w);
    const r = await finish(w, provider({ idToken: await signJwt(await goodClaims(state, { digilockerid: DLID.toUpperCase() })) }).f, state);
    expect(r.status).toBe(200);
  });

  it("kid null: accepted when exactly one eligible trusted key verifies (also with a second non-matching key)", async () => {
    for (const keys of [[jwk(pubJwk, { kid: "k1" })], [jwk(otherPubJwk, { kid: "k0" }), jwk(pubJwk, { kid: "k1" })], [jwk(pubJwk)]]) {
      for (const header of [{ alg: "RS256", kid: null, typ: "JWT" }, { alg: "RS256", typ: "JWT" }]) {
        const w = makeWorld();
        const { state } = await begin(w);
        const r = await finish(w, provider({ idToken: await signJwt(await goodClaims(state), { header }), jwks: { keys } }).f, state);
        expect(r.status).toBe(200);
      }
    }
  });

  it.each([undefined, null, "", "pan", "AADHAAR"] as const)(
    "signed DigiLocker identity succeeds without signed acr=%s after an acr=aadhaar authorization request",
    async (acr) => {
      const w = makeWorld();
      const { body, state } = await begin(w);
      expect(new URL(body.redirectUrl).searchParams.get("acr")).toBe("aadhaar");
      const p = provider({ idToken: await signJwt(await goodClaims(state, { acr })) });
      const r = await finish(w, p.f, state);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true, verified: true });
      expect(w.bindings).toEqual([{ user: USER, fp: expect.any(String), evidence: OIDC_EVIDENCE_METHOD }]);
      expect(p.log.some((l) => l.url.endsWith("/oauth2/1/revoke"))).toBe(true);
    },
  );

  const rejects: [string, (s: string) => Promise<{ idToken: string | null; extra?: Partial<Parameters<typeof provider>[0]> }>, string][] = [
    ["forged signature (other key)", async (s) => ({ idToken: await signJwt(await goodClaims(s), { key: otherPriv }) }), "ID_TOKEN_INVALID"],
    ["tampered payload", async (s) => {
      const t = (await signJwt(await goodClaims(s))).split(".");
      return { idToken: `${t[0]}.${b64u(JSON.stringify(await goodClaims(s, { digilockerid: "223e4567-e89b-12d3-a456-426655440001" })))}.${t[2]}` };
    }, "ID_TOKEN_INVALID"],
    ["alg none", async (s) => ({ idToken: `${b64u(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64u(JSON.stringify(await goodClaims(s)))}.` }), "ID_TOKEN_INVALID"],
    ["HS256 confusion", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "HS256", kid: "k1" } }) }), "ID_TOKEN_INVALID"],
    ["unknown kid", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: "zz" } }) }), "ID_TOKEN_INVALID"],
    ["empty-string kid", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: "" } }) }), "ID_TOKEN_INVALID"],
    ["numeric kid", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: 1 } }) }), "ID_TOKEN_INVALID"],
    ["kid null, no eligible key verifies", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: null } }),
      extra: { jwks: { keys: [jwk(otherPubJwk, { kid: "k0" })] } } }), "ID_TOKEN_INVALID"],
    ["kid null, ambiguous: two trusted keys both verify", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: null } }),
      extra: { jwks: { keys: [jwk(pubJwk, { kid: "k1" }), jwk(pubJwk, { kid: "k2" })] } } }), "ID_TOKEN_INVALID"],
    ["kid null, only key is not a signing key", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: null } }),
      extra: { jwks: { keys: [jwk(pubJwk, { use: "enc" })] } } }), "ID_TOKEN_INVALID"],
    ["kid null, only key declares another alg", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: null } }),
      extra: { jwks: { keys: [jwk(pubJwk, { alg: "RS512" })] } } }), "ID_TOKEN_INVALID"],
    ["duplicate kid in JWKS", async (s) => ({ idToken: await signJwt(await goodClaims(s)),
      extra: { jwks: { keys: [jwk(pubJwk, { kid: "k1" }), jwk(otherPubJwk, { kid: "k1" })] } } }), "ID_TOKEN_INVALID"],
    ["oversized JWKS key set", async (s) => ({ idToken: await signJwt(await goodClaims(s)),
      extra: { jwks: { keys: Array.from({ length: 11 }, (_, i) => jwk(pubJwk, { kid: `k${i}` })) } } }), "INVALID_PROVIDER_RESPONSE"],
    ["wrong issuer", async (s) => ({ idToken: await signJwt(await goodClaims(s, { iss: "https://evil.example" })) }), "ID_TOKEN_INVALID"],
    ["wrong audience", async (s) => ({ idToken: await signJwt(await goodClaims(s, { aud: "other-client" })) }), "ID_TOKEN_INVALID"],
    ["multi-audience without azp", async (s) => ({ idToken: await signJwt(await goodClaims(s, { aud: [CLIENT, "other"] })) }), "ID_TOKEN_INVALID"],
    ["wrong azp", async (s) => ({ idToken: await signJwt(await goodClaims(s, { azp: "other" })) }), "ID_TOKEN_INVALID"],
    ["expired", async (s) => ({ idToken: await signJwt(await goodClaims(s, { exp: nowS() - 600, iat: nowS() - 900 })) }), "ID_TOKEN_INVALID"],
    ["issued in the future", async (s) => ({ idToken: await signJwt(await goodClaims(s, { iat: nowS() + 600, exp: nowS() + 900 })) }), "ID_TOKEN_INVALID"],
    ["issued too long ago (older than the attempt window)", async (s) => ({ idToken: await signJwt(await goodClaims(s, { iat: nowS() - 2000, exp: nowS() + 300 })) }), "ID_TOKEN_INVALID"],
    ["missing exp", async (s) => ({ idToken: await signJwt(await goodClaims(s, { exp: undefined })) }), "ID_TOKEN_INVALID"],
    ["missing subject", async (s) => ({ idToken: await signJwt(await goodClaims(s, { sub: "" })) }), "ID_TOKEN_INVALID"],
    ["wrong nonce", async (s) => ({ idToken: await signJwt(await goodClaims(s, { nonce: "x" })) }), "ID_TOKEN_INVALID"],
    ["missing nonce", async (s) => ({ idToken: await signJwt(await goodClaims(s, { nonce: undefined })) }), "ID_TOKEN_INVALID"],
    ["nonce from another attempt", async () => ({ idToken: await signJwt(await goodClaims("e".repeat(64))) }), "ID_TOKEN_INVALID"],
    ["missing digilockerid in signed token (unsigned response id is not enough)", async (s) => ({ idToken: await signJwt(await goodClaims(s, { digilockerid: undefined })) }), "ID_TOKEN_INVALID"],
    ["malformed digilockerid in signed token", async (s) => ({ idToken: await signJwt(await goodClaims(s, { digilockerid: "short" })) }), "ID_TOKEN_INVALID"],
    ["signed and token-response ids disagree", async (s) => ({ idToken: await signJwt(await goodClaims(s)), extra: { id: "223e4567-e89b-12d3-a456-426655440001" } }), "ID_TOKEN_INVALID"],
    ["malformed token-response id", async (s) => ({ idToken: await signJwt(await goodClaims(s)), extra: { id: "short" } }), "INVALID_PROVIDER_RESPONSE"],
    ["signed identity with untrusted key", async (s) => ({ idToken: await signJwt(await goodClaims(s), { key: otherPriv }) }), "ID_TOKEN_INVALID"],
    ["signed identity payload swapped after signing", async (s) => {
      const t = (await signJwt(await goodClaims(s, { acr: undefined }))).split(".");
      return { idToken: `${t[0]}.${b64u(JSON.stringify(await goodClaims(s)))}.${t[2]}` };
    }, "ID_TOKEN_INVALID"],
    ["signed token expired", async (s) => ({ idToken: await signJwt(await goodClaims(s, { exp: nowS() - 600, iat: nowS() - 900 })) }), "ID_TOKEN_INVALID"],
    ["signed token wrong nonce", async (s) => ({ idToken: await signJwt(await goodClaims(s, { nonce: "x" })) }), "ID_TOKEN_INVALID"],
    ["missing id_token", async () => ({ idToken: null }), "ID_TOKEN_INVALID"],
    ["not a JWT", async () => ({ idToken: "abc.def" }), "ID_TOKEN_INVALID"],
  ];
  it.each(rejects)("negative: %s => no badge, no binding, token revoked", async (_n, build, code) => {
    const w = makeWorld();
    const { state } = await begin(w);
    const b = await build(state);
    const p = provider({ idToken: b.idToken, ...(b.extra ?? {}) });
    const r = await finish(w, p.f, state);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error).toBe(code);
    expect(w.calls).not.toContain("server_idv_dl_complete_v2");
    expect(w.calls).not.toContain("server_idv_dl_complete");
    expect(w.verified.size).toBe(0);
    expect(w.bindings).toHaveLength(0);
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/revoke"))).toBe(true);
    for (const s of ["tok-secret", DLID]) expect(r.text).not.toContain(s);
  });

  it("provider errors: denial, refusal and outage create nothing; no provider call is made", async () => {
    for (const [err, code, status] of [["access_denied", "CONSENT_DENIED", 400], ["denied", "CONSENT_DENIED", 400], ["unauthorized_client", "PROVIDER_REJECTED", 422], ["server_error", "PROVIDER_UNAVAILABLE", 502], ["temporarily_unavailable", "PROVIDER_UNAVAILABLE", 502]] as const) {
      const w = makeWorld();
      const { state } = await begin(w);
      const p = provider();
      const r = await finish(w, p.f, state, { error: err });
      expect(r.status).toBe(status);
      expect(r.body.error).toBe(code);
      expect(p.log).toHaveLength(0);
      expect(w.verified.size).toBe(0);
    }
  });

  it("token endpoint refusal and timeout fail closed", async () => {
    const w = makeWorld();
    const a = await begin(w);
    expect((await finish(w, provider({ tokenStatus: 400 }).f, a.state)).body.error).toBe("PROVIDER_REJECTED");
    const b = await begin(w);
    expect((await finish(w, provider({ timeout: true }).f, b.state)).status).toBe(504);
    expect(w.verified.size).toBe(0);
  });

  it("replayed state, wrong-user callback and unknown state never reach the provider", async () => {
    const w = makeWorld();
    const { state } = await begin(w);
    const wrong = provider({ idToken: await signJwt(await goodClaims(state)) });
    expect((await finish(w, wrong.f, state, { code: "c" }, env(), "attacker")).status).toBe(404);
    expect(wrong.log).toHaveLength(0);
    const ok = provider({ idToken: await signJwt(await goodClaims(state)) });
    expect((await finish(w, ok.f, state)).status).toBe(200);
    const replay = provider({ idToken: await signJwt(await goodClaims(state)) });
    expect((await finish(w, replay.f, state)).status).toBe(409);
    expect(replay.log).toHaveLength(0);
    expect((await finish(w, replay.f, "0".repeat(64))).status).toBe(404);
  });

  it("duplicate identity on another account is rejected with recovery; same-account retry stays verified", async () => {
    const w = makeWorld();
    const a = await begin(w, env(), "u-1");
    await finish(w, provider({ idToken: await signJwt(await goodClaims(a.state)) }).f, a.state, { code: "c" }, env(), "u-1");
    const again = await begin(w, env(), "u-1");
    expect((await finish(w, provider({ idToken: await signJwt(await goodClaims(again.state)) }).f, again.state, { code: "c" }, env(), "u-1")).status).toBe(200);
    expect(w.bindings).toHaveLength(1);
    const b = await begin(w, env(), "u-2");
    const r = await finish(w, provider({ idToken: await signJwt(await goodClaims(b.state)) }).f, b.state, { code: "c" }, env(), "u-2");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "IDENTITY_ALREADY_LINKED", recoveryHint: true });
    expect(w.verified.has("u-2")).toBe(false);
  });

  it("fraud-blocked or revoked identity is refused with recovery and no badge", async () => {
    const w = makeWorld();
    const a = await begin(w, env(), "u-1");
    await finish(w, provider({ idToken: await signJwt(await goodClaims(a.state)) }).f, a.state, { code: "c" }, env(), "u-1");
    w.blocked.add(w.bindings[0].fp);
    const b = await begin(w, env(), "u-3");
    const r = await finish(w, provider({ idToken: await signJwt(await goodClaims(b.state)) }).f, b.state, { code: "c" }, env(), "u-3");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "VERIFICATION_UNAVAILABLE", recoveryHint: true });
    expect(w.verified.has("u-3")).toBe(false);
  });

  it("unauthenticated callers are refused; legacy/missing mode closes start and complete", async () => {
    const w = makeWorld();
    expect((await handleDigiLockerComplete(new Request("https://x/f", { method: "POST", body: "{}" }), env(), fetch, w.deps)).status).toBe(401);
    for (const e of [env({ DIGILOCKER_AUTH_MODE: "legacy" }), env({ DIGILOCKER_AUTH_MODE: "" })]) {
      expect((await handleDigiLockerStart(req({ consentAcknowledged: true }), e, w.deps)).status).toBe(503);
      expect((await handleDigiLockerComplete(req({ state: "a".repeat(64), code: "c" }), e, fetch, w.deps)).status).toBe(503);
    }
    expect(w.calls).toHaveLength(0);
    expect(await sha256Hex("x")).toHaveLength(64);
  });
});
