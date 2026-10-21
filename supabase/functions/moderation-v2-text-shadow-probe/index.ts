import { createClient } from "@supabase/supabase-js";
import {
  runTextShadowProbe,
  type TextShadowDeps,
} from "../../../src/lib/moderation/v2/text-shadow-probe.ts";
import {
  moderateText,
  type ModerationOutcome,
} from "../../../src/lib/moderation/v2/free-moderation.ts";

/**
 * Production-authorized text-only manual shadow probe.
 * Endpoint is authenticated by Supabase JWT gateway (verify_jwt=true) PLUS
 * exact service-role bearer comparison. Never call from Web, Admin UI,
 * Android, iOS or public clients. Operator invocation only.
 *
 * Supports an independently authenticated synthetic connectivity check
 * without reading any real listing or photo.
 * Reads a single DB listing, calls free OpenAI Moderation for title/description,
 * reads DB again, and returns only sanitized results. NEVER writes to DB or
 * Storage, never claims a queue job, never invokes finalization/publication.
 */
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

export interface ShadowProbeRuntime extends TextShadowDeps {
  getEnv(name: string): string | undefined;
}

const PROD_URL = "https://kriuhwppxgxsyyrbjsau.supabase.co";
const MAX_BODY_BYTES = 512;

function respond(status: number, code: string, extra?: Record<string, unknown>): Response {
  return Response.json(
    { code, ...(extra ?? {}) },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a), right = encoder.encode(b);
  const n = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < n; i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

async function boundedJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new Error("BODY_TOO_LARGE");
  }
  if (!request.body) throw new Error("INVALID_BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
}

/** Exported for network-free security tests with injected fake dependencies. */
export async function handleTextShadowProbeRequest(
  request: Request,
  runtime: ShadowProbeRuntime,
): Promise<Response> {
  if (request.method !== "POST") return respond(405, "METHOD_NOT_ALLOWED");

  const serviceRole = runtime.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const bearer = request.headers.get("authorization");
  if (!serviceRole || serviceRole.length < 40 || !bearer ||
      !constantTimeEqual(bearer, "Bearer " + serviceRole)) {
    return respond(401, "UNAUTHORIZED");
  }
  // Enforce existing Production project only; never accidentally evaluate
  // private listings from a separately configured environment.
  if (runtime.getEnv("SUPABASE_URL") !== PROD_URL) {
    return respond(503, "PRODUCTION_TARGET_REQUIRED");
  }
  const key = runtime.getEnv("OPENAI_API_KEY");
  if (!key || key.length < 20) return respond(503, "OPENAI_NOT_CONFIGURED");

  let input: unknown;
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return respond(415, "INVALID_CONTENT_TYPE");
    }
    input = await boundedJson(request);
  } catch {
    return respond(400, "INVALID_REQUEST");
  }
  // Operator-only, synthetic-only OpenAI connectivity proof.
  // No seller text, photo, listing lookup or publication is involved.
  // The strict service-role+JWT and Production-project checks above
  // MUST complete before this branch is reachable.
  if (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    (input as Record<string, unknown>).probe === "synthetic_connectivity"
  ) {
    let provider: ModerationOutcome;
    try {
      provider = await runtime.moderateText(
        "A used bicycle is available for inspection in Pune. No advance payment required.",
      );
    } catch {
      provider = { state: "failed", reason: "PROVIDER_UNAVAILABLE" };
    }
    if (provider.state === "failed") {
      return respond(503, "OPENAI_MODERATION_CHECK_FAILED", {
        authority: "SYNTHETIC_CONNECTIVITY_ONLY",
        reason: provider.reason,
      });
    }
    if (provider.model !== "omni-moderation-2024-09-26") {
      return respond(503, "OPENAI_MODERATION_CHECK_FAILED", {
        authority: "SYNTHETIC_CONNECTIVITY_ONLY",
        reason: "PROVIDER_SCHEMA",
      });
    }
    return respond(200, "OPENAI_MODERATION_CONNECTED", {
      authority: "SYNTHETIC_CONNECTIVITY_ONLY",
      scope: "BENIGN_SYNTHETIC_TEXT_NOT_LISTING_REVIEW",
      model: provider.model,
      provider: provider.state,
    });
  }

  const result = await runTextShadowProbe(input, runtime);
  if (!result.ok) {
    return respond(
      result.code === "NOT_FOUND" ? 404 :
      result.code === "INVALID_REQUEST" ? 400 : 503,
      result.code,
    );
  }
  return respond(200, "SHADOW_TEXT_ONLY", { result });
}

export async function processTextShadowProbeHandler(request: Request): Promise<Response> {
  const getEnv = (key: string) => Deno.env.get(key);
  let client: ReturnType<typeof createClient> | undefined;
  const runtime: ShadowProbeRuntime = {
    getEnv,
    loadListing: async (listingId) => {
      // Client is created only after authorization and provider config checks.
      if (!client) {
        client = createClient(
          getEnv("SUPABASE_URL") ?? "",
          getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "",
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
      }
      const { data, error } = await client
        .from("listings")
        .select("id, title, description, status, revision, updated_at")
        .eq("id", listingId)
        .maybeSingle();
      if (error) throw new Error("READ_FAILED");
      return data;
    },
    moderateText: async (text: string): Promise<ModerationOutcome> =>
      moderateText(text, { apiKey: getEnv("OPENAI_API_KEY") ?? "" }),
  };
  return handleTextShadowProbeRequest(request, runtime);
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(processTextShadowProbeHandler);
}
