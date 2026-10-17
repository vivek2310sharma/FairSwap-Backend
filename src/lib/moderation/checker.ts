import {
  MODERATION_RULE_IDS,
  MODERATION_RULESET_VERSION,
  MODERATION_EVALUATION_SCOPE,
  moderationInputSchema,
  type ModerationRuleId,
  type ModerationTargetField,
  type ModerationReviewFlag,
  type ModerationEvaluationResult,
} from "./contract";
import * as rulesModule from "./rules";

interface InternalRuleDefinition {
  readonly ruleId: ModerationRuleId;
  readonly run: (
    text: string,
    field: ModerationTargetField
  ) => ModerationReviewFlag | null;
}

/**
 * Immutable tuple of all mandatory prototype rules in stable execution order.
 * Delegates to rulesModule functions dynamically to allow test mock interception.
 */
const MANDATORY_RULES: readonly InternalRuleDefinition[] = Object.freeze([
  Object.freeze({
    ruleId: MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING,
    run: (text: string, field: ModerationTargetField) =>
      rulesModule.evaluateProhibitedItemWording(text, field),
  }),
  Object.freeze({
    ruleId: MODERATION_RULE_IDS.SHORTENED_LINK,
    run: (text: string, field: ModerationTargetField) =>
      rulesModule.evaluateShortenedLinks(text, field),
  }),
  Object.freeze({
    ruleId: MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING,
    run: (text: string, field: ModerationTargetField) =>
      rulesModule.evaluatePaymentBeforeViewing(text, field),
  }),
]);

/**
 * Required rule IDs that must all complete before a final outcome is returned.
 */
const REQUIRED_RULE_IDS: readonly ModerationRuleId[] = Object.freeze(
  MANDATORY_RULES.map((r) => r.ruleId)
);

/**
 * Pure evaluator for listing titles and descriptions.
 *
 * Guarantees:
 * - Public API accepts rawInput only; callers cannot supply or override runners.
 * - Always executes all trusted mandatory rules in fixed order.
 * - Deterministic output.
 * - Does not mutate caller's input.
 * - No network requests, database access, or external side effects.
 * - Sourced bounded text input constraints verified via Zod.
 * - no_review_flags requires ALL mandatory rules to complete with 0 flags.
 * - needs_review requires ALL mandatory rules to complete with >= 1 flag.
 * - Any rule failure or incomplete coverage returns checks_incomplete.
 * - Preserves collected flags even if a subsequent rule fails.
 */
export function evaluateListingText(
  rawInput: unknown
): ModerationEvaluationResult {
  // 1. Zod input contract validation
  const validation = moderationInputSchema.safeParse(rawInput);
  if (!validation.success) {
    return {
      outcome: "invalid_input",
      ruleSetVersion: MODERATION_RULESET_VERSION,
      scope: MODERATION_EVALUATION_SCOPE,
      errors: validation.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const { title, description } = validation.data;
  const completedRules: ModerationRuleId[] = [];
  const failedRules: ModerationRuleId[] = [];
  const flags: ModerationReviewFlag[] = [];

  // 2. Evaluate trusted mandatory rules across title and description
  for (const rule of MANDATORY_RULES) {
    try {
      const titleFlag = rule.run(title, "title");
      if (titleFlag) {
        flags.push(titleFlag);
      }

      const descFlag = rule.run(description, "description");
      if (descFlag) {
        flags.push(descFlag);
      }

      completedRules.push(rule.ruleId);
    } catch {
      failedRules.push(rule.ruleId);
    }
  }

  // 3. Handle rule execution failures
  if (failedRules.length > 0) {
    return {
      outcome: "checks_incomplete",
      ruleSetVersion: MODERATION_RULESET_VERSION,
      scope: MODERATION_EVALUATION_SCOPE,
      completedRules,
      failedRules,
      flags,
      reason: `Rule execution failed on: ${failedRules.join(", ")}`,
    };
  }

  // 4. Enforce mandatory-rule completeness invariant explicitly
  const completedSet = new Set(completedRules);
  const missingRules = REQUIRED_RULE_IDS.filter((id) => !completedSet.has(id));
  if (missingRules.length > 0) {
    return {
      outcome: "checks_incomplete",
      ruleSetVersion: MODERATION_RULESET_VERSION,
      scope: MODERATION_EVALUATION_SCOPE,
      completedRules,
      failedRules: missingRules,
      flags,
      reason: `Mandatory rules not completed: ${missingRules.join(", ")}`,
    };
  }

  // 5. Handle flag presence vs clean outcome
  if (flags.length > 0) {
    return {
      outcome: "needs_review",
      ruleSetVersion: MODERATION_RULESET_VERSION,
      scope: MODERATION_EVALUATION_SCOPE,
      completedRules,
      flags,
    };
  }

  return {
    outcome: "no_review_flags",
    ruleSetVersion: MODERATION_RULESET_VERSION,
    scope: MODERATION_EVALUATION_SCOPE,
    completedRules,
    flags: [],
  };
}
