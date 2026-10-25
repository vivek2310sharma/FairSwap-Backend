/**
 * FairSwap India: deterministic review-only signals, not automatic guilt or rejection.
 * Operates on an isolated text field. Source hashes must be computed from raw DB
 * text BEFORE this matching-only normalization.
 */
export type FraudSignal =
  | "OTP_PIN"
  | "QR_RECEIVE"
  | "ADVANCE_VIEWING"
  | "IMPERSONATION_FEE";

export interface FraudFinding {
  readonly id: FraudSignal;
  readonly clauseIndex: number;
}

const zeroWidth = /[\u200B-\u200D\u2060\uFEFF]/g;
const separators = /[\n\r.!?।؛;]+/u;
const has = (s: string, p: RegExp) => p.test(s);

function normalizeForMatching(input: string): string {
  return input.normalize("NFKC").replace(zeroWidth, "").toLocaleLowerCase("en-IN")
    .replace(/[\t ]+/g, " ").trim();
}

const safetyAdvice = /(?:\b(?:never|don't|do not|avoid|beware|scam|warning|not|shouldn'?t)\b.{0,42}\b(?:send|share|scan|pay|give|transfer|enter)\b|\b(?:kabhi|kisi ko|koi|bilkul)\b.{0,44}\b(?:mat|nahi|nahin|na)\b|\b(?:mat|nahi|nahin)\b.{0,26}\b(?:bhejo|dena|do|dalo|scan|share|pay)\b|(?:मत|नहीं|ना करें|सावधान).{0,36}(?:भेज|बत|डाल|शेयर|स्कैन|भुगतान|दें)|(?:भेज|बत|डाल|शेयर|स्कैन|भुगतान|दें).{0,16}(?:मत|नहीं|ना करें))/u;
const solicitation = /\b(?:send|share|tell|enter|type|fill|submit|give|pay|transfer|bhejo|bhej|batao|batana|dalo|daalo|karo|karna|do|dena|scan)\b|(?:भेजो|भेजें|भेज|बताओ|बताएं|डालो|डालें|दीजिए|दें|दे दो|करो|करें|स्कैन)/u;
const otpPin = /\b(?:otp|upi\s*pin|payment\s*pin|upi\s*password|one\s*time\s*password)\b|(?:ओटीपी|यूपीआई\s*पिन|पिन\s*नंबर)/u;
const qr = /\b(?:qr|q\s*r|scan|collect\s*request)\b|(?:क्यूआर|स्कैन|कलेक्ट)/u;
const receiving = /\b(?:receive|receiving|collect|credit|paise\s*(?:lene|milne|receive)|payment\s*(?:lene|receive))\b|(?:पैसे\s*(?:लेने|मिलने)|पैसा\s*(?:लेने|मिलने|प्राप्त)|भुगतान\s*प्राप्त)/u;
const before = /\b(?:before|pehle|pahle|pahale|advance|first|token|booking)\b|(?:पहले|अग्रिम|एडवांस|टोकन|बुकिंग)/u;
const viewing = /\b(?:view|viewing|inspect|inspection|check|dekh|dekho|dekhna|dekhe|milna|meeting|pickup|test\s*ride)\b|(?:देखने|देखो|देखें|मिलने|जाँच|जांच|डिलीवरी\s*से\s*पहले)/u;
const payment = /\b(?:upi|pay|payment|bhejo|bhej|send|transfer|deposi?t|fee|token|advance|rs|inr|rupees|paisa|paise|paise\s*bhejo)\b|(?:₹|रु\.?|रुपये|भेजो|भेजें|भुगतान|पैसे|फीस|जमा|टोकन)/u;
const afterViewing = /\b(?:after\s*(?:inspection|view|pickup)|inspect\s*first|pehle\s*(?:dekh|check)|dekhne\s*ke\s*baad|inspection\s*ke\s*baad)\b|(?:देखने\s*के\s*बाद|जाँच\s*के\s*बाद)/u;
const army = /\b(?:army|military|soldier|officer|defen[cs]e|fauji|jawaan|jawan)\b|(?:सेना|फौज|फौजी|सैनिक|आर्मी|अफसर)/u;
const courier = /\b(?:courier|delivery|parcel|dispatch|shipping|transfer)\b|(?:कूरियर|डिलीवरी|पार्सल|शिपिंग|भेजने)/u;
const fee = /\b(?:fee|charges?|refundable|advance|deposit|payment|token|rs|inr)\b|(?:फीस|शुल्क|एडवांस|रिफंड|जमा|₹)/u;
const benignArmyProduct = /\b(?:army\s*green|army\s*print|army\s*pattern|toy\s*soldier|army\s*poster)\b/u;

/**
 * Punctuation and newline define small clauses to avoid cross-sentence matches.
 * This is a high-precision *review hint*, not a comprehensive scam detector.
 */
export function findIndiaFraudSignals(rawText: string): readonly FraudFinding[] {
  if (typeof rawText !== "string" || rawText.length > 5000) return [];
  const clauses = normalizeForMatching(rawText).split(separators).filter(Boolean);
  const findings: FraudFinding[] = [];
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (safetyAdvice.test(clause)) continue;
    const ask = has(clause, solicitation);
    if (!ask) continue;
    const signals = new Set<FraudSignal>();
    if (has(clause, otpPin)) signals.add("OTP_PIN");
    if (has(clause, qr) && has(clause, receiving)) signals.add("QR_RECEIVE");
    if (has(clause, before) && has(clause, viewing) && has(clause, payment) &&
        !has(clause, afterViewing)) signals.add("ADVANCE_VIEWING");
    if (!has(clause, benignArmyProduct) && has(clause, army) && has(clause, courier) &&
        has(clause, fee) && has(clause, payment)) signals.add("IMPERSONATION_FEE");
    for (const id of signals) findings.push({ id, clauseIndex: i });
  }
  return findings;
}

