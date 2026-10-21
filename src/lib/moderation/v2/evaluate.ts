import { moderationInputSchema } from "../contract";
import * as rules from "../rules";
import { CONTRACT_VERSION, POLICY, MODEL, CATEGORIES, FS_IDS, ModerationResultV2Schema,
  SnapshotV2Schema, type EvaluationResultV2, type ModerationResultV2, type SnapshotV2 } from "./contract";
import type { moderateOpenAI } from "./openai";

type Check = EvaluationResultV2["checks"][number];
type ProviderResult = Awaited<ReturnType<typeof moderateOpenAI>>;
type Identity = Pick<EvaluationResultV2, "request_id" | "attempt_id" | "evaluated_at">;
type Observation = {
  snapshot_sha256: string;
  input_sha256: string;
  result: ProviderResult;
};
type ImageEvidence = {
  media_id: string;
  canonicalWebp: Uint8Array;
  // From the separately trusted sealer/registry, NOT inferred from a byte hash.
  integrity?: { snapshot_sha256: string; sealed_media: SnapshotV2["media"][number]; check: Check };
};
type Input = Identity & {
  listing_id: string; listing_revision: number; generation_id: string;
  title: unknown; description: unknown;
  snapshot?: SnapshotV2;
  images?: readonly ImageEvidence[];
  observations?: readonly Observation[];
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
const hashText = (text: string) => sha256(new TextEncoder().encode(text));
function mediaIdentity(media: SnapshotV2["media"][number]): string {
  const objects = [media.original, media.canonical, media.thumb, media.medium, media.large];
  return JSON.stringify([media.media_id, media.asset_version, media.display_order, media.source_sha256, media.recipe,
    ...objects.map(o => [o.object_id, o.sha256, o.bytes, o.width, o.height])]);
}
const sameTarget = (a: Check["target"], b: ProviderResult["target"]) =>
  a.kind === "text" ? b.kind === "text" && a.field === b.field
    : b.kind === "image" && a.media_id === b.imageId;
function failed(check: Check, reason: Check["reason_codes"][number], retryable = false): Check {
  return { ...check, state: "failed", reason_codes: [...new Set([...check.reason_codes, reason])], retryable };
}
const reasonMap = {
  PROVIDER_TIMEOUT: "TIMEOUT", PROVIDER_RATE_LIMIT: "RATE_LIMIT", PROVIDER_TRANSPORT: "TRANSPORT",
  PROVIDER_5XX: "PROVIDER_5XX", PROVIDER_AUTH: "PROVIDER_AUTH", PROVIDER_INPUT: "PROVIDER_INPUT",
  PROVIDER_SCHEMA: "PROVIDER_SCHEMA",
} as const;

/** Pure evidence assembly: no HTTP, Storage, clocks, env, DB, retries or publication.
 * Trusted callers must bind observations and sealer evidence to the exact snapshot.
 * Hash agreement alone never certifies decoding, metadata stripping or immutability.
 * Invalid envelope/snapshot shapes throw sanitized errors; they cannot be serialized
 * as a valid V2 evaluation without a valid identity and snapshot.
 */
export async function evaluateModerationV2(input: Input): Promise<ModerationResultV2> {
  const identity = { contract_version: CONTRACT_VERSION, policy_version: POLICY, evaluator_version: "v2.0.0",
    request_id: input.request_id, attempt_id: input.attempt_id, evaluated_at: input.evaluated_at };
  const titleHash = typeof input.title === "string" ? await hashText(input.title) : null;
  const descriptionHash = typeof input.description === "string" ? await hashText(input.description) : null;
  const validation = moderationInputSchema.safeParse({ title: input.title, description: input.description });
  const finish = (value: unknown): ModerationResultV2 => {
    const parsed = ModerationResultV2Schema.safeParse(value);
    if (!parsed.success) throw new Error("INVALID_V2_EVALUATION");
    return parsed.data;
  };
  if (!validation.success) {
    const errors: Array<{ field: "title" | "description"; code: "TYPE" | "TOO_SHORT" | "TOO_LONG" }> = [];
    for (const field of ["title", "description"] as const) {
      const value = input[field];
      const min = field === "title" ? 3 : 10;
      const max = field === "title" ? 150 : 5000;
      if (typeof value !== "string") errors.push({ field, code: "TYPE" });
      else if (value.trim().length < min) errors.push({ field, code: "TOO_SHORT" });
      else if (value.trim().length > max) errors.push({ field, code: "TOO_LONG" });
    }
    return finish({ ...identity, phase: "input_validation", outcome: "invalid_input",
      listing_id: input.listing_id, listing_revision: input.listing_revision, generation_id: input.generation_id,
      title_sha256: titleHash, description_sha256: descriptionHash, validation_errors: errors });
  }
  const parsedSnapshot = SnapshotV2Schema.safeParse(input.snapshot);
  if (!parsedSnapshot.success) throw new Error("INVALID_V2_SNAPSHOT");
  const snapshot = parsedSnapshot.data;
  const expectedSnapshotHash = await hashText(JSON.stringify(["fairswap:v2:snapshot_v1", CONTRACT_VERSION,
    POLICY, snapshot.listing_id, snapshot.listing_revision, snapshot.generation_id,
    snapshot.title_sha256, snapshot.description_sha256, snapshot.media_manifest_sha256]));
  const contextMatches = snapshot.listing_id === input.listing_id
    && snapshot.listing_revision === input.listing_revision && snapshot.generation_id === input.generation_id
    && snapshot.snapshot_sha256 === expectedSnapshotHash;
  const observations = input.observations ?? [];
  const images = input.images ?? [];
  // Extra evidence must not be silently ignored or attributed to an expected target.
  if (images.some(i => !snapshot.media.some(m => m.media_id === i.media_id))
    || observations.some(o => {
      const target = o.result.target;
      if (!target) return true;
      if (target.kind === "text") return target.field !== "title" && target.field !== "description";
      if (target.kind === "image") return !snapshot.media.some(m => m.media_id === target.imageId);
      return true;
    })) {
    throw new Error("UNEXPECTED_V2_EVIDENCE");
  }
  const checks: Check[] = [];
  function base(check_id: Check["check_id"], target: Check["target"], digest: string): Check {
    return { check_id, target, input_sha256: digest, state: "passed", reason_codes: [], retryable: false, provider: null };
  }
  function providerCheck(target: Check["target"], digest: string): Check {
    let check = base(target.kind === "text" ? "openai_text_v2" : "openai_image_v2", target, digest);
    const matches = observations.filter(o => sameTarget(target, o.result.target));
    if (matches.length !== 1) return failed(check, "PROVIDER_SCHEMA", true);
    const observation = matches[0];
    if (observation.input_sha256 !== digest || observation.snapshot_sha256 !== snapshot.snapshot_sha256) {
      return failed(check, "DIGEST_MISMATCH");
    }
    const result = observation.result;
    if (!result.ok) {
      const reason = reasonMap[result.code];
      return failed(check, reason, ["TIMEOUT", "RATE_LIMIT", "TRANSPORT", "PROVIDER_5XX", "PROVIDER_SCHEMA"].includes(reason));
    }
    check = { ...check, state: result.flagged ? "flagged" : "passed",
      reason_codes: result.flagged ? ["PROVIDER_FLAG"] : [],
      provider: { name: "openai", requested_model: MODEL, returned_model: result.model,
        response_id: result.responseId, request_id: result.requestId, flagged: result.flagged,
        categories: CATEGORIES.map(category => {
          const finding = result.findings.find(f => f.category === category);
          if (!finding) throw new Error("INVALID_V2_PROVIDER_EVIDENCE");
          return { category, applicability: finding.applicable ? "evaluated" : "not_applicable",
            flagged: finding.flag, score: finding.score };
        }) } };
    // Validate mapped provider semantics using the canonical schema, below.
    return check;
  }
  const runners = [rules.evaluateProhibitedItemWording, rules.evaluateShortenedLinks, rules.evaluatePaymentBeforeViewing];
  const localReasons = ["PROHIBITED_WORDING", "SHORTENED_LINK", "PAYMENT_BEFORE_VIEWING"] as const;
  for (const field of ["title", "description"] as const) {
    const target = { kind: "text", field } as const;
    const digest = field === "title" ? snapshot.title_sha256 : snapshot.description_sha256;
    const actualHash = field === "title" ? titleHash : descriptionHash;
    for (let index = 0; index < FS_IDS.length; index++) {
      let check = base(FS_IDS[index], target, digest);
      try {
        if (runners[index](validation.data[field], field)) {
          check = { ...check, state: "flagged", reason_codes: [localReasons[index]] };
        }
      } catch {
        // The approved schema has no local-rule execution error code. Missing
        // coverage expresses incomplete execution without inventing a reason.
        continue;
      }
      if (actualHash !== digest || !contextMatches) check = failed(check, "DIGEST_MISMATCH");
      checks.push(check);
    }
    let check = providerCheck(target, digest);
    if (actualHash !== digest || !contextMatches) check = failed(check, "DIGEST_MISMATCH");
    checks.push(check);
  }
  for (const media of snapshot.media) {
    const target = { kind: "image", media_id: media.media_id } as const;
    const matches = images.filter(i => i.media_id === media.media_id);
    const image = matches.length === 1 ? matches[0] : undefined;
    let integrity = base("image_integrity_v2", target, media.canonical.sha256);
    const supplied = image?.integrity;
    if (supplied && supplied.snapshot_sha256 === snapshot.snapshot_sha256
      && mediaIdentity(supplied.sealed_media) === mediaIdentity(media)
      && supplied.check.check_id === "image_integrity_v2" && supplied.check.target.kind === "image"
      && supplied.check.target.media_id === media.media_id && supplied.check.input_sha256 === media.canonical.sha256) {
      integrity = structuredClone(supplied.check);
    } else integrity = failed(integrity, "SEAL_INVALID");
    const bytesMatch = image?.canonicalWebp instanceof Uint8Array
      && image.canonicalWebp.length === media.canonical.bytes
      && await sha256(image.canonicalWebp) === media.canonical.sha256;
    if (!bytesMatch || !contextMatches) integrity = failed(integrity, "DIGEST_MISMATCH");
    checks.push(integrity);
    let provider = providerCheck(target, media.canonical.sha256);
    if (!contextMatches || !bytesMatch) provider = failed(provider, "DIGEST_MISMATCH");
    if (integrity.state !== "passed") provider = failed(provider, "SEAL_INVALID");
    checks.push(provider);
  }
  const outcome = checks.length !== 8 + 2 * snapshot.media.length || checks.some(c => c.state === "failed") ? "checks_incomplete"
    : checks.some(c => c.state === "flagged") ? "needs_review" : "no_review_flags";
  return finish({ ...identity, phase: "evaluation", snapshot, checks, outcome });
}
