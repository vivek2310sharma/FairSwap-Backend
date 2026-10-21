/**
 * FairSwap Moderation V2 — Shared Contract
 *
 * Contract version 2.0.0, policy `fairswap_moderation_v2.0.0`.
 *
 * Authoritative specification: docs/moderation/MODERATION_V2_CONTRACT.md
 * This module is the SOLE normative TypeScript/Zod representation.
 *
 * Point 3 (FairSwap-Backend-Approval) is the exclusive owner.
 * Point 2 (Codex/OpenAI adapter) consumes but never edits this file.
 *
 * @module
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Contract version. */
export const CONTRACT_VERSION = "2.0.0" as const;

/** Approved policy identifier. */
export const POLICY = "fairswap_moderation_v2.0.0" as const;

/** CTO-approved initial pinned model. No latest-alias fallback. */
export const MODEL = "omni-moderation-2024-09-26" as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 digest (64 chars). */
const Hash = z.string().regex(/^[0-9a-f]{64}$/);

/** Lowercase UUID v4 with hyphens. */
const UUID = z.string().uuid().regex(/^[0-9a-f-]+$/);

// ---------------------------------------------------------------------------
// Check IDs
// ---------------------------------------------------------------------------

/** Three existing FairSwap local moderation rules, unchanged from V1. */
export const FS_IDS = [
  "rule_prohibited_item_wording",
  "rule_shortened_link",
  "rule_payment_before_viewing",
] as const;

/** All six V2 check identifiers (three local + three provider/integrity). */
export const CHECK_IDS = [
  ...FS_IDS,
  "openai_text_v2",
  "image_integrity_v2",
  "openai_image_v2",
] as const;

// ---------------------------------------------------------------------------
// Category support matrix  (Section 4)
// ---------------------------------------------------------------------------

/**
 * All 13 OpenAI moderation categories in canonical order.
 * Text modality: all 13 required.
 * Image modality: only the 6 in IMAGE_CATEGORIES are required;
 * the remaining 7 are not_applicable.
 */
export const CATEGORIES = [
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "sexual",
  "sexual/minors",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "violence",
  "violence/graphic",
] as const;

/** Categories the pinned model supports for image modality. */
export const IMAGE_CATEGORIES: readonly string[] = [
  "sexual",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "violence",
  "violence/graphic",
];

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

const Reason = z.enum([
  "PROHIBITED_WORDING",
  "SHORTENED_LINK",
  "PAYMENT_BEFORE_VIEWING",
  "PROVIDER_FLAG",
  "UNSUPPORTED_MEDIA",
  "DIGEST_MISMATCH",
  "SEAL_INVALID",
  "TIMEOUT",
  "RATE_LIMIT",
  "PROVIDER_5XX",
  "TRANSPORT",
  "PROVIDER_SCHEMA",
  "PROVIDER_AUTH",
  "PROVIDER_INPUT",
  "LEASE_LOST",
]);

// ---------------------------------------------------------------------------
// Target (discriminated union)
// ---------------------------------------------------------------------------

const Target = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("text"), field: z.enum(["title", "description"]) })
    .strict(),
  z.object({ kind: z.literal("image"), media_id: UUID }).strict(),
]);

// ---------------------------------------------------------------------------
// Sealed image identity
// ---------------------------------------------------------------------------

const ObjectIdentity = z
  .object({
    object_id: UUID,
    sha256: Hash,
    bytes: z.number().int().min(1).max(5242880),
    width: z.number().int().min(1).max(8000),
    height: z.number().int().min(1).max(8000),
  })
  .strict();

const Media = z
  .object({
    media_id: UUID,
    asset_version: UUID,
    display_order: z.number().int().nonnegative(),
    source_sha256: Hash,
    recipe: z.literal("seal_v1"),
    original: ObjectIdentity,
    canonical: ObjectIdentity,
    thumb: ObjectIdentity,
    medium: ObjectIdentity,
    large: ObjectIdentity,
  })
  .strict();

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const SnapshotV2Schema = z
  .object({
    listing_id: UUID,
    listing_revision: z.number().int().nonnegative(),
    generation_id: UUID,
    canonicalization: z.literal("snapshot_v1"),
    title_sha256: Hash,
    description_sha256: Hash,
    media_manifest_sha256: Hash,
    snapshot_sha256: Hash,
    cover_media_id: UUID,
    media: z.array(Media).min(1).max(8),
  })
  .strict();

// ---------------------------------------------------------------------------
// Provider result categories
// ---------------------------------------------------------------------------

