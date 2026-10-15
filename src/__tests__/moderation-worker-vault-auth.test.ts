import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeModerationWorkerRequest } from "../../supabase/functions/_shared/listing-moderation-worker";

const url = "https://example.com/functions/v1/process-listing-moderation";
const validToken = "a".repeat(64);

function mockedClient(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

describe("MOD-03A private Vault dispatch authorization", () => {
  it("rejects missing and malformed tokens without a database call", async () => {
    const rpc = vi.fn();
    for (const candidate of [undefined, "too-short", "A".repeat(64), "g".repeat(64)]) {
      const request = new Request(url, {
        method: "POST",
        headers: candidate ? { "x-moderation-worker-secret": candidate } : {},
      });
      expect(await authorizeModerationWorkerRequest(request, mockedClient(rpc))).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts only a positive answer from the service-only Vault verification RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const request = new Request(url, {
      method: "POST",
      headers: { "x-moderation-worker-secret": validToken },
    });
    expect(await authorizeModerationWorkerRequest(request, mockedClient(rpc))).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("verify_moderation_worker_secret", {
      p_candidate: validToken,
    });
  });

  it("fails closed for rejection, RPC errors, malformed answers, and outages", async () => {
    const request = new Request(url, {
      method: "POST",
      headers: { "x-moderation-worker-secret": validToken },
    });
    const results = [
      { data: false, error: null },
      { data: true, error: { message: "permission denied" } },
      { data: "true", error: null },
      { data: null, error: null },
    ];
    for (const result of results) {
      expect(
        await authorizeModerationWorkerRequest(
          request,
          mockedClient(vi.fn().mockResolvedValue(result))
        )
      ).toBe(false);
    }
    expect(
      await authorizeModerationWorkerRequest(
        request,
        mockedClient(vi.fn().mockRejectedValue(new Error("network unavailable")))
      )
    ).toBe(false);
  });
});
