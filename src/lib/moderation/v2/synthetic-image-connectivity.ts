/**
 * Read-only, operator-only synthetic image connectivity proof.
 * The Edge Function must authorize service_role AND pin FairSwapProd before
 * invoking this helper. No listing reads/writes or publication decisions.
 */
import type { ModerationOutcome } from "./free-moderation.ts";
const MODEL = "omni-moderation-2024-09-26" as const;
const HASH = "866a9ba5828a55c5ea2c0b581f9795906669be3ffa181cfc9fd4b40f2b61f080";
// 256px synthetic geometric WebP: sky, ground, and a blue rectangle; no people.
const IMAGE = "UklGRnABAABXRUJQVlA4IGQBAADwFQCdASoAAQABPtFosFIoJySiovsYCQAaCWlu4XSg4bTgFFla6kKSQ/6AEyNCzHJB3fAJjla6kKSQ/58j/8+R/+phMcrXUhSW82cfI//Pkf/F+3Ruvtx8D47y+6rW/nyJFkfoxLy18+bhw0kmmH6j/JAKb8a8mJ1BSj3bkDrGFYVhWFYVhR2NrH3PFvyrHTUn5KCyufNJgMnAnL/L1PFOaS1rqQpJD/nyP/z5H/58kBVnO/bUe7cgAP7+jvGsWGFGzFzwOLpDYAgL4dvPOgL4dvPOgMVE7RaluAAYcyAJAqwDjLuCGWOIBvj+P8Xl//i7u/OMJfd7SgCCGynnFYll3Q4w/QiWubIfNYQnW0R4dtNPclswrFHDqeqAbzxZs4BWMhyOuprGiyfolk6HS2MU2sinLkLTb3Kz4/u5506OwsiITUWa1vsoEpu+fEKCqPKuT5pKmeyALaGIRH8koJr9yAAAAA==";

export function isSyntheticImageConnectivityRequest(input: unknown): boolean {
  return !!input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    (input as Record<string, unknown>).probe === "synthetic_connectivity";
}
export type SyntheticImageConnectivityResult =
  | Readonly<{ ok: true; model: typeof MODEL; provider: "clear" | "flagged" }>
  | Readonly<{ ok: false; reason: "PROVIDER_AUTH" | "PROVIDER_LIMIT" |
      "PROVIDER_UNAVAILABLE" | "PROVIDER_SCHEMA" | "PROVIDER_INPUT" | "TIMEOUT" }>;

/** Fixed bytes only. Never reads or processes marketplace media. */
export async function runSyntheticImageConnectivity(
  moderateImage: (bytes: Uint8Array, sha256: string) => Promise<ModerationOutcome>,
): Promise<SyntheticImageConnectivityResult> {
  try {
    const bytes = Uint8Array.from(atob(IMAGE), (ch) => ch.charCodeAt(0));
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    );
    const sha = Array.from(digest).map((n) => n.toString(16).padStart(2, "0")).join("");
    if (sha !== HASH) return { ok: false, reason: "PROVIDER_INPUT" };
    const outcome = await moderateImage(bytes, sha);
    if (outcome.state === "failed") return { ok: false, reason: outcome.reason };
    if (outcome.model !== MODEL) return { ok: false, reason: "PROVIDER_SCHEMA" };
    return { ok: true, model: MODEL, provider: outcome.state };
  } catch {
    return { ok: false, reason: "PROVIDER_UNAVAILABLE" };
  }
}
