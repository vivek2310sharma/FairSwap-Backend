import { z } from "zod";

// Strict schemas for Setu DigiLocker API
export const setuEnvironmentSchema = z.enum(["sandbox", "production"]);
export type SetuEnvironment = z.infer<typeof setuEnvironmentSchema>;

export const setuConfigSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  productInstanceId: z.string().min(1),
  apiBaseUrl: z.string().url(),
  redirectBaseUrl: z.string().url(),
});
export type SetuConfig = z.infer<typeof setuConfigSchema>;

export const setuCreateRequestPayloadSchema = z.object({
  redirectUrl: z.string().url(),
  docType: z.string().optional(),
});

export const setuCreateRequestResponseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["unauthenticated", "authenticated", "revoked"]),
  url: z.string().url(),
  validUpto: z.string(),
});
export type SetuCreateRequestResponse = z.infer<typeof setuCreateRequestResponseSchema>;

export const setuStatusResponseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["unauthenticated", "authenticated", "revoked"]),
  validUpto: z.string().optional(),
});
export type SetuStatusResponse = z.infer<typeof setuStatusResponseSchema>;

export const setuDocumentParameterSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});
export type SetuDocumentParameter = z.infer<typeof setuDocumentParameterSchema>;

export const setuDocumentRequestPayloadSchema = z.object({
  docType: z.string().min(1),
  orgId: z.string().min(1),
  format: z.enum(["pdf", "xml", "both"]).default("pdf"),
  consent: z.literal("Y").default("Y"),
  parameters: z.array(setuDocumentParameterSchema),
});
export type SetuDocumentRequestPayload = z.infer<typeof setuDocumentRequestPayloadSchema>;

/**
 * Official Setu document response schema:
 * Only returns fileUrl and validUpto. Does NOT return issuer or mimeType.
 */
export const setuDocumentResponseSchema = z.object({
  fileUrl: z.string().url(),
  validUpto: z.string().optional(),
});
export type SetuDocumentResponse = z.infer<typeof setuDocumentResponseSchema>;

/**
 * Official Setu Aadhaar response schema:
 * status: "complete"
 * id: string
 * aadhaar: { name, maskedNumber, verified: { signature: boolean }, xml: { fileUrl, validUntil } }
 */
export const setuAadhaarResponseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "complete", "failed"]),
  aadhaar: z.object({
    name: z.string().min(1),
    maskedNumber: z.string().min(1),
    verified: z.object({
      signature: z.boolean(),
    }).passthrough().optional(),
    xml: z.object({
      fileUrl: z.string().url(),
      validUntil: z.string().optional(),
    }).optional(),
  }),
});
export type SetuAadhaarResponse = z.infer<typeof setuAadhaarResponseSchema>;

/**
 * Explicit Setu revoke response schema:
 * Requires explicit success: true and a success message.
 * Missing or malformed data is NOT success.
 */
export const setuRevokeResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});
export type SetuRevokeResponse = z.infer<typeof setuRevokeResponseSchema>;

/**
 * Permitted Setu Document Catalogue mappings.
 * Allowed issuer/document combinations per official documentation.
 */
export interface DocumentCatalogueItem {
  docType: string;
  defaultOrgId: string;
  issuerAuthority: string;
  supportedFormats: readonly ("pdf" | "xml")[];
  contentAuthSupported: boolean;
  activationNote?: string;
}

export const SETU_DOCUMENT_CATALOGUE: Record<"aadhaar_kyc" | "pan_card" | "driving_licence", DocumentCatalogueItem> = {
  aadhaar_kyc: {
    docType: "ADHAR",
    defaultOrgId: "in.gov.uidai",
    issuerAuthority: "Unique Identification Authority of India (UIDAI)",
    supportedFormats: ["xml", "pdf"] as const,
    contentAuthSupported: false, // Badge issuance disabled: full cryptographic XML signature verification (W3C xmldsig against UIDAI root CA) pending live provider certificate provisioning
    activationNote: "Requires live Setu credentials and approved UIDAI root certificate trust store for cryptographic XML signature validation",
  },
  pan_card: {
    docType: "PANCR",
    defaultOrgId: "in.gov.incometax",
    issuerAuthority: "Income Tax Department",
    supportedFormats: ["pdf"] as const,
    contentAuthSupported: false, // Badge issuance disabled: raw PDF lacks client-verifiable issuer digital signature verification without dedicated IncomeTax RSA signer root
    activationNote: "Requires commercial DigiLocker XML API access or institutional Income Tax signer certificate verification",
  },
  driving_licence: {
    docType: "DRVLC",
    defaultOrgId: "in.gov.morth",
    issuerAuthority: "Ministry of Road Transport and Highways (MoRTH)",
    supportedFormats: ["pdf"] as const,
    contentAuthSupported: false, // Badge issuance disabled: raw PDF lacks client-verifiable issuer digital signature verification without dedicated MoRTH signer root
    activationNote: "Requires commercial DigiLocker XML API access or institutional MoRTH signer certificate verification",
  },
};

export interface SetuClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Validates that download URLs point strictly to authorized Setu or DigiLocker endpoints
 * to protect against SSRF and fraudulent redirect locators.
 */
