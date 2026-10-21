// Synthetic offline input validator checks; no secrets, media or network.
// Node 24+ strips TypeScript types natively when importing the module.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateV2TextFields } from "../../src/lib/moderation/v2/input-validation.ts";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const cleanTitle = "Local bicycle for sale";
const cleanDescription = "Lightly used bicycle with local pickup after inspection.";
const validate = (...args) =>
  validateV2TextFields(args.length >= 1 ? args[0] : cleanTitle,
    args.length >= 2 ? args[1] : cleanDescription);

for (const [name, title, expected] of [
  ["missing title", undefined, "TYPE"],
  ["null title", null, "TYPE"],
  ["numeric title", 10, "TYPE"],
  ["boxed string title", new String("abc"), "TYPE"],
  ["array title", ["abc"], "TYPE"],
  ["object title", { text: "abc" }, "TYPE"],
  ["boolean title", false, "TYPE"],
  ["empty title", "", "TOO_SHORT"],
  ["whitespace-only title", "      ", "TOO_SHORT"],
  ["two-character title", "ab", "TOO_SHORT"],
  ["overlong title", "x".repeat(151), "TOO_LONG"],
  ["Unicode trim title", " \u00a0ab\u00a0 ", "TOO_SHORT"],
  ["BOM trim title", "\ufeffab\ufeff", "TOO_SHORT"],
  ["ideographic whitespace trim title", "\u3000ab\u3000", "TOO_SHORT"],
  ["astral emoji title counts as 2 UTF-16 units", "😀", "TOO_SHORT"],
  ["76 emoji title counts as 152 units", "😀".repeat(76), "TOO_LONG"],
]) {
  test(`title: ${name}`, async () => {
    const value = await validate(title);
    assert.equal(value.status, "invalid");
    assert.deepEqual(value.validation_errors, [{ field: "title", code: expected }]);
    assert.equal(value.title_sha256, typeof title === "string" ? sha(title) : null);
    assert.equal(value.description_sha256, sha(cleanDescription));
  });
}

for (const [name, description, expected] of [
  ["missing description", undefined, "TYPE"],
  ["null description", null, "TYPE"],
  ["numeric description", 500, "TYPE"],
  ["short description", "123456789", "TOO_SHORT"],
  ["overlong description", "x".repeat(5001), "TOO_LONG"],
  ["4 emoji are only 8 UTF-16 units", "😀".repeat(4), "TOO_SHORT"],
  ["over 2500 emoji", "😀".repeat(2501), "TOO_LONG"],
]) {
  test(`description: ${name}`, async () => {
    const value = await validate(cleanTitle, description);
    assert.equal(value.status, "invalid");
    assert.deepEqual(value.validation_errors, [{ field: "description", code: expected }]);
    assert.equal(value.description_sha256, typeof description === "string" ? sha(description) : null);
  });
}

test("both fields valid at exact lower bounds", async () => {
  const v = await validate("abc", "1234567890");
  assert.equal(v.status, "valid");
  assert.deepEqual(v.validation_errors, []);
});

test("both fields valid at exact upper bounds", async () => {
  const v = await validate("a".repeat(150), "d".repeat(5000));
  assert.equal(v.status, "valid");
});

test("emoji pair and ASCII make minimum 3 title UTF-16 code units", async () => {
  assert.equal((await validate("😀a")).status, "valid");
  assert.equal((await validate("😀".repeat(75))).status, "valid");
  assert.equal((await validate(cleanTitle, "😀".repeat(5))).status, "valid");
});

test("Hindi, Hinglish and currency symbols are not inherently invalid", async () => {
  const v = await validate("बाइक ₹500", "Local meetup and inspection ke baad payment.");
  assert.equal(v.status, "valid");
  assert.equal(v.title_sha256, sha("बाइक ₹500"));
});

test("titles are case-sensitive exact-byte hashes, not normalized", async () => {
  const a = await validate("Bike");
  const b = await validate("bike");
  assert.notEqual(a.title_sha256, b.title_sha256);
});

test("composed and decomposed Unicode yield distinct input hashes", async () => {
  const a = await validate("Café");
  const b = await validate("Cafe\u0301");
  assert.equal(a.status, "valid");
  assert.equal(b.status, "valid");
  assert.notEqual(a.title_sha256, b.title_sha256);
});

test("leading spaces remain part of the SHA-256 input digest", async () => {
  const text = "   bike  ";
  const v = await validate(text);
  assert.equal(v.title_sha256, sha(text));
  assert.notEqual(v.title_sha256, sha(text.trim()));
  assert.equal(v.status, "valid");
});

test("exact TYPE before length, and no fabricated digest for nonstrings", async () => {
  const v = await validate(null, []);
  assert.deepEqual(v.validation_errors, [
    { field: "title", code: "TYPE" },
    { field: "description", code: "TYPE" },
  ]);
  assert.equal(v.title_sha256, null);
  assert.equal(v.description_sha256, null);
});

test("at most one error per field in stable title/description order", async () => {
  const v = await validate("  ", "  ");
  assert.deepEqual(v.validation_errors, [
    { field: "title", code: "TOO_SHORT" },
    { field: "description", code: "TOO_SHORT" },
  ]);
});

test("UTF-16 edge null surrogate fails closed (not mislabeled seller TYPE)", async () => {
  await assert.rejects(() => validate("bad\ud800"), /INVALID_UTF16_INPUT/);
  await assert.rejects(() => validate(cleanTitle, "bad\udc00"), /INVALID_UTF16_INPUT/);
});

test("valid surrogate pairs do not fail closed", async () => {
  assert.equal((await validate("😀😀", "ok local pickup after viewing")).status, "valid");
});

test("no input text, IDs, media or provider data in validation errors", async () => {
  const sensitive = "UPI 9876543210";
  const v = await validate(sensitive, "too short");
  const serialized = JSON.stringify(v);
  assert.ok(!serialized.includes(sensitive));
  assert.ok(!serialized.includes("media"));
  assert.ok(!serialized.includes("provider"));
  assert.deepEqual(Object.keys(v).sort(), [
    "status", "title_sha256", "description_sha256", "validation_errors",
  ].sort());
});

test("the result and error list are immutable", async () => {
  const v = await validate("ab", "short");
  assert.equal(Object.isFrozen(v), true);
  assert.equal(Object.isFrozen(v.validation_errors), true);
  assert.equal(Object.isFrozen(v.validation_errors[0]), true);
});

test("zero-width space is NOT trimmed by the ECMAScript trim algorithm", async () => {
  const v = await validate("\u200b\u200b\u200b");
  assert.equal(v.status, "valid");
});

// Explicit absence of side-effect affordances: TypeScript source should remain
// a portable pure helper and must not import network, storage, or auth clients.
test("validation module has no network or storage imports", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/lib/moderation/v2/input-validation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:fetch|axios|openai|supabase\.rpc|XMLHttpRequest)\s*\(/);
  assert.doesNotMatch(source, /\b(?:from|import)\s*["'](?:node:)?(?:fs|http|https)/);
});
