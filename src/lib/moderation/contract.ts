import { z } from "zod";

/**
 * Moderation rule identifiers.
 */
export const MODERATION_RULE_IDS = {
  PROHIBITED_ITEM_WORDING: "rule_prohibited_item_wording",
  SHORTENED_LINK: "rule_shortened_link",
  PAYMENT_BEFORE_VIEWING: "rule_payment_before_viewing",
} as const;

export type ModerationRuleId =
  (typeof MODERATION_RULE_IDS)[keyof typeof MODERATION_RULE_IDS];

/**
 * Fixed prototype rule-set version and evaluation scope.
 */
export const MODERATION_RULESET_VERSION = "prototype_v0.1.1" as const;
export const MODERATION_EVALUATION_SCOPE = "title_description" as const;

/**
 * The 4 distinct outcome kinds.
 */
export type ModerationOutcomeKind =
  | "no_review_flags"
  | "needs_review"
  | "invalid_input"
  | "checks_incomplete";

/**
 * Bounded text constraints sourced from existing schema and database definitions:
 * - Title: min 3 chars (from 20260914000008_create_listing_rpcs.sql and draftListingSchema in src/types/listing.ts),
 *   max 150 chars (from 20260914000005_create_listings.sql and draftListingSchema).
 * - Description: min 10 chars for submitted text (from 20260914000008_create_listing_rpcs.sql: length(trim(description)) >= 10),
 *   max 5000 chars (from 20260914000005_create_listings.sql and draftListingSchema).
 */
export const moderationInputSchema = z
  .object({
    title: z
      .string({
        required_error: "Title is required",
        invalid_type_error: "Title must be a string",
      })
      .trim()
      .min(3, "Title must be at least 3 non-whitespace characters")
      .max(150, "Title must not exceed 150 characters"),
    description: z
      .string({
        required_error: "Description is required",
        invalid_type_error: "Description must be a string",
      })
      .trim()
      .min(10, "Description must be at least 10 non-whitespace characters")
      .max(5000, "Description must not exceed 5000 characters"),
  })
  .strict();

export type ModerationInput = z.infer<typeof moderationInputSchema>;

/**
 * Field that triggered a review flag.
 */
export type ModerationTargetField = "title" | "description";

/**
 * Individual review signal emitted by a rule.
 * Raw PII, contact info, full URLs, and raw input text are not stored here.
 */
export interface ModerationReviewFlag {
  ruleId: ModerationRuleId;
  field: ModerationTargetField;
  reason: string;
}

/**
 * The 4 distinct type-safe evaluation results.
 */
export interface ModerationNoReviewFlagsResult {
  outcome: "no_review_flags";
  ruleSetVersion: typeof MODERATION_RULESET_VERSION;
  scope: typeof MODERATION_EVALUATION_SCOPE;
  completedRules: readonly ModerationRuleId[];
  flags: readonly [];
}

export interface ModerationNeedsReviewResult {
  outcome: "needs_review";
  ruleSetVersion: typeof MODERATION_RULESET_VERSION;
  scope: typeof MODERATION_EVALUATION_SCOPE;
  completedRules: readonly ModerationRuleId[];
  flags: readonly ModerationReviewFlag[];
}

export interface ModerationInvalidInputResult {
  outcome: "invalid_input";
  ruleSetVersion: typeof MODERATION_RULESET_VERSION;
  scope: typeof MODERATION_EVALUATION_SCOPE;
  errors: readonly { field: string; message: string }[];
}

export interface ModerationChecksIncompleteResult {
  outcome: "checks_incomplete";
  ruleSetVersion: typeof MODERATION_RULESET_VERSION;
  scope: typeof MODERATION_EVALUATION_SCOPE;
  completedRules: readonly ModerationRuleId[];
  failedRules: readonly ModerationRuleId[];
  flags: readonly ModerationReviewFlag[];
  reason: string;
}

export type ModerationEvaluationResult =
  | ModerationNoReviewFlagsResult
  | ModerationNeedsReviewResult
  | ModerationInvalidInputResult
  | ModerationChecksIncompleteResult;
