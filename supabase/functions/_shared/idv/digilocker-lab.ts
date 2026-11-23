// FairSwap DigiLocker IDENTITY LAB (flow:"lab"). STAGE-ONLY, FairSwapTest only. Not identity verification.
// A SECOND, separate Authpartner: its own client id/secret/redirect URI, state key, state namespace, PKCE verifier and
// nonce. It tells an allowlisted tester which token fields/claims the provider sends and whether signed acr=aadhaar is
// proven. It never links an identity, issues a badge, persists a token or claim, or returns any value: the response
// is a fixed, strict, value-free schema (names, types, verdict enums). Tokens and personal data are removed HERE,
// before anything reaches the Web app. Reuses the diagnostic's token exchange and ID-token validation (no new crypto).
import { z } from "zod";
import { DIGILOCKER_ID_PATTERN, DigiLockerError, generateState, revokeToken, sha256Hex } from "./digilocker-client.ts";
import { defaultDeps, type IdvDeps } from "./digilocker-deps.ts";
import {
  DIAG_ALLOWED_PROJECT_REF, DIAG_STATE_TTL_SECONDS, DIGILOCKER_OIDC_ISSUER, DIGILOCKER_OIDC_JWKS_URL, type DiagRuntime,
  buildDiagAuthorizeUrl, deriveLabNonce, evaluateIdToken, exchangeDiagCode,
} from "./digilocker-oidc-diag.ts";
import { resolveProjectRef } from "./idv-config.ts";

/** The only registered Lab redirect URI. No Production entry, no override. */
export const LAB_REDIRECT_URI_BY_PROJECT: Record<string, string> = {
  [DIAG_ALLOWED_PROJECT_REF]: "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/lab/callback",
};
const MIN_KEY_LENGTH = 32;
const MAX_TESTERS = 5;
const MAX_NAMES = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lab states live in their own hash namespace, so a diagnostic or primary state can never be consumed here or vice versa. */
export const labStateHash = (state: string) => sha256Hex(`fs:dl:lab:state:v1:${state}`);

// ---------------- Strict contract (identical shape to Web `labResultSchema`) ----------------
export const LAB_ERROR_CODES = [
  "INVALID_RESULT", "INVALID_CONTRACT", "INVALID_CALLBACK", "INVALID_PROVIDER_REDIRECT", "STATE_INVALID", "STATE_EXPIRED",
  "STATE_ALREADY_USED", "FORBIDDEN", "UNAUTHORIZED", "RATE_LIMIT_EXCEEDED", "NOT_FOUND", "LAB_NOT_CONFIGURED",
  "PROVIDER_DENIED", "PROVIDER_ERROR", "TOKEN_EXCHANGE_FAILED", "RESPONSE_TOO_LARGE", "EDGE_FUNCTION_UNAVAILABLE", "START_FAILED",
] as const;
export type LabErrorCode = (typeof LAB_ERROR_CODES)[number];
const errorCode = z.enum(LAB_ERROR_CODES);
const claimName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const valueType = z.enum(["string", "number", "boolean", "object", "array", "null"]);
const fieldList = z.array(z.object({ name: claimName, type: valueType }).strict()).max(MAX_NAMES);
const tri = z.enum(["verified", "unconfirmed", "failed"]);
const presence = z.enum(["present", "absent", "empty", "null", "invalid"]);
export const labResultSchema = z.object({
  outcome: z.enum(["VERIFIED", "UNCONFIRMED", "NOT_VERIFIED", "CANCELLED", "FAILED"]),
  errorCode: errorCode.nullable(),
  httpStatusBucket: z.enum(["2xx", "3xx", "4xx", "5xx", "none"]),
  tokenResponseFields: fieldList,
  idTokenClaims: fieldList,
  checks: z.object({
    signature: tri, issuer: tri, audience: tri, expiry: tri, issuedAt: tri,
    nonce: z.enum(["match", "absent", "mismatch"]),
    acr: z.enum(["aadhaar", "missing", "other", "invalid"]),
  }).strict(),
  presence: z.object({
    digilockerid: presence, eaadhaar: presence, masked_aadhaar: presence, name: presence, dob: presence, gender: presence,
  }).strict(),
}).strict();
export type LabResult = z.infer<typeof labResultSchema>;

const PROVIDER_ERRORS = ["access_denied", "temporarily_unavailable", "server_error", "invalid_request", "denied"] as const;
export const labPayloadSchema = z.union([
  z.object({ action: z.literal("start"), flow: z.literal("lab") }).strict(),
  z.object({
    action: z.literal("complete"), flow: z.literal("lab"), state: z.string().regex(/^[0-9a-f]{64}$/),
    code: z.string().min(1).max(2048).optional(), error: z.enum(PROVIDER_ERRORS).optional(),
  }).strict().refine((v) => (v.code === undefined) !== (v.error === undefined)), // exactly one, never both
]);

