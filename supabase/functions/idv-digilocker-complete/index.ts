import { z } from "zod";
import { readDigiLockerRuntime } from "../_shared/idv/digilocker-config.ts";
import {
  DigiLockerError, confirmDigiLockerId, derivePkceVerifier, exchangeCode, fingerprintDigiLockerId, revokeToken, sha256Hex,
} from "../_shared/idv/digilocker-client.ts";
import { defaultDeps, type IdvDeps } from "../_shared/idv/digilocker-deps.ts";

declare const Deno: {
  env: { toObject(): Record<string, string | undefined> };
  serve(handler: (req: Request) => Promise<Response>): void;
};

// The browser relays the callback query. Nothing in it is trusted as identity: only the server-side exchange is.
export const completePayloadSchema = z.object({
  state: z.string().regex(/^[0-9a-f]{64}$/),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().max(128).optional(),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleDigiLockerComplete(
  req: Request,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  deps: IdvDeps = defaultDeps,
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });

  const runtime = readDigiLockerRuntime(env);
  if (!runtime) return json(503, { error: "FEATURE_DISABLED" });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return json(401, { error: "UNAUTHORIZED" });

  let raw: unknown;
  try { raw = await req.json(); } catch { return json(400, { error: "INVALID_REQUEST" }); }
  const parsed = completePayloadSchema.safeParse(raw);
  if (!parsed.success || (!parsed.data.code && !parsed.data.error)) return json(400, { error: "INVALID_REQUEST" });
  const { state, code, error: providerError } = parsed.data;

  const url = env["SUPABASE_URL"] ?? "";
  const userClient = deps.makeClient(url, env["SUPABASE_ANON_KEY"] ?? "", authHeader);
  const { data: u, error: uErr } = await userClient.auth.getUser();
  if (uErr || !u?.user) return json(401, { error: "UNAUTHORIZED" });
  const userId: string = u.user.id;
  const admin = deps.makeClient(url, env["SUPABASE_SERVICE_ROLE_KEY"] ?? "");

  // 1. Single-use, user-bound state. Consumed before any provider call so a replay can never reach the provider.
  const { data: c, error: cErr } = await admin.rpc("server_idv_dl_consume_state", {
    p_user_id: userId,
    p_state_hash: await sha256Hex(state),
  });
  if (cErr || !c?.success) {
    const e = c?.error === "ATTEMPT_EXPIRED" ? "ATTEMPT_EXPIRED" : c?.error === "STATE_ALREADY_USED" ? "STATE_ALREADY_USED" : "ATTEMPT_NOT_FOUND";
    return json(e === "ATTEMPT_EXPIRED" ? 410 : e === "STATE_ALREADY_USED" ? 409 : 404, { error: e });
  }
  const attemptId: string = c.attempt_id;
  const fail = async (status: number, errCode: string) => {
    await admin.rpc("server_idv_dl_fail_attempt", { p_attempt_id: attemptId, p_user_id: userId, p_code: errCode });
    return json(status, { error: errCode });
  };

  if (providerError || !code) return fail(400, "CONSENT_DENIED");

  // 2. Server-side exchange. The digilockerid is taken from the authenticated back-channel token response; when
  //    userdetails is approved for this client it must also match /oauth2/1/user. Anything missing fails closed.
  let accessToken = "";
  let fingerprint: string;
  let legacyFingerprints: string[];
  try {
    const verifier = await derivePkceVerifier(runtime.stateKey, state);
    const ex = await exchangeCode(runtime.client, code, verifier, fetchImpl);
    accessToken = ex.accessToken;
    const id = runtime.requireUserDetails ? await confirmDigiLockerId(accessToken, ex.digilockerid, fetchImpl) : ex.digilockerid;
    fingerprint = await fingerprintDigiLockerId(runtime.currentFpKey.key, id);
    legacyFingerprints = await Promise.all(runtime.legacyFpKeys.map((k) => fingerprintDigiLockerId(k.key, id)));
  } catch (e) {
    if (accessToken) await revokeToken(runtime.client, accessToken, fetchImpl);
    const code2 = e instanceof DigiLockerError ? e.code : "PROVIDER_UNAVAILABLE";
    const status = code2 === "PROVIDER_TIMEOUT" ? 504 : code2 === "PROVIDER_UNAVAILABLE" ? 502 : 422;
    return fail(status, code2);
  }
  await revokeToken(runtime.client, accessToken, fetchImpl); // identity obtained; the token has no further use

  // 3. Atomic bind + badge.
  const { data: r, error: rErr } = await admin.rpc("server_idv_dl_complete", {
    p_attempt_id: attemptId,
    p_user_id: userId,
    p_id_fingerprint: fingerprint,
    p_key_version: runtime.currentFpKey.version,
    p_legacy_fingerprints: legacyFingerprints,
  });
  if (rErr || !r) return json(500, { error: "COMPLETION_FAILED" });
  if (!r.success) {
    const e = r.error as string;
    if (e === "IDENTITY_ALREADY_LINKED") return json(409, { error: e, recoveryHint: true });
    if (e === "VERIFICATION_UNAVAILABLE") return json(403, { error: e, recoveryHint: true });
    if (e === "ACCOUNT_LINKED_TO_OTHER_IDENTITY") return json(409, { error: e });
    return json(400, { error: "COMPLETION_FAILED" });
  }
  return json(200, { success: true, verified: true });
}

if (typeof Deno !== "undefined" && "serve" in Deno) {
  Deno.serve((req) => handleDigiLockerComplete(req, Deno.env.toObject()));
}
