import { describe, it, expect } from "vitest";
import { evaluateIndiaRules } from "@/lib/moderation/india/checker";
import {
  evaluateSsdChemicalWashing,
  evaluateUpiAdvanceFraud,
  evaluateProhibitedGoods,
  evaluateFakeCourierEscrow,
  evaluateUnsupportedLanguage,
} from "@/lib/moderation/india/rules";

describe("India Moderation Engine V1 (English-Only Scope) - Security & Precision Tests", () => {
  describe("Gate 1: SSD Chemical/Currency Washing vs Legitimate Computer SSD (English)", () => {
    it("flags chemical currency washing scam as critical", () => {
      const scamTitle = "SSD Chemical solution available for cleaning black money notes";
      const scamDesc = "Universal automatic SSD solution and vectrol paste for defaced currency.";
      const res = evaluateIndiaRules({ title: scamTitle, description: scamDesc });

      expect(res.hasCriticalFlags).toBe(true);
      expect(res.flags.some((f) => f.code === "SSD_CURRENCY_WASHING_FRAUD")).toBe(true);
    });

    it("approves legitimate computer SSD hardware", () => {
      const pcTitle = "Samsung 980 Pro 1TB NVMe M.2 SSD for sale";
      const pcDesc = "Brand new sealed Samsung 980 Pro 1TB PCIe Gen4 NVMe internal solid state drive. Read speed up to 7000 MB/s. Bill and warranty available.";
      const res = evaluateIndiaRules({ title: pcTitle, description: pcDesc });

      expect(res.hasCriticalFlags).toBe(false);
      expect(res.flags).toHaveLength(0);
    });

    it("approves Kingston or Crucial SATA 500GB SSD", () => {
      const pcTitle = "Crucial BX500 480GB SATA SSD";
      const pcDesc = "Used for 6 months, excellent health, 540 MB/s read speed. Selling because upgraded to 2TB SSD.";
      const res = evaluateIndiaRules({ title: pcTitle, description: pcDesc });

      expect(res.hasCriticalFlags).toBe(false);
      expect(res.flags).toHaveLength(0);
    });
  });

  describe("Military Profession False Positive vs Scam Escrow (English)", () => {
    it("approves legitimate listing by an ex-serviceman or military officer selling in person", () => {
      const flag = evaluateFakeCourierEscrow(
        "Ex-serviceman Indian Army officer selling personal Maruti Swift 2019. Driven only 35000 km, single owner. Car available for physical test drive in Pune Cantonment.",
        "description"
      );
      expect(flag).toBeNull();
    });

    it("flags fraudulent army courier fee scam", () => {
      const flag = evaluateFakeCourierEscrow(
        "Army transport courier gate pass deposit of Rs 2500 required before vehicle dispatch.",
        "description"
      );
      expect(flag).not.toBeNull();
      expect(flag?.code).toBe("DEFENCE_COURIER_ESCROW_FRAUD");
    });
  });

  describe("UPI Advance Fraud & Negation Handling (English)", () => {
    it("flags explicit advance fee request in English", () => {
      const flag = evaluateUpiAdvanceFraud(
        "Pay 2000 advance token money prior to viewing the bike",
        "description"
      );
      expect(flag).not.toBeNull();
      expect(flag?.code).toBe("UPI_ADVANCE_FEE_SCAM");
    });

    it("does NOT flag negated safety warning in English", () => {
      const flag = evaluateUpiAdvanceFraud(
        "Warning: Do not pay advance token amount before viewing the car. Inspect in person first.",
        "description"
      );
      expect(flag).toBeNull();
    });
  });

  describe("Unsupported Non-English Script Handling (V1 Policy)", () => {
    it("flags Indic / Devanagari text for manual review under V1 English-only policy", () => {
      const flag = evaluateUnsupportedLanguage("गाड़ी बहुत अच्छी कंडीशन में है", "description");
      expect(flag).not.toBeNull();
      expect(flag?.code).toBe("UNSUPPORTED_LANGUAGE_REVIEW_REQUIRED");
      expect(flag?.severity).toBe("warning");
    });
  });

  describe("Prohibited Goods Detection", () => {
    it("flags illicit firearms or ammunition", () => {
      const flag = evaluateProhibitedGoods("Selling country made pistol and ammunition", "title");
      expect(flag).not.toBeNull();
      expect(flag?.code).toBe("PROHIBITED_ITEM_DETECTED");
    });
  });

  describe("Multimodal OCR & QR inspection", () => {
    it("flags fraud text extracted from image OCR (English)", () => {
      const res = evaluateIndiaRules({
        title: "Clean Honda Activa 5G",
        description: "Good running condition, single owner.",
        ocrTexts: ["Scan QR to pay token advance fee of Rs 500 first before visit"],
      });

      expect(res.hasCriticalFlags).toBe(true);
      expect(res.flags.some((f) => f.field === "ocr_text")).toBe(true);
    });

    it("flags embedded UPI payment QR payload", () => {
      const res = evaluateIndiaRules({
        title: "iPhone 13 128GB",
        description: "Blue color, battery 88%.",
        qrPayloads: ["upi://pay?pa=scammer@oksbi&pn=PayNow&am=15000&mode=02"],
      });

      expect(res.hasCriticalFlags).toBe(true);
      expect(res.flags.some((f) => f.field === "qr_payload")).toBe(true);
    });
  });
});
