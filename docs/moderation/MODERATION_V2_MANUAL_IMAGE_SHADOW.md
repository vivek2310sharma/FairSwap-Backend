# FairSwap Moderation V2 — Free image shadow probe in existing FairSwapProd

**Status:** Operator-only, read-only, **one image at a time**, **not** trusted V2 finalization or publication. No third Supabase project, no new SQL, no paid GPT/Responses model.

## Why this exists

FairSwap currently has a default-off V2 database foundation but no accepted sealed-object registry or independent Storage immutability enforcement. The existing V1 uploader writes private, metadata-stripped WebP derivatives of uploaded photos.

This bounded probe lets an authorized Backend operator observe the **free** OpenAI Moderation model on one existing V1 *medium WebP derivative*. It does **not** assume a signed URL, seller-provided digest, public object URL or committed review registry is trustworthy. Image checks are for harmful content categories supported by OpenAI's Moderation API; they do **not** detect UPI fraud, fake army officers or fake courier scams by themselves. Use the separate text shadow probe for deterministic India fraud signals.

**No ordinary buyer or seller endpoint may invoke this function.** An operator-selected test listing ID and media ID are required.

## Immutable / integrity safety boundaries

1. The function must pass Supabase JWT gateway authentication (`verify_jwt=true`), and internally require a constant-time match against the server-side Supabase service-role JWT. Use only a trusted backend operator environment.
2. Strict JSON `{ "listingId": "<uuid>", "mediaId": "<uuid>" }`; no accepted Storage paths, URLs, expected digests, binaries, extra fields or client-provided seller identity. Maximum input 512 bytes.
3. Load current DB-owned listing `status/revision/updated_at` and a ready, linked media row. Require the **entire** four-path V1 key set to match the listing/media identity. No V2 or cross-listing paths.
4. Download the private `listing-derivatives/<listing>/<media>/medium.webp` object using the server-only credential. Limit to 5 MiB. Validate RIFF static WebP and reject ICC/EXIF/XMP/animation/unknown chunks; fail closed on malformed payloads. This is structural validation, not a full pixel decoder.
5. Hash an independent copy with SHA-256, then send the metadata-checked **legacy medium derivative** inline to the pinned, free `omni-moderation-2024-09-26` API. Do **not** forward Storage signed URLs, raw unprocessed originals, seller JWTs or service-role credentials to OpenAI.
6. Download the *same* medium object again after moderation and compare SHA-256. Re-read both DB rows and fail closed on changes to the listing, original/derivative object paths, ordering, created_at, processing state or revision. This detects many post-read tampering/race cases but is **NOT** a WORM or independently immutable sealed-object guarantee.
7. Return only a sanitized result with `SHADOW_IMAGE_ONLY_NEVER_PUBLISH`, `LEGACY_MEDIUM_WEBP_UNSEALED`, `ONE_MEDIA_ONLY_NOT_FULL_COVERAGE`, no-store headers, optional harm category names, point-in-time SHA-256 and stale/retry flags. **No approvals, rejections, publication, queue claims, DB writes, Storage writes or registry bindings**.

The existing Web signed-url fail-closed fence remains active for all `/v2/` keys. Do not weaken it until a DB-owned verified delivery route exists.

## Operator test workflow (no secrets in GitHub/chat)

- Make sure FairSwapProd Edge secrets include `OPENAI_API_KEY`. If absent, the probe returns `503 OPENAI_NOT_CONFIGURED`; it stays inert. Configure it through the official Supabase Dashboard on the existing project, not via Web/browser environment variables.
- From a trusted local operator shell holding the **existing FairSwapProd service-role JWT**, run:

  `node scripts/moderation/v2-shadow-invoke.mjs text <listing-uuid>`

  `node scripts/moderation/v2-shadow-invoke.mjs image <listing-uuid> <media-uuid>`

- The CLI reads `SUPABASE_SERVICE_ROLE_KEY` from the process environment and targets only `kriuhwppxgxsyyrbjsau.supabase.co`; it never accepts an operator-provided URL and never prints keys or full provider responses. Only the operator may configure this environment. Never copy service-role JWTs into browser consoles, mobile apps, support tickets or ChatGPT.
- Run this only for an operator-controlled test listing where your privacy notice/consent covers content moderation by an external provider. Obtain India DPDP legal sign-off before extending automatic analysis to real customers.
- Confirm that the V1 worker `process-listing-moderation` remains active and unaffected, and the Production switches remain `moderation_automation_enabled=true`, `moderation_v2_enabled=false`, `moderation_v2_mode=disabled`.

## Boundaries to finish before V2 becomes an automatic listing reviewer

A shadow image check is **not** a trusted seal. The mandatory work still includes parent-locked, authenticated source registration, full-frame canonical images, five-object manifest, independent overwrite prevention or equivalent publication-time fail-closed byte serving, retirement/erasure, complete text+all-image coverage, legitimate lease ownership, canonical finalization, end-to-end Mobile/Web parity, and controlled activation.

No third project is required for **this shadow workflow**. Fully authoritative V2 image publication in the same Supabase project still requires a reviewed solution to `service_role`'s ability to mutate private objects outside RLS.