/** Chat-only extension. Does not change the listing moderation rule contract. */
export type ChatFraudSignal = FraudSignal | "UPI_COLLECT" | "PAYMENT_LINK" |
  "ADVANCE_DELIVERY" | "OFF_PLATFORM";

export const CHAT_SAFETY_RULE_VERSION = "chat_india_v1" as const;

// Never return matched text, phone numbers, addresses or URLs to a caller/logger.
export interface ChatSafetyResult {
  readonly rule_version: typeof CHAT_SAFETY_RULE_VERSION;
  readonly rule_ids: readonly ChatFraudSignal[];
}

const chatAdvice = /\b(?:never|do not|don't|avoid)\s+(?:ever\s+)?(?:send|share|scan|pay|give|transfer|enter|accept|click|move|contact)\b|\b(?:mat|nahi|nahin)\s+(?:bhejo|dena|do|dalo|scan|share|pay|karo)\b|\b(?:share|pay|scan|bhejo|bhejna|dena|karo|karna)\s+(?:mat|nahi|nahin)\b|(?:मत\s*(?:भेज|बत|डाल|शेयर|स्कैन|भुगतान|दें|कर)|(?:भेज|शेयर|स्कैन|भुगतान|साझा).{0,20}(?:मत|नहीं))/u;
const chatNoNeed = /\b(?:do not|don't)\s+need\s+to\s+(?:enter|share|pay|scan)\b|\bno\s+need\s+to\s+(?:enter|share|pay|scan)\b|\b(?:dalo|daalna|dalna|dena|bhejna|karna)\b.{0,28}\b(?:zaroorat|jarurat|zarurat)\s+(?:nahi|nahin)\b|(?:डालने|देने|भेजने|करने).{0,20}(?:ज़रूरत|जरूरत|आवश्यकता)\s*नहीं/u;
const chatAdvance = /\b(?:advance|token|booking|deposit|refundable|pehle|pahle|first|before)\b|(?:अग्रिम|एडवांस|टोकन|बुकिंग|पहले|जमा)/u;
const chatArmy = /\b(?:army|crpf|cisf|military|soldier|fauji|jawan|transfer\s+order)\b|(?:आर्मी|सीआरपीएफ|सेना|फौजी|ट्रांसफर)/u;
const chatOffPlatform = /\b(?:whats\s*app|telegram|call\s+me|phone\s+me|contact\s+me|mobile\s+number)\b|(?:व्हाट्सएप|व्हाट्सऐप|कॉल\s*कर)|(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}\b/u;
const chatUpi = /\b(?:collect\s*request|upi\s*(?:id|request)|vpa)\b|[a-z0-9._-]{2,256}@[a-z]{2,32}\b|(?:कलेक्ट\s*रिक्वेस्ट|यूपीआई\s*(?:आईडी|अनुरोध))/u;
const chatUrl = /\bhttps?:\/\/[^\s<>]+|\bwww\.[^\s<>]+/u;
const chatPaymentContext = /\b(?:pay|payment|courier|booking|deposit|token|advance|refund|collect)\b|(?:भुगतान|कूरियर|बुकिंग|टोकन|एडवांस|रिफंड)/u;

/** Server-only deterministic cautions. Findings never reject or alter a message. */
export function classifyIndiaChatSafety(rawText: string): ChatSafetyResult {
  const ids = new Set<ChatFraudSignal>();
  if (typeof rawText !== "string" || rawText.length > 2000) {
    return { rule_version: CHAT_SAFETY_RULE_VERSION, rule_ids: [] };
  }
  // Keep periods inside links intact; punctuation/newlines still bound advice scope.
  const clauses = normalizeForMatching(rawText).split(/[\n\r!?।;]+|\.(?=\s|$)/u).filter(Boolean);
  for (const clause of clauses) {
    if (chatAdvice.test(clause) || chatNoNeed.test(clause)) continue;
    const ask = solicitation.test(clause);
    if (ask && otpPin.test(clause)) ids.add("OTP_PIN");
    if (ask && qr.test(clause) && receiving.test(clause)) ids.add("QR_RECEIVE");
    if (ask && before.test(clause) && viewing.test(clause) && payment.test(clause) && !afterViewing.test(clause)) {
      ids.add("ADVANCE_VIEWING");
    }
    if (ask && chatArmy.test(clause) && !benignArmyProduct.test(clause) && fee.test(clause)) {
      ids.add("IMPERSONATION_FEE");
    }
    if (chatUpi.test(clause) && (ask || receiving.test(clause))) ids.add("UPI_COLLECT");
    if (chatUrl.test(clause) && chatPaymentContext.test(clause)) ids.add("PAYMENT_LINK");
    if (ask && chatAdvance.test(clause) && courier.test(clause) && payment.test(clause) && !afterViewing.test(clause)) {
      ids.add("ADVANCE_DELIVERY");
    }
    if (chatOffPlatform.test(clause)) ids.add("OFF_PLATFORM");
  }
  return { rule_version: CHAT_SAFETY_RULE_VERSION, rule_ids: [...ids].sort() };
}
