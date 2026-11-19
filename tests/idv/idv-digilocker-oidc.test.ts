// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleDigiLockerStart } from "../../supabase/functions/idv-digilocker-start/index";
import { handleDigiLockerComplete } from "../../supabase/functions/idv-digilocker-complete/index";
import { readDigiLockerRuntime } from "../../supabase/functions/_shared/idv/digilocker-config";
import { deriveOidcNonce, OIDC_ISSUER, OIDC_JWKS_URL, OIDC_TOKEN_PATH } from "../../supabase/functions/_shared/idv/digilocker-oidc";
import { DIGILOCKER_HOST, derivePkceVerifier, pkceChallenge, sha256Hex } from "../../supabase/functions/_shared/idv/digilocker-client";

const KEY = "s".repeat(40);
const FP1 = "f".repeat(40);
const DLID = "123e4567-e89b-12d3-a456-426655440000";
const STAGE_REDIRECT = "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback";
const CLIENT = "stage-client";
const USER = "u-1";

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  FAIRSWAP_DIGILOCKER_ENABLED: "true",
  DIGILOCKER_AUTH_MODE: "oidc_v2",
  DIGILOCKER_ACR_SEMANTICS_CONFIRMED: "true",
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

let priv: CryptoKey; let pubJwk: JsonWebKey; let otherPriv: CryptoKey;
beforeAll(async () => {
  const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const kp = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  priv = kp.privateKey; pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  otherPriv = ((await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
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
  nonce: await deriveOidcNonce(KEY, state), acr: "aadhaar", ...over,
});

function makeWorld() {
  const attempts = new Map<string, { id: string; user: string; status: string }>();
  const bindings: { user: string; fp: string }[] = [];
  const verified = new Set<string>();
  const calls: string[] = [];
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
    if (name === "server_idv_dl_complete") {
      const b = bindings.find((x) => x.fp === a.p_id_fingerprint);
      if (b && b.user !== a.p_user_id) return { data: { success: false, error: "IDENTITY_ALREADY_LINKED" }, error: null };
      if (!b) bindings.push({ user: a.p_user_id, fp: a.p_id_fingerprint });
      verified.add(a.p_user_id); return { data: { success: true }, error: null };
    }
    return { data: null, error: { message: "unknown" } };
  };
  const deps = { makeClient: (_u: string, _k: string, auth?: string) => auth
    ? { auth: { getUser: async () => { const id = auth.replace("Bearer ", ""); return id === "bad" ? { data: null, error: {} } : { data: { user: { id } }, error: null }; } } }
    : { rpc } };
  return { deps, calls, verified, bindings };
}

function provider(o: { idToken?: string | null; id?: string; tokenStatus?: number; jwks?: unknown; timeout?: boolean } = {}) {
  const log: { url: string; body?: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body as string });
    if (o.timeout) { const e = new Error("t"); e.name = "AbortError"; throw e; }
    if (url === `${DIGILOCKER_HOST}${OIDC_TOKEN_PATH}`) {
      const body: Record<string, unknown> = { access_token: "tok-secret", token_type: "Bearer", digilockerid: o.id ?? DLID };
      if (o.idToken !== null) body.id_token = o.idToken;
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

describe("DigiLocker OIDC v2 verification (Test only)", () => {
  it("mode guard: Production never enters OIDC mode; default stays legacy; unknown mode closes", () => {
    expect(readDigiLockerRuntime(env())?.oidc).toEqual({ acrSemanticsConfirmed: true });
    const { DIGILOCKER_AUTH_MODE: _m, ...legacy } = env();
    expect(readDigiLockerRuntime(legacy)?.oidc).toBeNull();
    expect(readDigiLockerRuntime(env({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co", DIGILOCKER_REDIRECT_URI: "https://fairswap.in/api/idv/digilocker/callback" }))).toBeNull();
    expect(readDigiLockerRuntime(env({ DIGILOCKER_AUTH_MODE: "bogus" }))).toBeNull();
    expect(readDigiLockerRuntime(env({ DIGILOCKER_ACR_SEMANTICS_CONFIRMED: "" }))?.oidc).toEqual({ acrSemanticsConfirmed: false });
  });

  it("start requests openid, acr=aadhaar, nonce and PKCE S256 on the registered redirect", async () => {
    const w = makeWorld();
    const { body, state } = await begin(w);
    const u = new URL(body.redirectUrl);
    expect(u.origin + u.pathname).toBe(`${DIGILOCKER_HOST}/public/oauth2/1/authorize`);
    expect(u.searchParams.get("acr")).toBe("aadhaar");
    expect(u.searchParams.get("scope")).toBe("openid");
    expect(u.searchParams.get("nonce")).toBe(await deriveOidcNonce(KEY, state));
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(await derivePkceVerifier(KEY, state)));
    expect(u.searchParams.get("redirect_uri")).toBe(STAGE_REDIRECT);
  });

  it("positive: verified token + acr=aadhaar binds through the existing RPC and issues the badge", async () => {
    const w = makeWorld();
    const { state } = await begin(w);
    const p = provider({ idToken: await signJwt(await goodClaims(state)) });
    const r = await finish(w, p.f, state);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, verified: true });
    expect(w.verified.has(USER)).toBe(true);
    expect(w.bindings).toHaveLength(1);
    expect(w.bindings[0].fp).toMatch(/^[0-9a-f]{64}$/);
    expect(w.bindings[0].fp).not.toContain(DLID);
    const sent = new URLSearchParams(p.log.find((l) => l.url.endsWith(OIDC_TOKEN_PATH))!.body);
    expect(sent.get("code_verifier")).toBe(await derivePkceVerifier(KEY, state));
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/revoke"))).toBe(true);
    for (const s of ["tok-secret", "auth-code", DLID]) expect(r.text).not.toContain(s);
  });

  const rejects: [string, (s: string) => Promise<{ idToken: string | null; extra?: Partial<Parameters<typeof provider>[0]> }>, string][] = [
    ["forged signature (other key)", async (s) => ({ idToken: await signJwt(await goodClaims(s), { key: otherPriv }) }), "ID_TOKEN_INVALID"],
    ["alg none", async (s) => ({ idToken: `${b64u(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64u(JSON.stringify(await goodClaims(s)))}.` }), "ID_TOKEN_INVALID"],
    ["HS256 confusion", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "HS256", kid: "k1" } }) }), "ID_TOKEN_INVALID"],
    ["unknown kid", async (s) => ({ idToken: await signJwt(await goodClaims(s), { header: { alg: "RS256", kid: "zz" } }) }), "ID_TOKEN_INVALID"],
    ["wrong issuer", async (s) => ({ idToken: await signJwt(await goodClaims(s, { iss: "https://evil.example" })) }), "ID_TOKEN_INVALID"],
    ["wrong audience", async (s) => ({ idToken: await signJwt(await goodClaims(s, { aud: "other-client" })) }), "ID_TOKEN_INVALID"],
    ["expired", async (s) => ({ idToken: await signJwt(await goodClaims(s, { exp: nowS() - 600, iat: nowS() - 900 })) }), "ID_TOKEN_INVALID"],
    ["missing subject", async (s) => ({ idToken: await signJwt(await goodClaims(s, { sub: "" })) }), "ID_TOKEN_INVALID"],
    ["wrong nonce", async (s) => ({ idToken: await signJwt(await goodClaims(s, { nonce: "x" })) }), "ID_TOKEN_INVALID"],
    ["missing nonce", async (s) => ({ idToken: await signJwt(await goodClaims(s, { nonce: undefined })) }), "ID_TOKEN_INVALID"],
    ["id_token digilockerid disagrees", async (s) => ({ idToken: await signJwt(await goodClaims(s, { digilockerid: "223e4567-e89b-12d3-a456-426655440001" })) }), "ID_TOKEN_INVALID"],
    ["missing id_token", async () => ({ idToken: null }), "ID_TOKEN_INVALID"],
    ["acr other than aadhaar", async (s) => ({ idToken: await signJwt(await goodClaims(s, { acr: "mobile" })) }), "ASSURANCE_NOT_PROVEN"],
    ["acr missing (unknown assurance is never proven)", async (s) => ({ idToken: await signJwt(await goodClaims(s, { acr: undefined })) }), "ASSURANCE_NOT_PROVEN"],
    ["malformed stable id", async (s) => ({ idToken: await signJwt(await goodClaims(s)), extra: { id: "short" } }), "INVALID_PROVIDER_RESPONSE"],
  ];
  it.each(rejects)("negative: %s => no badge, no binding, token revoked", async (_n, build, code) => {
    const w = makeWorld();
    const { state } = await begin(w);
    const b = await build(state);
    const p = provider({ idToken: b.idToken, ...(b.extra ?? {}) });
    const r = await finish(w, p.f, state);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error).toBe(code);
    expect(w.calls).not.toContain("server_idv_dl_complete");
    expect(w.verified.size).toBe(0);
    expect(w.bindings).toHaveLength(0);
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/revoke"))).toBe(true);
  });

  it("acr=aadhaar without the owner's semantics attestation is unproven: no badge", async () => {
    const w = makeWorld();
    const e = env({ DIGILOCKER_ACR_SEMANTICS_CONFIRMED: "false" });
    const { state } = await begin(w, e);
    const r = await finish(w, provider({ idToken: await signJwt(await goodClaims(state)) }).f, state, { code: "c" }, e);
    expect(r.body.error).toBe("ASSURANCE_NOT_PROVEN");
    expect(w.verified.size).toBe(0);
  });

  it("provider errors: denial, incomplete Aadhaar KYC and outage create nothing; no provider call is made", async () => {
    for (const [err, code, status] of [["access_denied", "CONSENT_DENIED", 400], ["denied", "CONSENT_DENIED", 400], ["unauthorized_client", "ASSURANCE_NOT_PROVEN", 422], ["server_error", "PROVIDER_UNAVAILABLE", 502]] as const) {
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

  it("timeout fails closed", async () => {
    const w = makeWorld();
    const { state } = await begin(w);
    const r = await finish(w, provider({ timeout: true }).f, state);
    expect(r.status).toBe(504);
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

  it("duplicate identity: a second account with the same DigiLocker id is rejected", async () => {
    const w = makeWorld();
    const a = await begin(w, env(), "u-1");
    await finish(w, provider({ idToken: await signJwt(await goodClaims(a.state)) }).f, a.state, { code: "c" }, env(), "u-1");
    const b = await begin(w, env(), "u-2");
    const r = await finish(w, provider({ idToken: await signJwt(await goodClaims(b.state)) }).f, b.state, { code: "c" }, env(), "u-2");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("IDENTITY_ALREADY_LINKED");
    expect(w.verified.has("u-2")).toBe(false);
  });

  it("unauthenticated callers are refused and legacy mode is unchanged (v1 endpoint, no id_token)", async () => {
    const w = makeWorld();
    expect((await handleDigiLockerComplete(new Request("https://x/f", { method: "POST", body: "{}" }), env(), fetch, w.deps)).status).toBe(401);
    const legacyEnv = env({ DIGILOCKER_AUTH_MODE: "legacy" });
    const { state } = await begin(w, legacyEnv);
    const f = vi.fn(async (url: string) =>
      url.endsWith("/oauth2/1/token") ? new Response(JSON.stringify({ access_token: "t", token_type: "Bearer", digilockerid: DLID })) : new Response("{}")) as unknown as typeof fetch;
    expect((await finish(w, f, state, { code: "c" }, legacyEnv)).status).toBe(200);
    expect(await sha256Hex("x")).toHaveLength(64);
  });
});
