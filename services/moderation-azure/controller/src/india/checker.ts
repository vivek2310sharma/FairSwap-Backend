import {
  evaluateSsdChemicalWashing,
  evaluateProhibitedGoods,
  evaluateUpiAdvanceFraud,
  evaluateFakeCourierEscrow,
  evaluateSuspiciousContact,
  evaluateUnsupportedLanguage,
} from "./rules";
import {
  INDIA_RULESET_VERSION,
  INDIA_EVALUATION_SCOPE,
  type IndiaReviewFlag,
} from "./contract";

export interface IndiaListingInput {
  title: string;
  description: string;
  ocrTexts?: string[];
  qrPayloads?: string[];
}

export interface IndiaRulesEvaluationResult {
  rulesetVersion: typeof INDIA_RULESET_VERSION;
  scope: typeof INDIA_EVALUATION_SCOPE;
  hasCriticalFlags: boolean;
  hasWarningFlags: boolean;
  flags: IndiaReviewFlag[];
  completedRules: string[];
}

export function evaluateIndiaRules(input: IndiaListingInput): IndiaRulesEvaluationResult {
  const flags: IndiaReviewFlag[] = [];
  const completedRules: string[] = [
    "rule_in_ssd_chemical_washing",
    "rule_in_prohibited_items",
    "rule_in_upi_advance_fraud",
    "rule_in_fake_courier_escrow",
    "rule_in_suspicious_payment_channel",
  ];

  // 1. Check title
  const titleChecks = [
    evaluateSsdChemicalWashing(input.title, "title"),
    evaluateProhibitedGoods(input.title, "title"),
    evaluateUpiAdvanceFraud(input.title, "title"),
    evaluateFakeCourierEscrow(input.title, "title"),
    evaluateSuspiciousContact(input.title, "title"),
    evaluateUnsupportedLanguage(input.title, "title"),
  ];
  for (const flag of titleChecks) {
    if (flag) flags.push(flag);
  }

  // 2. Check description
  const descChecks = [
    evaluateSsdChemicalWashing(input.description, "description"),
    evaluateProhibitedGoods(input.description, "description"),
    evaluateUpiAdvanceFraud(input.description, "description"),
    evaluateFakeCourierEscrow(input.description, "description"),
    evaluateSuspiciousContact(input.description, "description"),
    evaluateUnsupportedLanguage(input.description, "description"),
  ];
  for (const flag of descChecks) {
    if (flag) flags.push(flag);
  }

  // 3. Check OCR texts if available
  if (input.ocrTexts && input.ocrTexts.length > 0) {
    completedRules.push("rule_ocr_extracted_fraud");
    for (const ocr of input.ocrTexts) {
      const ocrChecks = [
        evaluateSsdChemicalWashing(ocr, "ocr_text"),
        evaluateProhibitedGoods(ocr, "ocr_text"),
        evaluateUpiAdvanceFraud(ocr, "ocr_text"),
        evaluateFakeCourierEscrow(ocr, "ocr_text"),
        evaluateSuspiciousContact(ocr, "ocr_text"),
        evaluateUnsupportedLanguage(ocr, "ocr_text"),
      ];
      for (const flag of ocrChecks) {
        if (flag) {
          flags.push({
            ...flag,
            boundedEvidence: ocr.slice(0, 100),
          });
        }
      }
    }
  }

  // 4. Check QR Payloads if available
  if (input.qrPayloads && input.qrPayloads.length > 0) {
    completedRules.push("rule_qr_suspicious_payload");
    for (const qr of input.qrPayloads) {
      if (/upi:\/\/pay\?.*(?:mode=02|sign=)/i.test(qr) || /pay/i.test(qr)) {
        flags.push({
          ruleId: "rule_qr_suspicious_payload" as any,
          field: "qr_payload",
          code: "QR_PAYMENT_REQUEST_DETECTED",
          reason: "QR code containing direct payment/collect URI embedded in listing image.",
          severity: "critical",
          boundedEvidence: "UPI URI scheme detected",
        });
      }
    }
  }

  const hasCriticalFlags = flags.some((f) => f.severity === "critical");
  const hasWarningFlags = flags.some((f) => f.severity === "warning");

  return {
    rulesetVersion: INDIA_RULESET_VERSION,
    scope: INDIA_EVALUATION_SCOPE,
    hasCriticalFlags,
    hasWarningFlags,
    flags,
    completedRules,
  };
}