export function validateProviderDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "setu.co" ||
      hostname.endsWith(".setu.co") ||
      hostname === "digilocker.gov.in" ||
      hostname.endsWith(".digilocker.gov.in")
    );
  } catch {
    return false;
  }
}

export class SetuDigiLockerClient {
  private readonly config: SetuConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: SetuConfig, options: SetuClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-client-id": this.config.clientId,
      "x-client-secret": this.config.clientSecret,
      "x-product-instance-id": this.config.productInstanceId,
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 1. Create a DigiLocker session request
   * POST /api/digilocker/
   */
  async createRequest(redirectUrl: string, docType?: string): Promise<SetuCreateRequestResponse> {
    const body = setuCreateRequestPayloadSchema.parse({ redirectUrl, docType });
    const response = await this.fetchWithTimeout(`${this.config.apiBaseUrl}/api/digilocker/`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Setu createRequest failed with status ${response.status}: ${errText}`);
    }

    const json = await response.json();
    return setuCreateRequestResponseSchema.parse(json);
  }

  /**
   * 2. Get DigiLocker request status
   * GET /api/digilocker/:id/status
   */
  async getStatus(requestId: string): Promise<SetuStatusResponse> {
    if (!requestId || !requestId.trim()) {
      throw new Error("Invalid Setu request ID");
    }

    const response = await this.fetchWithTimeout(
      `${this.config.apiBaseUrl}/api/digilocker/${encodeURIComponent(requestId)}/status`,
      {
        method: "GET",
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Setu getStatus failed with status ${response.status}: ${errText}`);
    }

    const json = await response.json();
    return setuStatusResponseSchema.parse(json);
  }

  /**
   * 3. Fetch user document with full Setu contract
   * POST /api/digilocker/:id/document
   * Includes docType, orgId, format, consent: "Y", and parameters
   */
  async fetchDocument(
    requestId: string,
    reqPayload: SetuDocumentRequestPayload
  ): Promise<SetuDocumentResponse> {
    const payload = setuDocumentRequestPayloadSchema.parse(reqPayload);
    const response = await this.fetchWithTimeout(
      `${this.config.apiBaseUrl}/api/digilocker/${encodeURIComponent(requestId)}/document`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Setu fetchDocument failed with status ${response.status}: ${errText}`);
    }

    const json = await response.json();
    const parsed = setuDocumentResponseSchema.parse(json);

    // Enforce SSRF protection allowlist
    if (!validateProviderDownloadUrl(parsed.fileUrl)) {
      throw new Error("Provider document URL rejected: destination domain is not on allowlist");
    }

    return parsed;
  }

  /**
   * Securely downloads document content from approved Setu/DigiLocker CDN endpoints.
   * Enforces:
   * - Strict host allowlist check
   * - HTTPS-only
   * - Redirect denial (manual redirect handling to prevent SSRF hopping)
   * - Bounded content size (max 10MB)
   */
  async fetchVerifiedDocumentContent(fileUrl: string): Promise<{ buffer: Uint8Array; contentType: string }> {
    if (!validateProviderDownloadUrl(fileUrl)) {
      throw new Error("Provider document URL rejected: destination domain is not on allowlist");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(fileUrl, {
        method: "GET",
        headers: {
          Accept: "application/pdf, application/xml, text/xml, */*",
        },
        redirect: "error", // Prevent SSRF redirect hopping
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Document download failed with HTTP status ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
        throw new Error("Document exceeds maximum permitted size of 10MB");
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const arrayBuffer = await response.arrayBuffer();
      const buffer = new Uint8Array(arrayBuffer);

      if (buffer.length > 10 * 1024 * 1024) {
        throw new Error("Document exceeds maximum permitted size of 10MB");
      }

      return { buffer, contentType };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 4. Fetch Aadhaar data (Only when legally permitted / configured)
   * GET /api/digilocker/:id/aadhaar
   * Returns structured identity data and DigiLocker XML envelope per Setu official quickstart docs.
   */
  async fetchAadhaar(requestId: string): Promise<SetuAadhaarResponse> {
    const response = await this.fetchWithTimeout(
      `${this.config.apiBaseUrl}/api/digilocker/${encodeURIComponent(requestId)}/aadhaar`,
      {
        method: "GET",
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error(`Setu fetchAadhaar failed with status ${response.status}`);
    }

    const json = await response.json();
    const parsed = setuAadhaarResponseSchema.parse(json);

    // If fileUrl is provided for the signed XML, validate it against the provider allowlist
    if (parsed.aadhaar.xml?.fileUrl && !validateProviderDownloadUrl(parsed.aadhaar.xml.fileUrl)) {
      throw new Error("Provider Aadhaar XML URL rejected: destination domain is not on allowlist");
    }

    return parsed;
  }

  /**
   * 5. Revoke access token
   * GET /api/digilocker/:id/revoke
   * Requires an explicitly valid Setu revocation response (success: true). Missing or malformed data is NOT success.
   */
  async revokeToken(requestId: string): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.config.apiBaseUrl}/api/digilocker/${encodeURIComponent(requestId)}/revoke`,
        {
          method: "GET",
          headers: this.getHeaders(),
        }
      );

      if (!response.ok) {
        return false;
      }

      const json = await response.json();
      const parsed = setuRevokeResponseSchema.safeParse(json);
      return parsed.success && parsed.data.success === true;
    } catch {
      return false;
    }
  }
}

