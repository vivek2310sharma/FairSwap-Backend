import { z } from "zod";
import { SetuDigiLockerClient, type SetuConfig } from "./setu-client.ts";

export const idvEnvConfigSchema = z.object({
  FAIRSWAP_IDV_ENABLED: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_PROJECT_REF: z.string().min(1),
  SETU_ENVIRONMENT: z.enum(["sandbox", "production"]),
  SETU_CLIENT_ID: z.string().optional().default(""),
  SETU_CLIENT_SECRET: z.string().optional().default(""),
  SETU_PRODUCT_INSTANCE_ID: z.string().optional().default(""),
  SETU_API_BASE_URL: z.string().url(),
  SETU_REDIRECT_BASE_URL: z.string().url(),
}).superRefine((data, ctx) => {
  // Bind Supabase project identity, Setu environment, API base URL and approved callback origin.
  // - FairSwapTest wpppxlnbzqynvhpeuavd: Setu sandbox only.
  // - FairSwapProd kriuhwppxgxsyyrbjsau: Setu production only.
  if (data.SUPABASE_PROJECT_REF === "wpppxlnbzqynvhpeuavd") {
    if (data.SETU_ENVIRONMENT !== "sandbox") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "FairSwapTest (wpppxlnbzqynvhpeuavd) must use Setu sandbox environment only",
        path: ["SETU_ENVIRONMENT"],
      });
    }
    if (data.SETU_API_BASE_URL !== "https://dg-sandbox.setu.co") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SETU_API_BASE_URL must be https://dg-sandbox.setu.co for FairSwapTest sandbox",
        path: ["SETU_API_BASE_URL"],
      });
    }
    if (data.SETU_REDIRECT_BASE_URL !== "https://fair-swap-git-staging-fairswap.vercel.app/account/verification") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SETU_REDIRECT_BASE_URL must be https://fair-swap-git-staging-fairswap.vercel.app/account/verification for FairSwapTest sandbox",
        path: ["SETU_REDIRECT_BASE_URL"],
      });
    }
  } else if (data.SUPABASE_PROJECT_REF === "kriuhwppxgxsyyrbjsau") {
    if (data.SETU_ENVIRONMENT !== "production") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "FairSwapProd (kriuhwppxgxsyyrbjsau) must use Setu production environment only",
        path: ["SETU_ENVIRONMENT"],
      });
    }
    if (data.SETU_API_BASE_URL !== "https://dg.setu.co") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SETU_API_BASE_URL must be https://dg.setu.co for FairSwapProd production",
        path: ["SETU_API_BASE_URL"],
      });
    }
    if (data.SETU_REDIRECT_BASE_URL !== "https://fairswap.in/account/verification") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SETU_REDIRECT_BASE_URL must be https://fairswap.in/account/verification for FairSwapProd production",
        path: ["SETU_REDIRECT_BASE_URL"],
      });
    }
  } else {
    // Non-canonical project ref rejected
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown or unapproved SUPABASE_PROJECT_REF: ${data.SUPABASE_PROJECT_REF}`,
      path: ["SUPABASE_PROJECT_REF"],
    });
  }
});

export type IdvEnvConfig = z.infer<typeof idvEnvConfigSchema>;

export function resolveProjectRef(env: Record<string, string | undefined>): { projectRef: string; supabaseUrl: string } {
  const explicitRef = env["SUPABASE_PROJECT_REF"] ? env["SUPABASE_PROJECT_REF"].trim() : "";
  const supabaseUrl = env["SUPABASE_URL"] ? env["SUPABASE_URL"].trim() : "";

  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is required and must not be absent or empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new Error(`SUPABASE_URL is malformed: '${supabaseUrl}'`);
  }

  // Strict URL shape: https://<ref>.supabase.co exactly
  if (parsed.protocol !== "https:") {
    throw new Error(`SUPABASE_URL scheme must be 'https:'; received '${parsed.protocol}'`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("SUPABASE_URL must not contain userinfo/credentials.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error(`SUPABASE_URL must not specify non-standard port: '${parsed.port}'`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`SUPABASE_URL must not contain a path: '${parsed.pathname}'`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error("SUPABASE_URL must not contain query parameters or hash.");
  }

  // Exactly 3 hostname segments: <project-ref>.supabase.co
  const hostParts = parsed.hostname.split(".");
  if (hostParts.length !== 3 || hostParts[1] !== "supabase" || hostParts[2] !== "co") {
    throw new Error(
      `SUPABASE_URL host '${parsed.hostname}' is unrecognised; expected exactly '<project-ref>.supabase.co'.`
    );
  }

  const extractedRef = hostParts[0].trim().toLowerCase();
  if (!extractedRef || !/^[a-z0-9]+$/.test(extractedRef)) {
    throw new Error(`SUPABASE_URL project reference '${extractedRef}' contains invalid characters.`);
  }

  if (explicitRef && explicitRef.toLowerCase() !== extractedRef) {
    throw new Error(
      `SUPABASE_PROJECT_REF mismatch: env contains '${explicitRef}' but SUPABASE_URL contains '${extractedRef}'. Rejecting cross-environment configuration.`
    );
  }

  const effectiveRef = explicitRef || extractedRef;
  const canonicalUrl = `https://${effectiveRef}.supabase.co`;
  return { projectRef: effectiveRef, supabaseUrl: canonicalUrl };
}