const Category = z
  .object({
    category: z.enum(CATEGORIES),
    applicability: z.enum(["evaluated", "not_applicable"]),
    flagged: z.boolean().nullable(),
    score: z.number().min(0).max(1).nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Provider envelope
// ---------------------------------------------------------------------------

const Provider = z
  .object({
    name: z.literal("openai"),
    requested_model: z.literal(MODEL),
    returned_model: z.literal(MODEL),
    response_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    request_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .nullable(),
    flagged: z.boolean(),
    categories: z.array(Category).length(13),
  })
  .strict();

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

const Check = z
  .object({
    check_id: z.enum(CHECK_IDS),
    target: Target,
    input_sha256: Hash,
    state: z.enum(["passed", "flagged", "failed"]),
    reason_codes: z.array(Reason).max(20),
    retryable: z.boolean(),
    provider: Provider.nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Semantic refinement lookup tables
// ---------------------------------------------------------------------------

/** Allowed flag reason codes per local check ID. */
const localFlags: Record<string, readonly string[]> = {
  rule_prohibited_item_wording: ["PROHIBITED_WORDING"],
  rule_shortened_link: ["SHORTENED_LINK"],
  rule_payment_before_viewing: ["PAYMENT_BEFORE_VIEWING"],
};

/** Transient failure reasons eligible for retry. */
const transient: readonly string[] = [
  "TIMEOUT",
  "RATE_LIMIT",
  "PROVIDER_5XX",
  "TRANSPORT",
  "PROVIDER_SCHEMA",
];

/** All failure reason codes (transient + permanent). */
const failures: readonly string[] = [
  ...transient,
  "UNSUPPORTED_MEDIA",
  "DIGEST_MISMATCH",
  "SEAL_INVALID",
  "PROVIDER_AUTH",
  "PROVIDER_INPUT",
  "LEASE_LOST",
];

// ---------------------------------------------------------------------------
// Shared identity fields
// ---------------------------------------------------------------------------

const Identity = {
  contract_version: z.literal("2.0.0"),
  policy_version: z.literal(POLICY),
  evaluator_version: z.string().regex(/^v2\.[0-9]+\.[0-9]+$/),
  request_id: UUID,
  attempt_id: UUID,
  evaluated_at: z.string().datetime({ offset: true }),
};

// ---------------------------------------------------------------------------
// Early invalid-input envelope (no snapshot, no media, no checks)
// ---------------------------------------------------------------------------

export const EarlyInvalidResultV2Schema = z
  .object({
    ...Identity,
    phase: z.literal("input_validation"),
    outcome: z.literal("invalid_input"),
    listing_id: UUID,
    listing_revision: z.number().int().nonnegative(),
    generation_id: UUID,
    title_sha256: Hash.nullable(),
    description_sha256: Hash.nullable(),
    validation_errors: z
      .array(
        z
          .object({
            field: z.enum(["title", "description"]),
            code: z.enum(["TYPE", "TOO_SHORT", "TOO_LONG"]),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();

// ---------------------------------------------------------------------------
// Evaluation result envelope (full snapshot + checks)
// ---------------------------------------------------------------------------

export const EvaluationResultV2Schema = z
  .object({
    ...Identity,
    phase: z.literal("evaluation"),
    snapshot: SnapshotV2Schema,
    checks: z.array(Check).max(24),
    outcome: z.enum(["no_review_flags", "needs_review", "checks_incomplete"]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Top-level discriminated union + superRefine invariants
// ---------------------------------------------------------------------------

export const ModerationResultV2Schema = z
  .discriminatedUnion("phase", [
    EarlyInvalidResultV2Schema,
    EvaluationResultV2Schema,
  ])
  .superRefine((r, ctx) => {
    const bad = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    // -----------------------------------------------------------------------
    // Early input_validation invariants
    // -----------------------------------------------------------------------
    if (r.phase === "input_validation") {
      // No duplicate field errors
      if (
        new Set(r.validation_errors.map((e) => e.field)).size !==
        r.validation_errors.length
      )
        bad("DUPLICATE_FIELD_ERROR");

      // TYPE ? null digest binding
      for (const e of r.validation_errors) {
        const digest =
          e.field === "title" ? r.title_sha256 : r.description_sha256;
        if ((e.code === "TYPE") !== (digest === null))
          bad("VALIDATION_DIGEST_BINDING");
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Evaluation-phase invariants
    // -----------------------------------------------------------------------

    // Media membership / cover
    const media = new Map(r.snapshot.media.map((m) => [m.media_id, m]));
    if (
      media.size !== r.snapshot.media.length ||
      !media.has(r.snapshot.cover_media_id)
    )
      bad("MEDIA_MEMBERSHIP");

    // Media sort order: ascending (display_order, media_id)
    const sorted = [...r.snapshot.media].sort(
      (a, b) =>
        a.display_order - b.display_order ||
        (a.media_id < b.media_id ? -1 : a.media_id > b.media_id ? 1 : 0),
    );
    if (sorted.some((m, i) => m.media_id !== r.snapshot.media[i].media_id))
      bad("MEDIA_ORDER");

    // Original SHA-256 must match source_sha256
    for (const m of r.snapshot.media)
      if (m.original.sha256 !== m.source_sha256) bad("ORIGINAL_BINDING");

    // No object ID reuse across all five slots of all media
    const objects = r.snapshot.media.flatMap((m) => [
      m.original,
      m.canonical,
      m.thumb,
      m.medium,
      m.large,
    ]);
    if (new Set(objects.map((o) => o.object_id)).size !== objects.length)
      bad("OBJECT_REUSE");

    // Expected check coverage: 3 FS rules + openai_text per text field,
    // image_integrity + openai_image per media_id
    const expected = new Set<string>();
    for (const field of ["title", "description"] as const)
      for (const id of [...FS_IDS, "openai_text_v2"])
        expected.add(`${id}:text:${field}`);
    for (const id of media.keys())
      for (const check of ["image_integrity_v2", "openai_image_v2"])
        expected.add(`${check}:image:${id}`);

    const seen = new Set<string>();
    for (const c of r.checks) {
      const t = c.target;
      const key = `${c.check_id}:${t.kind}:${t.kind === "text" ? t.field : t.media_id}`;

      // No unexpected or duplicate checks
      if (!expected.has(key) || seen.has(key))
        bad("UNEXPECTED_OR_DUPLICATE_CHECK");
      seen.add(key);

      // Input SHA-256 must match the snapshot digest for the target
      const digest =
        t.kind === "text"
          ? t.field === "title"
            ? r.snapshot.title_sha256
            : r.snapshot.description_sha256
          : media.get(t.media_id)?.canonical.sha256;
      if (c.input_sha256 !== digest) bad("INPUT_BINDING");

      // No duplicate reason codes
      if (new Set(c.reason_codes).size !== c.reason_codes.length)
        bad("DUPLICATE_REASON");

      // Passed checks: no retryable, no reasons
      if (c.state === "passed" && (c.retryable || c.reason_codes.length))
        bad("PASS_WITH_ERROR");

      // Non-passed checks: must have at least one reason
      if (c.state !== "passed" && !c.reason_codes.length) bad("MISSING_REASON");

      // Only failed checks may be retryable
      if (c.state !== "failed" && c.retryable) bad("INVALID_RETRY");

      // Retryable checks: all reasons must be transient or PROVIDER_FLAG
      if (
        c.retryable &&
        !c.reason_codes.every(
          (x) => transient.includes(x) || x === "PROVIDER_FLAG",
        )
      )
        bad("NONRETRYABLE_REASON");

      // Provider data binding
      const isProvider =
        c.check_id === "openai_text_v2" || c.check_id === "openai_image_v2";
      if (!isProvider && c.provider !== null) bad("LOCAL_PROVIDER_DATA");
      if (isProvider && c.state !== "failed" && c.provider === null)
        bad("MISSING_PROVIDER");

      // Flag/failure reason validation
      const allowedFlags = isProvider
        ? ["PROVIDER_FLAG"]
        : (localFlags[c.check_id] ?? []);
      if (
        c.state === "flagged" &&
        !c.reason_codes.every((x) => allowedFlags.includes(x))
      )
        bad("INVALID_FLAG_REASON");
      if (
        c.state === "failed" &&
        (!c.reason_codes.some((x) => failures.includes(x)) ||
          !c.reason_codes.every(
            (x) => failures.includes(x) || allowedFlags.includes(x),
          ))
      )
        bad("INVALID_FAILURE_REASON");

      // Provider category invariants
      if (c.provider) {
        const cats = c.provider.categories;
        if (new Set(cats.map((x) => x.category)).size !== 13)
          bad("CATEGORY_MEMBERSHIP");

        for (const cat of cats) {
          const applies =
            t.kind === "text" || IMAGE_CATEGORIES.includes(cat.category);

          // Required/evaluated modality: must have evaluated + non-null flag/score
          if (
            applies &&
            (cat.applicability !== "evaluated" ||
              cat.flagged === null ||
              cat.score === null)
          )
            bad("MISSING_COVERAGE");

          // Not-applicable modality: must have not_applicable + null flag/score
          if (
            !applies &&
            (cat.applicability !== "not_applicable" ||
              cat.flagged !== null ||
              cat.score !== null)
          )
            bad("FALSE_IMAGE_COVERAGE");
        }

        // Provider aggregate flag must match evaluated category flags
        const flagged = cats.some(
          (x) => x.applicability === "evaluated" && x.flagged === true,
        );
        if (c.provider.flagged !== flagged) bad("PROVIDER_FLAG_CONFLICT");

        // Check state must align with provider flag (unless failed)
        if (c.state !== "failed" && (c.state === "flagged") !== flagged)
          bad("CHECK_FLAG_CONFLICT");
      }
    }

    // Outcome consistency
    const full = seen.size === expected.size;
    const failed = r.checks.some((c) => c.state === "failed");
    const flagged = r.checks.some((c) => c.state === "flagged");
    const outcome =
      !full || failed
        ? "checks_incomplete"
        : flagged
          ? "needs_review"
          : "no_review_flags";
    if (r.outcome !== outcome) bad("OUTCOME_CONFLICT");
  });

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type ModerationResultV2 = z.infer<typeof ModerationResultV2Schema>;
export type SnapshotV2 = z.infer<typeof SnapshotV2Schema>;
export type EarlyInvalidResultV2 = z.infer<typeof EarlyInvalidResultV2Schema>;
export type EvaluationResultV2 = z.infer<typeof EvaluationResultV2Schema>;
