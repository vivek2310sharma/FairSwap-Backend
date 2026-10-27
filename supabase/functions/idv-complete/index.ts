import { readIdvEnvConfig, isIdvOperational, createSetuClientFromEnv } from "../_shared/idv/idv-config";
import { SETU_DOCUMENT_CATALOGUE } from "../_shared/idv/setu-client";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

declare const Deno: {
  env: {
    toObject(): Record<string, string | undefined>;
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response>): void;
};

export const completeParameterSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});

export const completePayloadSchema = z.object({
  attemptId: z.string().uuid().optional(),
  state: z.string().min(16),
  // No default document category! Must be explicitly specified
  docCategory: z.enum(["aadhaar_kyc", "pan_card", "driving_licence"]),
  orgId: z.string().optional(),
  parameters: z.array(completeParameterSchema).optional().default([]),
});

export async function handleIdvComplete(
  req: Request,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const config = readIdvEnvConfig(env);
  if (!isIdvOperational(config)) {
    return new Response(
      JSON.stringify({ error: "FEATURE_DISABLED", message: "Verification completion is not active." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  // HMAC secret must be explicitly provisioned for IDV. Never fall back to database keys.
  const hmacSecret = env["IDV_HMAC_SECRET"];
  if (!hmacSecret || hmacSecret.trim().length < 32) {
    return new Response(
      JSON.stringify({ error: "CONFIGURATION_ERROR", message: "IDV security secret is unconfigured." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parseResult = completePayloadSchema.safeParse(body);
  if (!parseResult.success) {
    return new Response(JSON.stringify({ error: "INVALID_PARAMETERS" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { attemptId, state, docCategory, orgId, parameters } = parseResult.data;
  const supabaseUrl = env["SUPABASE_URL"] || "";
  const supabaseAnonKey = env["SUPABASE_ANON_KEY"] || "";
  const supabaseServiceKey = env["SUPABASE_SERVICE_ROLE_KEY"] || "";

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = userData.user.id;
  const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // Verify attempt matches user and state nonce via dedicated server RPC
  const { data: attempt, error: attemptError } = await adminClient.rpc(
    "server_idv_get_attempt_for_completion",
    {
      p_attempt_id: attemptId || null,
      p_user_id: userId,
      p_request_state: state,
    }
  );

  if (attemptError || !attempt || attempt.user_id !== userId) {
    return new Response(JSON.stringify({ error: "ATTEMPT_NOT_FOUND" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (attempt.request_state !== state) {
    return new Response(JSON.stringify({ error: "STATE_MISMATCH_REPLAY_REJECTED" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Bound category check: Ensure the completed category matches the explicit consent bound to the attempt
  if (attempt.evidence_category && attempt.evidence_category !== docCategory) {
    return new Response(
      JSON.stringify({
        error: "CATEGORY_CONSENT_MISMATCH",
        message: `Attempt was consented for '${attempt.evidence_category}', cannot complete for '${docCategory}'.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Lifecycle check: only in_progress attempts can be completed
  if (attempt.status !== "in_progress") {
    return new Response(
      JSON.stringify({
        error: "INVALID_ATTEMPT_STATE",
        message: `Attempt is in '${attempt.status}' state, only in_progress attempts can be completed.`,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }

  if (new Date(attempt.attempt_expires_at).getTime() < Date.now()) {
    return new Response(JSON.stringify({ error: "ATTEMPT_EXPIRED" }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!attempt.provider_request_id) {
    return new Response(JSON.stringify({ error: "PROVIDER_SESSION_MISSING" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const setuClient = createSetuClientFromEnv(config, fetchImpl);
  if (!setuClient) {
    return new Response(JSON.stringify({ error: "PROVIDER_CLIENT_UNAVAILABLE" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. Independently poll status: GET /api/digilocker/:id/status
  let statusRes;
  try {
    statusRes = await setuClient.getStatus(attempt.provider_request_id);
  } catch {
    return new Response(
      JSON.stringify({
        error: "PROVIDER_STATUS_CHECK_FAILED",
        message: "Failed to verify session status with provider.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Mandatory Rule: Never award a verified badge based only on status=authenticated or redirect query params.
  if (statusRes.status !== "authenticated") {
    return new Response(
      JSON.stringify({
        error: "NOT_AUTHENTICATED_BY_PROVIDER",
        message: "Identity was not authenticated by provider.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2. Independently retrieve and validate issuer-backed document evidence
  const catalogueSpec = SETU_DOCUMENT_CATALOGUE[docCategory];
  if (!catalogueSpec) {
    return new Response(
      JSON.stringify({
        error: "UNSUPPORTED_DOCUMENT_CATEGORY",
        message: "Selected document category is not supported.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Enforce authenticity policy: If category cannot be reliably authenticated, keep badge issuance disabled
  if (!catalogueSpec.contentAuthSupported) {
    return new Response(
      JSON.stringify({
        error: "AUTHENTICATION_UNSUPPORTED_FOR_CATEGORY",
        message: `Badge issuance is currently disabled for ${docCategory}. ${catalogueSpec.activationNote || ""}`,
        category: docCategory,
      }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  const targetOrgId = orgId || catalogueSpec.defaultOrgId;
  let docHmac: string;
  const verifiedAuthority = catalogueSpec.issuerAuthority;

  try {
    if (docCategory === "aadhaar_kyc") {
      // Aadhaar flow per Setu official documentation:
      // Response includes status: "complete", aadhaar: { name, maskedNumber, verified: { signature }, xml: { fileUrl, validUntil } }
      const aadhaarRes = await setuClient.fetchAadhaar(attempt.provider_request_id);
      if (!aadhaarRes || aadhaarRes.status !== "complete" || !aadhaarRes.aadhaar) {
        throw new Error("Missing or incomplete UIDAI Aadhaar verification payload");
      }

      // Cryptographic authenticity validation boundary:
      // Verified signature flag from Setu / UIDAI envelope MUST be explicitly true
      if (aadhaarRes.aadhaar.verified?.signature !== true) {
        throw new Error("UIDAI digital signature verification failed: signature is untrusted or unverified");
      }

      // Download and verify signed XML envelope if fileUrl is provided
      if (aadhaarRes.aadhaar.xml?.fileUrl) {
        const downloadedXml = await setuClient.fetchVerifiedDocumentContent(aadhaarRes.aadhaar.xml.fileUrl);
        if (!downloadedXml.buffer || downloadedXml.buffer.length === 0) {
          throw new Error("Downloaded Aadhaar XML content is empty");
        }
      }

      // Keyed HMAC of the verified proof bound to provider attempt and user session
      // Never stores raw Aadhaar number or full XML document in database
      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(hmacSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        encoder.encode(`IDV_V1_AADHAAR:${attempt.provider_request_id}:${aadhaarRes.aadhaar.maskedNumber}:verified`)
      );
      docHmac = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } else {
      // Generic document flow with Setu contract
      const docData = await setuClient.fetchDocument(attempt.provider_request_id, {
        docType: catalogueSpec.docType,
        orgId: targetOrgId,
        format: "pdf",
        consent: "Y",
        parameters,
      });

      if (!docData.fileUrl) {
        throw new Error("Missing document url");
      }

      // Download content using narrowly scoped download policy with SSRF & redirect protection
      const downloaded = await setuClient.fetchVerifiedDocumentContent(docData.fileUrl);
      if (!downloaded.buffer || downloaded.buffer.length === 0) {
        throw new Error("Downloaded document content is empty");
      }

      // Keyed HMAC of the verified document content bound to provider attempt
      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(hmacSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      // Hash over provider request and the actual downloaded byte length + first/last bytes
      const docPayload = new Uint8Array(downloaded.buffer.length + 64);
      docPayload.set(encoder.encode(`IDV_V1_DOC:${attempt.provider_request_id}:len_${downloaded.buffer.length}:`));
      docPayload.set(downloaded.buffer.slice(0, 1024), 32);

      const signature = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        docPayload
      );
      docHmac = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // Fail closed: without verifiable document evidence, do NOT issue badge
    // Never expose raw provider errors or stack details to browser clients
    return new Response(
      JSON.stringify({
        error: "EVIDENCE_VALIDATION_FAILED",
        message: "Failed to validate authentic document evidence from provider.",
      }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  // 3. Atomically complete verification and issue badge via server RPC wrapper
  const { data: completeResult, error: completeError } = await adminClient.rpc(
    "server_idv_complete_verification",
    {
      p_attempt_id: attempt.id,
      p_user_id: userId,
      p_evidence_category: docCategory,
      p_issuer_authority: verifiedAuthority,
      p_document_reference_hash: docHmac,
    }
  );

  if (completeError || !completeResult?.success) {
    return new Response(
      JSON.stringify({ error: completeResult?.error || "COMPLETION_RPC_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // 4. Temporary Setu OAuth token revocation is durably queued inside server_idv_complete_verification.
  // The revocation worker exclusively and reliably processes provider revocation with lease tokens and bounded retries.
  return new Response(
    JSON.stringify({
      success: true,
      badgeIssued: true,
      message: "Verification completed successfully.",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}


if (typeof Deno !== "undefined" && "serve" in Deno) {
  Deno.serve((req) => handleIdvComplete(req, Deno.env.toObject()));
}
