#!/usr/bin/env node
/**
 * FairSwapProd manual V2 shadow probe caller.
 *
 * NEVER pass secrets as CLI arguments or put them in code. Set the existing
 * Supabase service-role JWT only in the operator's trusted process environment.
 * This tool does NOT publish, approve, write to Storage, or trigger V1 jobs.
 *
 * Usage:
 *   node scripts/moderation/v2-shadow-invoke.mjs check
 *   node scripts/moderation/v2-shadow-invoke.mjs image-check
 *   node scripts/moderation/v2-shadow-invoke.mjs text <listing-uuid>
 *   node scripts/moderation/v2-shadow-invoke.mjs image <listing-uuid> <media-uuid>
 *
 * Importable run() supports mocked fetch for CI and never logs bearer tokens.
 */

const PROD_URL = "https://kriuhwppxgxsyyrbjsau.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseShadowCommand(args) {
  if (!Array.isArray(args)) return null;
  // No real listing/photo is used to verify the free provider credentials.
  if (args.length === 1 && (args[0] === "check" || args[0] === "image-check")) {
    return { mode: args[0], body: { probe: "synthetic_connectivity" } };
  }
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
  const syntheticCheck = cmd.mode === "check" || cmd.mode === "image-check";
  const slug = cmd.mode === "image" || cmd.mode === "image-check"
    ? "moderation-v2-image-shadow-probe"
    : "moderation-v2-text-shadow-probe";
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
  // On synthetic connectivity only, allowlisted reason codes contain no PII.
  if (!response.ok) {
    if (syntheticCheck && response.status === 503) {
      try {
        const error = await response.json();
        const permitted = [
          "PROVIDER_AUTH", "PROVIDER_LIMIT", "PROVIDER_UNAVAILABLE",
          "PROVIDER_SCHEMA", "PROVIDER_INPUT", "TIMEOUT",
        ];
        const expectedFailureCode = cmd.mode === "image-check"
          ? "OPENAI_IMAGE_MODERATION_CHECK_FAILED"
          : "OPENAI_MODERATION_CHECK_FAILED";
        if (error?.code === expectedFailureCode &&
          error?.authority === "SYNTHETIC_CONNECTIVITY_ONLY" &&
          permitted.includes(error.reason)) {
          return { ok: false, code: "PROVIDER_CHECK_FAILED", reason: error.reason };
        }
        if (error?.code === "OPENAI_NOT_CONFIGURED") {
          return { ok: false, code: "OPENAI_NOT_CONFIGURED" };
        }
      } catch { /* Never expose provider or gateway error bodies. */ }
    }
    return { ok: false, code: "SHADOW_UNAVAILABLE", status: response.status };
  }
  let json;
  try {
    json = await response.json();
  } catch {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (syntheticCheck) {
    const expectedSuccessCode = cmd.mode === "image-check"
      ? "OPENAI_IMAGE_MODERATION_CONNECTED" : "OPENAI_MODERATION_CONNECTED";
    const expectedScope = cmd.mode === "image-check"
      ? "BENIGN_SYNTHETIC_IMAGE_NOT_LISTING_REVIEW"
      : "BENIGN_SYNTHETIC_TEXT_NOT_LISTING_REVIEW";
    if (json?.code !== expectedSuccessCode ||
      json?.authority !== "SYNTHETIC_CONNECTIVITY_ONLY" ||
      json?.scope !== expectedScope ||
      json?.model !== "omni-moderation-2024-09-26" ||
      !["clear", "flagged"].includes(json?.provider)) {
      return { ok: false, code: "INVALID_RESPONSE" };
    }
    return {
      ok: true,
      mode: cmd.mode,
      connected: true,
      authority: "SYNTHETIC_CONNECTIVITY_ONLY",
      model: json.model,
      provider: json.provider,
    };
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