// ---------------- Runtime (separate Lab environment variables; fails closed) ----------------
export interface LabRuntime { rt: DiagRuntime }
export type LabState = { kind: "off" } | { kind: "misconfigured" } | { kind: "ready"; lab: LabRuntime };

/** Never throws. "off" (flag off or not the FairSwapTest project) behaves as absent; "misconfigured" reports LAB_NOT_CONFIGURED.
 *  Primary-flow credentials are never read as a fallback; Lab credentials that equal them are rejected (no cross-client mixing). */
export function readLabRuntime(env: Record<string, string | undefined>): LabState {
  if ((env["FAIRSWAP_DIGILOCKER_LAB_ENABLED"] ?? "false").toLowerCase() !== "true") return { kind: "off" };
  let projectRef: string;
  try { projectRef = resolveProjectRef(env).projectRef; } catch { return { kind: "off" }; }
  const expectedRedirect = LAB_REDIRECT_URI_BY_PROJECT[projectRef];
  if (!expectedRedirect) return { kind: "off" }; // Production and every other project: absent
  const bad = { kind: "misconfigured" } as const;

  const redirectUri = (env["DIGILOCKER_LAB_REDIRECT_URI"] ?? "").trim();
  const clientId = (env["DIGILOCKER_LAB_CLIENT_ID"] ?? "").trim();
  const clientSecret = (env["DIGILOCKER_LAB_CLIENT_SECRET"] ?? "").trim();
  const stateKey = (env["DIGILOCKER_LAB_STATE_KEY"] ?? "").trim();
  if (redirectUri !== expectedRedirect) return bad;
  if (!clientId || !clientSecret || stateKey.length < MIN_KEY_LENGTH) return bad;

  const testers = (env["DIGILOCKER_LAB_TESTER_IDS"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (testers.length === 0 || testers.length > MAX_TESTERS || !testers.every((t) => UUID.test(t))) return bad;

  const av = (env["DIGILOCKER_LAB_AUTHORIZE_VERSION"] ?? "1").trim();
  if (av !== "1" && av !== "2") return bad;

  // Independence from the primary Authpartner and the existing diagnostic: nothing may be shared.
  const same = (name: string, v: string) => (env[name] ?? "").trim() === v && v !== "";
  if (same("DIGILOCKER_CLIENT_ID", clientId) || same("DIGILOCKER_CLIENT_SECRET", clientSecret)) return bad;
  if (same("DIGILOCKER_REDIRECT_URI", redirectUri) || same("IDV_DIGILOCKER_STATE_KEY", stateKey)) return bad;
  for (const [name, v] of Object.entries(env)) if (/^IDV_DIGILOCKER_FP_KEY_V[0-9]{1,3}$/.test(name) && (v ?? "").trim() === stateKey) return bad;

  return {
    kind: "ready",
    lab: {
      rt: {
        clientId, clientSecret, redirectUri, stateKey, authorizeVersion: av, domain: "lab",
        testerIds: new Set(testers), jwksUrl: DIGILOCKER_OIDC_JWKS_URL, expectedIssuer: DIGILOCKER_OIDC_ISSUER,
        acrSemanticsConfirmed: (env["DIGILOCKER_LAB_ACR_SEMANTICS_CONFIRMED"] ?? "false").toLowerCase() === "true",
      },
    },
  };
}

// ---------------- Sanitizing (values never leave this function's inputs) ----------------
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
type ValueType = z.infer<typeof valueType>;
const typeOf = (v: unknown): ValueType =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "string" ? "string" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "object";
const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const names = (o: Record<string, unknown> | null) =>
  o ? Object.keys(o).filter((k) => NAME.test(k)).sort().slice(0, MAX_NAMES).map((name) => ({ name, type: typeOf(o[name]) })) : [];

function decodePayload(idToken: string | null): Record<string, unknown> | null {
  const seg = idToken?.split(".")[1];
  if (!seg || !/^[A-Za-z0-9_-]+$/.test(seg)) return null;
  try {
    const bin = atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((seg.length + 3) % 4));
    return asObject(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))));
  } catch { return null; }
}

