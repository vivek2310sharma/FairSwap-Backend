import { describe, expect, it } from "vitest";
import { isSyntheticImageConnectivityRequest, runSyntheticImageConnectivity } from "../src/lib/moderation/v2/synthetic-image-connectivity.ts";
import { runTextShadowProbe } from "../src/lib/moderation/v2/text-shadow-probe.ts";

describe("synthetic image provider connectivity", () => {
  it("rejects extra caller-supplied fields", () => {
    expect(isSyntheticImageConnectivityRequest({probe:"synthetic_connectivity"})).toBe(true);
    expect(isSyntheticImageConnectivityRequest({probe:"synthetic_connectivity",listingId:"secret"})).toBe(false);
    expect(isSyntheticImageConnectivityRequest(null)).toBe(false);
  });
  it("checks pinned bytes before invoking provider", async () => {
    let calls=0;
    const result=await runSyntheticImageConnectivity(async (bytes, sha) => {
      calls++;
      expect(bytes.length).toBe(376);
      expect(sha).toBe("866a9ba5828a55c5ea2c0b581f9795906669be3ffa181cfc9fd4b40f2b61f080");
      return {state:"clear",model:"omni-moderation-2024-09-26",categoryFlags:{}};
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ok:true,model:"omni-moderation-2024-09-26",provider:"clear"});
  });
  it("fails closed on errors or unexpected model", async () => {
    expect(await runSyntheticImageConnectivity(async () => {throw new Error("secret");})).toEqual({ok:false,reason:"PROVIDER_UNAVAILABLE"});
    expect(await runSyntheticImageConnectivity(async () => ({state:"clear",model:"other",categoryFlags:{}}))).toEqual({ok:false,reason:"PROVIDER_SCHEMA"});
  });
});

describe("shadow text optional description", () => {
  it("does not retry just because description is absent", async () => {
    const listingId="bb2a48d6-f41c-4f50-ac29-c833586a2fe3";
    const listing={id:listingId,title:"Used bicycle for sale in Pune",description:null,status:"pending_review",revision:2,updated_at:"2026-10-21T10:00:00.000Z"};
    const result=await runTextShadowProbe({listingId},{
      loadListing:async()=>listing,
      moderateText:async()=>({state:"clear",model:"omni-moderation-2024-09-26",categoryFlags:{}}),
    });
    expect(result.ok).toBe(true);
    if(result.ok) {
      expect(result.provider.description).toBe("missing");
      expect(result.route).toBe("text_no_flags");
    }
  });
});
