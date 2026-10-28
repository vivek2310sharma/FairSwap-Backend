// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import {
  SetuDigiLockerClient,
  validateProviderDownloadUrl,
  SETU_DOCUMENT_CATALOGUE,
  type SetuConfig,
} from "../../supabase/functions/_shared/idv/setu-client";
import { readIdvEnvConfig, isIdvOperational } from "../../supabase/functions/_shared/idv/idv-config";
import { handleIdvComplete, completePayloadSchema } from "../../supabase/functions/idv-complete/index";
import { startPayloadSchema } from "../../supabase/functions/idv-start/index";

describe("Setu DigiLocker Client Adapter Contract", () => {
  const mockConfig: SetuConfig = {
    enabled: true,
    clientId: "test_client_id",
    clientSecret: "test_client_secret",
    productInstanceId: "test_instance_id",
    apiBaseUrl: "https://dg-sandbox.setu.co",
    redirectBaseUrl: "https://fairswap.in/account/verification/callback",
  };

  it("fails closed when environment variables are missing or feature is disabled", () => {
    const disabledEnv = {
      FAIRSWAP_IDV_ENABLED: "false",
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      SETU_CLIENT_ID: "client",
      SETU_CLIENT_SECRET: "secret",
    };
    const parsed = readIdvEnvConfig(disabledEnv);
    expect(isIdvOperational(parsed)).toBe(false);

    const missingCredsEnv = {
      FAIRSWAP_IDV_ENABLED: "true",
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      SETU_CLIENT_ID: "",
    };
    const parsedMissing = readIdvEnvConfig(missingCredsEnv);
    expect(isIdvOperational(parsedMissing)).toBe(false);
  });

  it("creates a DigiLocker session with valid redirectUrl and headers", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "req_12345",
        status: "unauthenticated",
        url: "https://dg-sandbox.setu.co/consent/req_12345",
        validUpto: "2026-10-27T00:00:00Z",
      }),
    });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    const result = await client.createRequest("https://fairswap.in/account/verification/callback?state=xyz123");

    expect(result.id).toBe("req_12345");
    expect(result.status).toBe("unauthenticated");
    expect(result.url).toBe("https://dg-sandbox.setu.co/consent/req_12345");

    expect(fakeFetch).toHaveBeenCalledWith(
      "https://dg-sandbox.setu.co/api/digilocker/",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-client-id": "test_client_id",
          "x-client-secret": "test_client_secret",
          "x-product-instance-id": "test_instance_id",
        }),
      })
    );
  });

  it("checks request status using GET /api/digilocker/:id/status", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "req_12345",
        status: "authenticated",
        validUpto: "2026-10-27T00:00:00Z",
      }),
    });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    const statusResult = await client.getStatus("req_12345");

    expect(statusResult.id).toBe("req_12345");
    expect(statusResult.status).toBe("authenticated");
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://dg-sandbox.setu.co/api/digilocker/req_12345/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-client-id": "test_client_id",
          "x-client-secret": "test_client_secret",
        }),
      })
    );
  });

  it("enforces SSRF protection allowlist for download URLs", () => {
    expect(validateProviderDownloadUrl("https://files.setu.co/doc1.pdf")).toBe(true);
    expect(validateProviderDownloadUrl("https://cdn.digilocker.gov.in/doc1.pdf")).toBe(true);
    expect(validateProviderDownloadUrl("https://attacker-controlled-site.com/fake.pdf")).toBe(false);
    expect(validateProviderDownloadUrl("http://files.setu.co/insecure.pdf")).toBe(false);
    expect(validateProviderDownloadUrl("not-a-url")).toBe(false);
  });

  it("fetches document with official parameter array schema and revokes provider OAuth token", async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fileUrl: "https://files.setu.co/documents/doc_123.pdf",
          validUpto: "2026-10-27T00:00:00Z",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    const doc = await client.fetchDocument("req_12345", {
      docType: "DRVLC",
      orgId: "in.gov.morth",
      format: "pdf",
      consent: "Y",
      parameters: [{ name: "dlno", value: "DL-1234567890123" }],
    });
    expect(doc.fileUrl).toBe("https://files.setu.co/documents/doc_123.pdf");
    expect(doc.validUpto).toBe("2026-10-27T00:00:00Z");

    const revoked = await client.revokeToken("req_12345");
    expect(revoked).toBe(true);

    expect(fakeFetch).toHaveBeenNthCalledWith(
      1,
      "https://dg-sandbox.setu.co/api/digilocker/req_12345/document",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          docType: "DRVLC",
          orgId: "in.gov.morth",
          format: "pdf",
          consent: "Y",
          parameters: [{ name: "dlno", value: "DL-1234567890123" }],
        }),
      })
    );

    expect(fakeFetch).toHaveBeenNthCalledWith(
      2,
      "https://dg-sandbox.setu.co/api/digilocker/req_12345/revoke",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("rejects document download URL pointing outside the allowlist", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        fileUrl: "https://evil-host.com/exfiltrate/doc_123.pdf",
      }),
    });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    await expect(
      client.fetchDocument("req_12345", {
        docType: "DRVLC",
        orgId: "in.gov.morth",
        format: "pdf",
        consent: "Y",
        parameters: [],
      })
    ).rejects.toThrow("destination domain is not on allowlist");
  });

  it("fetches structured Aadhaar data and signed DigiLocker XML according to official Setu schema", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "req_12345",
        status: "complete",
        aadhaar: {
          name: "Test Resident",
          maskedNumber: "xxxxxxxx1234",
          verified: {
            signature: true,
          },
          xml: {
            fileUrl: "https://files.setu.co/aadhaar.xml",
            validUntil: "2026-10-27T00:00:00Z",
          },
        },
      }),
    });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    const aadhaar = await client.fetchAadhaar("req_12345");

    expect(aadhaar.status).toBe("complete");
    expect(aadhaar.aadhaar.name).toBe("Test Resident");
    expect(aadhaar.aadhaar.maskedNumber).toBe("xxxxxxxx1234");
    expect(aadhaar.aadhaar.verified?.signature).toBe(true);
    expect(aadhaar.aadhaar.xml?.fileUrl).toBe("https://files.setu.co/aadhaar.xml");
  });

  it("rejects Aadhaar XML download URL outside provider allowlist", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "req_12345",
        status: "complete",
        aadhaar: {
          name: "Test Resident",
          maskedNumber: "xxxxxxxx1234",
          verified: { signature: true },
          xml: {
            fileUrl: "https://malicious-site.com/aadhaar.xml",
          },
        },
      }),
    });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    await expect(client.fetchAadhaar("req_12345")).rejects.toThrow("Provider Aadhaar XML URL rejected");
  });

  it("requires explicit success: true for Setu token revocation; malformed response returns false", async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok" }), // missing success: true
      });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    const res1 = await client.revokeToken("req_1");
    expect(res1).toBe(false);

    const res2 = await client.revokeToken("req_2");
    expect(res2).toBe(false);
  });

  it("downloads verified document content with size limits and redirect protection", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "application/pdf",
        "content-length": "1024",
      }),
      arrayBuffer: async () => new Uint8Array(1024).buffer,
    });

    const client = new SetuDigiLockerClient(mockConfig, { fetchImpl: fakeFetch as unknown as typeof fetch });
    const doc = await client.fetchVerifiedDocumentContent("https://files.setu.co/verified.pdf");

    expect(doc.contentType).toBe("application/pdf");
    expect(doc.buffer.length).toBe(1024);
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://files.setu.co/verified.pdf",
      expect.objectContaining({ redirect: "error" })
    );
  });
});