export function readIdvEnvConfig(env: Record<string, string | undefined>): IdvEnvConfig {
  const { projectRef, supabaseUrl } = resolveProjectRef(env);

  return idvEnvConfigSchema.parse({
    FAIRSWAP_IDV_ENABLED: env["FAIRSWAP_IDV_ENABLED"] || "false",
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PROJECT_REF: projectRef,
    SETU_ENVIRONMENT: env["SETU_ENVIRONMENT"],
    SETU_CLIENT_ID: env["SETU_CLIENT_ID"] || "",
    SETU_CLIENT_SECRET: env["SETU_CLIENT_SECRET"] || "",
    SETU_PRODUCT_INSTANCE_ID: env["SETU_PRODUCT_INSTANCE_ID"] || "",
    SETU_API_BASE_URL: env["SETU_API_BASE_URL"],
    SETU_REDIRECT_BASE_URL: env["SETU_REDIRECT_BASE_URL"],
  });
}

export function isIdvOperational(config: IdvEnvConfig): boolean {
  if (!config.FAIRSWAP_IDV_ENABLED) return false;
  return Boolean(
    config.SETU_CLIENT_ID &&
    config.SETU_CLIENT_SECRET &&
    config.SETU_PRODUCT_INSTANCE_ID &&
    config.SETU_API_BASE_URL &&
    config.SETU_REDIRECT_BASE_URL
  );
}

export function isIdvRevocationCapable(config: IdvEnvConfig): boolean {
  return Boolean(
    config.SETU_CLIENT_ID &&
    config.SETU_CLIENT_SECRET &&
    config.SETU_PRODUCT_INSTANCE_ID &&
    config.SETU_API_BASE_URL &&
    config.SETU_REDIRECT_BASE_URL
  );
}

export function createSetuClientFromEnv(config: IdvEnvConfig, fetchImpl?: typeof fetch): SetuDigiLockerClient | null {
  if (!isIdvOperational(config)) {
    return null;
  }

  const setuConfig: SetuConfig = {
    enabled: config.FAIRSWAP_IDV_ENABLED,
    clientId: config.SETU_CLIENT_ID,
    clientSecret: config.SETU_CLIENT_SECRET,
    productInstanceId: config.SETU_PRODUCT_INSTANCE_ID,
    apiBaseUrl: config.SETU_API_BASE_URL,
    redirectBaseUrl: config.SETU_REDIRECT_BASE_URL,
  };

  return new SetuDigiLockerClient(setuConfig, { fetchImpl });
}

export function createSetuRevocationClient(
  config: IdvEnvConfig,
  fetchImpl?: typeof fetch
): SetuDigiLockerClient | null {
  if (!isIdvRevocationCapable(config)) {
    return null;
  }

  const setuConfig: SetuConfig = {
    // Revocation client ignores FAIRSWAP_IDV_ENABLED=false so withdrawal can always occur
    enabled: true,
    clientId: config.SETU_CLIENT_ID,
    clientSecret: config.SETU_CLIENT_SECRET,
    productInstanceId: config.SETU_PRODUCT_INSTANCE_ID,
    apiBaseUrl: config.SETU_API_BASE_URL,
    redirectBaseUrl: config.SETU_REDIRECT_BASE_URL,
  };

  return new SetuDigiLockerClient(setuConfig, { fetchImpl });
}
