import { afterEach, describe, expect, it, vi } from "vitest";
import { moderateOpenAI } from "../lib/moderation/v2/openai";

// Synthetic fixtures only; shared no-network setup is required by the focused runner.
const categories = ["harassment", "harassment/threatening", "hate", "hate/threatening",
  "illicit", "illicit/violent", "sexual/minors", "sexual", "self-harm", "self-harm/intent",
  "self-harm/instructions", "violence", "violence/graphic"];
const model = "omni-moderation-2024-09-26";
const text = { kind: "text", field: "title", text: "Synthetic bicycle" } as const;
const image = { kind: "image", imageId: "synthetic-image-1", canonicalWebp: new Uint8Array([1, 2, 3]) } as const;
function fixture(kind: "text" | "image" = "text", flagged?: string) {
  return { id: "synthetic-response", model, results: [{ flagged: !!flagged,
    categories: Object.fromEntries(categories.map(c => [c, c === flagged])),
    category_scores: Object.fromEntries(categories.map(c => [c, c === flagged ? 0.9 : 0])),
    category_applied_input_types: Object.fromEntries(categories.map((c, i) => [c,
      kind === "image" && i < 7 ? [] : [kind]])),
  }] };
}
const options = (body: unknown, status = 200, headers?: HeadersInit) => ({
  apiKey: "fake-test-key", timeoutMs: 100,
  transport: vi.fn(async () => new Response(JSON.stringify(body), { status, headers })),
});
afterEach(() => vi.useRealTimers());