type Presence = z.infer<typeof presence>;
const FIELD_FORMAT: Record<string, (v: unknown) => boolean> = {
  digilockerid: (v) => typeof v === "string" && DIGILOCKER_ID_PATTERN.test(v),
  eaadhaar: (v) => typeof v === "boolean" || (typeof v === "string" && /^(?:[YyNn]|true|false)$/.test(v)),
  // A masked number shows at most the last four digits. A fully visible number is reported as invalid, never echoed.
  masked_aadhaar: (v) => typeof v === "string" && /^[Xx*0-9 -]{8,20}$/.test(v) && (v.match(/[0-9]/g) ?? []).length <= 4,
  name: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v),
  dob: (v) => typeof v === "string" && /^(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}[-/]\d{2}[-/]\d{4})$/.test(v),
  gender: (v) => typeof v === "string" && /^[A-Za-z]{1,12}$/.test(v),
};
/** ID-token claim first, then the token-response field. Only a state is returned, never the value. */
function presenceOf(field: string, claims: Record<string, unknown> | null, tokenJson: Record<string, unknown> | null): Presence {
  const src = claims && Object.prototype.hasOwnProperty.call(claims, field) ? claims
    : tokenJson && Object.prototype.hasOwnProperty.call(tokenJson, field) ? tokenJson : null;
  if (!src) return "absent";
  const v = src[field];
  if (v === null) return "null";
  if ((typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && Object.keys(v as object).length === 0)) return "empty";
  return FIELD_FORMAT[field](v) ? "present" : "invalid";
}

const bucket = (status: number | null): LabResult["httpStatusBucket"] =>
  status === null ? "none" : status >= 200 && status < 300 ? "2xx" : status >= 300 && status < 400 ? "3xx" : status >= 400 && status < 500 ? "4xx" : status >= 500 && status < 600 ? "5xx" : "none";

const EMPTY_CHECKS: LabResult["checks"] = { signature: "unconfirmed", issuer: "unconfirmed", audience: "unconfirmed", expiry: "unconfirmed", issuedAt: "unconfirmed", nonce: "absent", acr: "missing" };
const ABSENT_PRESENCE: LabResult["presence"] = { digilockerid: "absent", eaadhaar: "absent", masked_aadhaar: "absent", name: "absent", dob: "absent", gender: "absent" };
export const failedLabResult = (code: LabErrorCode, status: number | null = null): LabResult => ({
  outcome: "FAILED", errorCode: code, httpStatusBucket: bucket(status), tokenResponseFields: [], idTokenClaims: [], checks: EMPTY_CHECKS, presence: ABSENT_PRESENCE,
});

const FAILURE_CODE: Record<string, LabErrorCode> = {
  PROVIDER_UNAVAILABLE: "PROVIDER_ERROR", PROVIDER_TIMEOUT: "PROVIDER_ERROR", PROVIDER_REJECTED: "TOKEN_EXCHANGE_FAILED",
  INVALID_PROVIDER_RESPONSE: "TOKEN_EXCHANGE_FAILED", INVALID_ID_TOKEN: "TOKEN_EXCHANGE_FAILED",
};
const triOf = (ok: boolean): z.infer<typeof tri> => (ok ? "verified" : "failed");

/** Pure: builds the value-free result from the exchange and the (already evaluated) ID token. Exported for tests. */
export function buildLabResult(
  ex: { response: { httpStatus: number; json: unknown }; idToken: string | null; failure: string | null; oversize?: true },
  verdict: Awaited<ReturnType<typeof evaluateIdToken>> | null,
): LabResult {
  const status = ex.response.httpStatus;
  if (ex.oversize) return failedLabResult("RESPONSE_TOO_LARGE", status);
  const tokenJson = asObject(ex.response.json);
  const claims = decodePayload(ex.idToken);
  const a = claims?.["acr"];
  const dc = verdict?.checks ?? null;
  const checks: LabResult["checks"] = !dc ? EMPTY_CHECKS : {
    signature: dc.signature, issuer: dc.issuer, audience: triOf(dc.audience), expiry: triOf(dc.expiry), issuedAt: triOf(dc.issuedAt), nonce: dc.nonce,
    acr: a === undefined || a === null || a === "" ? "missing" : typeof a !== "string" ? "invalid" : a === "aadhaar" ? "aadhaar" : "other",
  };
  const outcome = ex.failure || status < 200 || status >= 300 ? "FAILED" : verdict ? verdict.outcome : "FAILED";
  const failed = outcome === "FAILED";
  return {
    outcome,
    errorCode: failed ? FAILURE_CODE[ex.failure ?? verdict?.code ?? ""] ?? "TOKEN_EXCHANGE_FAILED" : null,
    httpStatusBucket: bucket(status),
    tokenResponseFields: names(tokenJson),
    idTokenClaims: names(claims),
    checks,
    presence: {
      digilockerid: presenceOf("digilockerid", claims, tokenJson), eaadhaar: presenceOf("eaadhaar", claims, tokenJson),
      masked_aadhaar: presenceOf("masked_aadhaar", claims, tokenJson), name: presenceOf("name", claims, tokenJson),
      dob: presenceOf("dob", claims, tokenJson), gender: presenceOf("gender", claims, tokenJson),
    },
  };
}

