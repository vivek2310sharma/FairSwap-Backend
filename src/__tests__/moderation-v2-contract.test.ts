/**
 * FairSwap Moderation V2 — Contract Schema Tests
 *
 * Point 3-owned test file covering the specification's 38 design cases
 * and additional meaningful edge cases.
 *
 * Authoritative specification: docs/moderation/MODERATION_V2_CONTRACT.md
 *
 * Network access is blocked by the shared no-network setup file.
 * All data is synthetic; no real user data or provider credentials.
 */
import { describe, expect, it } from "vitest";
import { type ZodError, ZodIssueCode } from "zod";
import {
  CATEGORIES,
  CHECK_IDS,
  CONTRACT_VERSION,
  type EarlyInvalidResultV2,
  EarlyInvalidResultV2Schema,
  type EvaluationResultV2,
  EvaluationResultV2Schema,
  FS_IDS,
  IMAGE_CATEGORIES,
  MODEL,
  ModerationResultV2Schema,
  POLICY,
  SnapshotV2Schema,
} from "@/lib/moderation/v2/contract.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID v4 from a seed number. */
function uuid(n: number): string {
  const hex = n.toString(16).padStart(32, "0");
  // Set version 4 (0100) and variant 10xx bits
  const chars = hex.split("");
  chars[12] = "4"; // version
  chars[16] = "a"; // variant
  return [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20, 32).join(""),
  ].join("-");
}

