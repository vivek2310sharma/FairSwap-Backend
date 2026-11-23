// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { handleDigiLockerStart } from "../../supabase/functions/idv-digilocker-start/index";
import { handleDigiLockerComplete } from "../../supabase/functions/idv-digilocker-complete/index";
import { readDigiLockerRuntime } from "../../supabase/functions/_shared/idv/digilocker-config";
import {
  derivePkceVerifier, fingerprintDigiLockerId, pkceChallenge, sha256Hex, DIGILOCKER_HOST,
} from "../../supabase/functions/_shared/idv/digilocker-client";
import { deriveOidcNonce, OIDC_ISSUER, OIDC_JWKS_URL, OIDC_TOKEN_PATH } from "../../supabase/functions/_shared/idv/digilocker-oidc";

const KEY = "s".repeat(40); // state/PKCE key
const FP1 = "f".repeat(40);
const FP2 = "g".repeat(40);
const DLID = "123e4567-e89b-12d3-a456-426655440000";
const DLID2 = "223e4567-e89b-12d3-a456-426655440001";
const STAGE_REDIRECT = "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback";
const PROD_REDIRECT = "https://fairswap.in/api/idv/digilocker/callback";

const stageEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  FAIRSWAP_DIGILOCKER_ENABLED: "true",
  DIGILOCKER_AUTH_MODE: "oidc_v2",
  SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  DIGILOCKER_CLIENT_ID: "stage-client",
  DIGILOCKER_CLIENT_SECRET: "stage-secret-value",
  DIGILOCKER_REDIRECT_URI: STAGE_REDIRECT,
  IDV_DIGILOCKER_STATE_KEY: KEY,
  IDV_DIGILOCKER_FP_KEY_V1: FP1,
  ...over,
});

