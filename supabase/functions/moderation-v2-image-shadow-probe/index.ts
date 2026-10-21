import { hasExactManagedServiceRoleBearer, hasProductionServiceRoleClaims } from "../../../src/lib/moderation/v2/production-operator-jwt.ts";
import { createClient } from "@supabase/supabase-js";
import {
  runImageShadowProbe,
  type ImageShadowDeps,
} from "../../../src/lib/moderation/v2/image-shadow-probe.ts";
import {
  moderateCanonicalWebp,
} from "../../../src/lib/moderation/v2/free-moderation.ts";
import { isSyntheticImageConnectivityRequest, runSyntheticImageConnectivity } from "../../../src/lib/moderation/v2/synthetic-image-connectivity.ts";

/**
 * FairSwapProd operator-only one-image V2 shadow probe.
 *
 * verify_jwt=true (gateway) AND exact service-role JWT check (here).
 * Never accessible from browsers or mobile clients. This function does not
 * write the database or Storage; it cannot publish or approve a listing.
 *
 * Images are taken from the legacy medium WebP derivative. They are NOT
 * canonical sealed evidence and no independent Storage WORM is claimed.
 */

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

const PROD_URL = "https://kriuhwppxgxsyyrbjsau.supabase.co";
const MAX_INPUT_BYTES = 512;
const MAX_WEBP_BYTES = 5 * 1024 * 1024;

export interface ImageShadowRuntime extends ImageShadowDeps {
  getEnv(key: string): string | undefined;
}

function respond(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ code, ...extra }, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function boundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_INPUT_BYTES)) {
    throw new Error("INVALID_BODY");
  }
  if (!request.body) throw new Error("INVALID_BODY");
  const reader = request.body.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_INPUT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("BODY_TOO_LARGE");
      }
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

export async function handleImageShadowRequest(
  req: Request,
  runtime: ImageShadowRuntime,
): Promise<Response> {
  if (req.method !== "POST") return respond(405, "METHOD_NOT_ALLOWED");

  // Supabase's JWT-enabled gateway verifies the signature. Never
  // authorize a user JWT, an anon JWT or a non-Production role claim.
  if (!hasProductionServiceRoleClaims(req)) {
    return respond(401, "UNAUTHORIZED");
  }
  if (runtime.getEnv("SUPABASE_URL") !== PROD_URL) {
    return respond(503, "PRODUCTION_TARGET_REQUIRED");
  }
  const openaiKey = runtime.getEnv("OPENAI_API_KEY");
  if (!openaiKey || openaiKey.length < 20) {
    return respond(503, "OPENAI_NOT_CONFIGURED");
  }
  const ct = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!ct.startsWith("application/json")) return respond(415, "INVALID_CONTENT_TYPE");

  let body: unknown;
  try {
    body = await boundedJson(req);
  } catch {
    return respond(400, "INVALID_REQUEST");
  }
  if (isSyntheticImageConnectivityRequest(body)) {
    const check = await runSyntheticImageConnectivity(runtime.moderateImage);
    if (!check.ok) return respond(503, "OPENAI_IMAGE_MODERATION_CHECK_FAILED", { authority: "SYNTHETIC_CONNECTIVITY_ONLY", reason: check.reason });
    return respond(200, "OPENAI_IMAGE_MODERATION_CONNECTED", { authority: "SYNTHETIC_CONNECTIVITY_ONLY", scope: "BENIGN_SYNTHETIC_IMAGE_NOT_LISTING_REVIEW", model: check.model, provider: check.provider });
  }
  // Existing private listing/media shadow reads retain the original exact
  // managed service-key check. The JWT-claims fallback applies ONLY to
  // the fixed benign synthetic connectivity fixture.
  if (!hasExactManagedServiceRoleBearer(req, runtime.getEnv("SUPABASE_SERVICE_ROLE_KEY"))) {
    return respond(401, "UNAUTHORIZED");
  }
  const result = await runImageShadowProbe(body, runtime);
  if (!result.ok) {
    const status =
      result.code === "INVALID_REQUEST" ? 400 :
      result.code === "NOT_FOUND" ? 404 :
      result.code === "UNSUPPORTED_SOURCE" ? 409 :
      503;
    return respond(status, result.code);
  }
  return respond(200, "SHADOW_IMAGE_ONLY", { result });
}

export async function processImageShadowHandler(req: Request): Promise<Response> {
  const getEnv = (key: string) => Deno.env.get(key);
  let client: ReturnType<typeof createClient> | undefined;
  function db() {
    if (!client) {
      client = createClient(
        getEnv("SUPABASE_URL") ?? "",
        getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
    }
    return client;
  }
  const runtime: ImageShadowRuntime = {
    getEnv,
    async loadSnapshot(listingId, mediaId) {
      const { data: listing, error: listingError } = await db()
        .from("listings")
        .select("id, status, revision, updated_at")
        .eq("id", listingId)
        .maybeSingle();
      if (listingError) throw new Error("SNAPSHOT_UNAVAILABLE");
      if (!listing) return null;
      const { data: media, error: mediaError } = await db()
        .from("listing_media")
        .select(
          "id, listing_id, original_storage_path, thumbnail_storage_path, " +
          "medium_storage_path, large_storage_path, processing_status, " +
          "display_order, created_at",
        )
        .eq("id", mediaId)
        .eq("listing_id", listingId)
        .maybeSingle();
      if (mediaError) throw new Error("SNAPSHOT_UNAVAILABLE");
      if (!media) return null;
      return { listing, media };
    },
    async readMedium(key) {
      // Bucket and key are derived ONLY from a DB-sourced, strict V1
      // identity. Never accept an arbitrary caller-provided storage URL.
      const { data, error } = await db().storage
        .from("listing-derivatives")
        .download(key, {}, {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
      if (error || !data) throw new Error("STORAGE_UNAVAILABLE");
      if (data.size < 22 || data.size > MAX_WEBP_BYTES) {
        throw new Error("MEDIA_SIZE_INVALID");
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async moderateImage(bytes, sha) {
      return moderateCanonicalWebp(bytes, sha, {
        apiKey: getEnv("OPENAI_API_KEY") ?? "",
        timeoutMs: 15_000,
      });
    },
  };
  return handleImageShadowRequest(req, runtime);
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(processImageShadowHandler);
}