describe("isolated OpenAI moderation adapter", () => {
  it.each(["title", "description"] as const)("sends exact %s alone without local identifiers", async field => {
    const opts = options(fixture());
    const transport = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(fixture())));
    const result = await moderateOpenAI({ ...text, field, text: " Exact synthetic text\n" }, { ...opts, transport });
    expect(result).toMatchObject({ ok: true, target: { kind: "text", field }, model, flagged: false });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/moderations");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit",
      headers: { Authorization: "Bearer fake-test-key", "Content-Type": "application/json" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ model, input: [{ type: "text", text: " Exact synthetic text\n" }] });
  });
  it("sends image bytes inline, keeps identity local, and reports only six applicable categories", async () => {
    const transport = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(fixture("image"))));
    const result = await moderateOpenAI(image, { ...options(null), transport });
    expect(JSON.parse(transport.mock.calls[0][1].body as string)).toEqual({ model,
      input: [{ type: "image_url", image_url: { url: "data:image/webp;base64,AQID" } }] });
    expect(result).toMatchObject({ ok: true, target: { kind: "image", imageId: image.imageId } });
    if (!result.ok) throw new Error("Expected synthetic success");
    expect(result.findings.filter(f => f.applicable)).toHaveLength(6);
    expect(result.findings.filter(f => !f.applicable)).toEqual(categories.slice(0, 7).map(category =>
      ({ category, applicable: false, flag: null, score: null })));
  });
  it.each(categories)("retains text flag and score for %s", async category => {
    const result = await moderateOpenAI(text, options(fixture("text", category)));
    expect(result).toMatchObject({ ok: true, flagged: true });
    if (result.ok) expect(result.findings).toContainEqual({ category, applicable: true, flag: true, score: 0.9 });
  });
  it.each(categories.slice(7))("retains image flag for %s", async category => {
    expect(await moderateOpenAI(image, options(fixture("image", category)))).toMatchObject({ ok: true, flagged: true });
  });
  it("preserves attribution when independent image calls finish out of order", async () => {
    let release!: (response: Response) => void;
    const first = moderateOpenAI(image, { ...options(null), transport: () => new Promise(resolve => { release = resolve; }) });
    const second = await moderateOpenAI({ ...image, imageId: "synthetic-image-2" }, options(fixture("image", "violence")));
    release(new Response(JSON.stringify(fixture("image"))));
    expect(second).toMatchObject({ ok: true, target: { imageId: "synthetic-image-2" }, flagged: true });
    expect(await first).toMatchObject({ ok: true, target: { imageId: image.imageId }, flagged: false });
  });
  const mutations: Array<[string, (body: ReturnType<typeof fixture>) => void]> = [
    ["alias", b => { b.model = "omni-moderation-latest"; }],
    ["other snapshot", b => { b.model = "omni-moderation-2099-01-01"; }],
    ["missing result", b => { b.results = []; }],
    ["extra result", b => { b.results.push(b.results[0]); }],
    ["missing category", b => { delete b.results[0].categories.hate; }],
    ["unexpected category", b => { b.results[0].categories.unknown = false; }],
    ["missing score", b => { delete b.results[0].category_scores.hate; }],
    ["extra score", b => { b.results[0].category_scores.unknown = 0; }],
    ["bad score", b => { b.results[0].category_scores.hate = 1.1; }],
    ["missing support", b => { delete b.results[0].category_applied_input_types.hate; }],
    ["changed support", b => { b.results[0].category_applied_input_types.hate = ["image"]; }],
    ["duplicate support", b => { b.results[0].category_applied_input_types.hate = ["text", "text"]; }],
    ["aggregate true", b => { b.results[0].flagged = true; }],
    ["aggregate false", b => { b.results[0].categories.hate = true; }],
  ];
  it.each(mutations)("fails closed for %s", async (_name, mutate) => {
    const body = fixture(); mutate(body);
    expect(await moderateOpenAI(text, options(body))).toMatchObject({ ok: false, code: "PROVIDER_SCHEMA" });
  });
  it.each(["unsupported flag", "unsupported score", "required image absent", "support changed"])("rejects image %s", async test => {
    const body = fixture("image");
    if (test === "unsupported flag") body.results[0].categories.hate = true;
    if (test === "unsupported score") body.results[0].category_scores.hate = 0.1;
    if (test === "required image absent") delete body.results[0].categories.violence;
    if (test === "support changed") body.results[0].category_applied_input_types.hate = ["image"];
    expect(await moderateOpenAI(image, options(body))).toMatchObject({ ok: false, code: "PROVIDER_SCHEMA" });
  });
  it.each([[401, "PROVIDER_AUTH"], [403, "PROVIDER_AUTH"], [429, "PROVIDER_RATE_LIMIT"],
    [400, "PROVIDER_INPUT"], [413, "PROVIDER_INPUT"], [422, "PROVIDER_INPUT"],
    [500, "PROVIDER_HTTP"], [503, "PROVIDER_HTTP"], [302, "PROVIDER_HTTP"]] as const)("sanitizes HTTP %s", async (status, code) => {
    expect(await moderateOpenAI(text, options({ error: "SECRET synthetic payload" }, status))).toEqual({ ok: false, target: { kind: "text", field: "title" }, code });
  });
  it("returns bounded numeric retry delay without retrying", async () => {
    const opts = options(null, 429, { "retry-after": "2.5" });
    expect(await moderateOpenAI(text, opts)).toMatchObject({ ok: false, code: "PROVIDER_RATE_LIMIT", retryAfterMs: 2500 });
    expect(opts.transport).toHaveBeenCalledTimes(1);
  });
  it.each(["secret", "999999999999", "-2"])("omits unsafe retry header %s", async retry => {
    expect(await moderateOpenAI(text, options(null, 429, { "retry-after": retry }))).not.toHaveProperty("retryAfterMs");
  });
  it("sanitizes rejected transport", async () => {
    expect(await moderateOpenAI(text, { ...options(null), transport: async () => { throw new Error("synthetic SECRET"); } }))
      .toMatchObject({ ok: false, code: "PROVIDER_TRANSPORT" });
  });
  it("rejects malformed JSON", async () => {
    expect(await moderateOpenAI(text, { ...options(null), transport: async () => new Response("invalid synthetic JSON") }))
      .toMatchObject({ ok: false, code: "PROVIDER_SCHEMA" });
  });
  it.each([null, {}, { model, id: "fixture", results: [null] }])("rejects malformed response %#", async body => {
    expect(await moderateOpenAI(text, options(body))).toMatchObject({ ok: false, code: "PROVIDER_SCHEMA" });
  });
  it.each(["transport", "body"])("bounds stalled %s even if abort is ignored", async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const pending = moderateOpenAI(text, { ...options(null), transport: async (_url, init) => {
      signal = init.signal;
      if (stage === "transport") return new Promise<Response>(() => {});
      return { status: 200, json: () => new Promise(() => {}) } as unknown as Response;
    } });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, code: "PROVIDER_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects invalid input/config before transport", async () => {
    const opts = options(null);
    for (const invalid of [{ ...text, text: " " }, { ...image, canonicalWebp: new Uint8Array() },
      { ...image, canonicalWebp: new Uint8Array(5 * 1024 * 1024 + 1) }]) {
      expect(await moderateOpenAI(invalid, opts)).toMatchObject({ ok: false, code: "PROVIDER_INPUT" });
    }
    expect(await moderateOpenAI(text, { ...opts, apiKey: "" })).toMatchObject({ ok: false, code: "PROVIDER_INPUT" });
    expect(await moderateOpenAI(text, { ...opts, timeoutMs: Infinity })).toMatchObject({ ok: false, code: "PROVIDER_INPUT" });
    expect(opts.transport).not.toHaveBeenCalled();
  });
});
