// FairSwap DigiLocker OIDC v2 verification: the only flow that can issue "Verified with DigiLocker".
// Separate from the Test-only diagnostic (digilocker-oidc-diag.ts), which is untouched.
//
// Evidence model. A badge may be issued only when ALL hold:
//   1. the provider's token endpoint returns an ID token whose RS256 signature verifies against one trusted key from the
//      provider's published JWKS (none/HS*/other algorithms rejected; a missing or null `kid` is accepted only when
//      exactly one eligible key verifies), with exact issuer, audience (+azp), exp, iat, sub and our state-bound nonce;
//   2. the signature-verified ID token carries a well-formed `digilockerid`. If the authenticated token response also
//      returns `digilockerid`, both must be equal. The id is only ever HMAC-fingerprinted by the caller;
//   3. the caller (idv-digilocker-complete) binds that fingerprint atomically to exactly one FairSwap account.
// No Aadhaar ACR, KYC, PAN or document claim is requested, required or read.
// Nothing here stores or returns tokens, codes, claims or the raw id.
import { DIGILOCKER_HOST, DIGILOCKER_ID_PATTERN, DIGILOCKER_PURPOSE, DIGILOCKER_SERVICE_NAME, DigiLockerError, pkceChallenge } from "./digilocker-client.ts";
import type { DigiLockerClientConfig } from "./digilocker-client.ts";

export const OIDC_TOKEN_PATH = "/public/oauth2/2/token";
export const OIDC_AUTHORIZE_PATH = "/public/oauth2/1/authorize";
export const OIDC_ISSUER = DIGILOCKER_HOST;
export const OIDC_JWKS_URL = `${DIGILOCKER_HOST}/public/oauth2/jwks`;
/** Evidence label stored with the binding; the database refuses any other value for a badge-issuing link. */
export const OIDC_EVIDENCE_METHOD = "oidc_v2_signed_id_token";
const TIMEOUT_MS = 8000;
const CLOCK_SKEW_S = 60;
const MAX_ATTEMPT_AGE_S = 900; // attempt TTL is capped at 900 s in SQL
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 10;

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Domain-separated from the PKCE verifier and from the diagnostic nonce. */
export async function deriveOidcNonce(key: string, state: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(`fs:dl:oidc:nonce:v1:${state}`)));
}

