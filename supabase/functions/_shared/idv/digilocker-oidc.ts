// FairSwap DigiLocker OIDC v2 verification (Stage/Test only until the owner approves Production).
// Separate from the Stage diagnostic (digilocker-oidc-diag.ts), which is untouched.
//
// Evidence model. A badge may be issued only when ALL hold:
//   1. the provider's token endpoint returns a signed ID token that verifies against the provider's published JWKS
//      (RS256 only; none/HS* rejected), with exact issuer, audience (+azp), exp, iat, sub and our nonce;
//   2. the verified token carries acr == "aadhaar" (the value we requested), AND the owner has attested via
//      DIGILOCKER_ACR_SEMANTICS_CONFIRMED=true that the provider's documentation defines this acr as Aadhaar-verified
//      assurance. The provider specification (v2.3/v2.4) documents no `acr` claim, so without that attestation the
//      assurance is UNPROVEN and no badge or binding is created. A missing or different acr is never treated as proven.
//   3. a stable DigiLocker id is returned by the authenticated token response (`digilockerid`, 36 chars) and, if the ID
//      token also carries `digilockerid`, both agree. The id is only ever HMAC-fingerprinted by the caller.
// Nothing here stores or returns tokens, codes, claims, Aadhaar numbers or the raw id.
import { DIGILOCKER_HOST, DIGILOCKER_ID_PATTERN, DIGILOCKER_PURPOSE, DIGILOCKER_SERVICE_NAME, DigiLockerError, pkceChallenge } from "./digilocker-client.ts";
import type { DigiLockerClientConfig } from "./digilocker-client.ts";

/** OIDC mode is hard-locked to FairSwapTest. There is no Production entry and no override. */
export const OIDC_ALLOWED_PROJECT_REF = "wpppxlnbzqynvhpeuavd";
export const OIDC_ACR = "aadhaar";
export const OIDC_TOKEN_PATH = "/public/oauth2/2/token";
export const OIDC_AUTHORIZE_PATH = "/public/oauth2/1/authorize";
export const OIDC_ISSUER = DIGILOCKER_HOST;
export const OIDC_JWKS_URL = `${DIGILOCKER_HOST}/public/oauth2/jwks`;
const TIMEOUT_MS = 8000;
const CLOCK_SKEW_S = 60;
const MAX_ATTEMPT_AGE_S = 900; // attempt TTL is capped at 900 s in SQL
const MAX_JWKS_BYTES = 64 * 1024;

export interface OidcConfig {
  /** Owner attestation that acr=aadhaar means Aadhaar-verified assurance. Default false => assurance unproven. */
  acrSemanticsConfirmed: boolean;
}

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Domain-separated from the v1 PKCE verifier and from the diagnostic nonce. */
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
  u.searchParams.set("acr", OIDC_ACR);
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

export interface OidcExchange { accessToken: string; idToken: string; digilockerid: string }

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
  // The access token is returned to the caller first so it can be revoked even when the ID token is rejected.
  if (typeof idt !== "string" || !idt || idt.length > 16384) throw Object.assign(new DigiLockerError("ID_TOKEN_INVALID"), { accessToken: at });
  if (typeof id !== "string" || !DIGILOCKER_ID_PATTERN.test(id)) throw Object.assign(new DigiLockerError("INVALID_PROVIDER_RESPONSE"), { accessToken: at });
  return { accessToken: at, idToken: idt, digilockerid: id };
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

async function signatureValid(header: Record<string, unknown>, signingInput: string, sig: string, fetchImpl: typeof fetch): Promise<boolean> {
  if (header["alg"] !== "RS256") return false; // rejects none, HS*, and any other algorithm
  const sigBytes = segment(sig);
  const kid = header["kid"];
  if (!sigBytes || typeof kid !== "string" || !kid) return false;
  const res = await call(fetchImpl, OIDC_JWKS_URL, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) throw new DigiLockerError("PROVIDER_UNAVAILABLE");
  const text = await res.text();
  if (text.length > MAX_JWKS_BYTES) throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  let keys: unknown;
  try { keys = (JSON.parse(text) as { keys?: unknown }).keys; } catch { throw new DigiLockerError("INVALID_PROVIDER_RESPONSE"); }
  if (!Array.isArray(keys)) throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  const matches = keys.filter((k): k is Record<string, unknown> =>
    !!k && typeof k === "object" && (k as Record<string, unknown>)["kty"] === "RSA" &&
    ((k as Record<string, unknown>)["use"] ?? "sig") === "sig" && (k as Record<string, unknown>)["kid"] === kid);
  if (matches.length !== 1) return false;
  const { n, e } = matches[0] as { n?: unknown; e?: unknown };
  if (typeof n !== "string" || typeof e !== "string") return false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n, e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, enc.encode(signingInput));
  } catch {
    return false;
  }
}

export interface VerifiedOidcIdentity { digilockerid: string }

/** Throws DigiLockerError("ID_TOKEN_INVALID") for any failed cryptographic or claim check, and
 *  DigiLockerError("ASSURANCE_NOT_PROVEN") when the token is genuine but Aadhaar assurance cannot be proven. */
export async function verifyOidcIdentity(
  cfg: OidcConfig,
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
  const claimedId = claims["digilockerid"];
  if (claimedId !== undefined &&
      (typeof claimedId !== "string" || claimedId.toLowerCase() !== ex.digilockerid.toLowerCase())) throw bad();

  // Authenticity is now proven. Assurance is a separate question and fails closed.
  if (claims["acr"] !== OIDC_ACR || !cfg.acrSemanticsConfirmed) throw new DigiLockerError("ASSURANCE_NOT_PROVEN");
  return { digilockerid: ex.digilockerid };
}
