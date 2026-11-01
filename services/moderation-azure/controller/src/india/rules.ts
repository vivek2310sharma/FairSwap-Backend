import {
  INDIA_MODERATION_RULE_IDS,
  type IndiaReviewFlag,
  type ModerationTargetField,
} from "./contract";

/**
 * 1. SSD CHEMICAL / DEFACED CURRENCY CLEANING SCAM (English)
 * Legitimate computer SSD: NVMe, SATA, M.2, PCIe, Samsung, Crucial, Kingston, 500GB, 1TB, 2TB, solid state drive, read/write speed.
 * Fraud terms: SSD solution, SSD chemical, black money, black dollar, anti-breeze, cleaning banknotes, defaced currency.
 */
const SSD_SCAM_KEYWORDS = [
  /\bssd\s+(?:solution|chemical|liquid|powder|paste)\b/i,
  /\b(?:black\s+(?:money|currency|notes?|dollars?|euros?|pounds?))\b/i,
  /\b(?:vectrol\s+paste|anti\s*breeze|automatic\s+solution)\b/i,
  /\bcleaning\s+(?:black|defaced|stained|dyed)\s+(?:money|notes?|currency|dollars?)\b/i,
  /\b(?:de-?icing|activation)\s+powder\b/i,
  /\buniversal\s+chemical\s+for\s+(?:banknotes|notes|currency)\b/i,
];

const COMPUTER_SSD_TERMS = [
  /\b(?:nvme|sata|m\.2|pcie|gen\s*[345]|internal\s+ssd|external\s+ssd|portable\s+ssd|solid\s+state\s+drive)\b/i,
  /\b(?:read\s*speed|write\s*speed|mb\/s|gb\/s|tbw|nand)\b/i,
  /\b(?:samsung\s*9[89]0|crucial\s*[pbt]\d+|kingston|wd\s*black|wd\s*blue|sandisk|seagate)\b/i,
  /\b\d+\s*(?:gb|tb)\s+ssd\b/i,
  /\bssd\s+\d+\s*(?:gb|tb)\b/i,
];

export function evaluateSsdChemicalWashing(
  text: string,
  field: ModerationTargetField
): IndiaReviewFlag | null {
  for (const regex of SSD_SCAM_KEYWORDS) {
    if (regex.test(text)) {
      return {
        ruleId: INDIA_MODERATION_RULE_IDS.SSD_CHEMICAL_WASHING,
        field,
        code: "SSD_CURRENCY_WASHING_FRAUD",
        reason: "Defaced currency washing / SSD chemical fraud detected.",
        severity: "critical",
      };
    }
  }

  // If text has "SSD" + ambiguous chemical/cleaning keywords without genuine hardware specs
  if (/\bssd\b/i.test(text) && /\b(?:chemical|cleaning|wash|powder|notes?)\b/i.test(text)) {
    const isComputerSsd = COMPUTER_SSD_TERMS.some((rgx) => rgx.test(text));
    if (!isComputerSsd) {
      return {
        ruleId: INDIA_MODERATION_RULE_IDS.SSD_CHEMICAL_WASHING,
        field,
        code: "SSD_CHEMICAL_SUSPICIOUS",
        reason: "Suspicious SSD chemical phrase without computer storage hardware context.",
        severity: "critical",
      };
    }
  }

  return null;
}

/**
 * 2. PROHIBITED GOODS (English, India legal & marketplace policy)
 */
const PROHIBITED_GOODS_PATTERNS = [
  /\b(?:firearms?|hand\s*guns?|rifles?|pistols?|revolvers?|ammunition|bullets?|cartridges?)\b/i,
  /\b(?:heroin|cocaine|charas|ganja|opium|afim|smack|methamphetamine|mdma|lsd\s*blotters?)\b/i,
  /\b(?:ivory|tiger\s*skin|tiger\s*claws?|deer\s*antlers?|snake\s*venom)\b/i,
  /\b(?:fake\s*currency|counterfeit\s*(?:notes?|money)|duplicate\s*notes?)\b/i,
  /\b(?:kidney\s+for\s+sale|buy\s+human\s+organ|sell\s+blood)\b/i,
];

export function evaluateProhibitedGoods(
  text: string,
  field: ModerationTargetField
): IndiaReviewFlag | null {
  for (const regex of PROHIBITED_GOODS_PATTERNS) {
    if (regex.test(text)) {
      return {
        ruleId: INDIA_MODERATION_RULE_IDS.PROHIBITED_ITEMS,
        field,
        code: "PROHIBITED_ITEM_DETECTED",
        reason: "Prohibited, illegal, or restricted goods detected under India marketplace policy.",
        severity: "critical",
      };
    }
  }
  return null;
}

/**
 * 3. ADVANCE PAYMENT / UPI ADVANCE / QR SCAM (English only for V1)
 */
