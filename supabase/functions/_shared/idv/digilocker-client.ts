// FairSwap DigiLocker (MeriPehchaan) direct OAuth client.
// Source: Requester - Meri Pehchaan API Specification v2.4 (Sep 2026).
//   Authorize : GET  {host}/public/oauth2/1/authorize
//   Token     : POST {host}/public/oauth2/1/token   (returns digilockerid)
//   User      : GET  {host}/public/oauth2/1/user    (confirms digilockerid)
//   Revoke    : POST {host}/public/oauth2/1/revoke
// The spec documents a single (production) host and no sandbox host; Stage and Production
// are separated by credentials and registered redirect URIs, not by host.
// digilockerid is documented only in the v1 token response and /oauth2/1/user (the v2.4 sample id_token carries
// sub/preferred_username/user_sso_id, not digilockerid), so no id_token is requested, parsed or trusted.
// Only the digilockerid is ever used. No scope/acr/req_doctype is requested, so no document access is asked for.

export const DIGILOCKER_HOST = "https://digilocker.meripehchaan.gov.in";
export const DIGILOCKER_PROVIDER = "digilocker_meripehchaan";
export const DIGILOCKER_PURPOSE = "FairSwap account verification";
export const DIGILOCKER_SERVICE_NAME = "FairSwap";
export const DIGILOCKER_ID_PATTERN = /^[A-Za-z0-9-]{36}$/;
const TIMEOUT_MS = 8000;

export type DigiLockerErrorCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "SCOPE_MISSING"
  | "INVALID_PROVIDER_RESPONSE"
  | "ID_TOKEN_INVALID";

export class DigiLockerError extends Error {
  constructor(public readonly code: DigiLockerErrorCode) {
    super(code); // never carries provider bodies, tokens or PII
  }
}

export interface DigiLockerClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Default false. Only for Stage testing if the registered client requires scope=openid. The id_token is never consumed. */
  requestOpenidScope?: boolean;
}

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const toB64Url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function generateState(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(message));
}

/** PKCE verifier derived from the server key and the single-use state: 43 unreserved chars, never stored or sent to the browser. */
export async function derivePkceVerifier(key: string, state: string): Promise<string> {
  return toB64Url(await hmac(key, `fs:dl:pkce:v1:${state}`));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return toB64Url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

/** Keyed fingerprint of the DigiLocker id. Keys are versioned (see digilocker-config.ts); an old key stays configured
 *  while any binding uses it, because the raw id is never stored and cannot be re-keyed offline. */
export async function fingerprintDigiLockerId(key: string, digilockerid: string): Promise<string> {
  return toHex(await hmac(key, `fs:dlid:v1:${digilockerid.toLowerCase()}`));
}

export async function buildAuthorizeUrl(cfg: DigiLockerClientConfig, state: string, verifier: string): Promise<string> {
  const u = new URL(`${DIGILOCKER_HOST}/public/oauth2/1/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("purpose", DIGILOCKER_PURPOSE);
  u.searchParams.set("service_name", DIGILOCKER_SERVICE_NAME);
  if (cfg.requestOpenidScope) u.searchParams.set("scope", "openid");
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

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (res.status >= 500) throw new DigiLockerError("PROVIDER_UNAVAILABLE");
  if (res.status === 403) throw new DigiLockerError("SCOPE_MISSING");
  if (!res.ok) throw new DigiLockerError("PROVIDER_REJECTED");
  try {
    const j = await res.json();
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
}

export interface DigiLockerExchange { accessToken: string; digilockerid: string }

/** Server-side code exchange. Validates token_type and the digilockerid shape; fails closed on anything missing. */
export async function exchangeCode(
  cfg: DigiLockerClientConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch,
): Promise<DigiLockerExchange> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
  const res = await call(fetchImpl, `${DIGILOCKER_HOST}/public/oauth2/1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const j = await readJson(res);
  const token = j["access_token"];
  const id = j["digilockerid"];
  if (typeof token !== "string" || token.length === 0 || String(j["token_type"] ?? "").toLowerCase() !== "bearer") {
    throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  }
  if (typeof id !== "string" || !DIGILOCKER_ID_PATTERN.test(id)) {
    throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  }
  return { accessToken: token, digilockerid: id };
}

/** Independently confirms the id via the user-details API. Everything except digilockerid is discarded here. */
export async function confirmDigiLockerId(accessToken: string, expectedId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await call(fetchImpl, `${DIGILOCKER_HOST}/public/oauth2/1/user`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const j = await readJson(res);
  const id = j["digilockerid"];
  if (typeof id !== "string" || !DIGILOCKER_ID_PATTERN.test(id) || id.toLowerCase() !== expectedId.toLowerCase()) {
    throw new DigiLockerError("INVALID_PROVIDER_RESPONSE");
  }
  return id;
}

/** Best-effort: a failed revoke is harmless because the access token expires on its own (expires_in). */
export async function revokeToken(cfg: DigiLockerClientConfig, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await call(fetchImpl, `${DIGILOCKER_HOST}/public/oauth2/1/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString(),
    });
  } catch { /* ignore */ }
}
