import { z } from "zod";
import { readDigiLockerRuntime, APPROVED_DIGILOCKER_POLICY_VERSION } from "../_shared/idv/digilocker-config.ts";
import { defaultDeps, type IdvDeps } from "../_shared/idv/digilocker-deps.ts";
import { deriveOidcNonce, buildOidcAuthorizeUrl } from "../_shared/idv/digilocker-oidc.ts";
import { buildAuthorizeUrl, derivePkceVerifier, generateState, sha256Hex } from "../_shared/idv/digilocker-client.ts";

declare const Deno: {
  env: { toObject(): Record<string, string | undefined> };
  serve(handler: (req: Request) => Promise<Response>): void;
};

export const startPayloadSchema = z.object({
  consentAcknowledged: z.literal(true),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleDigiLockerStart(
  req: Request,
  env: Record<string, string | undefined>,
  deps: IdvDeps = defaultDeps,
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });

  const runtime = readDigiLockerRuntime(env);
  if (!runtime) return json(503, { error: "FEATURE_DISABLED", message: "DigiLocker verification is not available yet." });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return json(401, { error: "UNAUTHORIZED" });

  let raw: unknown = {};
  try { raw = await req.json(); } catch { /* empty */ }
  if (!startPayloadSchema.safeParse(raw).success) {
    return json(400, { error: "CONSENT_REQUIRED", message: "Please confirm consent to continue." });
  }

  const url = env["SUPABASE_URL"] ?? "";
  const userClient = deps.makeClient(url, env["SUPABASE_ANON_KEY"] ?? "", authHeader);
  const { data: u, error: uErr } = await userClient.auth.getUser();
  if (uErr || !u?.user) return json(401, { error: "UNAUTHORIZED" });
  const userId: string = u.user.id;

  const admin = deps.makeClient(url, env["SUPABASE_SERVICE_ROLE_KEY"] ?? "");
  const state = generateState();
  const { data: r, error: rErr } = await admin.rpc("server_idv_dl_start_attempt", {
    p_user_id: userId,
    p_state_hash: await sha256Hex(state),
    p_ttl_seconds: 600,
    p_consent_purpose: "FairSwap account verification via DigiLocker",
    p_consent_acknowledged: true,
    p_policy_version: APPROVED_DIGILOCKER_POLICY_VERSION,
  });
  if (rErr || !r) return json(500, { error: "ATTEMPT_INITIALIZATION_FAILED" });
  if (r.already_verified) return json(200, { success: true, alreadyVerified: true });
  if (!r.success) {
    const map: Record<string, number> = { RATE_LIMIT_EXCEEDED: 429, ACCOUNT_NOT_ELIGIBLE: 403, VERIFICATION_UNAVAILABLE: 403, CONSENT_REQUIRED: 400 };
    const code = typeof r.error === "string" && r.error in map ? r.error : "ATTEMPT_INITIALIZATION_FAILED";
    return json(map[code] ?? 400, { error: code, ...(code === "VERIFICATION_UNAVAILABLE" ? { recoveryHint: true } : {}) });
  }

  const verifier = await derivePkceVerifier(runtime.stateKey, state);
  const redirectUrl = runtime.oidc
    ? await buildOidcAuthorizeUrl(runtime.client, state, verifier, await deriveOidcNonce(runtime.stateKey, state))
    : await buildAuthorizeUrl(runtime.client, state, verifier);
  return json(200, { success: true, alreadyVerified: false, redirectUrl });
}

if (typeof Deno !== "undefined" && "serve" in Deno) {
  Deno.serve((req) => handleDigiLockerStart(req, Deno.env.toObject()));
}
