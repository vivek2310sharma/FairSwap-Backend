import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reviewListingContentSafety } from "../../supabase/functions/_shared/listing-media-safety";

const LISTING = "22222222-2222-4222-8222-222222222222";
const MEDIA_A = "55555555-5555-4555-8555-555555555555";
const MEDIA_B = "66666666-6666-4666-8666-666666666666";
const KEY = "sk-test-configuration-key-for-mocked-network-only";
const image = new Uint8Array([
  82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 1, 2, 3, 4,
]);
const allCategories = [
  "harassment", "harassment/threatening", "hate", "hate/threatening",
  "illicit", "illicit/violent", "sexual/minors", "sexual",
  "self-harm", "self-harm/intent", "self-harm/instructions",
  "violence", "violence/graphic",
];

function mockDatabase(mediaIds: readonly string[] = [MEDIA_A], changeAfter = false) {
  let listingReads = 0;
  const media = mediaIds.map((id, index) => ({
    id,
    medium_storage_path: LISTING + "/" + id + "/medium.webp",
    processing_status: "ready",
    display_order: index,
    created_at: "2026-10-21T20:00:00Z",
  }));
  const download = vi.fn(async () => ({
    data: new Blob([Uint8Array.from(image)], { type: "image/webp" }),
    error: null,
  }));
  const db = {
    from: vi.fn((table: string) => {
      if (table === "listings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                listingReads++;
                return {
                  data: {
                    id: LISTING,
                    status: "pending_review",
                    revision: changeAfter && listingReads > 1 ? 2 : 1,
                    title: "Vintage wooden table",
                    description: "Solid oak dining table in excellent shape",
                  },
                  error: null,
                };
              },
            }),
          }),
        };
      }
      if (table === "listing_media") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({
                  limit: async () => ({ data: media, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error("UNEXPECTED_TABLE");
    }),
    storage: {
      from: vi.fn(() => ({ download })),
    },
  };
  return { db: db as unknown as SupabaseClient, download };
}

function provider(options: {
  flaggedText?: boolean;
  flaggedImage?: boolean;
  policyText?: "clear" | "review" | "uncertain";
  policyImage?: "clear" | "review" | "uncertain";
  fail?: boolean;
} = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (options.fail) return new Response("temporarily unavailable", { status: 503 });
    if (String(url).endsWith("/moderations")) {
      const input = body.input as unknown[];
      const isText = Array.isArray(input) && input.some(
        entry => !!entry && typeof entry === "object" &&
          (entry as Record<string, unknown>).type === "text",
      );
      const flagged = isText ? !!options.flaggedText : !!options.flaggedImage;
      const flags = Object.fromEntries(allCategories.map(
        category => [category, flagged && category === "sexual"],
      ));
      const scores = Object.fromEntries(allCategories.map(
        category => [category, flagged && category === "sexual" ? 0.99 : 0],
      ));
      return Response.json({
        model: "omni-moderation-2024-09-26",
        results: [{
          flagged, categories: flags, category_scores: scores,
        }],
      });
    }
    const messages = body.messages as Array<Record<string, unknown>>;
    const user = messages[1]?.content;
    const isImage = Array.isArray(user);
    const decision = (isImage ? options.policyImage : options.policyText) ?? "clear";
    const reason = decision === "review" ? "weapons" :
      decision === "uncertain" ? "other" : "none";
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ decision, reason }) },
      }],
    });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

function job() {
  return {
    listingId: LISTING,
    revision: 1,
    title: "Vintage wooden table",
    description: "Solid oak dining table in excellent shape",
  };
}

describe("OpenAI listing text + image moderation preflight", () => {
  it("requires OpenAI moderation for title/description and EVERY image before clearing", async () => {
    const { db, download } = mockDatabase([MEDIA_A, MEDIA_B]);
    const { fetcher, calls } = provider();
    const result = await reviewListingContentSafety(job(), db, KEY, fetcher);
    expect(result).toEqual({ state: "clear", reviewedImages: 2 });
    expect(download).toHaveBeenCalledTimes(2);
    const moderationCalls = calls.filter(x => x.url.endsWith("/moderations"));
    const policyCalls = calls.filter(x => x.url.endsWith("/chat/completions"));
    expect(moderationCalls).toHaveLength(3);
    expect(policyCalls).toHaveLength(3);
    expect(moderationCalls[0].body.input).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text" })]),
    );
    expect(moderationCalls[1].body.input).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image_url" })]),
    );
    // No OpenAI call receives the listing ID, storage key, seller ID, or a signed URL.
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(LISTING);
    expect(serialized).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(serialized).not.toContain("listing-derivatives");
  });

  it("routes unsafe text flagged by OpenAI Moderations, without image approval", async () => {
    const { db, download } = mockDatabase();
    const { fetcher } = provider({ flaggedText: true });
    expect(await reviewListingContentSafety(job(), db, KEY, fetcher)).toEqual({
      state: "review", source: "text", reason: "OPENAI_HARM",
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("routes marketplace gun image even when the harm model reports it clear", async () => {
    const { db } = mockDatabase();
    const { fetcher } = provider({ policyImage: "review" });
    expect(await reviewListingContentSafety(job(), db, KEY, fetcher)).toEqual({
      state: "review", source: "image", reason: "OPENAI_MARKETPLACE_POLICY",
    });
  });

  it("routes explicit marketplace text through the OpenAI text policy model", async () => {
    const { db } = mockDatabase();
    const { fetcher } = provider({ policyText: "review" });
    expect(await reviewListingContentSafety(job(), db, KEY, fetcher)).toEqual({
      state: "review", source: "text", reason: "OPENAI_MARKETPLACE_POLICY",
    });
  });

  it("routes uncertain OpenAI policy output for human review", async () => {
    const { db } = mockDatabase();
    const { fetcher } = provider({ policyImage: "uncertain" });
    expect(await reviewListingContentSafety(job(), db, KEY, fetcher)).toEqual({
      state: "review", source: "image", reason: "OPENAI_UNCERTAIN",
    });
  });

  it("fails closed if OpenAI is unavailable or the key is not configured", async () => {
    const { db } = mockDatabase();
    const { fetcher } = provider({ fail: true });
    expect((await reviewListingContentSafety(job(), db, KEY, fetcher)).state)
      .toBe("incomplete");
    expect(await reviewListingContentSafety(job(), db, undefined, fetcher)).toEqual({
      state: "incomplete", reason: "PROVIDER_UNCONFIGURED",
    });
  });

  it("fails closed when a listing changes during provider evaluation", async () => {
    const { db } = mockDatabase([MEDIA_A], true);
    const { fetcher } = provider();
    expect(await reviewListingContentSafety(job(), db, KEY, fetcher)).toEqual({
      state: "incomplete", reason: "MANIFEST_CHANGED",
    });
  });

  it("fails closed for missing and excessive media", async () => {
    const { fetcher } = provider();
    expect(await reviewListingContentSafety(job(), mockDatabase([]).db, KEY, fetcher))
      .toEqual({ state: "incomplete", reason: "MEDIA_MANIFEST_INVALID" });
    expect(await reviewListingContentSafety(
      job(), mockDatabase(Array.from({ length: 9 }, (_, i) =>
        "00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
      )).db, KEY, fetcher,
    )).toEqual({ state: "incomplete", reason: "MEDIA_MANIFEST_INVALID" });
  });
});