describe("IDV Security Gate & Lifecycle Remediation Checks", () => {
  it("accepts completion payload without docCategory, allowing authoritative server resolution", () => {
    const payloadWithoutCategory = {
      attemptId: "11111111-1111-1111-1111-111111111111",
      state: "state_nonce_1234567890",
    };
    const res = completePayloadSchema.safeParse(payloadWithoutCategory);
    expect(res.success).toBe(true);
    expect(res.data?.docCategory).toBeUndefined();
  });

  it("accepts payload with omitted attemptId for secure session-bound state recovery", () => {
    const payloadWithoutAttempt = {
      state: "state_nonce_1234567890",
    };
    const res = completePayloadSchema.safeParse(payloadWithoutAttempt);
    expect(res.success).toBe(true);
    expect(res.data?.attemptId).toBeUndefined();
  });

  it("fails closed when document category lacks supported authenticity validation (PAN / DL / unverified Aadhaar)", () => {
    expect(SETU_DOCUMENT_CATALOGUE.pan_card.contentAuthSupported).toBe(false);
    expect(SETU_DOCUMENT_CATALOGUE.driving_licence.contentAuthSupported).toBe(false);
    expect(SETU_DOCUMENT_CATALOGUE.aadhaar_kyc.contentAuthSupported).toBe(false);
  });

  it("enforces strict environment isolation and rejects mismatched combinations", () => {
    // Valid staging config
    const stagingConfig = readIdvEnvConfig({
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
    });
    expect(stagingConfig.SETU_ENVIRONMENT).toBe("sandbox");

    // Valid production config
    const prodConfig = readIdvEnvConfig({
      SUPABASE_PROJECT_REF: "kriuhwppxgxsyyrbjsau",
      SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
      SETU_ENVIRONMENT: "production",
      SETU_API_BASE_URL: "https://dg.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fairswap.in/account/verification",
    });
    expect(prodConfig.SETU_ENVIRONMENT).toBe("production");

    // Valid production sandbox compatibility mode: allow sandbox credentials on FairSwapProd
    const prodSandboxCompat = readIdvEnvConfig({
      SUPABASE_PROJECT_REF: "kriuhwppxgxsyyrbjsau",
      SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_ALLOW_SANDBOX_ON_PROD: "true",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fairswap.in/account/verification",
    });
    expect(prodSandboxCompat.SETU_ENVIRONMENT).toBe("sandbox");
    expect(prodSandboxCompat.SETU_ALLOW_SANDBOX_ON_PROD).toBe(true);

    // Reject sending sandbox credentials to Setu production endpoint even when SETU_ALLOW_SANDBOX_ON_PROD=true
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "kriuhwppxgxsyyrbjsau",
        SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
        SETU_ENVIRONMENT: "sandbox",
        SETU_ALLOW_SANDBOX_ON_PROD: "true",
        SETU_API_BASE_URL: "https://dg.setu.co", // Dangerous!
        SETU_REDIRECT_BASE_URL: "https://fairswap.in/account/verification",
      })
    ).toThrow(/never send sandbox credentials to production endpoint/);

    // Reject sandbox environment on production when SETU_ALLOW_SANDBOX_ON_PROD is false / unset
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "kriuhwppxgxsyyrbjsau",
        SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fairswap.in/account/verification",
      })
    ).toThrow(/use Setu production environment only/);

    // Both canonical staging callback URLs are accepted
    const stagingCanonicalAlt = readIdvEnvConfig({
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fairswap-web-git-staging-fairswap.vercel.app/account/verification",
    });
    expect(stagingCanonicalAlt.SETU_REDIRECT_BASE_URL).toBe("https://fairswap-web-git-staging-fairswap.vercel.app/account/verification");

    // Mismatched staging project ref with production env
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
        SETU_ENVIRONMENT: "production",
        SETU_API_BASE_URL: "https://dg.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fairswap.in/account/verification",
      })
    ).toThrow();

    // Mismatched production project ref with sandbox baseUrl
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "kriuhwppxgxsyyrbjsau",
        SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
        SETU_ENVIRONMENT: "production",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fairswap.in/account/verification",
      })
    ).toThrow();

    // Unknown or unapproved project ref
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "unknown_project_ref",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow();
  });

  it("enforces server-side consent validation on idv-start payload and server-owned policy version", () => {
    // Missing consentAcknowledged
    const missingConsent = startPayloadSchema.safeParse({});
    expect(missingConsent.success).toBe(false);

    // False consentAcknowledged
    const falseConsent = startPayloadSchema.safeParse({ consentAcknowledged: false });
    expect(falseConsent.success).toBe(false);

    // Affirmative consentAcknowledged with default/canonical version and explicit docCategory
    const validConsent = startPayloadSchema.safeParse({ consentAcknowledged: true, docCategory: "aadhaar_kyc" });
    expect(validConsent.success).toBe(true);

    const validConsentWithCanonical = startPayloadSchema.safeParse({ consentAcknowledged: true, docCategory: "aadhaar_kyc", policyVersion: "v1.0" });
    expect(validConsentWithCanonical.success).toBe(true);

    // Missing explicit docCategory rejected
    const missingCategory = startPayloadSchema.safeParse({ consentAcknowledged: true });
    expect(missingCategory.success).toBe(false);

    // Arbitrary client-provided policy version rejected
    const arbitraryVersion = startPayloadSchema.safeParse({ consentAcknowledged: true, docCategory: "aadhaar_kyc", policyVersion: "v2.0-custom" });
    expect(arbitraryVersion.success).toBe(false);
  });

  it("rejects mismatches between explicit SUPABASE_PROJECT_REF and SUPABASE_URL host reference", () => {
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow(/SUPABASE_PROJECT_REF mismatch/);

    // Matching refs succeed
    const validMatch = readIdvEnvConfig({
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
    });
    expect(validMatch.SUPABASE_PROJECT_REF).toBe("wpppxlnbzqynvhpeuavd");

    // Strict URL validation: reject non-HTTPS scheme
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "http://wpppxlnbzqynvhpeuavd.supabase.co",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow(/scheme must be 'https:'/);

    // Strict URL validation: reject userinfo
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://user:pass@wpppxlnbzqynvhpeuavd.supabase.co",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow(/must not contain userinfo/);

    // Strict URL validation: reject non-standard port
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co:8443",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow(/non-standard port/);

    // Strict URL validation: reject path
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co/rest/v1",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow(/must not contain a path/);

    // Strict URL validation: reject query parameters
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co?apiKey=123",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow(/must not contain query parameters/);

    // Strict URL validation: reject extra hostname labels (e.g. sub.wpppxlnbzqynvhpeuavd.supabase.co)
    expect(() =>
      readIdvEnvConfig({
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://sub.wpppxlnbzqynvhpeuavd.supabase.co",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      })
    ).toThrow(/expected exactly '<project-ref>.supabase.co'/);
  });

  it("fails closed on complete verification when unconfigured or feature disabled", async () => {
    const req = new Request("http://localhost/idv-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attemptId: "11111111-1111-1111-1111-111111111111",
        state: "state_nonce_1234567890",
        docCategory: "aadhaar_kyc",
      }),
    });

    const disabledEnv = {
      FAIRSWAP_IDV_ENABLED: "false",
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
    };
    const res = await handleIdvComplete(req, disabledEnv);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("FEATURE_DISABLED");
  });

  it("fails closed if IDV_HMAC_SECRET is missing or insufficient", async () => {
    const req = new Request("http://localhost/idv-complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock_token",
      },
      body: JSON.stringify({
        attemptId: "11111111-1111-1111-1111-111111111111",
        state: "state_nonce_1234567890",
        docCategory: "aadhaar_kyc",
      }),
    });

    const envWithMissingHmac = {
      FAIRSWAP_IDV_ENABLED: "true",
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_CLIENT_ID: "client",
      SETU_CLIENT_SECRET: "secret",
      SETU_PRODUCT_INSTANCE_ID: "instance",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      IDV_HMAC_SECRET: "short", // less than 32 characters
    };

    const res = await handleIdvComplete(req, envWithMissingHmac);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("CONFIGURATION_ERROR");
  });

  it("rejects forged provider status when provider reports unauthenticated", async () => {
    const fakeFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: "req_123", status: "unauthenticated" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const client = new SetuDigiLockerClient(
      {
        enabled: true,
        clientId: "cid",
        clientSecret: "sec",
        productInstanceId: "prod",
        apiBaseUrl: "https://dg-sandbox.setu.co",
        redirectBaseUrl: "https://fairswap.in/callback",
      },
      { fetchImpl: fakeFetch as unknown as typeof fetch }
    );

    const statusRes = await client.getStatus("req_123");
    expect(statusRes.status).not.toBe("authenticated");
  });
});