/** Deterministic lowercase hex SHA-256 from a seed string. */
function sha(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

/** Build an ObjectIdentity with unique object_id. */
function makeObject(seed: number): {
  object_id: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
} {
  return {
    object_id: uuid(seed),
    sha256: sha(`obj-${seed}`),
    bytes: 100_000,
    width: 1400,
    height: 1050,
  };
}

/** Build a Media entry with unique IDs. Seeds spaced by 100 per slot. */
function makeMedia(
  mediaIndex: number,
  displayOrder: number,
  opts?: { overrideSourceSha256?: string },
): ReturnType<typeof makeMediaInner> {
  return makeMediaInner(mediaIndex, displayOrder, opts);
}

function makeMediaInner(
  i: number,
  displayOrder: number,
  opts?: { overrideSourceSha256?: string },
) {
  const base = i * 100;
  const original = makeObject(base + 1);
  return {
    media_id: uuid(base),
    asset_version: uuid(base + 50),
    display_order: displayOrder,
    source_sha256: opts?.overrideSourceSha256 ?? original.sha256,
    recipe: "seal_v1" as const,
    original,
    canonical: makeObject(base + 2),
    thumb: makeObject(base + 3),
    medium: makeObject(base + 4),
    large: makeObject(base + 5),
  };
}

/** Build all 13 categories for text modality (all evaluated). */
function makeTextCategories(
  overrides?: Partial<Record<string, { flagged: boolean; score: number }>>,
) {
  return CATEGORIES.map((cat) => {
    const ov = overrides?.[cat];
    return {
      category: cat,
      applicability: "evaluated" as const,
      flagged: ov?.flagged ?? false,
      score: ov?.score ?? 0.001,
    };
  });
}

/** Build all 13 categories for image modality (6 evaluated, 7 not_applicable). */
function makeImageCategories(
  overrides?: Partial<Record<string, { flagged: boolean; score: number }>>,
) {
  return CATEGORIES.map((cat) => {
    const applies = IMAGE_CATEGORIES.includes(cat);
    if (applies) {
      const ov = overrides?.[cat];
      return {
        category: cat,
        applicability: "evaluated" as const,
        flagged: ov?.flagged ?? false,
        score: ov?.score ?? 0.002,
      };
    }
    return {
      category: cat,
      applicability: "not_applicable" as const,
      flagged: null,
      score: null,
    };
  });
}

/** Build a Provider for text checks. */
function makeTextProvider(opts?: {
  flaggedCategories?: string[];
  responseId?: string;
}) {
  const flagSet = new Set(opts?.flaggedCategories ?? []);
  const cats = makeTextCategories(
    Object.fromEntries(
      [...flagSet].map((c) => [c, { flagged: true, score: 0.95 }]),
    ),
  );
  return {
    name: "openai" as const,
    requested_model: MODEL,
    returned_model: MODEL,
    response_id: opts?.responseId ?? "resp-text-001",
    request_id: "req-text-001",
    flagged: flagSet.size > 0,
    categories: cats,
  };
}

/** Build a Provider for image checks. */
function makeImageProvider(opts?: {
  flaggedCategories?: string[];
  responseId?: string;
}) {
  const flagSet = new Set(opts?.flaggedCategories ?? []);
  const cats = makeImageCategories(
    Object.fromEntries(
      [...flagSet].map((c) => [c, { flagged: true, score: 0.92 }]),
    ),
  );
  return {
    name: "openai" as const,
    requested_model: MODEL,
    returned_model: MODEL,
    response_id: opts?.responseId ?? "resp-img-001",
    request_id: null,
    flagged: flagSet.size > 0,
    categories: cats,
  };
}

const TITLE_SHA = sha("test title text");
const DESC_SHA = sha("test description text");

/** Build shared Identity fields. */
function makeIdentity(overrides?: Record<string, unknown>) {
  return {
    contract_version: "2.0.0",
    policy_version: POLICY,
    evaluator_version: "v2.0.0",
    request_id: uuid(9000),
    attempt_id: uuid(9001),
    evaluated_at: "2026-10-18T16:00:00+02:00",
    ...overrides,
  };
}

/** Build a single-image clean evaluation snapshot. */
function makeSnapshot(
  imageCount = 1,
  opts?: { coverIndex?: number },
) {
  const mediaArr = Array.from({ length: imageCount }, (_, i) =>
    makeMedia(i + 1, i),
  );
  const coverIdx = opts?.coverIndex ?? 0;
  return {
    listing_id: uuid(1),
    listing_revision: 0,
    generation_id: uuid(2),
    canonicalization: "snapshot_v1" as const,
    title_sha256: TITLE_SHA,
    description_sha256: DESC_SHA,
    media_manifest_sha256: sha("manifest"),
    snapshot_sha256: sha("snapshot"),
    cover_media_id: mediaArr[coverIdx].media_id,
    media: mediaArr,
  };
}

/**
 * Build the complete set of checks for a given snapshot.
 * All checks pass by default.
 */
function makeChecks(
  snapshot: ReturnType<typeof makeSnapshot>,
  opts?: {
    flagText?: string[];
    flagImage?: string[];
    failChecks?: string[];
    omitChecks?: string[];
    extraChecks?: Array<Record<string, unknown>>;
    duplicateCheck?: string;
  },
) {
  const checks: Record<string, unknown>[] = [];
  const flagTextSet = new Set(opts?.flagText ?? []);
  const flagImageSet = new Set(opts?.flagImage ?? []);
  const failSet = new Set(opts?.failChecks ?? []);
  const omitSet = new Set(opts?.omitChecks ?? []);

  // Text checks: 3 FS rules + openai_text_v2 per field
  for (const field of ["title", "description"] as const) {
    const inputHash =
      field === "title" ? snapshot.title_sha256 : snapshot.description_sha256;

    for (const ruleId of FS_IDS) {
      const key = `${ruleId}:${field}`;
      if (omitSet.has(key)) continue;
      const isFlagged = flagTextSet.has(key);
      const isFailed = failSet.has(key);
      const reasonMap: Record<string, string> = {
        rule_prohibited_item_wording: "PROHIBITED_WORDING",
        rule_shortened_link: "SHORTENED_LINK",
        rule_payment_before_viewing: "PAYMENT_BEFORE_VIEWING",
      };
      checks.push({
        check_id: ruleId,
        target: { kind: "text", field },
        input_sha256: inputHash,
        state: isFailed ? "failed" : isFlagged ? "flagged" : "passed",
        reason_codes: isFlagged
          ? [reasonMap[ruleId]]
          : isFailed
            ? ["TIMEOUT"]
            : [],
        retryable: false,
        provider: null,
      });
    }

    // openai_text_v2
    const textKey = `openai_text_v2:${field}`;
    if (!omitSet.has(textKey)) {
      const isFlagged = flagTextSet.has(textKey);
      const isFailed = failSet.has(textKey);
      checks.push({
        check_id: "openai_text_v2",
        target: { kind: "text", field },
        input_sha256: inputHash,
        state: isFailed ? "failed" : isFlagged ? "flagged" : "passed",
        reason_codes: isFlagged
          ? ["PROVIDER_FLAG"]
          : isFailed
            ? ["TIMEOUT"]
            : [],
        retryable: isFailed,
        provider: isFailed
          ? null
          : makeTextProvider(
              isFlagged ? { flaggedCategories: ["harassment"] } : {},
            ),
      });
    }
  }

  // Image checks: image_integrity_v2 + openai_image_v2 per media
  for (const m of snapshot.media) {
    const intKey = `image_integrity_v2:${m.media_id}`;
    if (!omitSet.has(intKey)) {
      const isFailed = failSet.has(intKey);
      checks.push({
        check_id: "image_integrity_v2",
        target: { kind: "image", media_id: m.media_id },
        input_sha256: m.canonical.sha256,
        state: isFailed ? "failed" : "passed",
        reason_codes: isFailed ? ["DIGEST_MISMATCH"] : [],
        retryable: false,
        provider: null,
      });
    }

    const imgKey = `openai_image_v2:${m.media_id}`;
    if (!omitSet.has(imgKey)) {
      const isFlagged = flagImageSet.has(imgKey);
      const isFailed = failSet.has(imgKey);
      checks.push({
        check_id: "openai_image_v2",
        target: { kind: "image", media_id: m.media_id },
        input_sha256: m.canonical.sha256,
        state: isFailed ? "failed" : isFlagged ? "flagged" : "passed",
        reason_codes: isFlagged
          ? ["PROVIDER_FLAG"]
          : isFailed
            ? ["PROVIDER_5XX"]
            : [],
        retryable: isFailed,
        provider: isFailed
          ? null
          : makeImageProvider(
              isFlagged ? { flaggedCategories: ["violence"] } : {},
            ),
      });
    }
  }

  if (opts?.duplicateCheck) {
    // Re-add the first check with matching key
    const first = checks[0];
    if (first) checks.push({ ...first });
  }

  if (opts?.extraChecks) {
    checks.push(...opts.extraChecks);
  }

  return checks;
}

/**
 * Build a complete valid EvaluationResultV2.
 */
function makeEvalResult(
  imageCount = 1,
  overrides?: Partial<EvaluationResultV2>,
): Record<string, unknown> {
  const snapshot = makeSnapshot(imageCount);
  const checks = makeChecks(snapshot);

  return {
    ...makeIdentity(),
    phase: "evaluation",
    snapshot,
    checks,
    outcome: "no_review_flags",
    ...overrides,
  };
}

/**
 * Build a complete valid EarlyInvalidResultV2.
 */
function makeEarlyInvalid(
  overrides?: Partial<EarlyInvalidResultV2>,
): Record<string, unknown> {
  return {
    ...makeIdentity(),
    phase: "input_validation",
    outcome: "invalid_input",
    listing_id: uuid(1),
    listing_revision: 0,
    generation_id: uuid(2),
    title_sha256: TITLE_SHA,
    description_sha256: null,
    validation_errors: [{ field: "description", code: "TYPE" }],
    ...overrides,
  };
}

/** Extract custom issue messages from a ZodError. */
function getCustomIssues(err: ZodError): string[] {
  return err.issues
    .filter((i) => i.code === ZodIssueCode.custom)
    .map((i) => i.message);
}

/** Assert that parsing fails and return the ZodError. */
function expectFail(data: unknown): ZodError {
  const result = ModerationResultV2Schema.safeParse(data);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("unreachable");
  return result.error;
}

/** Assert that parsing succeeds. */
function expectPass(data: unknown): void {
  const result = ModerationResultV2Schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    throw new Error(`Expected pass but got:\n${messages.join("\n")}`);
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Moderation V2 Contract — Constants", () => {
  it("exports correct contract version", () => {
    expect(CONTRACT_VERSION).toBe("2.0.0");
  });

  it("exports correct policy", () => {
    expect(POLICY).toBe("fairswap_moderation_v2.0.0");
  });

  it("exports correct pinned model", () => {
    expect(MODEL).toBe("omni-moderation-2024-09-26");
  });

  it("has exactly 3 FairSwap rule IDs", () => {
    expect(FS_IDS).toHaveLength(3);
    expect(FS_IDS).toContain("rule_prohibited_item_wording");
    expect(FS_IDS).toContain("rule_shortened_link");
    expect(FS_IDS).toContain("rule_payment_before_viewing");
  });

  it("has exactly 6 check IDs", () => {
    expect(CHECK_IDS).toHaveLength(6);
  });

  it("has exactly 13 categories", () => {
    expect(CATEGORIES).toHaveLength(13);
  });

  it("has exactly 6 image-supported categories", () => {
    expect(IMAGE_CATEGORIES).toHaveLength(6);
    expect(IMAGE_CATEGORIES).toContain("sexual");
    expect(IMAGE_CATEGORIES).toContain("self-harm");
    expect(IMAGE_CATEGORIES).toContain("violence");
    expect(IMAGE_CATEGORIES).toContain("violence/graphic");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Valid results (single image — 10 checks)
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Single image evaluation (10 checks)", () => {
  // C01-like: clean pass, all 10 checks
  it("DC01: accepts a complete no_review_flags result with 1 image (10 checks)", () => {
    expectPass(makeEvalResult(1));
  });

  // Flagged text rule
  it("DC02: accepts needs_review when a text rule flags", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      flagText: ["rule_prohibited_item_wording:title"],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
  });

  // Flagged OpenAI text
  it("DC03: accepts needs_review when openai_text_v2 flags a field", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      flagText: ["openai_text_v2:description"],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
  });

  // Flagged OpenAI image
  it("DC04: accepts needs_review when openai_image_v2 flags an image", () => {
    const snapshot = makeSnapshot(1);
    const media = snapshot.media[0];
    const checks = makeChecks(snapshot, {
      flagImage: [`openai_image_v2:${media.media_id}`],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
  });

  // Failed check → checks_incomplete
  it("DC05: accepts checks_incomplete when a provider check fails (transient)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      failChecks: ["openai_text_v2:title"],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
  });

  // Missing check → checks_incomplete
  it("DC06: accepts checks_incomplete when a check is missing", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      omitChecks: ["openai_text_v2:title"],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Valid results (8 images — 24 checks)
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Eight image evaluation (24 checks)", () => {
  // C04-like: maximum images
  it("DC07: accepts a complete no_review_flags result with 8 images (24 checks)", () => {
    expectPass(makeEvalResult(8));
  });

  it("DC08: accepts checks_incomplete with 8 images, one failed integrity check", () => {
    const snapshot = makeSnapshot(8);
    const media3 = snapshot.media[2];
    const checks = makeChecks(snapshot, {
      failChecks: [`image_integrity_v2:${media3.media_id}`],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Early invalid-input envelope
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Early invalid-input envelope (C25)", () => {
  it("DC09: accepts valid early invalid (description TYPE, null digest)", () => {
    expectPass(makeEarlyInvalid());
  });

  it("DC10: accepts early invalid with title TOO_SHORT", () => {
    expectPass(
      makeEarlyInvalid({
        title_sha256: TITLE_SHA,
        description_sha256: DESC_SHA,
        validation_errors: [{ field: "title", code: "TOO_SHORT" }],
      }),
    );
  });

  it("DC11: accepts early invalid with title TOO_LONG", () => {
    expectPass(
      makeEarlyInvalid({
        title_sha256: TITLE_SHA,
        description_sha256: DESC_SHA,
        validation_errors: [{ field: "title", code: "TOO_LONG" }],
      }),
    );
  });

  it("DC12: accepts two field errors (title TYPE + description TOO_SHORT)", () => {
    expectPass(
      makeEarlyInvalid({
        title_sha256: null,
        description_sha256: DESC_SHA,
        validation_errors: [
          { field: "title", code: "TYPE" },
          { field: "description", code: "TOO_SHORT" },
        ],
      }),
    );
  });

  it("DC13: rejects duplicate field errors", () => {
    const err = expectFail(
      makeEarlyInvalid({
        validation_errors: [
          { field: "description", code: "TYPE" },
          { field: "description", code: "TOO_SHORT" },
        ],
      }),
    );
    expect(getCustomIssues(err)).toContain("DUPLICATE_FIELD_ERROR");
  });

  it("DC14: rejects TYPE code without null digest (VALIDATION_DIGEST_BINDING)", () => {
    const err = expectFail(
      makeEarlyInvalid({
        description_sha256: DESC_SHA, // should be null for TYPE
        validation_errors: [{ field: "description", code: "TYPE" }],
      }),
    );
    expect(getCustomIssues(err)).toContain("VALIDATION_DIGEST_BINDING");
  });

  it("DC15: rejects null digest without TYPE code (VALIDATION_DIGEST_BINDING)", () => {
    const err = expectFail(
      makeEarlyInvalid({
        description_sha256: null,
        validation_errors: [{ field: "description", code: "TOO_SHORT" }],
      }),
    );
    expect(getCustomIssues(err)).toContain("VALIDATION_DIGEST_BINDING");
  });

  // C26: cross-phase smuggling — snapshot in early phase
  it("DC16: rejects unexpected snapshot field in early phase (strict)", () => {
    const data = makeEarlyInvalid();
    (data as Record<string, unknown>).snapshot = makeSnapshot(1);
    const result = ModerationResultV2Schema.safeParse(data);
    expect(result.success).toBe(false);
  });

  // C26: cross-phase smuggling — checks in early phase
  it("DC17: rejects checks field in early phase (strict)", () => {
    const data = makeEarlyInvalid();
    (data as Record<string, unknown>).checks = [];
    const result = ModerationResultV2Schema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("DC18: rejects zero validation_errors", () => {
    const data = makeEarlyInvalid({ validation_errors: [] as never });
    const result = ModerationResultV2Schema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("DC19: rejects three validation_errors (max is 2)", () => {
    const data = makeEarlyInvalid({
      validation_errors: [
        { field: "title", code: "TYPE" },
        { field: "description", code: "TYPE" },
        { field: "title", code: "TOO_SHORT" },
      ] as never,
    });
    const result = ModerationResultV2Schema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Version and identity enforcement
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Version / identity (C01)", () => {
  it("DC20: rejects unknown contract_version", () => {
    const result = ModerationResultV2Schema.safeParse(
      makeEvalResult(1, { contract_version: "3.0.0" } as never),
    );
    expect(result.success).toBe(false);
  });

  it("DC21: rejects unknown policy_version", () => {
    const result = ModerationResultV2Schema.safeParse(
      makeEvalResult(1, { policy_version: "unknown_policy" } as never),
    );
    expect(result.success).toBe(false);
  });

  it("DC22: rejects malformed evaluator_version", () => {
    const result = ModerationResultV2Schema.safeParse(
      makeEvalResult(1, { evaluator_version: "1.0.0" } as never),
    );
    expect(result.success).toBe(false);
  });

  it("DC23: rejects extra unknown fields (strict)", () => {
    const data = makeEvalResult(1);
    (data as Record<string, unknown>).secret = "leaked";
    const result = ModerationResultV2Schema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Check coverage invariants
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Check coverage (C01, C04)", () => {
  it("DC24: rejects duplicate check instance", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    // Duplicate the first check
    checks.push({ ...checks[0] });
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("UNEXPECTED_OR_DUPLICATE_CHECK");
  });

  it("DC25: rejects unrecognized check_id", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    checks.push({
      check_id: "unknown_rule",
      target: { kind: "text", field: "title" },
      input_sha256: snapshot.title_sha256,
      state: "passed",
      reason_codes: [],
      retryable: false,
      provider: null,
    });
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("DC26: rejects extra check for non-existent media_id", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const fakeMediaId = uuid(999);
    checks.push({
      check_id: "image_integrity_v2",
      target: { kind: "image", media_id: fakeMediaId },
      input_sha256: sha("fake"),
      state: "passed",
      reason_codes: [],
      retryable: false,
      provider: null,
    });
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("UNEXPECTED_OR_DUPLICATE_CHECK");
  });

  it("DC27: rejects outcome no_review_flags with missing checks", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      omitChecks: ["openai_text_v2:title"],
    });
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags", // wrong: should be checks_incomplete
    });
    expect(getCustomIssues(err)).toContain("OUTCOME_CONFLICT");
  });

  it("DC28: rejects outcome no_review_flags when a check is flagged", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      flagText: ["rule_shortened_link:title"],
    });
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("OUTCOME_CONFLICT");
  });

  it("DC29: rejects outcome needs_review when a check has failed", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      flagText: ["rule_shortened_link:title"],
      failChecks: ["openai_text_v2:description"],
    });
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review", // wrong: failed → checks_incomplete
    });
    expect(getCustomIssues(err)).toContain("OUTCOME_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Category modality semantics (C02, C03)
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Category modality (C02, C03)", () => {
  it("DC30: rejects image check with text-only category marked evaluated", () => {
    const snapshot = makeSnapshot(1);
    const media = snapshot.media[0];
    const provider = makeImageProvider();
    // Force 'harassment' (text-only) to evaluated for image
    const harassmentCat = provider.categories.find(
      (c) => c.category === "harassment",
    )!;
    harassmentCat.applicability = "evaluated";
    harassmentCat.flagged = false;
    harassmentCat.score = 0.01;

    const checks = makeChecks(snapshot);
    const imgCheck = checks.find(
      (c) =>
        (c as Record<string, unknown>).check_id === "openai_image_v2" &&
        ((c as Record<string, unknown>).target as Record<string, unknown>)
          .media_id === media.media_id,
    )!;
    (imgCheck as Record<string, unknown>).provider = provider;

    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("FALSE_IMAGE_COVERAGE");
  });

  it("DC31: rejects image check with image-supported category marked not_applicable", () => {
    const snapshot = makeSnapshot(1);
    const media = snapshot.media[0];
    const provider = makeImageProvider();
    // Force 'violence' (image-supported) to not_applicable
    const violenceCat = provider.categories.find(
      (c) => c.category === "violence",
    )!;
    violenceCat.applicability = "not_applicable";
    violenceCat.flagged = null;
    violenceCat.score = null;

    const checks = makeChecks(snapshot);
    const imgCheck = checks.find(
      (c) =>
        (c as Record<string, unknown>).check_id === "openai_image_v2" &&
        ((c as Record<string, unknown>).target as Record<string, unknown>)
          .media_id === media.media_id,
    )!;
    (imgCheck as Record<string, unknown>).provider = provider;

    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("MISSING_COVERAGE");
  });

  it("DC32: rejects not_applicable category with non-null flagged/score", () => {
    const snapshot = makeSnapshot(1);
    const media = snapshot.media[0];
    const provider = makeImageProvider();
    // Force 'hate' (text-only on images) to have score=0.5 while not_applicable
    const hateCat = provider.categories.find((c) => c.category === "hate")!;
    hateCat.score = 0.5; // invalid: must be null for not_applicable

    const checks = makeChecks(snapshot);
    const imgCheck = checks.find(
      (c) =>
        (c as Record<string, unknown>).check_id === "openai_image_v2" &&
        ((c as Record<string, unknown>).target as Record<string, unknown>)
          .media_id === media.media_id,
    )!;
    (imgCheck as Record<string, unknown>).provider = provider;

    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("FALSE_IMAGE_COVERAGE");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: State/reason/retry invariants
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — State/reason/retry invariants", () => {
  it("DC33: rejects passed check with reason codes", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const first = checks[0] as Record<string, unknown>;
    first.reason_codes = ["PROHIBITED_WORDING"];
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("PASS_WITH_ERROR");
  });

  it("DC34: rejects non-passed check with empty reason codes", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const first = checks[0] as Record<string, unknown>;
    first.state = "flagged";
    first.reason_codes = [];
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
    expect(getCustomIssues(err)).toContain("MISSING_REASON");
  });

  it("DC35: rejects retryable on a non-failed check", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      flagText: ["rule_prohibited_item_wording:title"],
    });
    const flaggedCheck = checks.find(
      (c) =>
        (c as Record<string, unknown>).check_id ===
          "rule_prohibited_item_wording" &&
        ((c as Record<string, unknown>).target as Record<string, unknown>)
          .field === "title",
    )!;
    (flaggedCheck as Record<string, unknown>).retryable = true;
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
    expect(getCustomIssues(err)).toContain("INVALID_RETRY");
  });

  it("DC36: rejects retryable with non-transient reason", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    // Manually create a failed check with retryable + PROVIDER_AUTH (non-transient)
    const first = checks[0] as Record<string, unknown>;
    first.state = "failed";
    first.reason_codes = ["PROVIDER_AUTH"];
    first.retryable = true;
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
    expect(getCustomIssues(err)).toContain("NONRETRYABLE_REASON");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Provider data binding
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Provider data binding", () => {
  it("DC37: rejects local check with non-null provider", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const first = checks[0] as Record<string, unknown>;
    first.provider = makeTextProvider();
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("LOCAL_PROVIDER_DATA");
  });

  it("DC38: rejects provider check with null provider when not failed", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )!;
    (openaiCheck as Record<string, unknown>).provider = null;
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("MISSING_PROVIDER");
  });

  it("accepts provider check with null provider when failed (transient)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      failChecks: ["openai_text_v2:title"],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Snapshot invariants
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Snapshot invariants", () => {
  it("rejects zero media", () => {
    const snapshot = makeSnapshot(1);
    snapshot.media = [];
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: [],
      outcome: "checks_incomplete",
    });
    expect(result.success).toBe(false);
  });

  it("rejects nine media (max is 8)", () => {
    const snapshot = makeSnapshot(9 as never);
    const result = SnapshotV2Schema.safeParse(snapshot);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate media_id", () => {
    const snapshot = makeSnapshot(2);
    snapshot.media[1].media_id = snapshot.media[0].media_id;
    snapshot.media[1].display_order = 1; // keep different order
    const checks = makeChecks(snapshot);
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("MEDIA_MEMBERSHIP");
  });

  it("rejects cover_media_id not in media list", () => {
    const snapshot = makeSnapshot(1);
    snapshot.cover_media_id = uuid(999);
    const checks = makeChecks(snapshot);
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("MEDIA_MEMBERSHIP");
  });

  it("rejects media not sorted by (display_order, media_id)", () => {
    const snapshot = makeSnapshot(2);
    // Reverse the order so display_order 1 comes before 0
    const temp = snapshot.media[0];
    snapshot.media[0] = snapshot.media[1];
    snapshot.media[1] = temp;
    const checks = makeChecks(snapshot);
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("MEDIA_ORDER");
  });

  it("rejects original.sha256 !== source_sha256 (ORIGINAL_BINDING)", () => {
    const snapshot = makeSnapshot(1);
    snapshot.media[0].source_sha256 = sha("different");
    const checks = makeChecks(snapshot);
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("ORIGINAL_BINDING");
  });

  it("rejects reused object_id across media slots (OBJECT_REUSE)", () => {
    const snapshot = makeSnapshot(1);
    // Make canonical reuse original's object_id
    snapshot.media[0].canonical.object_id = snapshot.media[0].original.object_id;
    const checks = makeChecks(snapshot);
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("OBJECT_REUSE");
  });

  it("rejects object with zero bytes", () => {
    const snapshot = makeSnapshot(1);
    snapshot.media[0].original.bytes = 0;
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects object exceeding 5 MiB", () => {
    const snapshot = makeSnapshot(1);
    snapshot.media[0].original.bytes = 5_242_881;
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects object with dimension exceeding 8000", () => {
    const snapshot = makeSnapshot(1);
    snapshot.media[0].original.width = 8001;
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Input binding
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Input binding", () => {
  it("rejects check with wrong input_sha256 for title", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    // Change the first check's input_sha256
    const first = checks.find(
      (c) =>
        (c as Record<string, unknown>).check_id ===
          "rule_prohibited_item_wording" &&
        ((c as Record<string, unknown>).target as Record<string, unknown>)
          .field === "title",
    )!;
    (first as Record<string, unknown>).input_sha256 = sha("wrong");
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("INPUT_BINDING");
  });

  it("rejects check with wrong input_sha256 for image (canonical hash)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const imgCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "image_integrity_v2",
    )!;
    (imgCheck as Record<string, unknown>).input_sha256 = sha("wrong");
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("INPUT_BINDING");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Provider flag consistency
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Provider flag consistency", () => {
  it("rejects provider.flagged=true when no category is flagged (PROVIDER_FLAG_CONFLICT)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.flagged = true; // No category is flagged
    openaiCheck.state = "flagged";
    openaiCheck.reason_codes = ["PROVIDER_FLAG"];
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
    expect(getCustomIssues(err)).toContain("PROVIDER_FLAG_CONFLICT");
  });

  it("rejects provider.flagged=false when a category IS flagged (PROVIDER_FLAG_CONFLICT)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      flagText: ["openai_text_v2:title"],
    });
    const openaiCheck = checks.find(
      (c) =>
        (c as Record<string, unknown>).check_id === "openai_text_v2" &&
        ((c as Record<string, unknown>).target as Record<string, unknown>)
          .field === "title",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.flagged = false; // Contradicts category flag
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
    expect(getCustomIssues(err)).toContain("PROVIDER_FLAG_CONFLICT");
  });

  it("rejects check state=passed when provider.flagged=true (CHECK_FLAG_CONFLICT)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = makeTextProvider({ flaggedCategories: ["harassment"] });
    openaiCheck.provider = provider;
    // State remains passed, but provider.flagged is true
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("CHECK_FLAG_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Flag/failure reason allowlists
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Reason allowlists", () => {
  it("rejects local flagged check with wrong reason code (INVALID_FLAG_REASON)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const first = checks[0] as Record<string, unknown>;
    first.state = "flagged";
    first.reason_codes = ["PROVIDER_FLAG"]; // wrong for local rule
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
    expect(getCustomIssues(err)).toContain("INVALID_FLAG_REASON");
  });

  it("rejects failed check with no failure reason code (INVALID_FAILURE_REASON)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const first = checks[0] as Record<string, unknown>;
    first.state = "failed";
    first.reason_codes = ["PROHIBITED_WORDING"]; // not a failure code
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
    expect(getCustomIssues(err)).toContain("INVALID_FAILURE_REASON");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Hash format validation
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Hash/UUID format", () => {
  it("rejects uppercase hex in SHA-256", () => {
    const snapshot = makeSnapshot(1);
    snapshot.title_sha256 = sha("title").toUpperCase();
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects SHA-256 with wrong length", () => {
    const snapshot = makeSnapshot(1);
    snapshot.title_sha256 = "abcd";
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects uppercase UUID", () => {
    const snapshot = makeSnapshot(1);
    snapshot.listing_id = uuid(1).toUpperCase();
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Provider model/name pinning
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Provider model pinning", () => {
  it("rejects wrong requested_model", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.requested_model = "text-moderation-latest";
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong returned_model", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.returned_model = "omni-moderation-latest";
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong provider name", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.name = "anthropic";
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Duplicate reason codes
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Duplicate reason codes", () => {
  it("rejects check with duplicate reason codes", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const first = checks[0] as Record<string, unknown>;
    first.state = "failed";
    first.reason_codes = ["TIMEOUT", "TIMEOUT"];
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
    expect(getCustomIssues(err)).toContain("DUPLICATE_REASON");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Category count
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Category membership", () => {
  it("rejects provider with fewer than 13 categories", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    (provider.categories as unknown[]).pop();
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects provider with duplicate category", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    const cats = provider.categories as unknown[];
    // Replace last with duplicate of first
    cats[cats.length - 1] = { ...(cats[0] as Record<string, unknown>) };
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("CATEGORY_MEMBERSHIP");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Recipe pinning
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Recipe", () => {
  it("rejects wrong recipe", () => {
    const snapshot = makeSnapshot(1);
    (snapshot.media[0] as Record<string, unknown>).recipe = "seal_v2";
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Canonicalization pinning
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Canonicalization", () => {
  it("rejects wrong canonicalization", () => {
    const snapshot = makeSnapshot(1);
    (snapshot as Record<string, unknown>).canonicalization = "snapshot_v2";
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Evaluated_at datetime
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — evaluated_at", () => {
  it("accepts ISO 8601 with offset", () => {
    expectPass(
      makeEvalResult(1, {
        evaluated_at: "2026-10-18T14:00:00+00:00",
      } as never),
    );
  });

  it("accepts ISO 8601 with Z", () => {
    expectPass(
      makeEvalResult(1, {
        evaluated_at: "2026-10-18T14:00:00Z",
      } as never),
    );
  });

  it("rejects non-ISO datetime", () => {
    const result = ModerationResultV2Schema.safeParse(
      makeEvalResult(1, {
        evaluated_at: "Oct 18, 2026",
      } as never),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Schema isolation (sub-schemas)
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Sub-schema isolation", () => {
  it("SnapshotV2Schema independently validates a correct snapshot", () => {
    const result = SnapshotV2Schema.safeParse(makeSnapshot(1));
    expect(result.success).toBe(true);
  });

  it("EarlyInvalidResultV2Schema independently validates", () => {
    const result = EarlyInvalidResultV2Schema.safeParse(makeEarlyInvalid());
    expect(result.success).toBe(true);
  });

  it("EvaluationResultV2Schema independently validates (no superRefine)", () => {
    const result = EvaluationResultV2Schema.safeParse(makeEvalResult(1));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Edge cases — response_id/request_id patterns
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Provider ID format", () => {
  it("accepts valid response_id with hyphens/underscores", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.response_id = "modr-A1b2_C3d4-E5f6";
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
  });

  it("rejects empty response_id", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.response_id = "";
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects response_id > 200 chars", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    provider.response_id = "a".repeat(201);
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Object identity reuse across multiple media
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Cross-media object reuse", () => {
  it("rejects object_id reused across two different media entries", () => {
    const snapshot = makeSnapshot(2);
    // Make media[1].thumb share object_id with media[0].original
    snapshot.media[1].thumb.object_id = snapshot.media[0].original.object_id;
    const checks = makeChecks(snapshot);
    const err = expectFail({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(getCustomIssues(err)).toContain("OBJECT_REUSE");
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Negative display_order / listing_revision
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Nonnegative constraints", () => {
  it("rejects negative display_order", () => {
    const snapshot = makeSnapshot(1);
    snapshot.media[0].display_order = -1;
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative listing_revision", () => {
    const snapshot = makeSnapshot(1);
    snapshot.listing_revision = -1;
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks: makeChecks(snapshot),
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("accepts listing_revision = 0", () => {
    expectPass(makeEvalResult(1));
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Checks array bounds
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Checks array bounds", () => {
  it("rejects more than 24 checks", () => {
    // Build an 8-image evaluation (24 checks) then add one extra
    const snapshot = makeSnapshot(8);
    const checks = makeChecks(snapshot);
    // Add an extra (which will also trigger UNEXPECTED_OR_DUPLICATE_CHECK,
    // but the .max(24) Zod constraint fires first or alongside)
    checks.push({
      check_id: "rule_prohibited_item_wording",
      target: { kind: "text", field: "title" },
      input_sha256: snapshot.title_sha256,
      state: "passed",
      reason_codes: [],
      retryable: false,
      provider: null,
    });
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 24 checks (8 images)", () => {
    const snapshot = makeSnapshot(8);
    const checks = makeChecks(snapshot);
    expect(checks).toHaveLength(24);
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
  });

  it("accepts exactly 10 checks (1 image)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    expect(checks).toHaveLength(10);
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Discriminated union enforcement
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Discriminated union", () => {
  it("rejects unknown phase", () => {
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "unknown_phase",
    });
    expect(result.success).toBe(false);
  });

  it("rejects early phase with evaluation outcome", () => {
    const data = makeEarlyInvalid();
    (data as Record<string, unknown>).outcome = "no_review_flags";
    const result = ModerationResultV2Schema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects evaluation phase with invalid_input outcome", () => {
    const result = ModerationResultV2Schema.safeParse(
      makeEvalResult(1, { outcome: "invalid_input" } as never),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Multiple flags and mixed states
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Mixed states and multiple flags", () => {
  it("flags + failures → checks_incomplete (not needs_review)", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot, {
      flagText: ["rule_prohibited_item_wording:title"],
      failChecks: ["openai_text_v2:description"],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "checks_incomplete",
    });
  });

  it("all checks passed → no_review_flags", () => {
    expectPass(makeEvalResult(1));
  });

  it("multiple flagged checks across rules and provider → needs_review", () => {
    const snapshot = makeSnapshot(1);
    const media = snapshot.media[0];
    const checks = makeChecks(snapshot, {
      flagText: [
        "rule_prohibited_item_wording:title",
        "openai_text_v2:description",
      ],
      flagImage: [`openai_image_v2:${media.media_id}`],
    });
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "needs_review",
    });
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Score bounds
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Score bounds", () => {
  it("rejects score > 1", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    const cats = provider.categories as Array<Record<string, unknown>>;
    cats[0].score = 1.5;
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("rejects score < 0", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    const cats = provider.categories as Array<Record<string, unknown>>;
    cats[0].score = -0.1;
    const result = ModerationResultV2Schema.safeParse({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
    expect(result.success).toBe(false);
  });

  it("accepts score = 0 and score = 1", () => {
    const snapshot = makeSnapshot(1);
    const checks = makeChecks(snapshot);
    const openaiCheck = checks.find(
      (c) => (c as Record<string, unknown>).check_id === "openai_text_v2",
    )! as Record<string, unknown>;
    const provider = openaiCheck.provider as Record<string, unknown>;
    const cats = provider.categories as Array<Record<string, unknown>>;
    cats[0].score = 0;
    cats[1].score = 1;
    expectPass({
      ...makeIdentity(),
      phase: "evaluation",
      snapshot,
      checks,
      outcome: "no_review_flags",
    });
  });
});

// ---------------------------------------------------------------------------
// Design Case Group: Evaluator version format
// ---------------------------------------------------------------------------

describe("Moderation V2 Contract — Evaluator version format", () => {
  it("accepts v2.0.0", () => {
    expectPass(makeEvalResult(1, { evaluator_version: "v2.0.0" } as never));
  });

  it("accepts v2.1.23", () => {
    expectPass(makeEvalResult(1, { evaluator_version: "v2.1.23" } as never));
  });

  it("rejects v1.0.0 (not v2.x.y)", () => {
    const result = ModerationResultV2Schema.safeParse(
      makeEvalResult(1, { evaluator_version: "v1.0.0" } as never),
    );
    expect(result.success).toBe(false);
  });

  it("rejects version without v prefix", () => {
    const result = ModerationResultV2Schema.safeParse(
      makeEvalResult(1, { evaluator_version: "2.0.0" } as never),
    );
    expect(result.success).toBe(false);
  });
});