export async function buildOidcAuthorizeUrl(cfg: DigiLockerClientConfig, state: string, verifier: string, nonce: string): Promise<string> {
  const u = new URL(`${DIGILOCKER_HOST}${OIDC_AUTHORIZE_PATH}`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("scope", "openid");
  u.searchParams.set("nonce", nonce);
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

/** `responseId` is the token response's digilockerid when present; it is never trusted on its own. */
export interface OidcExchange { accessToken: string; idToken: string; responseId: string | null }

export async function exchangeOidcCode(
  cfg: DigiLockerClientConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch,
): Promise<OidcExchange> {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri, code_verifier: verifier,
  });
  const res = await call(fetchImpl, `${DIGILOCKER_HOST}${OIDC_TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (res.status >= 500) throw new DigiLockerError("PROVIDER_UNAVAILABLE");
  if (!res.ok) throw new DigiLockerError("PROVIDER_REJECTED");
  let j: Record<string, unknown>;
  try {
    const parsed = await res.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    j = parsed as Record<string, unknown>;
  } catch {
    throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  }
  const at = j["access_token"];
  const idt = j["id_token"];
  const id = j["digilockerid"];
  if (typeof at !== "string" || !at || String(j["token_type"] ?? "").toLowerCase() !== "bearer") {
    throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  }
  // The access token travels with any later error so the caller can revoke it.
  const withToken = (code: "ID_TOKEN_INVALID" | "INVALID_PROVIDER_RESPONSE") =>
    Object.assign(new DigiLockerError(code), { accessToken: at });
  if (typeof idt !== "string" || !idt || idt.length > 16384) throw withToken("ID_TOKEN_INVALID");
  if (id !== undefined && id !== null && (typeof id !== "string" || !DIGILOCKER_ID_PATTERN.test(id))) {
    throw withToken("INVALID_PROVIDER_RESPONSE");
  }
  return { accessToken: at, idToken: idt, responseId: typeof id === "string" ? id : null };
}

function segment(seg: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(seg)) return null;
  try {
    const bin = atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((seg.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
function jsonSegment(seg: string): Record<string, unknown> | null {
  const b = segment(seg);
  if (!b) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(b));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Jwk = Record<string, unknown>;
const isEligibleKey = (k: unknown): k is Jwk => {
  if (!k || typeof k !== "object" || Array.isArray(k)) return false;
  const j = k as Jwk;
  return j["kty"] === "RSA" && (j["use"] === undefined || j["use"] === "sig") &&
    (j["alg"] === undefined || j["alg"] === "RS256") && typeof j["n"] === "string" && typeof j["e"] === "string";
};

async function verifyWith(k: Jwk, sig: Uint8Array<ArrayBuffer>, signingInput: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: k["n"] as string, e: k["e"] as string, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, enc.encode(signingInput));
  } catch {
    return false;
  }
}

async function signatureValid(header: Record<string, unknown>, signingInput: string, sig: string, fetchImpl: typeof fetch): Promise<boolean> {
  if (header["alg"] !== "RS256") return false; // rejects none, HS*, and any other algorithm
  const sigBytes = segment(sig);
  const kid = header["kid"];
  // kid is either a non-empty string or absent/null. Any other type or an empty string is malformed.
  if (!sigBytes || (kid !== undefined && kid !== null && (typeof kid !== "string" || !kid))) return false;
  const res = await call(fetchImpl, OIDC_JWKS_URL, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) throw new DigiLockerError("PROVIDER_UNAVAILABLE");
  const text = await res.text();
  if (text.length > MAX_JWKS_BYTES) throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  let keys: unknown;
  try { keys = (JSON.parse(text) as { keys?: unknown }).keys; } catch { throw new DigiLockerError("INVALID_PROVIDER_RESPONSE"); }
  if (!Array.isArray(keys) || keys.length > MAX_JWKS_KEYS) throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  const eligible = keys.filter(isEligibleKey);
  if (typeof kid === "string") {
    const matches = eligible.filter((k) => k["kid"] === kid);
    return matches.length === 1 && (await verifyWith(matches[0], sigBytes, signingInput));
  }
  // kid null/absent: accept only when exactly one eligible trusted key verifies. Zero or several is ambiguous.
  let verified = 0;
  for (const k of eligible) if (await verifyWith(k, sigBytes, signingInput)) verified++;
  return verified === 1;
}

export interface VerifiedOidcIdentity { digilockerid: string }

/** Throws DigiLockerError("ID_TOKEN_INVALID") for any failed cryptographic or claim check. */
export async function verifyOidcIdentity(
  ex: OidcExchange,
  ctx: { clientId: string; expectedNonce: string; nowSeconds: number; fetchImpl?: typeof fetch },
): Promise<VerifiedOidcIdentity> {
  const bad = () => new DigiLockerError("ID_TOKEN_INVALID");
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const parts = ex.idToken.split(".");
  if (parts.length !== 3) throw bad();
  const header = jsonSegment(parts[0]);
  const claims = jsonSegment(parts[1]);
  if (!header || !claims) throw bad();
  if (!(await signatureValid(header, `${parts[0]}.${parts[1]}`, parts[2], fetchImpl))) throw bad();

  if (claims["iss"] !== OIDC_ISSUER) throw bad();
  const aud = claims["aud"];
  const audList = typeof aud === "string" ? [aud] : Array.isArray(aud) && aud.every((x) => typeof x === "string") ? (aud as string[]) : [];
  const azp = claims["azp"];
  if (!audList.includes(ctx.clientId) || (azp === undefined ? audList.length !== 1 : azp !== ctx.clientId)) throw bad();
  const exp = claims["exp"];
  const iat = claims["iat"];
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!finite(exp) || exp + CLOCK_SKEW_S <= ctx.nowSeconds) throw bad();
  if (!finite(iat) || iat - CLOCK_SKEW_S > ctx.nowSeconds || iat + MAX_ATTEMPT_AGE_S + CLOCK_SKEW_S < ctx.nowSeconds || exp <= iat) throw bad();
  const sub = claims["sub"];
  if (typeof sub !== "string" || !sub.trim() || sub.length > 255) throw bad();
  if (typeof claims["nonce"] !== "string" || claims["nonce"] !== ctx.expectedNonce) throw bad();
  const id = claims["digilockerid"];
  if (typeof id !== "string" || !DIGILOCKER_ID_PATTERN.test(id)) throw bad();
  if (ex.responseId !== null && ex.responseId.toLowerCase() !== id.toLowerCase()) throw bad();
  return { digilockerid: id };
}
