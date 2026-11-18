// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { handleDigiLockerStart } from "../../supabase/functions/idv-digilocker-start/index";
import { handleDigiLockerComplete } from "../../supabase/functions/idv-digilocker-complete/index";
import { readDigiLockerRuntime } from "../../supabase/functions/_shared/idv/digilocker-config";
import {
  derivePkceVerifier, fingerprintDigiLockerId, pkceChallenge, sha256Hex, DIGILOCKER_HOST,
} from "../../supabase/functions/_shared/idv/digilocker-client";

const KEY = "s".repeat(40); // state/PKCE key
const FP1 = "f".repeat(40);
const FP2 = "g".repeat(40);
const DLID = "123e4567-e89b-12d3-a456-426655440000";
const DLID2 = "223e4567-e89b-12d3-a456-426655440001";
const STAGE_REDIRECT = "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback";
const PROD_REDIRECT = "https://fairswap.in/api/idv/digilocker/callback";

const stageEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  FAIRSWAP_DIGILOCKER_ENABLED: "true",
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
    if (name === "server_idv_dl_complete") {
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

function providerFetch(opts: { id?: string; userId?: string; tokenStatus?: number; userStatus?: number; tokenBody?: any; timeout?: boolean } = {}) {
  const log: { url: string; body?: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body as string });
    if (opts.timeout) { const e = new Error("t"); e.name = "AbortError"; throw e; }
    if (url.endsWith("/oauth2/1/token")) {
      const status = opts.tokenStatus ?? 200;
      return new Response(JSON.stringify(opts.tokenBody ?? { access_token: "tok-secret", token_type: "Bearer", digilockerid: opts.id ?? DLID, name: "Ajit", dob: "31121970" }), { status });
    }
    if (url.endsWith("/oauth2/1/user")) {
      const status = opts.userStatus ?? 200;
      return new Response(JSON.stringify({ digilockerid: opts.userId ?? opts.id ?? DLID, name: "Ajit", mobile: "9999999999", email: "a@b.c" }), { status });
    }
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
const complete = (w: ReturnType<typeof makeWorld>, f: typeof fetch, state: string, extra: any = { code: "auth-code" }, user = "user-1", env = stageEnv()) =>
  handleDigiLockerComplete(req({ state, ...extra }, `Bearer ${user}`), env, f, w.deps);

describe("DigiLocker direct verification", () => {
  it("first-time verification: PKCE S256, exact redirect, no document scopes, then verified", async () => {
    const w = makeWorld();
    const { res, body, state } = await startFlow(w);
    expect(res.status).toBe(200);
    const u = new URL(body.redirectUrl);
    expect(u.origin).toBe(DIGILOCKER_HOST);
    expect(u.pathname).toBe("/public/oauth2/1/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe(STAGE_REDIRECT);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(await derivePkceVerifier(KEY, state)));
    for (const p of ["scope", "acr", "req_doctype", "amr", "dl_flow"]) expect(u.searchParams.has(p)).toBe(false);
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const p = providerFetch();
    const done = await complete(w, p.f, state);
    expect(done.status).toBe(200);
    expect(w.verified.has("user-1")).toBe(true);
    const tokenCall = p.log.find((l) => l.url.endsWith("/oauth2/1/token"))!;
    expect(tokenCall.body).toContain("code_verifier=" + (await derivePkceVerifier(KEY, state)));
    expect(tokenCall.body).toContain("grant_type=authorization_code");
    expect(w.bindings[0].fp).toBe(await fingerprintDigiLockerId(FP1, DLID));
    expect(w.bindings[0].fp).not.toContain(DLID);
    // userdetails not approved by default: /oauth2/1/user is never called.
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/user"))).toBe(false);
  });

  it("openid scope is opt-in only; ACR/AMR are never sent", async () => {
    const w = makeWorld();
    const on = await startFlow(w, "user-1", stageEnv({ DIGILOCKER_REQUEST_OPENID_SCOPE: "true" }));
    const u = new URL(on.body.redirectUrl);
    expect(u.searchParams.get("scope")).toBe("openid");
    expect(u.searchParams.has("acr") || u.searchParams.has("amr")).toBe(false);
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
      complete(w, providerFetch().f, a.state, { code: "c" }, "user-1"),
      complete(w, providerFetch().f, b.state, { code: "c" }, "user-2"),
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
    ["missing digilockerid", { access_token: "t", token_type: "Bearer" }],
    ["short digilockerid", { access_token: "t", token_type: "Bearer", digilockerid: "abc" }],
    ["non-bearer token", { access_token: "t", token_type: "mac", digilockerid: DLID }],
    ["missing access token", { token_type: "Bearer", digilockerid: DLID }],
  ])("fails closed on %s", async (_n, tokenBody) => {
    const w = makeWorld(); const { state } = await startFlow(w);
    const r = await complete(w, providerFetch({ tokenBody }).f, state);
    expect(r.status).toBe(422);
    expect(w.verified.size).toBe(0);
  });

  it("userdetails approved: /user must confirm the same id; mismatch or missing scope fails closed", async () => {
    const env = stageEnv({ DIGILOCKER_USERDETAILS_APPROVED: "true" });
    const w = makeWorld(); const s1 = await startFlow(w, "user-1", env);
    expect((await complete(w, providerFetch({ userId: DLID2 }).f, s1.state, { code: "c" }, "user-1", env)).status).toBe(422);
    const s2 = await startFlow(w, "user-1", env);
    expect((await complete(w, providerFetch({ userStatus: 403 }).f, s2.state, { code: "c" }, "user-1", env)).status).toBe(422);
    expect(w.verified.size).toBe(0);
    const s3 = await startFlow(w, "user-1", env);
    const p = providerFetch();
    expect((await complete(w, p.f, s3.state, { code: "c" }, "user-1", env)).status).toBe(200);
    expect(p.log.some((l) => l.url.endsWith("/oauth2/1/user"))).toBe(true);
  });

  it("OpenID-only client: no digilockerid in the token response fails closed (never inferred from id_token)", async () => {
    const w = makeWorld(); const { state } = await startFlow(w);
    const tokenBody = { access_token: "t", token_type: "Bearer", scope: "openid", id_token: "eyJ.eyJ.sig" };
    const r = await complete(w, providerFetch({ tokenBody }).f, state);
    expect(r.status).toBe(422);
    expect(w.verified.size).toBe(0);
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
