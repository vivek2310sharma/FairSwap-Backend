import { resolveProjectRef } from "./idv-config.ts";
import type { DigiLockerClientConfig } from "./digilocker-client.ts";

// Test and Production are isolated by the validated Supabase project ref: each ref accepts only its own registered
// callback, and credentials/keys are configured separately per project (never shared). The environment is derived from
// the project ref; there is no separate environment switch and no legacy fallback.
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
  /** Environment derived from the validated project ref. */
  environment: "test" | "production";
}

export const DIGILOCKER_ENVIRONMENT_BY_PROJECT: Record<string, "test" | "production"> = {
  wpppxlnbzqynvhpeuavd: "test",
  kriuhwppxgxsyyrbjsau: "production",
};

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

/** Returns null (feature closed) unless the flag is ON, DIGILOCKER_AUTH_MODE is exactly `oidc_v2`, and every credential is
 *  valid for this environment. Signed OIDC is the only mode: unsigned legacy account linking can never be selected. Never throws. */
export function readDigiLockerRuntime(env: Record<string, string | undefined>): DigiLockerRuntime | null {
  if ((env["FAIRSWAP_DIGILOCKER_ENABLED"] ?? "false").toLowerCase() !== "true") return null;
  if ((env["DIGILOCKER_AUTH_MODE"] ?? "").trim().toLowerCase() !== "oidc_v2") return null;
  let projectRef: string;
  try {
    projectRef = resolveProjectRef(env).projectRef;
  } catch {
    return null;
  }
  const environment = DIGILOCKER_ENVIRONMENT_BY_PROJECT[projectRef];
  const expectedRedirect = DIGILOCKER_REDIRECT_BY_PROJECT[projectRef];
  const redirectUri = (env["DIGILOCKER_REDIRECT_URI"] ?? "").trim();
  const clientId = (env["DIGILOCKER_CLIENT_ID"] ?? "").trim();
  const clientSecret = (env["DIGILOCKER_CLIENT_SECRET"] ?? "").trim();
  const stateKey = (env["IDV_DIGILOCKER_STATE_KEY"] ?? "").trim();
  if (!environment || !expectedRedirect || redirectUri !== expectedRedirect) return null; // exact registered URI only
  if (!clientId || !clientSecret || stateKey.length < MIN_KEY_LENGTH) return null;
  const ring = readFingerprintKeyring(env);
  if (!ring) return null;
  if ([ring.current, ...ring.legacy].some((k) => k.key === stateKey)) return null; // keys must be independent
  return {
    client: { clientId, clientSecret, redirectUri },
    stateKey,
    currentFpKey: ring.current,
    legacyFpKeys: ring.legacy,
    environment,
  };
}
