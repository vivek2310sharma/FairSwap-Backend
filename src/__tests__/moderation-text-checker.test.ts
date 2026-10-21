import { describe, it, expect, vi } from "vitest";
import { evaluateListingText } from "@/lib/moderation/checker";
import {
  MODERATION_RULE_IDS,
  MODERATION_RULESET_VERSION,
  MODERATION_EVALUATION_SCOPE,
  type ModerationInput,
} from "@/lib/moderation/contract";
import * as rulesModule from "@/lib/moderation/rules";
import { evaluatePaymentBeforeViewing } from "@/lib/moderation/rules";

describe("MOD-01 Isolated Moderation Text Checker", () => {
  describe("RULE A: Selected prohibited-item wording", () => {
    it("flags explicit positive weapon keywords in title", () => {
      const result = evaluateListingText({
        title: "Handgun for sale in good condition",
        description: "Fully working model with original case included.",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags).toEqual([
          {
            ruleId: MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING,
            field: "title",
            reason: "Selected prohibited-item wording found.",
          },
        ]);
      }
    });

    it("flags explicit positive weapon keywords in description", () => {
      const result = evaluateListingText({
        title: "Vintage collectable equipment",
        description: "Multiple firearms available for inspection.",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags[0].ruleId).toBe(
          MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING
        );
        expect(result.flags[0].field).toBe("description");
      }
    });

    it("flags stolen bike wording", () => {
      const result = evaluateListingText({
        title: "Stolen bike for sale cheap",
        description: "Quick sale needed, no questions asked.",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags[0].ruleId).toBe(
          MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING
        );
      }
    });

    it("flags hand gun with whitespace variation", () => {
      const result = evaluateListingText({
        title: "Antique hand gun display piece",
        description: "Decommissioned display model from 1950.",
      });
      expect(result.outcome).toBe("needs_review");
    });

    it("flags ammunition and controlled substances", () => {
      const resultHeroin = evaluateListingText({
        title: "Pharmaceutical items",
        description: "Small quantity of heroin available.",
      });
      expect(resultHeroin.outcome).toBe("needs_review");

      const resultCocaine = evaluateListingText({
        title: "Pure cocaine sample",
        description: "Direct import product sample.",
      });
      expect(resultCocaine.outcome).toBe("needs_review");

      const resultAmmo = evaluateListingText({
        title: "Surplus equipment box",
        description: "Box containing vintage ammunition rounds.",
      });
      expect(resultAmmo.outcome).toBe("needs_review");
    });

    it("does NOT flag ordinary tools like glue gun (false-positive prevention)", () => {
      const result = evaluateListingText({
        title: "Hot melt glue gun with sticks",
        description: "Ideal for craft work and light repairs. Works great.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag ordinary words containing heroine (false-positive prevention)", () => {
      const result = evaluateListingText({
        title: "Classic novel featuring a brave heroine",
        description: "Hardcover first edition in fine condition.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });
  });

  describe("RULE B: Known shortened links", () => {
    it("flags standard https shortened link (bit.ly)", () => {
      const result = evaluateListingText({
        title: "Apple iPhone 13 128GB Blue",
        description: "More details here: https://bit.ly/example-item",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags).toEqual([
          {
            ruleId: MODERATION_RULE_IDS.SHORTENED_LINK,
            field: "description",
            reason: "Known shortened link found.",
          },
        ]);
      }
    });

    it("flags bare domain shortener (tinyurl.com)", () => {
      const result = evaluateListingText({
        title: "Royal Enfield Classic 350",
        description: "Photos: tinyurl.com/motorcycle-pics in album",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags[0].ruleId).toBe(MODERATION_RULE_IDS.SHORTENED_LINK);
      }
    });

    it("flags www prefixed shortener link", () => {
      const result = evaluateListingText({
        title: "Canon EOS 1500D Camera",
        description: "Specs and receipts: http://www.bit.ly/receipt-doc",
      });
      expect(result.outcome).toBe("needs_review");
    });

    it("does NOT flag ordinary manufacturer/specification links", () => {
      const result = evaluateListingText({
        title: "Sony WH-1000XM4 Headphones",
        description:
          "Official specs at https://electronics.sony.com/audio/headphones for reference.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag subdomains of other sites resembling shorteners (bit.ly.example.com)", () => {
      const result = evaluateListingText({
        title: "Laptop computer stand",
        description: "Product page https://bit.ly.example.com/stand available.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag paths containing shorteners on other domains (example.com/bit.ly)", () => {
      const result = evaluateListingText({
        title: "Wooden study table",
        description: "Catalog page https://example.com/bit.ly/item verified.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag userinfo containing shortener (https://bit.ly@example.com)", () => {
      const result = evaluateListingText({
        title: "Bicycle helmet size M",
        description: "Check safety rating at https://bit.ly@example.com/helmet.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag email addresses containing shortener domain", () => {
      const result = evaluateListingText({
        title: "Leather jacket brown size L",
        description: "Contact my agent at support@bit.ly for inquiries.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });
  });

  describe("RULE C: Explicit payment-before-viewing requests", () => {
    it("flags positive request for booking amount before viewing car", () => {
      const result = evaluateListingText({
        title: "Hyundai i20 Magna 2020",
        description: "Send Rs 1000 booking amount first before viewing the car.",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags).toEqual([
          {
            ruleId: MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING,
            field: "description",
            reason: "Explicit payment-before-viewing request found.",
          },
        ]);
      }
    });

    it("flags request with rupee symbol before viewing flat", () => {
      const result = evaluateListingText({
        title: "2 BHK Apartment for Rent",
        description: "Pay ₹1,000 before viewing this flat in Koramangala.",
      });
      expect(result.outcome).toBe("needs_review");
    });

    it("flags request for token before inspecting motorcycle", () => {
      const result = evaluateListingText({
        title: "KTM Duke 390 2021",
        description: "Pay a token before inspecting the motorcycle tomorrow.",
      });
      expect(result.outcome).toBe("needs_review");
    });

    it("does NOT flag isolated words like deposit or advance without before-viewing condition", () => {
      const result = evaluateListingText({
        title: "3 BHK Flat for Lease",
        description:
          "Security deposit required for a 10-month house lease. Rent 35k.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag payment on collection", () => {
      const result = evaluateListingText({
        title: "Dining table with 6 chairs",
        description: "Payment on collection only. Cash or UPI accepted in person.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag negated statements (e.g. no advance payment required)", () => {
      const result = evaluateListingText({
        title: "Honda Activa 5G 2019",
        description:
          "No advance payment required. Come inspect the scooter in person.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("does NOT flag negated phrase: do not pay a booking amount before viewing", () => {
      const result = evaluateListingText({
        title: "1 BHK Flat near Metro",
        description:
          "Do not pay a booking amount before viewing. Beware of fraudsters.",
      });
      expect(result.outcome).toBe("no_review_flags");
    });

    it("still flags combined text where one sentence is negated but another has positive demand", () => {
      const result = evaluateListingText({
        title: "Studio Apartment Downtown",
        description:
          "No advance payment required. Pay ₹1,000 before viewing the flat.",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags[0].ruleId).toBe(
          MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING
        );
      }
    });
  });

  describe("Multiple Rules, Ordering, and Combined Flags", () => {
    it("returns all triggered flags in stable rule order when multiple rules match", () => {
      const result = evaluateListingText({
        title: "Handgun accessories kit",
        description:
          "Check photos on https://bit.ly/gun-photos and pay ₹500 before viewing.",
      });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.flags).toHaveLength(3);
        expect(result.flags[0].ruleId).toBe(
          MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING
        );
        expect(result.flags[1].ruleId).toBe(
          MODERATION_RULE_IDS.SHORTENED_LINK
        );
        expect(result.flags[2].ruleId).toBe(
          MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING
        );
      }
    });

    it("evaluates clean input to no_review_flags with exact metadata", () => {
      const cleanInput: ModerationInput = {
        title: "Wooden study desk in teak finish",
        description:
          "Solid wood study desk with 3 storage drawers. Lightly used for 6 months.",
      };
      const result = evaluateListingText(cleanInput);
      expect(result).toEqual({
        outcome: "no_review_flags",
        ruleSetVersion: MODERATION_RULESET_VERSION,
        scope: MODERATION_EVALUATION_SCOPE,
        completedRules: [
          MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING,
          MODERATION_RULE_IDS.SHORTENED_LINK,
          MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING,
        ],
        flags: [],
      });
    });

    it("is deterministic: repeated evaluations produce identical results", () => {
      const input = {
        title: "iPhone 12 with box",
        description: "Visit https://bit.ly/phone-box for pictures.",
      };
      const run1 = evaluateListingText(input);
      const run2 = evaluateListingText(input);
      expect(run1).toEqual(run2);
    });

    it("does not mutate the input object", () => {
      const original: ModerationInput = {
        title: "Original Title",
        description: "Original Description with enough characters.",
      };
      const clone = { ...original };
      evaluateListingText(original);
      expect(original).toEqual(clone);
    });
  });

  describe("Input Validation (invalid_input)", () => {
    it("rejects null or non-object input", () => {
      const result = evaluateListingText(null);
      expect(result.outcome).toBe("invalid_input");
      if (result.outcome === "invalid_input") {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it("rejects missing title or description", () => {
      const missingTitle = evaluateListingText({
        description: "Valid description text here.",
      });
      expect(missingTitle.outcome).toBe("invalid_input");

      const missingDesc = evaluateListingText({
        title: "Valid Title",
      });
      expect(missingDesc.outcome).toBe("invalid_input");
    });

    it("rejects title with less than 3 characters", () => {
      const result = evaluateListingText({
        title: "AB",
        description: "Valid description text here.",
      });
      expect(result.outcome).toBe("invalid_input");
      if (result.outcome === "invalid_input") {
        expect(result.errors[0].field).toBe("title");
      }
    });

    it("rejects title with only whitespace", () => {
      const result = evaluateListingText({
        title: "    ",
        description: "Valid description text here.",
      });
      expect(result.outcome).toBe("invalid_input");
    });

    it("rejects description with less than 10 characters", () => {
      const result = evaluateListingText({
        title: "Valid Title",
        description: "Short",
      });
      expect(result.outcome).toBe("invalid_input");
    });

    it("rejects title exceeding 150 characters", () => {
      const result = evaluateListingText({
        title: "A".repeat(151),
        description: "Valid description text here.",
      });
      expect(result.outcome).toBe("invalid_input");
    });

    it("rejects description exceeding 5000 characters", () => {
      const result = evaluateListingText({
        title: "Valid Title",
        description: "A".repeat(5001),
      });
      expect(result.outcome).toBe("invalid_input");
    });
  });

  describe("Incomplete and Failure Handling (checks_incomplete)", () => {
    it("returns checks_incomplete if a required rule throws an unexpected error", () => {
      const spy = vi.spyOn(rulesModule, "evaluateProhibitedItemWording").mockImplementation(() => {
        throw new Error("Simulated regex or memory crash");
      });

      try {
        const result = evaluateListingText({
          title: "Clean looking title",
          description: "Clean looking description with enough characters.",
        });

        expect(result.outcome).toBe("checks_incomplete");
        if (result.outcome === "checks_incomplete") {
          expect(result.failedRules).toContain(
            MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING
          );
          expect(result.completedRules).toContain(
            MODERATION_RULE_IDS.SHORTENED_LINK
          );
          expect(result.completedRules).toContain(
            MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING
          );
        }
      } finally {
        spy.mockRestore();
      }
    });

    it("preserves flags and still returns checks_incomplete if a flag was found before another rule fails", () => {
      const spy = vi.spyOn(rulesModule, "evaluateShortenedLinks").mockImplementation(() => {
        throw new Error("Simulated network timeout / engine failure");
      });

      try {
        const result = evaluateListingText({
          title: "Handgun for sale",
          description: "Valid description text with enough characters.",
        });

        expect(result.outcome).toBe("checks_incomplete");
        if (result.outcome === "checks_incomplete") {
          expect(result.flags.length).toBe(1);
          expect(result.flags[0].ruleId).toBe(
            MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING
          );
          expect(result.failedRules).toContain(
            MODERATION_RULE_IDS.SHORTENED_LINK
          );
          expect(result.completedRules).toContain(
            MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING
          );
          expect(result.completedRules).toContain(
            MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING
          );
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("MOD-01A Hardening & Regression Suite", () => {
    it("proves public API ignores extra arguments and cannot bypass mandatory checks", () => {
      const flaggedInput = {
        title: "Handgun with ammunition for sale",
        description: "Send Rs 1000 before viewing the car. Visit https://bit.ly/test",
      };
      // Attempting to pass empty array or no-op runners as extra arguments
      const fn = evaluateListingText as unknown as (...args: unknown[]) => ReturnType<typeof evaluateListingText>;
      const result = fn(flaggedInput, [], { malicious: true });
      expect(result.outcome).toBe("needs_review");
      if (result.outcome === "needs_review") {
        expect(result.completedRules).toEqual([
          MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING,
          MODERATION_RULE_IDS.SHORTENED_LINK,
          MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING,
        ]);
        expect(result.flags.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("enforces exact mandatory completed rule coverage on completed outcomes", () => {
      const cleanInput = {
        title: "Teak wood dining table",
        description: "Six seater dining table in good condition with chairs.",
      };
      const result = evaluateListingText(cleanInput);
      expect(result.outcome).toBe("no_review_flags");
      if (result.outcome === "no_review_flags") {
        expect(result.completedRules).toEqual([
          MODERATION_RULE_IDS.PROHIBITED_ITEM_WORDING,
          MODERATION_RULE_IDS.SHORTENED_LINK,
          MODERATION_RULE_IDS.PAYMENT_BEFORE_VIEWING,
        ]);
      }
    });

    it("evaluates all Rule C candidate phrases accurately (positive, negative, and currency formats)", () => {
      const cases = [
        { text: "No advance, pay Rs 1000 before viewing.", expected: "needs_review" },
        { text: "No advance, but pay Rs 1000 before viewing.", expected: "needs_review" },
        { text: "No advance payment required, but send Rs 1000 booking amount before viewing.", expected: "needs_review" },
        { text: "Pay the refundable token security deposit amount before viewing.", expected: "needs_review" },
        { text: "Do not pay the refundable token security deposit amount before viewing.", expected: "no_review_flags" },
        { text: "No advance payment required.", expected: "no_review_flags" },
        { text: "Payment on collection only.", expected: "no_review_flags" },
        { text: "Security deposit required for a 10-month house lease.", expected: "no_review_flags" },
        { text: "Pay INR 1,000 before viewing this flat.", expected: "needs_review" },
        { text: "Pay ₹1,000 before viewing this flat.", expected: "needs_review" },
      ];

      for (const tc of cases) {
        const flag = evaluatePaymentBeforeViewing(tc.text, "description");
        const outcome = flag ? "needs_review" : "no_review_flags";
        expect({ text: tc.text, outcome }).toEqual({ text: tc.text, outcome: tc.expected });
      }
    });
  });
});


