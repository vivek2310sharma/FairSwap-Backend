import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateModerationV2 } from "../lib/moderation/v2/evaluate";
import { moderateOpenAI } from "../lib/moderation/v2/openai";
import { CATEGORIES, IMAGE_CATEGORIES, MODEL, POLICY, ModerationResultV2Schema,
  type SnapshotV2, type EvaluationResultV2 } from "../lib/moderation/v2/contract";
import * as rules from "../lib/moderation/rules";

type Input = Parameters<typeof evaluateModerationV2>[0];
type Check = EvaluationResultV2["checks"][number];
const uuid = (n: number) => `00000000-0000-4000-a000-${n.toString(16).padStart(12, "0")}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function snapshotHash(snapshot: SnapshotV2) {
  return hash(JSON.stringify(["fairswap:v2:snapshot_v1", "2.0.0", POLICY, snapshot.listing_id,
    snapshot.listing_revision, snapshot.generation_id, snapshot.title_sha256,
    snapshot.description_sha256, snapshot.media_manifest_sha256]));
}
function wire(kind: "text" | "image", flagged = false) {
  return { id: "synthetic_response", model: MODEL, results: [{ flagged,
    categories: Object.fromEntries(CATEGORIES.map(c => [c, flagged && c === "violence"])),
    category_scores: Object.fromEntries(CATEGORIES.map(c => [c, flagged && c === "violence" ? 0.9 : 0.002])),
    category_applied_input_types: Object.fromEntries(CATEGORIES.map(c => [c,
      kind === "text" || IMAGE_CATEGORIES.includes(c) ? [kind] : []])),
  }] };
}
async function fixture(count = 1, title = "Synthetic bicycle", description = "Synthetic bicycle for local pickup."): Promise<Input> {
  const object = (n: number, bytes: Uint8Array) => ({ object_id: uuid(n), sha256: hash(bytes),
    bytes: bytes.length, width: 1, height: 1 });
  // Bytes stand in for a registered synthetic WebP: no actual decoding/sealing is claimed.
  const media = Array.from({ length: count }, (_, i) => {
    const n = 100 + i * 10;
    const bytes = new Uint8Array([1, 2, i]);
    const original = object(n + 1, bytes);
    return { media_id: uuid(n), asset_version: uuid(n + 6), display_order: i, source_sha256: original.sha256,
      recipe: "seal_v1" as const, original, canonical: object(n + 2, bytes), thumb: object(n + 3, bytes),
      medium: object(n + 4, bytes), large: object(n + 5, bytes) };
  });
  const snapshot: SnapshotV2 = { listing_id: uuid(1), listing_revision: 2, generation_id: uuid(2),
    canonicalization: "snapshot_v1", title_sha256: hash(title), description_sha256: hash(description),
    media_manifest_sha256: hash("opaque synthetic DB-owned source manifest"), snapshot_sha256: "",
    cover_media_id: media[0].media_id, media };
  snapshot.snapshot_sha256 = snapshotHash(snapshot);
  const images = media.map((m, i) => ({ media_id: m.media_id, canonicalWebp: new Uint8Array([1, 2, i]),
    integrity: { snapshot_sha256: snapshot.snapshot_sha256, sealed_media: structuredClone(m), check: {
      check_id: "image_integrity_v2", target: { kind: "image", media_id: m.media_id },
      input_sha256: m.canonical.sha256, state: "passed", reason_codes: [], retryable: false, provider: null,
    } as Check } }));
  const observations: NonNullable<Input["observations"]>[number][] = [];
  for (const field of ["title", "description"] as const) {
    const value = field === "title" ? title : description;
    const result = await moderateOpenAI({ kind: "text", field, text: value }, {
      apiKey: "fake-key", timeoutMs: 100, transport: async () => new Response(JSON.stringify(wire("text"))),
    });
    observations.push({ snapshot_sha256: snapshot.snapshot_sha256, input_sha256: hash(value), result });
  }
  for (const image of images) {
    const result = await moderateOpenAI({ kind: "image", imageId: image.media_id, canonicalWebp: image.canonicalWebp }, {
      apiKey: "fake-key", timeoutMs: 100, transport: async () => new Response(JSON.stringify(wire("image"))),
    });
    observations.push({ snapshot_sha256: snapshot.snapshot_sha256, input_sha256: hash(image.canonicalWebp), result });
  }
  return { request_id: uuid(3), attempt_id: uuid(4), evaluated_at: "2026-10-18T12:00:00Z",
    listing_id: snapshot.listing_id, listing_revision: snapshot.listing_revision, generation_id: snapshot.generation_id,
    title, description, snapshot, images, observations };
}
function evaluation(result: Awaited<ReturnType<typeof evaluateModerationV2>>) {
  expect(ModerationResultV2Schema.safeParse(result).success).toBe(true);
  if (result.phase !== "evaluation") throw new Error("Expected synthetic evaluation");
  return result;
}
afterEach(() => vi.restoreAllMocks());

describe("pure V2 evaluator with mocked completed evidence", () => {
  it.each([1, 8])("assembles complete coverage for %i images independent of reply order", async count => {
    const input = await fixture(count);
    input.observations = [...input.observations!].reverse();
    input.images = [...input.images!].reverse();
    const before = structuredClone(input);
    const result = evaluation(await evaluateModerationV2(input));
    expect(result.outcome).toBe("no_review_flags");
    expect(result.checks).toHaveLength(8 + 2 * count);
    expect(result.checks.filter(c => c.target.kind === "text")).toHaveLength(8);
    const providers = result.checks.filter(c => c.provider);
    expect(providers).toHaveLength(count + 2);
    for (const check of providers) {
      expect(check.provider?.response_id).toBe("synthetic_response");
      expect(check.provider?.categories.filter(c => c.applicability === "evaluated"))
        .toHaveLength(check.target.kind === "text" ? 13 : 6);
    }
    expect(input).toEqual(before);
    expect(await evaluateModerationV2(input)).toEqual(result);
  });
  it.each([
    ["firearm for sale", "PROHIBITED_WORDING"],
    ["Synthetic bicycle bit.ly/test", "SHORTENED_LINK"],
    ["Pay token before viewing", "PAYMENT_BEFORE_VIEWING"],
  ])("preserves the existing rule on either field: %s", async (value, reason) => {
    for (const field of ["title", "description"] as const) {
      const input = await fixture(1, field === "title" ? value : undefined, field === "description" ? value : undefined);
      const result = evaluation(await evaluateModerationV2(input));
      expect(result.outcome).toBe("needs_review");
      expect(result.checks.some(c => c.target.kind === "text" && c.target.field === field && c.reason_codes.includes(reason as Check["reason_codes"][number]))).toBe(true);
    }
  });
  it.each(["Heroine poster and glue gun", "Army-green bicycle", "OTP ya UPI PIN kabhi share mat karo"])("retains current benign/gap behavior: %s", async title => {
    expect((await evaluateModerationV2(await fixture(1, title))).outcome).toBe("no_review_flags");
  });
  it.each(["title", "description", "image"] as const)("maps independent provider flag on %s", async kind => {
    const input = await fixture();
    const index = kind === "title" ? 0 : kind === "description" ? 1 : 2;
    const obs = input.observations![index];
    const result = obs.result;
    if (!result.ok) throw new Error("Expected mocked provider success");
    result.flagged = true;
    const finding = result.findings.find(f => f.category === "violence")!;
    finding.flag = true; finding.score = 0.9;
    const evaluated = evaluation(await evaluateModerationV2(input));
    expect(evaluated.outcome).toBe("needs_review");
    expect(evaluated.checks.filter(c => c.state === "flagged")).toHaveLength(1);
  });
  it.each([
    ["PROVIDER_TIMEOUT", "TIMEOUT", true], ["PROVIDER_RATE_LIMIT", "RATE_LIMIT", true],
    ["PROVIDER_TRANSPORT", "TRANSPORT", true], ["PROVIDER_5XX", "PROVIDER_5XX", true],
    ["PROVIDER_SCHEMA", "PROVIDER_SCHEMA", true],
    ["PROVIDER_AUTH", "PROVIDER_AUTH", false], ["PROVIDER_INPUT", "PROVIDER_INPUT", false],
  ] as const)("maps %s without losing existing FairSwap flags", async (code, reason, retryable) => {
    const input = await fixture(1, "firearm for sale");
    input.observations = input.observations!.map((o, i) => i === 1 ? { ...o,
      result: { ok: false, target: { kind: "text", field: "description" }, code } } : o);
    const result = evaluation(await evaluateModerationV2(input));
    expect(result.outcome).toBe("checks_incomplete");
    expect(result.checks.some(c => c.state === "flagged" && c.reason_codes.includes("PROHIBITED_WORDING"))).toBe(true);
    expect(result.checks.find(c => c.check_id === "openai_text_v2" && c.target.kind === "text" && c.target.field === "description"))
      .toMatchObject({ state: "failed", provider: null, reason_codes: [reason], retryable });
  });
  it.each(["missing", "duplicate", "stale digest", "stale snapshot", "swapped targets"])("fails closed for %s provider evidence", async mode => {
    const input = await fixture();
    const observations = [...input.observations!];
    if (mode === "missing") observations.pop();
    if (mode === "duplicate") observations.push(structuredClone(observations[0]));
    if (mode === "stale digest") observations[0].input_sha256 = hash("stale");
    if (mode === "stale snapshot") observations[0].snapshot_sha256 = hash("stale");
    if (mode === "swapped targets") observations[1].result.target = { kind: "text", field: "title" };
    input.observations = observations;
    expect((await evaluateModerationV2(input)).outcome).toBe("checks_incomplete");
  });
  it.each(["missing seal", "stale seal", "altered bytes", "missing image", "duplicate image", "failed integrity"])("fails closed for %s", async mode => {
    const input = await fixture();
    const images = [...input.images!];
    if (mode === "missing seal") delete images[0].integrity;
    if (mode === "stale seal") images[0].integrity!.snapshot_sha256 = hash("stale");
    if (mode === "altered bytes") images[0].canonicalWebp[0] = 99;
    if (mode === "missing image") images.pop();
    if (mode === "duplicate image") images.push(structuredClone(images[0]));
    if (mode === "failed integrity") Object.assign(images[0].integrity!.check,
      { state: "failed", reason_codes: ["UNSUPPORTED_MEDIA"] });
    input.images = images;
    const result = evaluation(await evaluateModerationV2(input));
    expect(result.outcome).toBe("checks_incomplete");
    expect(result.checks.find(c => c.check_id === "image_integrity_v2")?.state).toBe("failed");
    expect(result.checks.find(c => c.check_id === "openai_image_v2")?.state).toBe("failed");
  });
  it.each(["listing_id", "listing_revision", "generation_id", "snapshot_sha256"] as const)("rejects stale context %s as incomplete", async key => {
    const input = await fixture();
    if (key === "snapshot_sha256") input.snapshot![key] = hash("forged");
    else if (key === "listing_revision") input[key]++;
    else input[key] = uuid(900);
    expect((await evaluateModerationV2(input)).outcome).toBe("checks_incomplete");
  });
  it("hashes exact Unicode/whitespace without silently changing provider identity", async () => {
    const input = await fixture(1, "  Synthetic e\u0301  ");
    expect((await evaluateModerationV2(input)).outcome).toBe("no_review_flags");
    input.title = (input.title as string).normalize("NFC");
    expect((await evaluateModerationV2(input)).outcome).toBe("checks_incomplete");
  });
  it.each(["asset version", "canonical object", "source hash", "display order"])("invalidates seal evidence after changing %s", async change => {
    const input = await fixture();
    const media = input.snapshot!.media[0];
    if (change === "asset version") media.asset_version = uuid(987);
    if (change === "canonical object") media.canonical.object_id = uuid(986);
    if (change === "source hash") { media.source_sha256 = hash("reprocessed source"); media.original.sha256 = media.source_sha256; }
    if (change === "display order") media.display_order++;
    expect((await evaluateModerationV2(input)).outcome).toBe("checks_incomplete");
  });
  it("retains a provider image flag when seal evidence is incomplete", async () => {
    const input = await fixture();
    delete input.images![0].integrity;
    const observed = input.observations![2].result;
    if (!observed.ok) throw new Error("Expected mocked provider success");
    observed.flagged = true;
    const finding = observed.findings.find(f => f.category === "violence")!;
    finding.flag = true; finding.score = 0.9;
    const result = evaluation(await evaluateModerationV2(input));
    expect(result.outcome).toBe("checks_incomplete");
    expect(result.checks.find(c => c.check_id === "openai_image_v2"))
      .toMatchObject({ state: "failed", reason_codes: ["PROVIDER_FLAG", "SEAL_INVALID"], provider: { flagged: true } });
  });
  it.each([
    [undefined, "TYPE"], [12, "TYPE"], [" x ", "TOO_SHORT"], ["x".repeat(151), "TOO_LONG"],
  ] as const)("returns early title validation %# without a sealed snapshot", async (title, code) => {
    const input = await fixture();
    input.title = title; delete input.snapshot; delete input.images; delete input.observations;
    const result = await evaluateModerationV2(input);
    expect(result).toMatchObject({ phase: "input_validation", outcome: "invalid_input",
      title_sha256: typeof title === "string" ? hash(title) : null, validation_errors: [{ field: "title", code }] });
    expect(result).not.toHaveProperty("snapshot"); expect(result).not.toHaveProperty("checks");
  });
  it("returns one deterministic validation error per field", async () => {
    const input = await fixture(); input.title = null; input.description = "short";
    expect(await evaluateModerationV2(input)).toMatchObject({ phase: "input_validation",
      validation_errors: [{ field: "title", code: "TYPE" }, { field: "description", code: "TOO_SHORT" }] });
  });
  it("preserves flags from other rules when a local rule throws", async () => {
    const input = await fixture(1, "firearm for sale");
    vi.spyOn(rules, "evaluateShortenedLinks").mockImplementation(() => { throw new Error("synthetic secret"); });
    const result = evaluation(await evaluateModerationV2(input));
    expect(result.outcome).toBe("checks_incomplete");
    expect(result.checks.some(c => c.reason_codes.includes("PROHIBITED_WORDING"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic secret");
  });
  it("rejects malformed snapshots with sanitized error", async () => {
    const input = await fixture(); delete input.snapshot;
    await expect(evaluateModerationV2(input)).rejects.toThrow("INVALID_V2_SNAPSHOT");
  });
  it("rejects evidence for unattached media", async () => {
    const input = await fixture(); input.images = [...input.images!, { media_id: uuid(999), canonicalWebp: new Uint8Array([1]) }];
    await expect(evaluateModerationV2(input)).rejects.toThrow("UNEXPECTED_V2_EVIDENCE");
  });
  it.each(["summary", "TITLE", "", undefined])("rejects an extra unexpected text field %# instead of ignoring it", async field => {
    const input = await fixture();
    for (const ok of [true, false]) {
      const extra = structuredClone(input.observations![0]);
      if (!ok) extra.result = { ok: false, target: { kind: "text", field: "title" }, code: "PROVIDER_INPUT" };
      // Exercise runtime input validation at a JavaScript/trust boundary.
      Object.assign(extra.result.target, { field });
      await expect(evaluateModerationV2({ ...input, observations: [...input.observations!, extra] }))
        .rejects.toThrow("UNEXPECTED_V2_EVIDENCE");
    }
  });
  it("rejects an unknown observation target kind", async () => {
    const input = await fixture();
    const extra = structuredClone(input.observations![0]);
    Object.assign(extra.result.target, { kind: "audio" });
    await expect(evaluateModerationV2({ ...input, observations: [...input.observations!, extra] }))
      .rejects.toThrow("UNEXPECTED_V2_EVIDENCE");
  });
  it.each([201, 301, 302, 307, 404, 405, 409, 418])("maps actual unexpected HTTP %s to a non-retryable approved reason", async status => {
    const input = await fixture(1, "firearm for sale");
    const result = await moderateOpenAI({ kind: "text", field: "description", text: input.description as string }, {
      apiKey: "fake-key", timeoutMs: 100,
      transport: async () => new Response(JSON.stringify({ error: "synthetic sensitive body" }), {
        status, headers: { "retry-after": "1" },
      }),
    });
    input.observations = input.observations!.map((o, i) => i === 1 ? { ...o, result } : o);
    const evaluated = evaluation(await evaluateModerationV2(input));
    expect(evaluated.outcome).toBe("checks_incomplete");
    expect(evaluated.checks.find(c => c.check_id === "openai_text_v2"
      && c.target.kind === "text" && c.target.field === "description"))
      .toMatchObject({ state: "failed", reason_codes: ["PROVIDER_INPUT"], retryable: false, provider: null });
    expect(evaluated.checks.some(c => c.reason_codes.includes("PROHIBITED_WORDING"))).toBe(true);
    expect(JSON.stringify(evaluated)).not.toContain("synthetic sensitive body");
  });
});
