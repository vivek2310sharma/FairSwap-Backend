import {
  MODERATION_RULE_IDS,
  type ModerationTargetField,
  type ModerationReviewFlag,
} from "./contract";

/**
 * RULE A: Selected prohibited-item wording.
 * Initial limited dictionary:
 * - firearm / firearms
 * - handgun / handguns
 * - hand gun / hand guns
 * - ammunition
 * - heroin
 * - cocaine
 * - stolen bike / stolen bikes
 *
 * Matching behaviour: Case-insensitive whole-word/phrase boundary matching.
 * Does not match "heroine" or "glue gun".
 */
const PROHIBITED_ITEM_REGEXES: readonly RegExp[] = [
  /\bfirearms?\b/i,
  /\bhand\s*guns?\b/i,
  /\bammunition\b/i,
  /\bheroin\b/i, // Does not match "heroine" due to word boundary
  /\bcocaine\b/i,
  /\bstolen\s+bikes?\b/i,
];

const PROHIBITED_ITEM_REASON = "Selected prohibited-item wording found.";

export function evaluateProhibitedItemWording(
  text: string,
  field: ModerationTargetField
): ModerationReviewFlag | null {
  for (const regex of PROHIBITED_ITEM_REGEXES) {
    if (regex.test(text)) {
      return {
        ruleId: MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING,
        field,
        reason: PROHIBITED_ITEM_REASON,
      };
    }
  }
  return null;
}

/**
 * RULE B: Known shortened links.
 * Checks for links whose parsed hostname is exactly:
 * - bit.ly
 * - www.bit.ly
 * - tinyurl.com
 * - www.tinyurl.com
 *
 * Matching behaviour:
 * - Case-insensitive URL/host matching.
 * - Supports http://, https://, and bare domain patterns (e.g. bit.ly/xyz, tinyurl.com/xyz).
 * - Checks exact parsed hostname; does not flag bit.ly.example.com, example.com/bit.ly, or bit.ly@example.com.
 * - Excludes email addresses (e.g. user@bit.ly or user@tinyurl.com) where the domain is preceded by '@'.
 */
const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "www.bit.ly",
  "tinyurl.com",
  "www.tinyurl.com",
]);

const SHORTENED_LINK_REASON = "Known shortened link found.";

/**
 * Regex to extract potential URL/link tokens delimited by whitespace or brackets.
 */
const TOKEN_REGEX = /(?:https?:\/\/[^\s)\]>"',]+|(?<=\s|^|[([<"'])(?:[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s)\]>"',]*)?))/gi;

