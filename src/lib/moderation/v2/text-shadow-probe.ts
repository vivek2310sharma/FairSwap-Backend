import { z } from "zod";
import { findIndiaFraudSignals } from "./india-fraud.ts";
import type { ModerationOutcome } from "./free-moderation.ts";

/**
 * A read-only, text-only V2 Production shadow probe.
 *
 * No image can be declared reviewed here: the immutable V2 registry has NOT
 * shipped. No SQL/Storage writes, claims, approvals, policy changes or V1
 * finalizer calls belong in this module.
 *
 * This is not the full Moderation V2 worker. A "text_no_flags" result must
 * NEVER be used as a publication decision.
 */

export const ShadowTextRequestSchema = z.object({
  listingId: z.string().uuid(),
}).strict();

const StatusSchema = z.enum([
  "draft", "pending_review", "active", "reserved", "sold",
  "rejected", "paused", "expired", "removed",
]);

const ListingSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(5000),
  description: z.string().max(5000).nullable(),
  status: StatusSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updated_at: z.string().min(1).max(80),
}).strict();

export type ShadowTextListing = z.infer<typeof ListingSchema>;

export type TextShadowResult =
  | Readonly<{
      ok: true;
      authority: "SHADOW_TEXT_ONLY_NEVER_PUBLISH";
      imageModeration: "NOT_PERFORMED";
      listingId: string;
      revision: number;
      stale: boolean;
      route: "review" | "retry" | "text_no_flags";
      provider: Readonly<{
        title: "clear" | "flagged" | "failed";
        description: "clear" | "flagged" | "failed" | "missing";
      }>;
      harmCategories: readonly string[];
      indiaFraudSignals: readonly string[];
    }>
  | Readonly<{
      ok: false;
      code: "INVALID_REQUEST" | "NOT_FOUND" | "INVALID_SNAPSHOT" | "SOURCE_UNAVAILABLE";
    }>;

export interface TextShadowDeps {
  /** Server-side read-only database query; must read from FairSwapProd. */
  loadListing(listingId: string): Promise<unknown>;
  /** Must call ONLY the free OpenAI Moderation endpoint. */
  moderateText(text: string): Promise<ModerationOutcome>;
}

function matchingListing(
  original: ShadowTextListing,
  after: ShadowTextListing,
): boolean {
  return (
    original.id === after.id &&
    original.revision === after.revision &&
    original.status === after.status &&
    original.updated_at === after.updated_at &&
    original.title === after.title &&
    original.description === after.description
  );
}

function onlyFlaggedCategories(outcome: ModerationOutcome): readonly string[] {
  return outcome.state === "flagged"
    ? Object.entries(outcome.categoryFlags)
        .filter(([, yes]) => yes)
        .map(([key]) => key)
        .slice(0, 16)
    : [];
}

function isFailed(outcome: ModerationOutcome): boolean {
  return outcome.state === "failed";
}

/**
 * Run at most TWO text moderation calls for one identified listing.
 * Authoritative text is fetched twice; the second read detects concurrent
 * changes before returning, but does not pretend to provide a DB lock.
 *
 * Never return title/description, API error details, seller identifiers or
 * raw provider scores. No logging of listing content or provider requests.
 */
export async function runTextShadowProbe(
  rawRequest: unknown,
  deps: TextShadowDeps,
): Promise<TextShadowResult> {
  const request = ShadowTextRequestSchema.safeParse(rawRequest);
  if (!request.success) return { ok: false, code: "INVALID_REQUEST" };

  let rawBefore: unknown;
  try {
    rawBefore = await deps.loadListing(request.data.listingId);
  } catch {
    return { ok: false, code: "SOURCE_UNAVAILABLE" };
  }
  if (!rawBefore) return { ok: false, code: "NOT_FOUND" };

  const beforeResult = ListingSchema.safeParse(rawBefore);
  if (!beforeResult.success) return { ok: false, code: "INVALID_SNAPSHOT" };
  const before = beforeResult.data;
  if (before.id !== request.data.listingId || before.status === "removed") {
    return { ok: false, code: "NOT_FOUND" };
  }

  const titleFraud = findIndiaFraudSignals(before.title).map((finding) => finding.id);
  const descriptionFraud = findIndiaFraudSignals(before.description ?? "").map((finding) => finding.id);
  const signals = [...new Set([...titleFraud, ...descriptionFraud])].sort();

  const run = async (value: string): Promise<ModerationOutcome> => {
    try {
      return await deps.moderateText(value);
    } catch {
      return { state: "failed", reason: "PROVIDER_UNAVAILABLE" };
    }
  };

  const title = await run(before.title);
  const hasDescription = !!before.description?.trim();
  const description = hasDescription
    ? await run(before.description!)
    : null;

  let stillCurrent = false;
  try {
    const afterResult = ListingSchema.safeParse(
      await deps.loadListing(before.id),
    );
    stillCurrent = afterResult.success &&
      matchingListing(before, afterResult.data) &&
      afterResult.data.status !== "removed";
  } catch {
    stillCurrent = false;
  }

  const hasProviderFailure = isFailed(title) ||
    (description !== null && isFailed(description));
  const flagged = title.state === "flagged" ||
    description?.state === "flagged" || signals.length > 0;

  return {
    ok: true,
    authority: "SHADOW_TEXT_ONLY_NEVER_PUBLISH",
    imageModeration: "NOT_PERFORMED",
    listingId: before.id,
    revision: before.revision,
    stale: !stillCurrent,
    route: !stillCurrent || hasProviderFailure
      ? "retry"
      : flagged ? "review" : "text_no_flags",
    provider: {
      title: title.state,
      description: description?.state ?? "missing",
    },
    harmCategories: [...new Set([
      ...onlyFlaggedCategories(title),
      ...(description ? onlyFlaggedCategories(description) : []),
    ])].sort(),
    indiaFraudSignals: signals,
  };
}
