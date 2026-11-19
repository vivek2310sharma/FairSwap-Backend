import { resolveProjectRef } from "./idv-config.ts";
import type { DigiLockerClientConfig } from "./digilocker-client.ts";
import { OIDC_ALLOWED_PROJECT_REF, type OidcConfig } from "./digilocker-oidc.ts";

// Stage and Production are isolated by Supabase project ref: each ref accepts only its own registered callback.
// Credentials are separate per environment (never shared); the API Setu "Stage" tag is not assumed to be a sandbox.
export const DIGILOCKER_REDIRECT_BY_PROJECT: Record<string, string> = {
  wpppxlnbzqynvhpeuavd: "https://fairswap-web-git-staging-fairswap.vercel.app/api/idv/digilocker/callback",
  kriuhwppxgxsyyrbjsau: "https://fairswap.in/api/idv/digilocker/callback",
};

export const APPROVED_DIGILOCKER_POLICY_VERSION = "dl-v1.0";
const MIN_KEY_LENGTH = 32;
const FP_KEY_ENV = /^IDV_DIGILOCKER_FP_KEY_(V[0-9]{1,3})$/;

export interface FingerprintKey {
  version: string; // "v1", "v2", ...
  key: string;
}

export interface DigiLockerRuntime {
  client: DigiLockerClientConfig;
  /** Derives PKCE verifiers from state. Rotating it only invalidates in-flight attempts (<= 10 minutes). */
  stateKey: string;
  /** Current fingerprint key. Never rotate it away: add a new version and keep every older one configured. */
  currentFpKey: FingerprintKey;
  /** All older fingerprint keys still configured, used only to match existing bindings and fraud blocks. */
  legacyFpKeys: FingerprintKey[];
  /** false (default): the digilockerid comes from the server-to-server token response only.
   *  true: additionally requires /oauth2/1/user to return the same id (only once userdetails is approved). */
  requireUserDetails: boolean;
  /** null = legacy v1 flow (unchanged, the only mode outside FairSwapTest). Set only when DIGILOCKER_AUTH_MODE=oidc_v2
   *  on the Test project: signed ID token + acr=aadhaar evidence is then mandatory for any badge. */
  oidc: OidcConfig | null;
}

/** Collects IDV_DIGILOCKER_FP_KEY_V<n> keys. Returns null if any configured key is too short or the current one is missing. */
export function readFingerprintKeyring(
  env: Record<string, string | undefined>,
): { current: FingerprintKey; legacy: FingerprintKey[] } | null {
  const keys: FingerprintKey[] = [];
  for (const [name, value] of Object.entries(env)) {
    const m = FP_KEY_ENV.exec(name);
    if (!m) continue;
    const key = (value ?? "").trim();
    if (key.length < MIN_KEY_LENGTH) return null; // a short configured key is a misconfiguration: fail closed
    keys.push({ version: m[1].toLowerCase(), key });
  }
  const currentVersion = (env["IDV_DIGILOCKER_FP_KEY_CURRENT"] ?? "v1").trim().toLowerCase();
  const current = keys.find((k) => k.version === currentVersion);
  if (!current) return null;
  const legacy = keys.filter((k) => k.version !== currentVersion).sort((a, b) => a.version.localeCompare(b.version));
  if (legacy.length > 8) return null;
  if (new Set(keys.map((k) => k.key)).size !== keys.length) return null; // the same secret under two versions is a mistake
  return { current, legacy };
}

/** Returns null (feature closed) unless the flag is ON and every credential is valid for this environment. Never throws. */
export function readDigiLockerRuntime(env: Record<string, string | undefined>): DigiLockerRuntime | null {
  if ((env["FAIRSWAP_DIGILOCKER_ENABLED"] ?? "false").toLowerCase() !== "true") return null;
  let projectRef: string;
  try {
    projectRef = resolveProjectRef(env).projectRef;
  } catch {
    return null;
  }
  const expectedRedirect = DIGILOCKER_REDIRECT_BY_PROJECT[projectRef];
  const redirectUri = (env["DIGILOCKER_REDIRECT_URI"] ?? "").trim();
  const clientId = (env["DIGILOCKER_CLIENT_ID"] ?? "").trim();
  const clientSecret = (env["DIGILOCKER_CLIENT_SECRET"] ?? "").trim();
  const stateKey = (env["IDV_DIGILOCKER_STATE_KEY"] ?? "").trim();
  if (!expectedRedirect || redirectUri !== expectedRedirect) return null; // exact registered URI only
  if (!clientId || !clientSecret || stateKey.length < MIN_KEY_LENGTH) return null;
  const mode = (env["DIGILOCKER_AUTH_MODE"] ?? "legacy").trim().toLowerCase();
  if (mode !== "legacy" && mode !== "oidc_v2") return null;
  if (mode === "oidc_v2" && projectRef !== OIDC_ALLOWED_PROJECT_REF) return null; // never Production
  const ring = readFingerprintKeyring(env);
  if (!ring) return null;
  if ([ring.current, ...ring.legacy].some((k) => k.key === stateKey)) return null; // keys must be independent
  return {
    client: {
      clientId,
      clientSecret,
      redirectUri,
      requestOpenidScope: (env["DIGILOCKER_REQUEST_OPENID_SCOPE"] ?? "false").toLowerCase() === "true",
    },
    stateKey,
    currentFpKey: ring.current,
    legacyFpKeys: ring.legacy,
    requireUserDetails: (env["DIGILOCKER_USERDETAILS_APPROVED"] ?? "false").toLowerCase() === "true",
    oidc: mode === "oidc_v2"
      ? { acrSemanticsConfirmed: (env["DIGILOCKER_ACR_SEMANTICS_CONFIRMED"] ?? "false").toLowerCase() === "true" }
      : null,
  };
}
