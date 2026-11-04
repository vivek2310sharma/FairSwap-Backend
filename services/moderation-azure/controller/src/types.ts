import { z } from "zod";

export const ControllerConfigSchema = z.object({
  port: z.coerce.number().default(8080),
  moderationSecret: z.string().min(16),
  openAiApiKey: z.string().min(1),
  openAiApiBase: z.string().url().default("https://api.openai.com/v1"),
  nodeVisionServiceUrl: z.string().url().default("http://ca-node-vision:8081"),
  pythonOcrServiceUrl: z.string().url().default("http://ca-python-ocr:8082"),
  timeoutMs: z.coerce.number().default(5000),
  environment: z.enum(["test", "prod"]).default("test"),
  allowedStorageHost: z.string(), // Exact Supabase Project Storage Host (e.g. wpppxlnbzqynvhpeuavd.supabase.co)
});

export type ControllerConfig = z.infer<typeof ControllerConfigSchema>;

export const MediaItemInputSchema = z.object({
  id: z.string().uuid(),
  originalStoragePath: z.string().min(1),
  scopedSignedUrl: z.string().url(),
  mediaSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type MediaItemInput = z.infer<typeof MediaItemInputSchema>;

export const ModerationJobRequestSchema = z.object({
  listingId: z.string().uuid(),
  listingRevision: z.number().int().nonnegative(),
  generationId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  categorySlug: z.string().optional(),
  mediaDigest: z.string().regex(/^[a-f0-9]{64}$/),
  media: z.array(MediaItemInputSchema).max(20),
});

export type ModerationJobRequest = z.infer<typeof ModerationJobRequestSchema>;

export const WorkerMediaResultSchema = z.object({
  mediaId: z.string().uuid(),
  sha256Verified: z.boolean(),
  status: z.enum(["success", "download_failed", "decode_failed", "hash_mismatch", "timeout"]),
  error: z.string().optional(),
});

export const NodeVisionScanResponseSchema = z.object({
  status: z.enum(["completed", "incomplete", "failed"]),
  scannedCount: z.number().int().nonnegative(),
  results: z.array(WorkerMediaResultSchema),
  flags: z.array(
    z.object({
      check: z.string(),
      field: z.string(),
      code: z.string(),
      reason: z.string(),
      severity: z.enum(["critical", "warning"]),
      boundedEvidence: z.string().optional(),
    })
  ),
});

export const PythonOcrScanResponseSchema = z.object({
  status: z.enum(["completed", "incomplete", "failed"]),
  scannedCount: z.number().int().nonnegative(),
  results: z.array(WorkerMediaResultSchema),
  extractedTexts: z.array(z.string()),
  qrPayloads: z.array(z.string()),
});

export interface ModerationDecisionRecord {
  verdict: "APPROVE" | "REJECT" | "FLAG" | "INCOMPLETE";
  listingId: string;
  listingRevision: number;
  generationId: string;
  mediaDigest: string;
  completedChecks: string[];
  failedChecks: string[];
  flags: Array<{
    check: string;
    field: string;
    code: string;
    reason: string;
    severity: "critical" | "warning";
    boundedEvidence?: string;
  }>;
  manifest: Array<{
    mediaId: string;
    originalStoragePath: string;
    mediaSha256: string;
  }>;
  perImageResults: Array<{
    mediaId: string;
    visionStatus: string;
    ocrStatus: string;
    hashVerified: boolean;
  }>;
  modelVersions: {
    rulesetVersion: string;
    openaiModerationModel?: string;
    nsfwjsModel?: string;
    mobilenetModel?: string;
    paddleOcrModel?: string;
    qrDetector?: string;
  };
  scannedMediaCount: number;
  evaluatedAt: string;
}
