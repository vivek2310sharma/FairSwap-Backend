// FairSwap DigiLocker OIDC v2 STAGE-ONLY DIAGNOSTIC. Not production identity verification.
// It answers one question for an allowlisted tester: does the provider prove Aadhaar-verified assurance (acr=aadhaar)
// in a signature-verified ID token? It never links accounts, never issues a badge and never stores or logs anything.
// For the one allowlisted FairSwapTest tester it returns the provider's token response UNREDACTED (DiagResult.raw) for a
// one-time display. FairSwap's own client secret, state key, service-role key and signing keys are never part of it.
//
// Endpoint discrepancy (resolved conservatively):
//   MeriPehchaan v2.4 (the provider's own specification): authorize /public/oauth2/1/authorize, OIDC token /public/oauth2/2/token.
//   API Setu generator: /public/oauth2/2/authorize and /public/oauth2/2/token.
// Default follows the specification (authorize v1). DIGILOCKER_DIAG_AUTHORIZE_VERSION=2 is the only allowed override, so
// the owner can compare both. The token endpoint is always v2 (both sources agree). The result reports which was used.
import { DIGILOCKER_HOST, DIGILOCKER_PURPOSE, DIGILOCKER_SERVICE_NAME, DigiLockerError, pkceChallenge } from "./digilocker-client.ts";
import { DIGILOCKER_REDIRECT_BY_PROJECT } from "./digilocker-config.ts";
import { resolveProjectRef } from "./idv-config.ts";

/** Hard lock: FairSwapTest only. There is no Production entry and no override. */
export const DIAG_ALLOWED_PROJECT_REF = "wpppxlnbzqynvhpeuavd";
export const DIAG_STATE_TTL_SECONDS = 300;
export const DIAG_ACR = "aadhaar";
export const DIAG_TOKEN_PATH = "/public/oauth2/2/token";
// Provider-published OIDC discovery (GET {host}/.well-known/openid-configuration, checked 19 Nov 2026): issuer, jwks_uri,
// RS256 signing, token_endpoint /public/oauth2/2/token, authorization_endpoint /public/oauth2/1/authorize. The signing kid
// matches the kid in the provider's specification sample token. The specification (v2.3) documents no `acr` claim.
export const DIGILOCKER_OIDC_ISSUER = DIGILOCKER_HOST;
export const DIGILOCKER_OIDC_JWKS_URL = `${DIGILOCKER_HOST}/public/oauth2/jwks`;
const MIN_KEY_LENGTH = 32;
const MAX_TESTERS = 5;
const TIMEOUT_MS = 8000;
const CLOCK_SKEW_S = 60;
const MAX_JWKS_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuthorizeVersion = "1" | "2";

export interface DiagRuntime {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateKey: string;
  authorizeVersion: AuthorizeVersion;
  testerIds: ReadonlySet<string>;
  /** Provider JWKS URL (default: the provider's published jwks_uri). Must stay on the DigiLocker host. */
  jwksUrl: string;
  /** Provider issuer (default: the provider's published issuer). Must stay on the DigiLocker host. */
  expectedIssuer: string;
  /** Owner attests, from provider documentation, that acr=aadhaar in the ID token means Aadhaar-verified assurance.
   *  Default false: an otherwise valid acr=aadhaar token is UNCONFIRMED, never VERIFIED. */
  acrSemanticsConfirmed: boolean;
  /** Derivation domain for PKCE verifier and nonce. Omitted = "diag" (unchanged). The Lab uses "lab", so the two flows can
   *  never derive each other's verifier or nonce even if a state were replayed across them. */
  domain?: "diag" | "lab";
}