describe("IDV Token Revocation Retry Worker", () => {
  it("sanitizes authorization tokens and secrets from error logs", async () => {
    const { sanitizeRevocationError } = await import(
      "../../supabase/functions/_shared/idv/idv-revocation-worker"
    );
    const rawError = new Error("Failed at https://api.setu.co?apiKey=secret_123 with Bearer eyJhbGciOi...");
    const sanitized = sanitizeRevocationError(rawError);
    expect(sanitized).not.toContain("secret_123");
    expect(sanitized).not.toContain("eyJhbGciOi...");
    expect(sanitized).toContain("apiKey=[REDACTED]");
    expect(sanitized).toContain("Bearer [REDACTED]");
  });

  it("calculates exponential backoff bounded to 3600 seconds", async () => {
    const { calculateRevocationBackoffSeconds } = await import(
      "../../supabase/functions/_shared/idv/idv-revocation-worker"
    );
    expect(calculateRevocationBackoffSeconds(0)).toBe(30);
    expect(calculateRevocationBackoffSeconds(1)).toBe(120);
    expect(calculateRevocationBackoffSeconds(2)).toBe(480);
    expect(calculateRevocationBackoffSeconds(10)).toBe(3600);
  });

  it("retains pending-revocation state when credentials are unavailable", async () => {
    const { runIdvRevocationRetryWorker } = await import(
      "../../supabase/functions/_shared/idv/idv-revocation-worker"
    );

    const rpcMock = vi.fn().mockImplementation((fnName: string) => {
      if (fnName === "server_idv_claim_revocation_retries") {
        return Promise.resolve({
          data: {
            success: true,
            claimed_retries: [
              {
                attempt_id: "attempt-1",
                provider_request_id: "req_1",
                retry_count: 0,
                last_error: null,
                lease_token: "lease_token_uuid_1",
              },
            ],
          },
          error: null,
        });
      }
      if (fnName === "server_idv_record_token_revocation_failed") {
        return Promise.resolve({
          data: { success: true, retry_count: 0, retry_exhausted: false },
          error: null,
        });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });

    const fakeSupabase = { rpc: rpcMock };
    // Environment without Setu credentials
    const envNoCreds = {
      FAIRSWAP_IDV_ENABLED: "false",
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
    };

    const res = await runIdvRevocationRetryWorker(
      envNoCreds,
      fakeSupabase as unknown as import("@supabase/supabase-js").SupabaseClient
    );

    expect(res.claimed).toBe(1);
    expect(res.skippedDueToMissingCredentials).toBe(true);
    expect(res.failed).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "server_idv_record_token_revocation_failed",
      expect.objectContaining({
        p_attempt_id: "attempt-1",
        p_lease_token: "lease_token_uuid_1",
        p_consume_retry: false,
        p_error: "Setu provider credentials unavailable for revocation retry",
      })
    );
  });

  it("passes lease_token and acknowledges success when provider revocation succeeds", async () => {
    const { runIdvRevocationRetryWorker } = await import(
      "../../supabase/functions/_shared/idv/idv-revocation-worker"
    );

    const rpcMock = vi.fn().mockImplementation((fnName: string) => {
      if (fnName === "server_idv_claim_revocation_retries") {
        return Promise.resolve({
          data: {
            success: true,
            claimed_retries: [
              {
                attempt_id: "attempt-2",
                provider_request_id: "req_2",
                retry_count: 1,
                last_error: null,
                lease_token: "lease_token_uuid_2",
              },
            ],
          },
          error: null,
        });
      }
      if (fnName === "server_idv_record_token_revoked") {
        return Promise.resolve({
          data: { success: true, revoked: true },
          error: null,
        });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const fakeSupabase = { rpc: rpcMock };
    const envWithCreds = {
      FAIRSWAP_IDV_ENABLED: "false", // Worker runs even when new IDV starts are disabled
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      SETU_CLIENT_ID: "valid_id",
      SETU_CLIENT_SECRET: "valid_secret",
      SETU_PRODUCT_INSTANCE_ID: "valid_instance",
    };

    const res = await runIdvRevocationRetryWorker(
      envWithCreds,
      fakeSupabase as unknown as import("@supabase/supabase-js").SupabaseClient,
      { fetchImpl: fakeFetch as unknown as typeof fetch }
    );

    expect(res.claimed).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(0);
    expect(rpcMock).toHaveBeenCalledWith(
      "server_idv_record_token_revoked",
      expect.objectContaining({
        p_attempt_id: "attempt-2",
        p_lease_token: "lease_token_uuid_2",
      })
    );
  });

  it("handles duplicate workers gracefully when rows are already claimed", async () => {
    const { runIdvRevocationRetryWorker } = await import(
      "../../supabase/functions/_shared/idv/idv-revocation-worker"
    );

    // Concurrent worker: claim returns empty list because other worker claimed them
    const rpcMock = vi.fn().mockResolvedValue({
      data: {
        success: true,
        claimed_retries: [],
      },
      error: null,
    });

    const fakeSupabase = { rpc: rpcMock };
    const env = {
      FAIRSWAP_IDV_ENABLED: "false",
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      SETU_CLIENT_ID: "valid_id",
      SETU_CLIENT_SECRET: "valid_secret",
      SETU_PRODUCT_INSTANCE_ID: "valid_instance",
    };

    const res = await runIdvRevocationRetryWorker(
      env,
      fakeSupabase as unknown as import("@supabase/supabase-js").SupabaseClient
    );

    expect(res.claimed).toBe(0);
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(0);
  });

  it("records failure with lease_token and consumes retry quota when provider rejects", async () => {
    const { runIdvRevocationRetryWorker } = await import(
      "../../supabase/functions/_shared/idv/idv-revocation-worker"
    );

    const rpcMock = vi.fn().mockImplementation((fnName: string) => {
      if (fnName === "server_idv_claim_revocation_retries") {
        return Promise.resolve({
          data: {
            success: true,
            claimed_retries: [
              {
                attempt_id: "attempt-fail",
                provider_request_id: "req_fail",
                retry_count: 2,
                last_error: "prior error",
                lease_token: "lease_fail_token",
              },
            ],
          },
          error: null,
        });
      }
      if (fnName === "server_idv_record_token_revocation_failed") {
        return Promise.resolve({
          data: { success: true, retry_count: 3, retry_exhausted: false },
          error: null,
        });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    });

    const fakeSupabase = { rpc: rpcMock };
    const env = {
      FAIRSWAP_IDV_ENABLED: "false",
      SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
      SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co",
      SETU_ENVIRONMENT: "sandbox",
      SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
      SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      SETU_CLIENT_ID: "valid_id",
      SETU_CLIENT_SECRET: "valid_secret",
      SETU_PRODUCT_INSTANCE_ID: "valid_instance",
    };

    const res = await runIdvRevocationRetryWorker(
      env,
      fakeSupabase as unknown as import("@supabase/supabase-js").SupabaseClient,
      { fetchImpl: fakeFetch as unknown as typeof fetch }
    );

    expect(res.claimed).toBe(1);
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "server_idv_record_token_revocation_failed",
      expect.objectContaining({
        p_attempt_id: "attempt-fail",
        p_lease_token: "lease_fail_token",
        p_consume_retry: true,
      })
    );
  });

  describe("Project Binding & Cross-Project Worker Rejection", () => {
    it("rejects swapped staging/production worker URLs against configured project ref", () => {
      const stagingEnvWithProdUrl = {
        FAIRSWAP_IDV_ENABLED: "false",
        SUPABASE_PROJECT_REF: "wpppxlnbzqynvhpeuavd",
        SUPABASE_URL: "https://kriuhwppxgxsyyrbjsau.supabase.co", // Swapped!
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      };

      expect(() => readIdvEnvConfig(stagingEnvWithProdUrl)).toThrow(
        /SUPABASE_PROJECT_REF mismatch.*Rejecting cross-environment configuration/i
      );

      const prodEnvWithStagingUrl = {
        FAIRSWAP_IDV_ENABLED: "false",
        SUPABASE_PROJECT_REF: "kriuhwppxgxsyyrbjsau",
        SUPABASE_URL: "https://wpppxlnbzqynvhpeuavd.supabase.co", // Swapped!
        SETU_ENVIRONMENT: "production",
        SETU_API_BASE_URL: "https://dg.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fairswap.in/account/verification",
      };

      expect(() => readIdvEnvConfig(prodEnvWithStagingUrl)).toThrow(
        /SUPABASE_PROJECT_REF mismatch.*Rejecting cross-environment configuration/i
      );
    });

    it("rejects unapproved project worker URLs that do not belong to FairSwapTest or FairSwapProd", () => {
      const unapprovedEnv = {
        FAIRSWAP_IDV_ENABLED: "false",
        SUPABASE_PROJECT_REF: "attackerproject123",
        SUPABASE_URL: "https://attackerproject123.supabase.co",
        SETU_ENVIRONMENT: "sandbox",
        SETU_API_BASE_URL: "https://dg-sandbox.setu.co",
        SETU_REDIRECT_BASE_URL: "https://fair-swap-git-staging-fairswap.vercel.app/account/verification",
      };

      expect(() => readIdvEnvConfig(unapprovedEnv)).toThrow(
        /Unknown or unapproved SUPABASE_PROJECT_REF/i
      );
    });
  });
});


