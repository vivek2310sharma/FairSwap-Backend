/**
 * Bounded, non-publishing bridge: existing Backend claim/lease/registry remains
 * authoritative. This code creates REVIEW RESULTS ONLY. No SQL or Storage writer.
 */
import { findIndiaFraudSignals, type FraudFinding } from "./india-fraud.ts";
import { moderateText, moderateCanonicalWebp, type ModerationOutcome, type ProviderDeps } from "./free-moderation.ts";

export interface ShadowMedia {
  readonly mediaId: string;
  readonly sha256: string; // Expected, DB-registered canonical bytes digest
}
export interface ShadowSnapshot {
  readonly listingId: string;
  readonly revision: number;
  readonly generationId: string;
  readonly title: string;
  readonly description: string;
  readonly media: readonly ShadowMedia[];
}
export interface ShadowDeps {
  readonly provider: ProviderDeps;
  /** Trusted read only; this must verify DB-backed canonical asset identity. */
  readCanonical(mediaId: string): Promise<Uint8Array>;
  /** Re-read DB authoritative context after provider work, before any commit. */
  isCurrent(snapshot: ShadowSnapshot): Promise<boolean>;
}
export interface ShadowResult {
  readonly authority: "SHADOW_ONLY_NEVER_PUBLISH";
  readonly stale: boolean;
  readonly route: "review" | "no_harm_flags" | "retry";
  readonly fraud: Readonly<{title: readonly FraudFinding[]; description: readonly FraudFinding[]}>;
  readonly checks: ReadonlyArray<{kind: "title" | "description" | "image"; target: string; outcome: ModerationOutcome}>;
}

export async function runFreeShadowEvaluation(
  snapshot: ShadowSnapshot,
  deps: ShadowDeps,
): Promise<ShadowResult> {
  if (!snapshot || !snapshot.title || !snapshot.description || !snapshot.media ||
      snapshot.media.length < 1 || snapshot.media.length > 8) {
    throw new Error("INVALID_SNAPSHOT");
  }
  const fraud = {
    title: findIndiaFraudSignals(snapshot.title),
    description: findIndiaFraudSignals(snapshot.description),
  };
  const checks: Array<{kind: "title" | "description" | "image"; target: string; outcome: ModerationOutcome}> = [];
  checks.push({kind: "title", target: "title", outcome: await moderateText(snapshot.title, deps.provider)});
  checks.push({kind: "description", target: "description", outcome: await moderateText(snapshot.description, deps.provider)});
  for (const entry of snapshot.media) {
    let outcome: ModerationOutcome;
    try {
      const exactCanonicalBytes = await deps.readCanonical(entry.mediaId);
      outcome = await moderateCanonicalWebp(exactCanonicalBytes, entry.sha256, deps.provider);
    } catch {
      outcome = {state: "failed", reason: "PROVIDER_INPUT"};
    }
    checks.push({kind: "image", target: entry.mediaId, outcome});
  }
  let stale = true;
  try { stale = !(await deps.isCurrent(snapshot)); }
  catch { stale = true; }
  const failed = checks.some(c => c.outcome.state === "failed");
  const flagged = checks.some(c => c.outcome.state === "flagged") || !!fraud.title.length || !!fraud.description.length;
  return {
    authority: "SHADOW_ONLY_NEVER_PUBLISH",
    stale,
    route: stale || failed ? "retry" : flagged ? "review" : "no_harm_flags",
    fraud,
    checks,
  };
}