// ---------------- Handler ----------------
const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
const fail = (status: number, error: LabErrorCode) => respond(status, { success: false, flow: "lab", error });

/** True when the (unconsumed) request body asks for the Lab flow. Reads a clone; never throws. */
export async function isLabFlowRequest(req: Request): Promise<boolean> {
  if (req.method !== "POST") return false;
  try { return asObject(await req.clone().json())?.["flow"] === "lab"; } catch { return false; }
}

export async function handleLabFlow(
  req: Request, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch, deps: IdvDeps = defaultDeps, now: () => number = Date.now,
): Promise<Response> {
  const st = readLabRuntime(env);
  if (st.kind === "off") return fail(404, "NOT_FOUND");
  if (st.kind === "misconfigured") return fail(503, "LAB_NOT_CONFIGURED");
  const { rt } = st.lab;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return fail(401, "UNAUTHORIZED");
  let raw: unknown;
  try { raw = await req.json(); } catch { return fail(400, "INVALID_CALLBACK"); }
  const parsed = labPayloadSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "INVALID_CALLBACK");

  const url = env["SUPABASE_URL"] ?? "";
  const userClient = deps.makeClient(url, env["SUPABASE_ANON_KEY"] ?? "", authHeader);
  const { data: u, error: uErr } = await userClient.auth.getUser();
  if (uErr || !u?.user?.id) return fail(401, "UNAUTHORIZED");
  const userId = String(u.user.id).toLowerCase();
  if (!rt.testerIds.has(userId)) return fail(403, "FORBIDDEN"); // before any write or provider call

  const admin = deps.makeClient(url, env["SUPABASE_SERVICE_ROLE_KEY"] ?? "");
  const body = parsed.data;

  if (body.action === "start") {
    const state = generateState();
    const { data: r, error: rErr } = await admin.rpc("server_idv_dl_diag_start", {
      p_user_id: userId, p_state_hash: await labStateHash(state), p_ttl_seconds: DIAG_STATE_TTL_SECONDS,
    });
    if (rErr || !r) return fail(500, "START_FAILED");
    if (!r.success) return r.error === "RATE_LIMIT_EXCEEDED" ? fail(429, "RATE_LIMIT_EXCEEDED") : fail(500, "START_FAILED");
    return respond(200, { success: true, flow: "lab", redirectUrl: await buildDiagAuthorizeUrl(rt, state) });
  }

  // complete: single-use, user-bound state is consumed before any provider call
  const { state, code, error: providerError } = body;
  const { data: c, error: cErr } = await admin.rpc("server_idv_dl_diag_consume", { p_user_id: userId, p_state_hash: await labStateHash(state) });
  if (cErr || !c?.success) {
    return c?.error === "ATTEMPT_EXPIRED" ? fail(410, "STATE_EXPIRED") : c?.error === "STATE_ALREADY_USED" ? fail(409, "STATE_ALREADY_USED") : fail(404, "STATE_INVALID");
  }
  const send = (r: LabResult) => {
    const ok = labResultSchema.safeParse(r); // exact contract or nothing
    return ok.success ? respond(200, { success: true, flow: "lab", result: ok.data }) : fail(500, "INVALID_RESULT");
  };
  if (providerError || !code) {
    const denied = providerError === "denied" || providerError === "access_denied";
    return send({ ...failedLabResult(denied ? "PROVIDER_DENIED" : "PROVIDER_ERROR"), outcome: denied ? "CANCELLED" : "FAILED" });
  }

  let accessToken: string | null = null;
  try {
    const ex = await exchangeDiagCode(rt, code, state, fetchImpl);
    accessToken = ex.accessToken;
    const nowS = Math.floor(now() / 1000);
    const verdict = ex.idToken && !ex.oversize && !ex.failure ? await evaluateIdToken(rt, ex.idToken, await deriveLabNonce(rt.stateKey, state), nowS, fetchImpl) : null;
    return send(buildLabResult(ex, verdict));
  } catch (e) {
    return send(failedLabResult(e instanceof DigiLockerError && e.code === "PROVIDER_TIMEOUT" ? "PROVIDER_ERROR" : "PROVIDER_ERROR"));
  } finally {
    if (accessToken) await revokeToken({ clientId: rt.clientId, clientSecret: rt.clientSecret, redirectUri: rt.redirectUri }, accessToken, fetchImpl);
  }
}