// ---- Signed ID tokens. The nonce is bound to the state of the request being completed. ----
let priv: CryptoKey; let pubJwk: JsonWebKey;
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  priv = kp.privateKey; pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
});
const b64u = (b: Uint8Array | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : b).toString("base64url");
let currentState = "";
async function idTokenFor(id: string | undefined, state = currentState) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iss: OIDC_ISSUER, aud: "stage-client", sub: "s", iat: now - 5, exp: now + 300, nonce: await deriveOidcNonce(KEY, state), acr: "aadhaar" };
  if (id !== undefined) claims.digilockerid = id;
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })); const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, Buffer.from(`${h}.${p}`))))}`;
}

// ---- In-memory fake mirroring the SQL contract (atomicity itself is proven in tests/idv-pg17) ----
function makeWorld() {
  const attempts = new Map<string, { id: string; user: string; status: string; exp: number }>();
  const bindings: { user: string | null; fp: string; blocked: boolean }[] = [];
  const verified = new Set<string>();
  const calls: string[] = [];
  let n = 0;
  const rpc = async (name: string, a: any) => {
    calls.push(name);
    if (name === "server_idv_dl_start_attempt") {
      if (verified.has(a.p_user_id)) return { data: { success: true, already_verified: true }, error: null };
      if (bindings.some((b) => b.user === a.p_user_id && b.blocked)) return { data: { success: false, error: "VERIFICATION_UNAVAILABLE" }, error: null };
      attempts.set(a.p_state_hash, { id: `att-${++n}`, user: a.p_user_id, status: "pending", exp: Date.now() + 600_000 });
      return { data: { success: true, attempt_id: `att-${n}` }, error: null };
    }
    if (name === "server_idv_dl_consume_state") {
      const at = attempts.get(a.p_state_hash);
      if (!at || at.user !== a.p_user_id) return { data: { success: false, error: "ATTEMPT_NOT_FOUND" }, error: null };
      if (at.status !== "pending") return { data: { success: false, error: "STATE_ALREADY_USED" }, error: null };
      if (at.exp < Date.now()) return { data: { success: false, error: "ATTEMPT_EXPIRED" }, error: null };
      at.status = "consumed";
      return { data: { success: true, attempt_id: at.id }, error: null };
    }
    if (name === "server_idv_dl_fail_attempt") return { data: { success: true }, error: null };
    if (name === "server_idv_dl_complete") return { data: { success: false, error: "LEGACY_LINK_DISABLED" }, error: null };
    if (name === "server_idv_dl_complete_v2") {
      const all = [a.p_id_fingerprint, ...(a.p_legacy_fingerprints ?? [])];
      if (bindings.some((x) => all.includes(x.fp) && x.blocked)) return { data: { success: false, error: "VERIFICATION_UNAVAILABLE" }, error: null };
      const b = bindings.find((x) => all.includes(x.fp));
      if (b?.blocked) return { data: { success: false, error: "VERIFICATION_UNAVAILABLE" }, error: null };
      if (b && b.user !== a.p_user_id) return { data: { success: false, error: "IDENTITY_ALREADY_LINKED", recovery: true }, error: null };
      if (!b) bindings.push({ user: a.p_user_id, fp: a.p_id_fingerprint, blocked: false });
      verified.add(a.p_user_id);
      return { data: { success: true }, error: null };
    }
    return { data: null, error: { message: "unknown" } };
  };
  const deps = {
    makeClient: (_u: string, key: string, auth?: string) => {
      if (auth) {
        const uid = auth.replace("Bearer ", "");
        return { auth: { getUser: async () => (uid === "bad" ? { data: null, error: {} } : { data: { user: { id: uid } }, error: null }) } };
      }
      return { rpc };
    },
  };
  return { deps, attempts, bindings, verified, calls };
}

function providerFetch(opts: { id?: string; tokenStatus?: number; tokenBody?: any; timeout?: boolean; state?: string } = {}) {
  const log: { url: string; body?: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body as string });
    if (opts.timeout) { const e = new Error("t"); e.name = "AbortError"; throw e; }
    if (url === `${DIGILOCKER_HOST}${OIDC_TOKEN_PATH}`) {
      const status = opts.tokenStatus ?? 200;
      const id = opts.id ?? DLID;
      return new Response(JSON.stringify(opts.tokenBody ?? { access_token: "tok-secret", token_type: "Bearer", digilockerid: id,
        id_token: await idTokenFor(id, opts.state ?? currentState), name: "Ajit", dob: "31121970" }), { status });
    }
    if (url === OIDC_JWKS_URL) return new Response(JSON.stringify({ keys: [{ ...pubJwk, kid: "k1", use: "sig" }] }));
    return new Response("{}", { status: 200 }); // revoke
  });
  return { f: f as unknown as typeof fetch, log };
}

const req = (body: unknown, auth = "Bearer user-1") =>
  new Request("https://x/f", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function startFlow(world: ReturnType<typeof makeWorld>, user = "user-1", env = stageEnv()) {
  const res = await handleDigiLockerStart(req({ consentAcknowledged: true }, `Bearer ${user}`), env, world.deps);
  const body = await res.json();
  const state = body.redirectUrl ? new URL(body.redirectUrl).searchParams.get("state")! : "";
  return { res, body, state };
}
const complete = (w: ReturnType<typeof makeWorld>, f: typeof fetch, state: string, extra: any = { code: "auth-code" }, user = "user-1", env = stageEnv()) => {
  currentState = state;
  return handleDigiLockerComplete(req({ state, ...extra }, `Bearer ${user}`), env, f, w.deps);
};

describe("DigiLocker direct verification", () => {
  it("first-time verification: PKCE S256, exact redirect, openid + nonce + fixed acr=aadhaar (no document scopes), then verified", async () => {
    const w = makeWorld();
    const { res, body, state } = await startFlow(w);
    expect(res.status).toBe(200);
    const u = new URL(body.redirectUrl);
    expect(u.origin).toBe(DIGILOCKER_HOST);
    expect(u.pathname).toBe("/public/oauth2/1/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe(STAGE_REDIRECT);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(await derivePkceVerifier(KEY, state)));
    expect(u.searchParams.get("scope")).toBe("openid");
    expect(u.searchParams.get("nonce")).toBe(await deriveOidcNonce(KEY, state));
    expect(u.searchParams.getAll("acr")).toEqual(["aadhaar"]);
    for (const p of ["req_doctype", "amr", "dl_flow"]) expect(u.searchParams.has(p)).toBe(false);
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const p = providerFetch();
    const done = await complete(w, p.f, state);
    expect(done.status).toBe(200);
    expect(w.verified.has("user-1")).toBe(true);
    const tokenCall = p.log.find((l) => l.url.endsWith(OIDC_TOKEN_PATH))!;
    expect(tokenCall.body).toContain("code_verifier=" + (await derivePkceVerifier(KEY, state)));
    expect(tokenCall.body).toContain("grant_type=authorization_code");
    expect(w.bindings[0].fp).toBe(await fingerprintDigiLockerId(FP1, DLID));
    expect(w.bindings[0].fp).not.toContain(DLID);
    // The identifier comes only from the signed ID token: /oauth2/1/user and the v1 token endpoint are never called.
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/user") || l.url.endsWith("/oauth2/1/token"))).toBe(false);
  });

  it("obsolete legacy knobs cannot re-enable unsigned linking, change ACR or add AMR", async () => {
    const w = makeWorld();
    const on = await startFlow(w, "user-1", stageEnv({ DIGILOCKER_REQUEST_OPENID_SCOPE: "false", DIGILOCKER_USERDETAILS_APPROVED: "true" }));
    const u = new URL(on.body.redirectUrl);
    expect(u.searchParams.get("scope")).toBe("openid");
    expect(u.searchParams.getAll("acr")).toEqual(["aadhaar"]);
    expect(u.searchParams.has("amr")).toBe(false);
  });

  it("already verified: returns status without redirecting to DigiLocker", async () => {
    const w = makeWorld(); w.verified.add("user-1");
    const { res, body } = await startFlow(w);
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, alreadyVerified: true });
  });

  it("duplicate identity on another account is rejected safely with recovery hint", async () => {
    const w = makeWorld();
    const a = await startFlow(w, "user-1"); await complete(w, providerFetch().f, a.state);
    const b = await startFlow(w, "user-2");
    const r = await complete(w, providerFetch().f, b.state, { code: "c2" }, "user-2");
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body).toEqual({ error: "IDENTITY_ALREADY_LINKED", recoveryHint: true });
    expect(w.verified.has("user-2")).toBe(false);
  });

  it("concurrent duplicate requests never bind one identity to two accounts", async () => {
    const w = makeWorld();
    const [a, b] = await Promise.all([startFlow(w, "user-1"), startFlow(w, "user-2")]);
    const [ra, rb] = await Promise.all([
      complete(w, providerFetch({ state: a.state }).f, a.state, { code: "c" }, "user-1"),
      complete(w, providerFetch({ state: b.state }).f, b.state, { code: "c" }, "user-2"),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(w.bindings.length).toBe(1);
  });

  it("fraud-blocked identity cannot verify another account; response is generic", async () => {
    const w = makeWorld();
    w.bindings.push({ user: null, fp: await fingerprintDigiLockerId(FP1, DLID), blocked: true });
    const a = await startFlow(w, "user-9");
    const r = await complete(w, providerFetch().f, a.state, { code: "c" }, "user-9");
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).not.toMatch(/fraud|blocked/i);
    expect(w.verified.has("user-9")).toBe(false);
  });

  it.each([
    ["missing id_token (unsigned token-response id alone)", async () => ({ access_token: "t", token_type: "Bearer", digilockerid: DLID })],
    ["short token-response digilockerid", async () => ({ access_token: "t", token_type: "Bearer", digilockerid: "abc", id_token: await idTokenFor(DLID) })],
    ["token-response id differs from signed id", async () => ({ access_token: "t", token_type: "Bearer", digilockerid: DLID2, id_token: await idTokenFor(DLID) })],
    ["signed token without digilockerid", async () => ({ access_token: "t", token_type: "Bearer", digilockerid: DLID, id_token: await idTokenFor(undefined) })],
    ["unsigned/garbage id_token", async () => ({ access_token: "t", token_type: "Bearer", digilockerid: DLID, id_token: "eyJ.eyJ.sig" })],
    ["non-bearer token", async () => ({ access_token: "t", token_type: "mac", id_token: await idTokenFor(DLID) })],
    ["missing access token", async () => ({ token_type: "Bearer", id_token: await idTokenFor(DLID) })],
  ])("fails closed on %s", async (_n, build) => {
    const w = makeWorld(); const { state } = await startFlow(w);
    currentState = state;
    const r = await complete(w, providerFetch({ tokenBody: await build() }).f, state);
    expect(r.status).toBe(422);
    expect(w.verified.size).toBe(0);
    expect(w.calls).not.toContain("server_idv_dl_complete_v2");
  });

  it("signed ID token alone (no token-response id) is sufficient", async () => {
    const w = makeWorld(); const { state } = await startFlow(w);
    currentState = state;
    const tokenBody = { access_token: "t", token_type: "Bearer", scope: "openid", id_token: await idTokenFor(DLID) };
    expect((await complete(w, providerFetch({ tokenBody }).f, state)).status).toBe(200);
    expect(w.bindings[0].fp).toBe(await fingerprintDigiLockerId(FP1, DLID));
  });

  it("key rotation keeps duplicate and fraud-block matching via legacy fingerprints", async () => {
    const rotated = stageEnv({ IDV_DIGILOCKER_FP_KEY_V2: FP2, IDV_DIGILOCKER_FP_KEY_CURRENT: "v2" });
    const w = makeWorld();
    w.bindings.push({ user: null, fp: await fingerprintDigiLockerId(FP1, DLID), blocked: true }); // blocked under v1
    const a = await startFlow(w, "user-7", rotated);
    const r = await complete(w, providerFetch().f, a.state, { code: "c" }, "user-7", rotated);
    expect(r.status).toBe(403);
    expect(w.verified.has("user-7")).toBe(false);
  });

  it("rejects replayed state, unknown state, and a different user's state", async () => {
    const w = makeWorld(); const { state } = await startFlow(w);
    expect((await complete(w, providerFetch().f, state, { code: "c" }, "user-2")).status).toBe(404); // wrong user
    expect((await complete(w, providerFetch().f, state)).status).toBe(200);
    const p = providerFetch();
    expect((await complete(w, p.f, state)).status).toBe(409); // replay: provider never contacted
    expect(p.f).not.toHaveBeenCalled();
    expect((await complete(w, p.f, "a".repeat(64))).status).toBe(404);
    expect((await complete(w, p.f, "short")).status).toBe(400);
  });

  it("rejects an invalid or replayed code reported by the provider", async () => {
    const w = makeWorld(); const { state } = await startFlow(w);
    const r = await complete(w, providerFetch({ tokenStatus: 400 }).f, state, { code: "reused" });
    expect(r.status).toBe(422);
    expect(w.verified.size).toBe(0);
  });

  it("maps provider timeout and downtime without verifying", async () => {
    const w = makeWorld(); const s1 = await startFlow(w);
    expect((await complete(w, providerFetch({ timeout: true }).f, s1.state)).status).toBe(504);
    const s2 = await startFlow(w);
    expect((await complete(w, providerFetch({ tokenStatus: 503 }).f, s2.state)).status).toBe(502);
    expect(w.verified.size).toBe(0);
  });

  it("consent denied at DigiLocker verifies nothing and never calls the provider", async () => {
    const w = makeWorld(); const { state } = await startFlow(w);
    const p = providerFetch();
    const r = await complete(w, p.f, state, { error: "access_denied" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("CONSENT_DENIED");
    expect(p.f).not.toHaveBeenCalled();
  });

  it("requires explicit consent and an authenticated user", async () => {
    const w = makeWorld();
    expect((await handleDigiLockerStart(req({}), stageEnv(), w.deps)).status).toBe(400);
    expect((await handleDigiLockerStart(req({ consentAcknowledged: true }, "Bearer bad"), stageEnv(), w.deps)).status).toBe(401);
    expect((await handleDigiLockerStart(new Request("https://x", { method: "POST", body: "{}" }), stageEnv(), w.deps)).status).toBe(401);
    expect((await handleDigiLockerComplete(req({ state: "a".repeat(64), code: "c" }, "Bearer bad"), stageEnv(), providerFetch().f, w.deps)).status).toBe(401);
  });

  it("credentials absent / flag off / wrong redirect => closed (503) and no DB or provider access", async () => {
    const w = makeWorld(); const p = providerFetch();
    for (const env of [
      stageEnv({ FAIRSWAP_DIGILOCKER_ENABLED: "false" }),
      stageEnv({ DIGILOCKER_CLIENT_ID: "" }),
      stageEnv({ DIGILOCKER_CLIENT_SECRET: "" }),
      stageEnv({ IDV_DIGILOCKER_STATE_KEY: "short" }),
      stageEnv({ IDV_DIGILOCKER_FP_KEY_V1: "short" }),
      stageEnv({ IDV_DIGILOCKER_FP_KEY_CURRENT: "v2" }),
      stageEnv({ IDV_DIGILOCKER_FP_KEY_V1: KEY }),
      stageEnv({ IDV_DIGILOCKER_FP_KEY_V2: FP1 }),
      stageEnv({ DIGILOCKER_REDIRECT_URI: STAGE_REDIRECT + "/" }),
      stageEnv({ DIGILOCKER_REDIRECT_URI: "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback?x=1" }),
    ]) {
      expect((await handleDigiLockerStart(req({ consentAcknowledged: true }), env, w.deps)).status).toBe(503);
      expect((await handleDigiLockerComplete(req({ state: "a".repeat(64), code: "c" }), env, p.f, w.deps)).status).toBe(503);
    }
    expect(w.calls.length).toBe(0);
    expect(p.f).not.toHaveBeenCalled();
  });

  it("legacy or missing auth mode never falls back to unsigned linking", async () => {
    const w = makeWorld(); const p = providerFetch();
    for (const env of [stageEnv({ DIGILOCKER_AUTH_MODE: "legacy" }), stageEnv({ DIGILOCKER_AUTH_MODE: "" })]) {
      expect((await handleDigiLockerStart(req({ consentAcknowledged: true }), env, w.deps)).status).toBe(503);
      expect((await handleDigiLockerComplete(req({ state: "a".repeat(64), code: "c" }), env, p.f, w.deps)).status).toBe(503);
    }
    expect(w.calls.length).toBe(0);
  });

  it("Stage and Production are isolated by project ref and callback", () => {
    expect(readDigiLockerRuntime(stageEnv())).not.toBeNull();
    // Production project with the Stage callback (or vice versa) must be refused.
    expect(readDigiLockerRuntime(stageEnv({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co" }))).toBeNull();
    expect(readDigiLockerRuntime(stageEnv({ DIGILOCKER_REDIRECT_URI: PROD_REDIRECT }))).toBeNull();
    expect(readDigiLockerRuntime(stageEnv({ SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co", DIGILOCKER_REDIRECT_URI: PROD_REDIRECT }))).not.toBeNull();
    expect(readDigiLockerRuntime(stageEnv({ SUPABASE_URL: "https://unknownref.supabase.co" }))).toBeNull();
  });

  it("responses and logs never expose tokens, secrets, raw digilockerid or provider PII", async () => {
    const w = makeWorld(); const spy = vi.spyOn(console, "log"); const spy2 = vi.spyOn(console, "error");
    const { state, body: sb } = await startFlow(w);
    const bodies = [JSON.stringify(sb)];
    bodies.push(await (await complete(w, providerFetch().f, state)).text());
    const s2 = await startFlow(w, "user-2");
    bodies.push(await (await complete(w, providerFetch().f, s2.state, { code: "c" }, "user-2")).text());
    for (const b of bodies) for (const bad of ["tok-secret", "stage-secret-value", DLID, "Ajit", "9999999999", KEY, FP1, "client_secret"]) expect(b).not.toContain(bad);
    expect(spy).not.toHaveBeenCalled(); expect(spy2).not.toHaveBeenCalled();
    spy.mockRestore(); spy2.mockRestore();
  });

  it("stores only the state hash, never the raw state", async () => {
    const w = makeWorld(); const { state } = await startFlow(w);
    expect([...w.attempts.keys()]).toEqual([await sha256Hex(state)]);
  });
});

describe("migration 20261117090000 static guarantees", () => {
  const sql = readFileSync("supabase/forward-migrations/idv/20261117090000_idv_digilocker_direct_v1.sql", "utf8");
  it("has unique provider+fingerprint, no raw id column, cascade-safe FK, one-time validity", () => {
    expect(sql).toMatch(/UNIQUE \(provider, id_fingerprint\)/);
    expect(sql).not.toMatch(/digilockerid\s+text/i);
    expect(sql).toMatch(/user_id uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(sql).toMatch(/CREATE TRIGGER trg_idv_dl_binding_guard BEFORE UPDATE OR DELETE/);
    expect(sql).not.toMatch(/GRANT [A-Z, ]*ON app_security\.idv_digilocker_bindings TO/);
    expect(sql).toMatch(/VALUES \(p_user_id, 'verified', true, v_now, NULL, NULL, v_now\)/);
    expect(sql).not.toMatch(/interval '1 year'/);
  });
  it("gate defaults OFF and INSERT enforcement does not depend on the caller", () => {
    expect(sql).toMatch(/VALUES \('identity_verification_required', 'false',/);
    expect(sql).toMatch(/enforce_verified_actor\(NEW\.seller_id, true\)/);
    expect(sql).toMatch(/enforce_verified_actor\(NEW\.sender_id, true\)/);
    expect(sql).toMatch(/enforce_verified_actor\(NEW\.buyer_id, true\)/);
  });
  it("never treats a NULL owner as a verified actor", () => {
    expect(sql).not.toMatch(/IF p_actor IS NULL THEN\s*RETURN;/);
    expect(sql).toMatch(/app_security\.idv_request_role\(\) IS NULL OR app_security\.identity_gate_system_write\(\)/);
    expect(sql).toMatch(/IF v_uid IS NOT NULL AND NOT app_security\.is_active_staff_aal2\('moderator'\)/);
  });
  it("confirmed fraud reuses the existing suspension implementation without failing on suspended accounts", () => {
    expect(sql).toMatch(/IF v_status = 'active' THEN\s*PERFORM app_security\.impl_update_user_account_status/);
  });
  it("is additive: no drops of tables/columns, no edits to historical migrations", () => {
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/i);
    expect(sql.startsWith("-- Migration:")).toBe(true);
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';\s*set local statement_timeout = '30s';/);
  });
  it("service-only RPCs are not granted to clients", () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.server_idv_dl_complete\([^)]*\) TO service_role;/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION app_security\.enforce_verified_actor\([^)]*\) TO [^;]*authenticated/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.server_idv_dl_[a-z_]+\([^)]*\) TO [^;]*authenticated/);
  });
});

describe("migration 20261119200000 (OIDC v2 badge provenance) static guarantees", () => {
  const sql = readFileSync("supabase/forward-migrations/idv/20261119200000_idv_digilocker_oidc_v2_badge.sql", "utf8");
  it("is additive and hardened; never stores raw ids or changes the identity gate", () => {
    expect(sql.startsWith("-- Migration: 20261119200000_idv_digilocker_oidc_v2_badge.sql")).toBe(true);
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';\s*set local statement_timeout = '30s';/);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DROP FUNCTION/i);
    expect(sql).not.toMatch(/digilockerid\s+text|aadhaar_kyc/i);
    expect(sql).not.toMatch(/identity_verification_required'\s*,\s*'true'|SET setting_value/i);
  });
  it("badge requires signed provenance; legacy linking issues nothing", () => {
    expect(sql).toMatch(/b\.evidence_method = 'oidc_v2_signed_id_token'/);
    expect(sql).toMatch(/failure_code = 'LEGACY_LINK_DISABLED'/);
    expect(sql).toMatch(/IF p_evidence_method IS DISTINCT FROM 'oidc_v2_signed_id_token' THEN/);
  });
  it("every function is SECURITY DEFINER with an empty search_path and minimal grants", () => {
    const fns = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) ?? [];
    expect(fns.length).toBe(7);
    for (const f of fns) { expect(f).toMatch(/SECURITY DEFINER/); expect(f).toMatch(/SET search_path = ''/); }
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app_security\.has_digilocker_badge\(uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION app_security\.has_digilocker_badge\(uuid\) TO service_role;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.server_idv_dl_complete_v2\([^)]*\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION (public\.server_idv_dl_complete_v2|app_security\.impl_idv_dl_complete_v2)\([^)]*\) TO [^;]*(anon|authenticated)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_digilocker_badges\(uuid\[\]\) FROM PUBLIC;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_digilocker_badges\(uuid\[\]\) TO anon, authenticated, service_role;/);
    expect(sql).toMatch(/RAISE EXCEPTION 'TOO_MANY_USER_IDS'/);
  });
});

describe("migration 20261122100000 (mandatory gate requires signed DigiLocker) static guarantees", () => {
  const sql = readFileSync("supabase/forward-migrations/idv/20261122100000_idv_digilocker_required_gate.sql", "utf8");
  const v1 = readFileSync("supabase/forward-migrations/idv/20261117090000_idv_digilocker_direct_v1.sql", "utf8");
  const body = (text: string) => {
    const m = text.match(/CREATE OR REPLACE FUNCTION app_security\.enforce_verified_actor\([\s\S]*?\n\$\$;/);
    expect(m).not.toBeNull();
    return m![0];
  };
  it("is additive, hardened and never changes the identity gate switch", () => {
    expect(sql.startsWith("-- Migration: 20261122100000_idv_digilocker_required_gate.sql")).toBe(true);
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';\s*set local statement_timeout = '30s';/);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DROP FUNCTION|DROP TRIGGER|CREATE TRIGGER|ALTER TABLE/i);
    expect(sql).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM|SET setting_value/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'IDV_DIGILOCKER_REQUIRED_PREREQUISITE_MISSING'/);
  });
  it("replaces only the gate helper and swaps the generic predicate for the signed DigiLocker badge", () => {
    expect((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1);
    const next = body(sql);
    expect(next).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER\s+SET search_path = ''/);
    expect(next).toMatch(/IF NOT app_security\.has_digilocker_badge\(p_actor\) THEN/);
    expect(next).not.toMatch(/is_identity_verified/);
    // Everything else (NULL-owner, staff, service, system-write rules, error contract) is byte-identical to V1.
    const strip = (t: string) => t.split("\n").filter(l => !/^\s*--/.test(l)).join("\n");
    expect(strip(next).replace("app_security.has_digilocker_badge(p_actor)", "app_security.is_identity_verified(p_actor)"))
      .toBe(strip(body(v1)));
    expect((next.match(/RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';/g) ?? []).length).toBe(3);
  });
  it("keeps the helper server-only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app_security\.enforce_verified_actor\(uuid, boolean\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION app_security\.enforce_verified_actor\(uuid, boolean\) TO service_role;/);
    expect(sql).not.toMatch(/GRANT [^;]* TO [^;]*(anon|authenticated|PUBLIC)/i);
  });
  it("is wired into the disposable PG17 suite after the V2 assertions", () => {
    const runner = readFileSync("tests/idv-pg17/run-disposable.mjs", "utf8");
    const order = ["assertions-digilocker-v2.sql", "20261122100000_idv_digilocker_required_gate.sql", "assertions-digilocker-required.sql"]
      .map(f => runner.indexOf(f));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("migration 20261123120000 (Aadhaar ACR evidence) static guarantees", () => {
  const f = "supabase/forward-migrations/idv/20261123120000_idv_digilocker_aadhaar_acr.sql";
  const sql = readFileSync(f, "utf8");
  const v2 = readFileSync("supabase/forward-migrations/idv/20261119200000_idv_digilocker_oidc_v2_badge.sql", "utf8");
  const fnBody = (t: string, name: string) => t.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replace(".", "\\.")}\\([\\s\\S]*?\n\\$\\$;`))![0];
  it("is forward-only, additive in effect, bounded, and never touches the gate switch or stores claims", () => {
    expect(sql.startsWith("-- Migration: 20261123120000_idv_digilocker_aadhaar_acr.sql")).toBe(true);
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';\s*set local statement_timeout = '30s';/);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DROP FUNCTION|DELETE FROM app_security\.idv_digilocker_bindings\s+WHERE\s+evidence/i);
    expect(sql).not.toMatch(/SET setting_value|identity_verification_required'\s*,\s*'true'|app_system_settings/i);
    expect(sql).not.toMatch(/UPDATE app_security\.idv_digilocker_bindings\s+SET evidence_method/i); // old rows are never upgraded
    expect(sql).not.toMatch(/\b(acr|aadhaar)\s+(text|varchar)|masked_aadhaar|eaadhaar/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'IDV_DIGILOCKER_ACR_PREREQUISITE_MISSING'/);
  });
  it("badge predicate and completion accept only the Aadhaar-assured evidence label", () => {
    expect(fnBody(sql, "app_security.has_digilocker_badge")).toMatch(/b\.evidence_method = 'oidc_v2_signed_aadhaar_acr'/);
    expect(fnBody(sql, "app_security.has_digilocker_badge")).not.toMatch(/oidc_v2_signed_id_token|legacy_account_link/);
    const c = fnBody(sql, "app_security.impl_idv_dl_complete_v2");
    expect(c).toMatch(/IF p_evidence_method IS DISTINCT FROM 'oidc_v2_signed_aadhaar_acr' THEN/);
    expect(c).not.toMatch(/oidc_v2_signed_id_token/);
    // Only the evidence literal differs from the previous body: all binding/fraud/revocation/audit logic is unchanged.
    expect(c).toBe(fnBody(v2, "app_security.impl_idv_dl_complete_v2").split("'oidc_v2_signed_id_token'").join("'oidc_v2_signed_aadhaar_acr'"));
    expect(fnBody(sql, "app_security.has_digilocker_badge")).toBe(fnBody(v2, "app_security.has_digilocker_badge").split("'oidc_v2_signed_id_token'").join("'oidc_v2_signed_aadhaar_acr'"));
  });
  it("keeps historical evidence values valid in the constraint and hardens every function", () => {
    expect(sql).toMatch(/evidence_method IN \('legacy_account_link', 'oidc_v2_signed_id_token', 'oidc_v2_signed_aadhaar_acr'\)/);
    const fns = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) ?? [];
    expect(fns.length).toBe(2);
    for (const fn of fns) { expect(fn).toMatch(/SECURITY DEFINER/); expect(fn).toMatch(/SET search_path = ''/); }
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app_security\.has_digilocker_badge\(uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.server_idv_dl_complete_v2\([^)]*\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).not.toMatch(/GRANT [^;]* TO [^;]*(anon|authenticated|PUBLIC)/i);
  });
  it("is wired into the disposable PG17 suite after the required-gate assertions", () => {
    const runner = readFileSync("tests/idv-pg17/run-disposable.mjs", "utf8");
    const order = ["assertions-digilocker-required.sql", "20261123120000_idv_digilocker_aadhaar_acr.sql", "assertions-digilocker-aadhaar-acr.sql"].map(x => runner.indexOf(x));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
