#!/usr/bin/env node
/**
 * FairSwapProd manual V2 shadow probe caller.
 *
 * NEVER pass secrets as CLI arguments or put them in code. Set the existing
 * Supabase service-role JWT only in the operator's trusted process environment.
 * This tool does NOT publish, approve, write to Storage, or trigger V1 jobs.
 *
 * Usage:
 *   node scripts/moderation/v2-shadow-invoke.mjs text <listing-uuid>
 *   node scripts/moderation/v2-shadow-invoke.mjs image <listing-uuid> <media-uuid>
 *
 * Importable run() supports mocked fetch for CI and never logs bearer tokens.
 */

const PROD_URL = "https://kriuhwppxgxsyyrbjsau.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseShadowCommand(args) {
  if (!Array.isArray(args)) return null;
  const [mode, listingId, mediaId, ...rest] = args;
  if (rest.length || !UUID.test(listingId ?? "") ||
      !["text", "image"].includes(mode) ||
      (mode === "text" && mediaId !== undefined) ||
      (mode === "image" && !UUID.test(mediaId ?? ""))) return null;
  return mode === "text"
    ? { mode, body: { listingId } }
    : { mode, body: { listingId, mediaId } };
}

export async function invokeShadow(
  args,
  deps = {
    fetcher: fetch,
    getEnv: key => process.env[key],
  },
) {
  const cmd = parseShadowCommand(args);
  if (!cmd) return { ok: false, code: "INVALID_ARGS" };
  const key = deps.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  // JWT-gated Supabase Edge Function requires the exact project service-role
  // JWT, never the public anon key or a browser/mobile bearer token.
  if (!key || key.length < 40 || key.split(".").length !== 3) {
    return { ok: false, code: "SERVICE_ROLE_JWT_NOT_CONFIGURED" };
  }
  const slug = cmd.mode === "text"
    ? "moderation-v2-text-shadow-probe"
    : "moderation-v2-image-shadow-probe";
  let response;
  try {
    response = await deps.fetcher(
      PROD_URL + "/functions/v1/" + slug,
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + key,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(cmd.body),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    return { ok: false, code: "NETWORK_OR_TIMEOUT" };
  }
  // Do not echo untrusted/provider error bodies; they may contain PII.
  if (!response.ok) {
    return { ok: false, code: "SHADOW_UNAVAILABLE", status: response.status };
  }
  let json;
  try {
    json = await response.json();
  } catch {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  const r = json?.result;
  const correctAuthority = cmd.mode === "text"
    ? "SHADOW_TEXT_ONLY_NEVER_PUBLISH"
    : "SHADOW_IMAGE_ONLY_NEVER_PUBLISH";
  const allowedRoutes = cmd.mode === "text"
    ? ["review", "retry", "text_no_flags"]
    : ["review", "retry", "image_no_harm_flags"];
  if (!r || json.code !== (cmd.mode === "text" ? "SHADOW_TEXT_ONLY" : "SHADOW_IMAGE_ONLY") ||
      r.authority !== correctAuthority || r.listingId !== cmd.body.listingId ||
      (cmd.mode === "image" && r.mediaId !== cmd.body.mediaId) ||
      !allowedRoutes.includes(r.route) || typeof r.stale !== "boolean" ||
      (cmd.mode === "text" && r.imageModeration !== "NOT_PERFORMED") ||
      (cmd.mode === "image" && (
        r.source !== "LEGACY_MEDIUM_WEBP_UNSEALED" ||
        r.scope !== "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE" ||
        r.imageReview !== "HARM_CATEGORIES_ONLY_NOT_MARKETPLACE_FRAUD" ||
        !/^[0-9a-f]{64}$/.test(r.sampleSha256 ?? "")
      ))) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  return {
    ok: true,
    mode: cmd.mode,
    authority: correctAuthority,
    listingId: r.listingId,
    ...(cmd.mode === "image" ? { mediaId: r.mediaId } : {}),
    route: r.route,
    stale: r.stale === true,
    harmCategories: Array.isArray(r.harmCategories)
      ? r.harmCategories.filter(x => typeof x === "string").slice(0, 16)
      : [],
    ...(cmd.mode === "text"
      ? {
          indiaFraudSignals: Array.isArray(r.indiaFraudSignals)
            ? r.indiaFraudSignals.filter(x => typeof x === "string").slice(0, 8)
            : [],
          imageModeration: "NOT_PERFORMED",
        }
      : {
          sampleSha256: /^[0-9a-f]{64}$/.test(r.sampleSha256 ?? "")
            ? r.sampleSha256 : "INVALID",
          scope: "ONE_MEDIA_ONLY_NOT_FULL_COVERAGE",
          source: "LEGACY_MEDIUM_WEBP_UNSEALED",
        }),
  };
}

// Runs only when invoked as a script. Tests can import invokeShadow()
const invokedFile = process.argv[1];
if (invokedFile && import.meta.url.endsWith(
  "/" + invokedFile.replaceAll("\\", "/").split("/").slice(-3).join("/"),
)) {
  const result = await invokeShadow(process.argv.slice(2));
  // No raw token, photo, seller text, provider response, signed URL or PII.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}
