import { z } from "zod";
import { DigiLockerError, generateState, revokeToken, sha256Hex } from "../_shared/idv/digilocker-client.ts";
import { defaultDeps, type IdvDeps } from "../_shared/idv/digilocker-deps.ts";
import { handleLabFlow, isLabFlowRequest } from "../_shared/idv/digilocker-lab.ts";
import {
  DIAG_STATE_TTL_SECONDS, type DiagRaw, buildDiagAuthorizeUrl, deriveDiagNonce, evaluateIdToken, exchangeDiagCode, readDiagRuntime,
  type DiagResult,
} from "../_shared/idv/digilocker-oidc-diag.ts";

declare const Deno: {
  env: { toObject(): Record<string, string | undefined> };
  serve(handler: (req: Request) => Promise<Response>): void;
};

// STAGE-ONLY DigiLocker OIDC v2 diagnostic. Allowlisted testers only. It never calls server_idv_dl_complete,
// never writes identity bindings or badges, persists nothing and writes nothing to logs. It returns the verdict plus the
// provider's unredacted token response (DiagResult.raw) to the allowlisted FairSwapTest tester only.
export const diagPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({
    action: z.literal("complete"),
    state: z.string().regex(/^[0-9a-f]{64}$/),
    code: z.string().min(1).max(2048).optional(),
    // Provider OAuth error code and description, relayed verbatim by the Web callback for the tester display.
    error: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    error_description: z.string().max(500).optional(),
  }).strict(),
]);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });

export async function handleDigiLockerDiagnostic(
  req: Request,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  deps: IdvDeps = defaultDeps,
  now: () => number = Date.now,
): Promise<Response> {
  // Identity Lab (flow:"lab") has its own credentials, state namespace and strict contract; it never shares this
  // diagnostic's runtime gate or response shape. Requests without flow:"lab" fall through unchanged.
  if (await isLabFlowRequest(req)) return handleLabFlow(req, env, fetchImpl, deps, now);

  const rt = readDiagRuntime(env);
  if (!rt) return json(404, { error: "NOT_FOUND" }); // closed, non-Test project or misconfigured: behave as absent
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return json(401, { error: "UNAUTHORIZED" });

  let raw: unknown;
  try { raw = await req.json(); } catch { return json(400, { error: "INVALID_REQUEST" }); }
  const parsed = diagPayloadSchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: "INVALID_REQUEST" });

  const url = env["SUPABASE_URL"] ?? "";
  const userClient = deps.makeClient(url, env["SUPABASE_ANON_KEY"] ?? "", authHeader);
  const { data: u, error: uErr } = await userClient.auth.getUser();
  if (uErr || !u?.user?.id) return json(401, { error: "UNAUTHORIZED" });
  const userId = String(u.user.id).toLowerCase();
  if (!rt.testerIds.has(userId)) return json(403, { error: "FORBIDDEN" }); // checked before any write or provider call

  const admin = deps.makeClient(url, env["SUPABASE_SERVICE_ROLE_KEY"] ?? "");
  const body = parsed.data;

  if (body.action === "start") {
    const state = generateState();
    const { data: r, error: rErr } = await admin.rpc("server_idv_dl_diag_start", {
      p_user_id: userId,
      p_state_hash: await sha256Hex(state),
      p_ttl_seconds: DIAG_STATE_TTL_SECONDS,
    });
    if (rErr || !r) return json(500, { error: "START_FAILED" });
    if (!r.success) return r.error === "RATE_LIMIT_EXCEEDED" ? json(429, { error: "RATE_LIMIT_EXCEEDED" }) : json(500, { error: "START_FAILED" });
    return json(200, { success: true, redirectUrl: await buildDiagAuthorizeUrl(rt, state) });
  }

  // complete: consume the single-use, user-bound, short-lived state before any provider call (replay never reaches the provider)
  const { state, code, error: providerError, error_description: providerErrorDescription } = body;
  if (!code && !providerError) return json(400, { error: "INVALID_REQUEST" });
  const { data: c, error: cErr } = await admin.rpc("server_idv_dl_diag_consume", {
    p_user_id: userId,
    p_state_hash: await sha256Hex(state),
  });
  if (cErr || !c?.success) {
    const e = c?.error === "ATTEMPT_EXPIRED" ? "ATTEMPT_EXPIRED" : c?.error === "STATE_ALREADY_USED" ? "STATE_ALREADY_USED" : "ATTEMPT_NOT_FOUND";
    return json(e === "ATTEMPT_EXPIRED" ? 410 : e === "STATE_ALREADY_USED" ? 409 : 404, { error: e });
  }

  const endpoints = { authorize: rt.authorizeVersion, token: "2" as const };
  const result = (r: DiagResult) => json(200, { success: true, result: r });
  if (providerError || !code) {
    const raw: DiagRaw = {
      providerCallback: providerError ? { error: providerError, error_description: providerErrorDescription ?? null } : null,
      tokenResponse: null, expected: null,
    };
    // access_denied (and the legacy "denied") is a user cancellation. Any other provider error is reported as its own
    // code, so a KYC-required or provider-side failure is never mislabelled as a consent denial.
    return providerError && providerError !== "denied" && providerError !== "access_denied"
      ? result({ outcome: "FAILED", code: `PROVIDER_ERR_${providerError.toUpperCase().replace(/[^A-Z_]/g, "_").slice(0, 24)}`, endpoints, checks: null, claimNames: null, raw })
      : result({ outcome: "CANCELLED", code: "CONSENT_DENIED", endpoints, checks: null, claimNames: null, raw });
  }

  let accessToken: string | null = null;
  try {
    const ex = await exchangeDiagCode(rt, code, state, fetchImpl);
    accessToken = ex.accessToken;
    const nonce = await deriveDiagNonce(rt.stateKey, state);
    const nowS = Math.floor(now() / 1000);
    const raw: DiagRaw = {
      providerCallback: null,
      tokenResponse: ex.response,
      expected: { issuer: rt.expectedIssuer, audience: rt.clientId, nonce, checkedAtEpoch: nowS },
    };
    if (ex.failure || !ex.idToken) {
      return result({ outcome: "FAILED", code: ex.failure ?? "INVALID_PROVIDER_RESPONSE", endpoints, checks: null, claimNames: null, raw });
    }
    return result({ ...(await evaluateIdToken(rt, ex.idToken, nonce, nowS, fetchImpl)), raw });
  } catch (e) {
    const code2 = e instanceof DigiLockerError ? e.code : "PROVIDER_UNAVAILABLE";
    return result({ outcome: "FAILED", code: code2, endpoints, checks: null, claimNames: null });
  } finally {
    if (accessToken) {
      await revokeToken({ clientId: rt.clientId, clientSecret: rt.clientSecret, redirectUri: rt.redirectUri }, accessToken, fetchImpl);
    }
  }
}

if (typeof Deno !== "undefined" && "serve" in Deno) {
  Deno.serve((req) => handleDigiLockerDiagnostic(req, Deno.env.toObject()));
}