const ADVANCE_PAYMENT_PATTERNS = [
  /\b(?:pay|send|transfer|deposit|wire)\s+(?:(?:rs\.?|inr|₹)?\s*\d+\s+)?(?:advance|token|booking\s+amount|deposit|fees?|money)(?:\s+(?:token|money|amount|fees?))*\s+(?:first\s+)?(?:before|prior\s+to)\s+(?:viewing|inspecting|seeing|visit|delivery)/i,
  /\bscan\s+(?:this\s+)?qr\s+(?:code\s+)?to\s+(?:receive|get|credit)\s+(?:money|payment|cash|funds)\b/i,
  /\b(?:pay|send)\s+(?:token\s+)?(?:advance\s+)?(?:fee\s+)?(?:of\s+)?(?:rs\.?|inr|₹)?\s*\d+\s*(?:first\s+)?(?:before|prior\s+to)\s+(?:visit|viewing|inspecting|delivery)/i,
  /\b(?:pay|send)\s+(?:via\s+)?(?:gpay|googlepay|phonepe|paytm|bhim|upi)\s+(?:before|advance)\b/i,
];

const NEGATION_PATTERNS = [
  /\b(?:do\s*not|never|don't|no|strictly\s+no)\b/i,
  /\b(?:without|prior\s+inspection)\b/i,
];

export function evaluateUpiAdvanceFraud(
  text: string,
  field: ModerationTargetField
): IndiaReviewFlag | null {
  const normalized = text.replace(/\s+/g, " ");
  const clauses = normalized.split(/[.;!\n]+/);

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;

    for (const pattern of ADVANCE_PAYMENT_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match && match.index !== undefined) {
        const beforeMatch = trimmed.slice(0, match.index);
        const hasNegationBefore = NEGATION_PATTERNS.some((neg) => neg.test(beforeMatch));
        const matchHasNegation = NEGATION_PATTERNS.some((neg) => neg.test(match[0]));

        if (hasNegationBefore || matchHasNegation) {
          continue; // Negated warning
        }

        return {
          ruleId: INDIA_MODERATION_RULE_IDS.UPI_ADVANCE_FRAUD,
          field,
          code: "UPI_ADVANCE_FEE_SCAM",
          reason: "Advance payment or fraudulent QR scanning prompt detected.",
          severity: "critical",
        };
      }
    }
  }

  return null;
}

/**
 * 4. FAKE COURIER / MILITARY ESCROW SCHEMES (English only for V1)
 */
const SUSPICIOUS_MILITARY_ESCROW_PATTERNS = [
  /\b(?:army|military|cisf|crpf|defence)\s+(?:transport|courier|escrow|gate\s+pass)\s+(?:charges?|fees?|deposit)\b/i,
  /\b(?:army|military|cisf|crpf|defence)\s+(?:transport\s+)?(?:courier\s+)?gate\s+pass\s+deposit\b/i,
];

export function evaluateFakeCourierEscrow(
  text: string,
  field: ModerationTargetField
): IndiaReviewFlag | null {
  for (const pattern of SUSPICIOUS_MILITARY_ESCROW_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ruleId: INDIA_MODERATION_RULE_IDS.FAKE_COURIER_ESCROW,
        field,
        code: "DEFENCE_COURIER_ESCROW_FRAUD",
        reason: "Suspicious defense personnel / courier escrow payment scheme detected.",
        severity: "critical",
      };
    }
  }
  return null;
}

/**
 * 5. SUSPICIOUS OFFLINE CONTACT / SHORTENED LINK (English)
 */
const SUSPICIOUS_CONTACT_PATTERNS = [
  /\b(?:wa\.me\/\S+|chat\s+on\s+whatsapp\s+directly\s+at\s+[\d\s+-]{10,})\b/i,
  /\b(?:telegram|t\.me)\/[\w_]{4,}\b/i,
];

export function evaluateSuspiciousContact(
  text: string,
  field: ModerationTargetField
): IndiaReviewFlag | null {
  for (const pattern of SUSPICIOUS_CONTACT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ruleId: INDIA_MODERATION_RULE_IDS.SUSPICIOUS_PAYMENT_CHANNEL,
        field,
        code: "OFF_PLATFORM_CONTACT_REDIRECT",
        reason: "Off-platform external contact redirect detected.",
        severity: "warning",
      };
    }
  }
  return null;
}

/**
 * 6. UNSUPPORTED NON-ENGLISH SCRIPT DETECTION (V1 English-only scope)
 * Flags non-Latin / Indic scripts (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam)
 * for manual admin review when text cannot be safely evaluated by V1 English models.
 */
const NON_LATIN_SCRIPT_REGEX = /[\u0900-\u0D7F]/;

export function evaluateUnsupportedLanguage(
  text: string,
  field: ModerationTargetField
): IndiaReviewFlag | null {
  if (NON_LATIN_SCRIPT_REGEX.test(text)) {
    return {
      ruleId: INDIA_MODERATION_RULE_IDS.PROHIBITED_ITEMS,
      field,
      code: "UNSUPPORTED_LANGUAGE_REVIEW_REQUIRED",
      reason: "Non-English Indic script detected; flagged for manual review under V1 policy.",
      severity: "warning",
    };
  }
  return null;
}
