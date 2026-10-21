/**
 * FairSwap: production-oriented, standalone FREE OpenAI moderation adapter.
 * Not yet wired to Backend's authoritative V2 queue and finalizer.
 * Must run SERVER SIDE only; never bundle OPENAI_API_KEY into Web/mobile.
 * A returned "clear" is NOT a publish authorization.
 */

export const OPENAI_MODERATION_MODEL = "omni-moderation-2024-09-26" as const;
export type MediaKind = "text" | "image";
export type ModerationCategory =
  | "harassment" | "harassment/threatening" | "hate" | "hate/threatening"
  | "illicit" | "illicit/violent" | "sexual/minors" | "sexual"
  | "self-harm" | "self-harm/intent" | "self-harm/instructions"
  | "violence" | "violence/graphic";
const allCategories: readonly ModerationCategory[] = [
  "harassment", "harassment/threatening", "hate", "hate/threatening",
  "illicit", "illicit/violent", "sexual/minors", "sexual",
  "self-harm", "self-harm/intent", "self-harm/instructions", "violence", "violence/graphic",
];
const imageCategories: readonly ModerationCategory[] = [
  "sexual", "self-harm", "self-harm/intent", "self-harm/instructions",
  "violence", "violence/graphic",
];

export type ModerationOutcome =
  | Readonly<{ state: "flagged" | "clear"; model: string; categoryFlags: Readonly<Record<string, boolean>> }>
  | Readonly<{ state: "failed"; reason: "PROVIDER_AUTH" | "PROVIDER_LIMIT" |
      "PROVIDER_UNAVAILABLE" | "PROVIDER_SCHEMA" | "PROVIDER_INPUT" | "TIMEOUT" }>;

export interface ProviderDeps {
  readonly apiKey: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

function failure(reason: Extract<ModerationOutcome, {state: "failed"}>["reason"]): ModerationOutcome {
  return { state: "failed", reason };
}

function isObject(obj: unknown): obj is Record<string, unknown> {
  return !!obj && typeof obj === "object" && !Array.isArray(obj);
}

function parseResponse(body: unknown, kind: MediaKind): ModerationOutcome {
  if (!isObject(body) || !Array.isArray(body.results) || body.results.length !== 1 ||
      typeof body.model !== "string" ||
      body.model !== OPENAI_MODERATION_MODEL) {
    return failure("PROVIDER_SCHEMA");
  }
  const item: unknown = body.results[0];
  if (!isObject(item) || typeof item.flagged !== "boolean" ||
      !isObject(item.categories) || !isObject(item.category_scores)) {
    return failure("PROVIDER_SCHEMA");
  }
  const supported = kind === "image" ? imageCategories : allCategories;
  const results: Record<string, boolean> = {};
  for (const category of supported) {
    const value = item.categories[category];
    const score = item.category_scores[category];
    if (typeof value !== "boolean" || typeof score !== "number" ||
      !Number.isFinite(score) || score < 0 || score > 1) return failure("PROVIDER_SCHEMA");
    results[category] = value;
  }
  // An unexpected aggregate flag is not a clean result: it may indicate a
  // policy or category change, and must never auto-publish a listing.
  const anySupportedFlag = Object.values(results).some(Boolean);
  if (anySupportedFlag !== item.flagged) return failure("PROVIDER_SCHEMA");
  return { state: item.flagged ? "flagged" : "clear", model: body.model, categoryFlags: results };
}

function base64(bytes: Uint8Array): string {
  // 24,576 bytes is divisible by 3, so per-chunk btoa does not insert padding
  // in the middle of the final base64 string. Avoids max function arg limits.
  let result = "";
  const chunk = 24_576;
  for (let start = 0; start < bytes.length; start += chunk) {
    const part = bytes.subarray(start, Math.min(start + chunk, bytes.length));
    let chars = "";
    for (const byte of part) chars += String.fromCharCode(byte);
    result += btoa(chars);
  }
  return result;
}

async function callProvider(input: unknown, kind: MediaKind, options: ProviderDeps): Promise<ModerationOutcome> {
  if (!options.apiKey || options.apiKey.length < 10) return failure("PROVIDER_AUTH");
  const timeout = Math.min(15_000, Math.max(1, options.timeoutMs ?? 15_000));
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await (options.fetcher ?? fetch)("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return failure("PROVIDER_AUTH");
    if (response.status === 429) return failure("PROVIDER_LIMIT");
    if (!response.ok) return failure("PROVIDER_UNAVAILABLE");
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > 100_000) return failure("PROVIDER_SCHEMA");
    const raw = await response.text();
    if (raw.length > 100_000) return failure("PROVIDER_SCHEMA");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return failure("PROVIDER_SCHEMA"); }
    return parseResponse(body, kind);
  } catch (error) {
    if (controller.signal.aborted) return failure("TIMEOUT");
    void error; // No provider errors, URLs, headers or buyer text logged.
    return failure("PROVIDER_UNAVAILABLE");
  } finally {
    clearTimeout(handle);
  }
}

export async function moderateText(text: string, options: ProviderDeps): Promise<ModerationOutcome> {
  if (!text || typeof text !== "string" || text.length > 5000) return failure("PROVIDER_INPUT");
  return callProvider([{ type: "text", text }], "text", options);
}

export async function moderateCanonicalWebp(
  bytes: Uint8Array,
  expectedSha256: string,
  options: ProviderDeps,
): Promise<ModerationOutcome> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > 5 * 1024 * 1024 ||
      bytes[0] !== 82 || bytes[1] !== 73 || bytes[2] !== 70 || bytes[3] !== 70 ||
      bytes[8] !== 87 || bytes[9] !== 69 || bytes[10] !== 66 || bytes[11] !== 80 ||
      !/^[0-9a-f]{64}$/.test(expectedSha256)) return failure("PROVIDER_INPUT");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  const actual = [...digest].map(x => x.toString(16).padStart(2, "0")).join("");
  if (actual !== expectedSha256) return failure("PROVIDER_INPUT");
  const dataUrl = "data:image/webp;base64," + base64(bytes);
  // Never include a mutable Storage signed URL in an OpenAI request.
  return callProvider([{ type: "image_url", image_url: { url: dataUrl } }], "image", options);
}