function onDigiLockerHost(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.origin === DIGILOCKER_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Returns null (diagnostic closed, endpoint behaves as absent) unless every guard holds. Never throws. */
export function readDiagRuntime(env: Record<string, string | undefined>): DiagRuntime | null {
  if ((env["FAIRSWAP_DIGILOCKER_DIAG_ENABLED"] ?? "false").toLowerCase() !== "true") return null;
  let projectRef: string;
  try {
    projectRef = resolveProjectRef(env).projectRef;
  } catch {
    return null;
  }
  if (projectRef !== DIAG_ALLOWED_PROJECT_REF) return null;

  const redirectUri = (env["DIGILOCKER_REDIRECT_URI"] ?? "").trim();
  if (redirectUri !== DIGILOCKER_REDIRECT_BY_PROJECT[projectRef]) return null; // existing registered Stage URI only
  const clientId = (env["DIGILOCKER_CLIENT_ID"] ?? "").trim();
  const clientSecret = (env["DIGILOCKER_CLIENT_SECRET"] ?? "").trim();
  const stateKey = (env["IDV_DIGILOCKER_STATE_KEY"] ?? "").trim();
  if (!clientId || !clientSecret || stateKey.length < MIN_KEY_LENGTH) return null;

  const testers = (env["DIGILOCKER_DIAG_TESTER_IDS"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (testers.length === 0 || testers.length > MAX_TESTERS || !testers.every((t) => UUID.test(t))) return null;

  const av = (env["DIGILOCKER_DIAG_AUTHORIZE_VERSION"] ?? "1").trim();
  if (av !== "1" && av !== "2") return null;

  const jwks = (env["DIGILOCKER_DIAG_JWKS_URL"] ?? "").trim();
  const iss = (env["DIGILOCKER_DIAG_EXPECTED_ISSUER"] ?? "").trim();
  if (jwks && !onDigiLockerHost(jwks)) return null; // keys only from the provider host
  if (iss && !onDigiLockerHost(iss)) return null;

  return {
    clientId, clientSecret, redirectUri, stateKey,
    authorizeVersion: av,
    testerIds: new Set(testers),
    jwksUrl: jwks || DIGILOCKER_OIDC_JWKS_URL,
    expectedIssuer: iss || DIGILOCKER_OIDC_ISSUER,
    acrSemanticsConfirmed: (env["DIGILOCKER_DIAG_ACR_SEMANTICS_CONFIRMED"] ?? "false").toLowerCase() === "true",
  };
}

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmacB64(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** Domain-separated from v1 (fs:dl:pkce:v1), so a v1 state can never derive a diagnostic verifier or vice versa. */
export const deriveDiagPkceVerifier = (key: string, state: string) => hmacB64(key, `fs:dl:diag:pkce:v1:${state}`);
export const deriveDiagNonce = (key: string, state: string) => hmacB64(key, `fs:dl:diag:nonce:v1:${state}`);
/** Same derivations under the Lab domain (fs:dl:lab:*), separate from both v1 and the diagnostic. */
export const deriveLabPkceVerifier = (key: string, state: string) => hmacB64(key, `fs:dl:lab:pkce:v1:${state}`);
export const deriveLabNonce = (key: string, state: string) => hmacB64(key, `fs:dl:lab:nonce:v1:${state}`);
const pkceVerifierFor = (rt: DiagRuntime, state: string) =>
  rt.domain === "lab" ? deriveLabPkceVerifier(rt.stateKey, state) : deriveDiagPkceVerifier(rt.stateKey, state);

export async function buildDiagAuthorizeUrl(rt: DiagRuntime, state: string): Promise<string> {
  const u = new URL(`${DIGILOCKER_HOST}/public/oauth2/${rt.authorizeVersion}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", rt.clientId);
  u.searchParams.set("redirect_uri", rt.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", await pkceChallenge(await pkceVerifierFor(rt, state)));
  u.searchParams.set("code_challenge_method", "S256");
  // The registered DEV client permits OpenID, not AVS. Keep Stage's OIDC
  // authorization flow; only the original diagnostic requests Aadhaar ACR.
  // The Lab requests no assurance and must never infer it from login alone.
  u.searchParams.set("scope", "openid");
  if (rt.domain !== "lab") u.searchParams.set("acr", DIAG_ACR);
  u.searchParams.set("nonce", await (rt.domain === "lab" ? deriveLabNonce(rt.stateKey, state) : deriveDiagNonce(rt.stateKey, state)));
  // dl_flow is documented only as "signup"; omitting it is the documented sign-in flow. Never send an undocumented value.
  u.searchParams.set("purpose", DIGILOCKER_PURPOSE);
  u.searchParams.set("service_name", DIGILOCKER_SERVICE_NAME);
  return u.toString();
}

async function call(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: "error" });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new DigiLockerError("PROVIDER_TIMEOUT");
    throw new DigiLockerError("PROVIDER_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

const MAX_TOKEN_BODY_CHARS = 64 * 1024;

/** The provider's token-endpoint response exactly as received (FairSwapTest tester diagnostic only; unredacted). */
export interface DiagTokenResponse {
  httpStatus: number;
  contentType: string | null;
  /** Parsed JSON body verbatim (all fields, including null and empty values), or null when the body was not JSON. */
  json: unknown;
  /** Raw body text, only when it was not valid JSON (capped). */
  text: string | null;
}
export interface DiagExchange {
  response: DiagTokenResponse;
  idToken: string | null;
  accessToken: string | null;
  /** True only when the provider body exceeded the size cap (key absent otherwise). The Lab reports it as RESPONSE_TOO_LARGE. */
  oversize?: true;
  /** Set when the exchange did not yield a usable ID token. */
  failure: "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED" | "INVALID_PROVIDER_RESPONSE" | null;
}

/** Server-side OIDC code exchange with the exact registered redirect URI and the PKCE verifier. Throws only when no HTTP
 *  response was received (timeout/network); any provider response, including errors, is returned for display. */
export async function exchangeDiagCode(rt: DiagRuntime, code: string, state: string, fetchImpl: typeof fetch = fetch): Promise<DiagExchange> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: rt.clientId,
    client_secret: rt.clientSecret,
    redirect_uri: rt.redirectUri,
    code_verifier: await pkceVerifierFor(rt, state),
  });
  const res = await call(fetchImpl, `${DIGILOCKER_HOST}${DIAG_TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  let text = "";
  let oversize = false;
  try {
    const full = await res.text();
    oversize = full.length > MAX_TOKEN_BODY_CHARS;
    text = full.slice(0, MAX_TOKEN_BODY_CHARS);
  } catch { /* empty body */ }
  let json: unknown = null;
  let parsed = false;
  try { json = JSON.parse(text); parsed = true; } catch { /* not JSON */ }
  const response: DiagTokenResponse = {
    httpStatus: res.status,
    contentType: res.headers.get("content-type"),
    json: parsed ? json : null,
    text: parsed ? null : text.slice(0, 4000),
  };
  const obj = parsed && json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  const at = obj?.["access_token"];
  const idToken = obj?.["id_token"];
  const accessToken = typeof at === "string" && at.length > 0 ? at : null;
  const usable = typeof idToken === "string" && idToken.length > 0 && idToken.length <= 16384;
  const failure = res.status >= 500 ? "PROVIDER_UNAVAILABLE" : !res.ok ? "PROVIDER_REJECTED" : !obj || !usable ? "INVALID_PROVIDER_RESPONSE" : null;
  return { response, idToken: usable ? (idToken as string) : null, accessToken, ...(oversize ? { oversize: true as const } : {}), failure };
}

// ---- ID token validation. Every output is a fixed enum/boolean; no claim value other than these is ever returned. ----

export type Tri = "verified" | "unconfirmed" | "failed";
export interface DiagChecks {
  signature: Tri;
  issuer: Tri;
  /** aud contains client_id; with several audiences (or any azp) azp must equal client_id. */
  audience: boolean;
  expiry: boolean;
  /** sub present: a non-empty string of at most 255 chars. Its value is never returned. */
  subject: boolean;
  /** iat present, numeric, not in the future and no older than the state lifetime. */
  issuedAt: boolean;
  nonce: "match" | "absent" | "mismatch";
  acr: "aadhaar" | "missing" | "other";
}
export type DiagOutcome = "VERIFIED" | "UNCONFIRMED" | "NOT_VERIFIED" | "CANCELLED" | "FAILED";
/** Unredacted provider material for the one-time FairSwapTest tester display. Never persisted or logged. */
export interface DiagRaw {
  /** Provider callback query error / error_description exactly as relayed, when the provider returned an error. */
  providerCallback: { error: string; error_description: string | null } | null;
  tokenResponse: DiagTokenResponse | null;
  /** What each verification was compared against (public values only; never the client secret or signing key). */
  expected: { issuer: string; audience: string; nonce: string; checkedAtEpoch: number } | null;
}
export interface DiagResult {
  outcome: DiagOutcome;
  code: string | null;
  endpoints: { authorize: AuthorizeVersion; token: "2" };
  checks: DiagChecks | null;
  /** Names (never values) of the claims present in the ID token, so the owner can see which assurance evidence the
   *  provider actually sends. Only plain claim names are kept; at most 40. */
  claimNames: string[] | null;
  raw?: DiagRaw | null;
}

function decodeSegment(seg: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(seg)) return null;
  try {
    const bin = atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((seg.length + 3) % 4));
    const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function b64urlToBytes(seg: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(seg)) return null;
  try {
    const bin = atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((seg.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function verifySignature(
  rt: DiagRuntime, header: Record<string, unknown>, signingInput: string, sig: string, fetchImpl: typeof fetch,
): Promise<Tri> {
  const alg = header["alg"];
  if (typeof alg !== "string" || alg === "none" || alg.startsWith("HS")) return "failed"; // never accept unsigned/symmetric
  if (alg !== "RS256") return "unconfirmed";
  let keys: unknown;
  try {
    const res = await call(fetchImpl, rt.jwksUrl, { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) return "unconfirmed";
    const text = await res.text();
    if (text.length > MAX_JWKS_BYTES) return "unconfirmed";
    keys = (JSON.parse(text) as { keys?: unknown }).keys;
  } catch {
    return "unconfirmed";
  }
  if (!Array.isArray(keys)) return "unconfirmed";
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  const candidates = keys.filter((k): k is Record<string, unknown> =>
    !!k && typeof k === "object" && (k as Record<string, unknown>)["kty"] === "RSA" &&
    ((k as Record<string, unknown>)["use"] ?? "sig") === "sig" &&
    (kid === null || (k as Record<string, unknown>)["kid"] === kid));
  if (candidates.length === 0 || (kid === null && candidates.length !== 1)) return "unconfirmed";
  const sigBytes = b64urlToBytes(sig);
  if (!sigBytes) return "failed";
  try {
    const { n, e } = candidates[0] as { n?: unknown; e?: unknown };
    if (typeof n !== "string" || typeof e !== "string") return "unconfirmed";
    const key = await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n, e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    return (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, enc.encode(signingInput))) ? "verified" : "failed";
  } catch {
    return "unconfirmed";
  }
}

export async function evaluateIdToken(
  rt: DiagRuntime, idToken: string, expectedNonce: string, nowSeconds: number, fetchImpl: typeof fetch = fetch,
): Promise<DiagResult> {
  const endpoints = { authorize: rt.authorizeVersion, token: "2" as const };
  const parts = idToken.split(".");
  const header = parts.length === 3 ? decodeSegment(parts[0]) : null;
  const claims = parts.length === 3 ? decodeSegment(parts[1]) : null;
  if (!header || !claims) return { outcome: "FAILED", code: "INVALID_ID_TOKEN", endpoints, checks: null, claimNames: null };

  const claimNames = Object.keys(claims).filter((k) => /^[a-z][a-z0-9_]{0,31}$/.test(k)).sort().slice(0, 40);
  const signature = await verifySignature(rt, header, `${parts[0]}.${parts[1]}`, parts[2], fetchImpl);
  const iss = claims["iss"];
  const issuer: Tri = iss === rt.expectedIssuer ? "verified" : "failed";
  const aud = claims["aud"];
  const azp = claims["azp"];
  const audList = typeof aud === "string" ? [aud] : Array.isArray(aud) && aud.every((x) => typeof x === "string") ? (aud as string[]) : [];
  const audience = audList.includes(rt.clientId) &&
    (azp === undefined ? audList.length === 1 : azp === rt.clientId); // OIDC Core 3.1.3.7 (8)-(9)
  const exp = claims["exp"];
  const iat = claims["iat"];
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const issuedAt = finite(iat) && iat - CLOCK_SKEW_S <= nowSeconds && iat + DIAG_STATE_TTL_SECONDS + CLOCK_SKEW_S >= nowSeconds;
  const expiry = finite(exp) && exp + CLOCK_SKEW_S > nowSeconds && (!finite(iat) || exp > iat);
  const sub = claims["sub"];
  const subject = typeof sub === "string" && sub.trim().length > 0 && sub.length <= 255;
  const n = claims["nonce"];
  const nonce = n === undefined ? "absent" : typeof n === "string" && n === expectedNonce ? "match" : "mismatch";
  const a = claims["acr"];
  const acr = a === undefined || a === null || a === "" ? "missing" : a === DIAG_ACR ? "aadhaar" : "other";
  const checks: DiagChecks = { signature, issuer, audience, expiry, subject, issuedAt, nonce, acr };

  if (signature === "failed" || issuer === "failed" || !audience || !expiry || !subject || !issuedAt || nonce === "mismatch") {
    return { outcome: "FAILED", code: "INVALID_ID_TOKEN", endpoints, checks, claimNames };
  }
  if (acr === "other") return { outcome: "NOT_VERIFIED", code: "ACR_NOT_AADHAAR", endpoints, checks, claimNames };
  if (acr === "missing") return { outcome: "UNCONFIRMED", code: "ACR_MISSING", endpoints, checks, claimNames };
  if (nonce !== "match") return { outcome: "UNCONFIRMED", code: "NONCE_MISSING", endpoints, checks, claimNames };
  if (signature !== "verified") return { outcome: "UNCONFIRMED", code: "SIGNING_KEYS_UNCONFIRMED", endpoints, checks, claimNames };
  if (issuer !== "verified") return { outcome: "UNCONFIRMED", code: "ISSUER_UNCONFIRMED", endpoints, checks, claimNames };
  if (!rt.acrSemanticsConfirmed) return { outcome: "UNCONFIRMED", code: "ASSURANCE_SEMANTICS_UNCONFIRMED", endpoints, checks, claimNames };
  // Only reachable with: verified signature, issuer, audience/azp, exp, iat, sub, matching nonce and acr=aadhaar.
  return { outcome: "VERIFIED", code: null, endpoints, checks, claimNames };
}
