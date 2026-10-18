// Provider-local types only. This module is not the shared V2 evaluation contract.
// Wire format: https://developers.openai.com/api/docs/guides/moderation
import { MODEL, CATEGORIES, IMAGE_CATEGORIES } from "./contract";
type Category = typeof CATEGORIES[number];
type Input = { kind: "text"; field: "title" | "description"; text: string }
  | { kind: "image"; imageId: string; canonicalWebp: Uint8Array };
type FailureCode = "PROVIDER_TIMEOUT" | "PROVIDER_RATE_LIMIT" | "PROVIDER_TRANSPORT"
  | "PROVIDER_AUTH" | "PROVIDER_INPUT" | "PROVIDER_SCHEMA" | "PROVIDER_5XX";
type Finding = { category: Category; applicable: true; flag: boolean; score: number }
  | { category: Category; applicable: false; flag: null; score: null };
type Target = { kind: "text"; field: "title" | "description" } | { kind: "image"; imageId: string };
type Result = { ok: true; target: Target; model: typeof MODEL; responseId: string; requestId: string | null; flagged: boolean; findings: Finding[] }
  | { ok: false; target: Target; code: FailureCode; retryAfterMs?: number };
type Failure = Extract<Result, { ok: false }>;
type Transport = (url: string, init: RequestInit) => Promise<Response>;
type Options = { apiKey: string; transport: Transport; timeoutMs: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactCategories(value: unknown): value is Record<Category, unknown> {
  return record(value) && Object.keys(value).length === CATEGORIES.length
    && CATEGORIES.every(key => Object.hasOwn(value, key));
}
function parse(value: unknown, target: Target, requestId: string | null): Result {
  const fail = (): Failure => ({ ok: false, target, code: "PROVIDER_SCHEMA" });
  if (!record(value) || value.model !== MODEL || typeof value.id !== "string"
    || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id)
    || (requestId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(requestId))
    || !Array.isArray(value.results) || value.results.length !== 1) return fail();
  const result: unknown = value.results[0];
  if (!record(result) || typeof result.flagged !== "boolean"
    || !exactCategories(result.categories) || !exactCategories(result.category_scores)
    || !exactCategories(result.category_applied_input_types)) return fail();
  const findings: Finding[] = [];
  for (const category of CATEGORIES) {
    const flag = result.categories[category];
    const score = result.category_scores[category];
    const types = result.category_applied_input_types[category];
    const applicable = target.kind === "text" || IMAGE_CATEGORIES.includes(category);
    if (typeof flag !== "boolean" || typeof score !== "number" || !Number.isFinite(score)
      || score < 0 || score > 1 || !Array.isArray(types)
      || types.length !== (applicable ? 1 : 0)
      || (applicable && types[0] !== target.kind)) return fail();
    // Unsupported scores may be nonzero; they never establish image coverage.
    if (!applicable) {
      if (flag) return fail();
      findings.push({ category, applicable: false, flag: null, score: null });
    } else findings.push({ category, applicable: true, flag, score });
  }
  if (result.flagged !== findings.some(f => f.flag === true)) return fail();
  return { ok: true, target, model: MODEL, responseId: value.id, requestId, flagged: result.flagged, findings };
}

/** One field/image per call; identifiers stay local. Caller verifies seals/digests.
 * No default fetch, retries, logging, environment reads, or shared V2 envelope.
 * Injected transport must honor abort and redirect:error. Timeout also bounds JSON reads.
 */
export async function moderateOpenAI(input: Input, options: Options): Promise<Result> {
  const target: Target = input.kind === "text" ? { kind: "text", field: input.field }
    : { kind: "image", imageId: input.imageId };
  const fail = (code: FailureCode): Failure => ({ ok: false, target, code });
  if (!options.apiKey || /[\r\n]/.test(options.apiKey)
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000
    || typeof options.transport !== "function") return fail("PROVIDER_INPUT");
  if (input.kind === "text" ? !["title", "description"].includes(input.field)
    || typeof input.text !== "string" || !input.text.trim()
    : !input.imageId || !(input.canonicalWebp instanceof Uint8Array)
      || input.canonicalWebp.length === 0 || input.canonicalWebp.length > 5 * 1024 * 1024) {
    return fail("PROVIDER_INPUT");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<Result>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fail("PROVIDER_TIMEOUT"));
      controller.abort();
    }, options.timeoutMs);
  });
  const work = async (): Promise<Result> => {
    try {
      // Byte conversion is deliberately runtime-neutral (no Node Buffer in Edge code).
      let encoded = "";
      if (input.kind === "image") {
        for (const byte of input.canonicalWebp) encoded += String.fromCharCode(byte);
      }
      const item = input.kind === "text" ? { type: "text", text: input.text }
        : { type: "image_url", image_url: { url: `data:image/webp;base64,${btoa(encoded)}` } };
      const response = await options.transport("https://api.openai.com/v1/moderations", {
        method: "POST", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: [item] }),
      });
      if (timedOut) return fail("PROVIDER_TIMEOUT");
      if (response.status !== 200) {
        const code: FailureCode = response.status === 401 || response.status === 403 ? "PROVIDER_AUTH"
          : response.status === 429 ? "PROVIDER_RATE_LIMIT"
          : response.status === 400 || response.status === 413 || response.status === 422 ? "PROVIDER_INPUT"
          // Unexpected non-transient statuses are input/configuration failures,
          // not malformed moderation results eligible for a schema retry.
          : response.status >= 500 && response.status <= 599 ? "PROVIDER_5XX" : "PROVIDER_INPUT";
        const result = fail(code);
        // Numeric Retry-After only; no raw headers/errors escape this module.
        const retry = response.headers.get("retry-after");
        if ((code === "PROVIDER_RATE_LIMIT" || code === "PROVIDER_5XX")
          && retry && /^\d+(\.\d+)?$/.test(retry)) {
          const ms = Number(retry) * 1000;
          if (Number.isFinite(ms) && ms <= 120_000) result.retryAfterMs = Math.ceil(ms);
        }
        return result;
      }
      try { return parse(await response.json(), target, response.headers.get("x-request-id")); }
      catch { return fail(timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_SCHEMA"); }
    } catch { return fail(timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_TRANSPORT"); }
  };
  try { return await Promise.race([work(), timeout]); }
  finally { clearTimeout(timer); }
}