function extractHostname(candidate: string): string | null {
  // Strip trailing punctuation often adjacent to URLs in prose
  const cleaned = candidate.replace(/[.,;:!?]+$/, "");
  let toParse = cleaned;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(toParse)) {
    toParse = "https://" + toParse;
  }
  try {
    const parsed = new URL(toParse);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function evaluateShortenedLinks(
  text: string,
  field: ModerationTargetField
): ModerationReviewFlag | null {
  const matches = text.match(TOKEN_REGEX);
  if (!matches) {
    return null;
  }

  for (const rawToken of matches) {
    // Check if part of an email address (e.g. user@bit.ly)
    const index = text.indexOf(rawToken);
    if (index > 0 && text[index - 1] === "@") {
      continue;
    }

    const host = extractHostname(rawToken);
    if (host && SHORTENER_HOSTS.has(host)) {
      return {
        ruleId: MODERATION_RULE_IDS.SHORTENED_LINK,
        field,
        reason: SHORTENED_LINK_REASON,
      };
    }
  }

  return null;
}

/**
 * RULE C: Explicit payment-before-viewing requests.
 * Detects requests to pay/send/transfer money, token, booking amount, or deposit
 * before viewing/inspecting an item or property.
 *
 * Matching behaviour:
 * - Explicit payment verbs: pay, send, transfer, deposit, wire, gpay, paytm, upi
 * - Explicit money/advance tokens: money, payment, deposit, amount, token, advance, booking amount, fees?, ₹|rs\.?|\d+
 * - Pre-viewing temporal connectors: before, prior to, in advance of
 * - Viewing/inspection actions: viewing, inspecting, seeing, visit, visit(ing), inspection
 *
 * Negation handling:
 * - Scoped local negation: if the payment verb is directly preceded within ~5 words by
 *   negation terms ("no", "not", "do not", "never", "without", "don't"), that specific clause is neutralized.
 * - Negation in one sentence does NOT exempt another clause or sentence.
 */
const PAYMENT_BEFORE_VIEWING_REASON =
  "Explicit payment-before-viewing request found.";

// Regex matching positive payment-before-viewing phrases
// Structure:
// [optional negation] + [payment action] + [money/token term] + [before/prior to] + [viewing/inspecting]
// or [payment action] + [before/prior to] + [viewing/inspecting]
const PAYMENT_VERBS =
  "(?:pay(?:ing)?|send(?:ing)?|transfer(?:ring)?|deposit(?:ing)?|wire|gpay|paytm|upi)";
const PAYMENT_TERMS =
  "(?:(?:advance\\s+)?(?:booking\\s+amount|token|deposit|amount|payment|fees?|money)|(?:rs\\.?|inr|₹)\\s*\\d+|\\d+\\s*(?:rs|rupees|inr))";
const BEFORE_TERMS = "(?:before|prior\\s+to|in\\s+advance\\s+of)";
const VIEWING_TERMS =
  "(?:viewing|inspecting|inspection|seeing|visit(?:ing)?|checking)";

const POSITIVE_PAYMENT_PATTERN = new RegExp(
  `\\b${PAYMENT_VERBS}\\s+(?:(?:a|an|the|any|some|first)\\s+)?(?:${PAYMENT_TERMS}\\s+)?(?:(?:first|online)\\s+)?${BEFORE_TERMS}\\s+(?:(?:a|an|the|this)\\s+)?(?:\\w+\\s+)?${VIEWING_TERMS}\\b`,
  "i"
);

// Alternative word order: "Send Rs 1000 booking amount first before viewing"
const ALTERNATIVE_PAYMENT_PATTERN = new RegExp(
  `\\b${PAYMENT_VERBS}\\s+(?:[a-zA-Z0-9₹.,\\s]{1,35}?)\\s*${BEFORE_TERMS}\\s+(?:(?:a|an|the|this)\\s+)?(?:[a-zA-Z0-9]+\\s+)?${VIEWING_TERMS}\\b`,
  "i"
);

// Negation check regex within the clause: support negation up to 5 words before the payment verb
// (e.g. "Do not pay", "Please do not pay", "Never pay", "Do not ever pay")
const LOCAL_NEGATION_PREFIX =
  /(?:^|[\s,;.])(?:no|not|never|don't|do\s+not|without)\s+(?:\w+\s+){0,5}$/i;

export function evaluatePaymentBeforeViewing(
  text: string,
  field: ModerationTargetField
): ModerationReviewFlag | null {
  // Normalize whitespace
  const normalized = text.replace(/\s+/g, " ");

  // Test across sentences or clauses separated by punctuation
  const clauses = normalized.split(/[.;!\n]+/);

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;

    // Check if the clause matches positive patterns
    let match = trimmed.match(POSITIVE_PAYMENT_PATTERN);
    if (!match) {
      match = trimmed.match(ALTERNATIVE_PAYMENT_PATTERN);
    }

    if (match && match.index !== undefined) {
      // Check if local negation immediately precedes the match in this clause
      const textBeforeMatch = trimmed.slice(0, match.index);
      if (LOCAL_NEGATION_PREFIX.test(textBeforeMatch)) {
        // Negated locally (e.g. "Do not pay a booking amount before viewing")
        continue;
      }

      // Check if negation is directly inside the match prefix (e.g. "no advance payment required before viewing")
      if (/^(?:no|not|never)\b/i.test(match[0])) {
        continue;
      }

      return {
        ruleId: MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING,
        field,
        reason: PAYMENT_BEFORE_VIEWING_REASON,
      };
    }
  }

  return null;
}
