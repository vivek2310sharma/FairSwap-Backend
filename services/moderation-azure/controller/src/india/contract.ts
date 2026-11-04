import { z } from "zod";

/**
 * Versioned India Moderation Engine identifiers and constants.
 */
export const INDIA_RULESET_VERSION = "india_v1.0.0" as const;
export const INDIA_EVALUATION_SCOPE = "multimodal_five_check" as const;

export const INDIA_MODERATION_RULE_IDS = {
  // Check 1: India Fraud & Prohibited items
  SSD_CHEMICAL_WASHING: "rule_in_ssd_chemical_washing",
  PROHIBITED_ITEMS: "rule_in_prohibited_items",
  UPI_ADVANCE_FRAUD: "rule_in_upi_advance_fraud",
  FAKE_COURIER_ESCROW: "rule_in_fake_courier_escrow",
  SUSPICIOUS_PAYMENT_CHANNEL: "rule_in_suspicious_payment_channel",
  SHORTENED_LINK: "rule_in_shortened_link",
  // Check 2: External OpenAI Text Moderation
  OPENAI_TEXT_MODERATION: "rule_openai_text_moderation",
  // Check 3: Vision NSFW / Nudity
  VISION_NSFW_NUDITY: "rule_vision_nsfw_nudity",
  // Check 4: Vision Category Coarseness
  VISION_CATEGORY_MISMATCH: "rule_vision_category_mismatch",
  // Check 5: OCR Text & QR inspection
  OCR_EXTRACTED_FRAUD: "rule_ocr_extracted_fraud",
  QR_SUSPICIOUS_PAYLOAD: "rule_qr_suspicious_payload",
} as const;

export type IndiaModerationRuleId =
  (typeof INDIA_MODERATION_RULE_IDS)[keyof typeof INDIA_MODERATION_RULE_IDS];

export type ModerationTargetField = "title" | "description" | "ocr_text" | "qr_payload" | "media";

export interface IndiaReviewFlag {
  ruleId: IndiaModerationRuleId;
  field: ModerationTargetField;
  code: string;
  reason: string;
  severity: "critical" | "warning";
  boundedEvidence?: string;
}

export type AzureModerationVerdict = "APPROVE" | "REJECT" | "FLAG" | "INCOMPLETE";

export interface AzureModerationResponse {
  verdict: AzureModerationVerdict;
  rulesetVersion: typeof INDIA_RULESET_VERSION;
  scope: typeof INDIA_EVALUATION_SCOPE;
  listingId: string;
  listingRevision: number;
  mediaDigest: string;
  completedChecks: readonly string[];
  failedChecks: readonly string[];
  flags: readonly IndiaReviewFlag[];
  modelVersions: {
    openaiModerationModel?: string;
    nsfwjsModel?: string;
    mobilenetModel?: string;
    paddleOcrModel?: string;
    qrDetector?: string;
  };
  scannedMediaCount: number;
  completedAt: string;
}

