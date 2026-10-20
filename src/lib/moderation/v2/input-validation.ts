/**
 * FairSwap Moderation V2 — deterministic scalar text validation.
 *
 * Backend-only pure computation. This is NOT an RPC or a ModerationResultV2
 * envelope: DB-created request/attempt/lease identities must be bound later.
 * No I/O except the platform's local WebCrypto digest; no provider requests.
 *
 * The exact unmodified UTF-8 bytes of each string are hashed even when its
 * trimmed length is invalid. Missing/non-string fields have null digests.
 */

export type TextFieldV2 = "title" | "description";
export type TextErrorCodeV2 = "TYPE" | "TOO_SHORT" | "TOO_LONG";
export type TextValidationErrorV2 = Readonly<{
  field: TextFieldV2;
  code: TextErrorCodeV2;
}>;

export type V2TextValidation = Readonly<{
  status: "valid" | "invalid";
  title_sha256: string | null;
  description_sha256: string | null;
  validation_errors: readonly TextValidationErrorV2[];
}>;

const LIMITS = Object.freeze({
  title: Object.freeze({ min: 3, max: 150 }),
  description: Object.freeze({ min: 10, max: 5000 }),
});

/**
 * PostgreSQL UTF-8 text cannot represent isolated UTF-16 surrogates.
 * Reject them instead of silently hashing TextEncoder's replacement bytes;
 * malformed Unicode is operational uncertainty, not a seller TYPE error.
 */
function assertWellFormedUtf16(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("INVALID_UTF16_INPUT");
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("INVALID_UTF16_INPUT");
    }
  }
}

async function sha256ExactUtf8(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("CRYPTO_UNAVAILABLE");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function validateField(
  field: TextFieldV2,
  value: unknown
): Promise<Readonly<{ sha256: string | null; error: TextValidationErrorV2 | null }>> {
  if (typeof value !== "string") {
    return { sha256: null, error: { field, code: "TYPE" } };
  }

  assertWellFormedUtf16(value);
  // Deliberately JS trim() and UTF-16 .length: this matches V1's Zod 3.24.2
  // constraints, including Hindi, emoji and ECMAScript edge whitespace.
  const trimmedLength = value.trim().length;
  const { min, max } = LIMITS[field];
  const error: TextValidationErrorV2 | null =
    trimmedLength < min
      ? { field, code: "TOO_SHORT" }
      : trimmedLength > max
        ? { field, code: "TOO_LONG" }
        : null;
  return { sha256: await sha256ExactUtf8(value), error };
}

/**
 * Return deterministic private validation facts in title/description order.
 * DB must independently recompute these facts against authoritative stored
 * input; this helper cannot authorize review, rejection or publication.
 */
export async function validateV2TextFields(
  title: unknown,
  description: unknown
): Promise<V2TextValidation> {
  const [t, d] = await Promise.all([
    validateField("title", title),
    validateField("description", description),
  ]);
  const errors = [t.error, d.error].filter(
    (error): error is TextValidationErrorV2 => error !== null
  ).map((error) => Object.freeze(error));
  return Object.freeze({
    status: errors.length ? "invalid" : "valid",
    title_sha256: t.sha256,
    description_sha256: d.sha256,
    validation_errors: Object.freeze(errors),
  });
}
