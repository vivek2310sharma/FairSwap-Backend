/**
 * FairSwap V1 free-only marketplace text screening.
 *
 * Review-only deterministic hints; never auto-reject or claim that text rules
 * can recognize weapons or scams depicted ONLY in photographs.
 * Built for India (English, Hindi, Hinglish), intentionally high-precision.
 * Do not log seller input, phone numbers, addresses, or payment links.
 */
import { findIndiaFraudSignals } from "./india-fraud";

export type FreePolicyReason = "WEAPON" | "REGULATED_GOODS" | "COUNTERFEIT" | "INDIA_PAYMENT_FRAUD";
export type FreePolicyDecision =
  | Readonly<{ decision: "clear" }>
  | Readonly<{ decision: "review"; reason: FreePolicyReason }>;

const zeroWidth = /[\u200B-\u200D\u2060\uFEFF]/g;

function normalize(text: string): string {
  return text.normalize("NFKC").replace(zeroWidth, "").toLocaleLowerCase("en-IN");
}

// Exact terms rather than "gun" alone: ordinary glue/nail/spray guns stay eligible.
// Toy/replica weapons receive human review rather than an automatic rejection.
const weaponTerms =
  /\b(?:firearms?|hand\s*guns?|pistols?|revolvers?|rifles?|shotguns?|(?:air|bb|pellet|stun)\s*guns?|tasers?|ammunition|(?:live\s*)?cartridges?|switchblades?|butterfly\s*knives|combat\s*knives|swords?)\b|(?:पिस्तौल|रिवॉल्वर|राइफल|बंदूक|कारतूस|गोला[\s-]?बारूद|गोली[\s-]?बंदूक)/iu;
const regulatedTerms =
  /\b(?:heroin|cocaine|mdma|lsd|charas|ganja|hashish|marijuana|cannabis|vapes?|e[\s-]?cigarettes?|nicotine\s*pouches|cigarettes?\s*(?:for\s*sale|pack)|vodka|whisk(?:y|ey)|liquor)\b|(?:गांजा|चरस|हेरोइन|कोकीन|नशीली[\s-]*दवा|तम्?बाकू|शराब)/iu;
const counterfeitTerms =
  /\b(?:first[\s-]*copy|master[\s-]*copy|a[\s-]*copy|fake[\s-]*brand(?:ed)?|counterfeit|forged[\s-]*(?:id|document|certificate))\b|(?:नकली[\s-]*(?:ब्रांड|आईडी|दस्तावेज़))/iu;
// A payment link or collecting funds on an outside service deserves human review;
// advertising a normal UPI-compatible phone should not be caught.
const paymentLinks =
  /(?:upi:\/\/(?:pay|collect)\b|(?:https?:\/\/)?(?:paytm\.me|razorpay\.me|cashfree\.com\/pay|phonepe\.com\/pay)[\/?#])/iu;
const explicitScam =
  /\b(?:scan\s*(?:the|my|this)?\s*qr\s*(?:to|for)\s*receive|pay\s*(?:the|a)?\s*courier\s*fee\s*(?:in\s*advance|first)|share\s*(?:your|the)\s*(?:upi\s*)?pin|send\s*(?:your|the)\s*otp)\b/iu;

export function evaluateFreeMarketplacePolicy(
  title: string,
  description: string,
): FreePolicyDecision {
  // Never pretend invalid/malformed input is safe. The caller validates with Zod.
  if (typeof title !== "string" || typeof description !== "string" ||
    title.length < 1 || title.length > 500 || description.length > 5000) {
    return { decision: "review", reason: "INDIA_PAYMENT_FRAUD" };
  }

  const text = normalize(title + "\n" + description);
  if (weaponTerms.test(text)) return { decision: "review", reason: "WEAPON" };
  if (regulatedTerms.test(text)) return { decision: "review", reason: "REGULATED_GOODS" };
  if (counterfeitTerms.test(text)) return { decision: "review", reason: "COUNTERFEIT" };
  if (paymentLinks.test(text) || explicitScam.test(text) ||
    findIndiaFraudSignals(title).length > 0 ||
    findIndiaFraudSignals(description).length > 0) {
    return { decision: "review", reason: "INDIA_PAYMENT_FRAUD" };
  }
  return { decision: "clear" };
}
