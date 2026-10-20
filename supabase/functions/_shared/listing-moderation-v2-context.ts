import { z } from "zod";
import {
  type EvaluationResultV2,
  ModerationResultV2Schema,
} from "../../../src/lib/moderation/v2/contract";
import type { WorkerClaim } from "./listing-moderation-v2-worker.ts";
const hash = z.string().regex(/^[0-9a-f]{64}$/), id = z.string().uuid();
export const CanonicalLocator = z.object({
  media_id: id,
  asset_version: id,
  object_id: id,
  bucket: z.literal("listing-originals"),
  logical_key: z.string().max(512),
  sha256: hash,
  bytes: z.number().int().min(1).max(5 * 1024 * 1024),
  width: z.number().int().min(1).max(8000),
  height: z.number().int().min(1).max(8000),
  recipe: z.literal("seal_v1"),
}).strict();
export const WorkerContext = z.object({
  success: z.literal(true),
  request_id: id,
  attempt_id: id,
  snapshot_sha256: hash,
  evaluator_build: hash,
  lease_expires_at: z.string().datetime({ offset: true }),
  provider_work_until: z.string().datetime({ offset: true }),
  prior_checks: z.array(
    z.object({
      attempt_id: id,
      attempt_number: z.number().int().min(1).max(3),
      check: z.unknown(),
      retry_after_seconds: z.number().int().min(0).max(86400).nullable(),
      recorded_at: z.string().datetime({ offset: true }),
    }).strict(),
  ).max(90),
  reserved_calls: z.array(
    z.object({
      attempt_id: id,
      check_key: z.string().max(200),
      input_sha256: hash,
      start_number: z.number().int().min(1).max(3),
      deadline: z.string().datetime({ offset: true }),
    }).strict(),
  ).max(30),
  canonical_objects: z.array(CanonicalLocator).min(1).max(8),
}).strict();
export type ReadContext = z.infer<typeof WorkerContext>;
export type Locator = z.infer<typeof CanonicalLocator>;
export function readContext(raw: unknown, c: WorkerClaim): ReadContext {
  const x = WorkerContext.parse(raw);
  if (
    x.request_id !== c.request_id || x.attempt_id !== c.attempt_id ||
    x.snapshot_sha256 !== c.snapshot.snapshot_sha256 ||
    x.evaluator_build !== c.evaluator_build ||
    x.canonical_objects.length !== c.snapshot.media.length
  ) throw Error("READ_CONTEXT_MISMATCH");
  for (const m of c.snapshot.media) {
    const objects = x.canonical_objects.filter((o) =>
      o.media_id === m.media_id
    );
    if (objects.length !== 1) throw Error("READ_OBJECT_MISMATCH");
    const o = objects[0];
    if (
      o.asset_version !== m.asset_version ||
      JSON.stringify([o.object_id, o.sha256, o.bytes, o.width, o.height]) !==
        JSON.stringify([
          m.canonical.object_id,
          m.canonical.sha256,
          m.canonical.bytes,
          m.canonical.width,
          m.canonical.height,
        ]) ||
      o.logical_key !==
        `${c.snapshot.listing_id}/${m.media_id}/v2/${m.asset_version}/${m.canonical.sha256}/canonical.webp`
    ) throw Error("READ_OBJECT_MISMATCH");
  }
  return x;
}
export function priorChecks(
  context: ReadContext,
  c: WorkerClaim,
): EvaluationResultV2["checks"] {
  const selected = new Map<string, EvaluationResultV2["checks"][number]>();
  for (const row of context.prior_checks) {
    if (row.attempt_number > c.attempt_number) throw Error("FUTURE_CHECKPOINT");
    const p = ModerationResultV2Schema.parse({
      contract_version: "2.0.0",
      policy_version: "fairswap_moderation_v2.0.0",
      evaluator_version: "v2.0.0",
      request_id: c.request_id,
      attempt_id: row.attempt_id,
      evaluated_at: row.recorded_at,
      phase: "evaluation",
      snapshot: c.snapshot,
      checks: [row.check],
      outcome: "checks_incomplete",
    });
    if (p.phase !== "evaluation") throw Error("INVALID_CHECKPOINT");
    const check = p.checks[0];
    if (
      check.check_id !== "openai_text_v2" &&
      check.check_id !== "openai_image_v2"
    ) continue;
    // Failed work is retried only if no provider flag was recorded. A failed check
    // carrying provider flags stays failed and is never re-run to seek a clean result.
    if (check.state === "failed" && check.provider?.flagged !== true) continue;
    const key = JSON.stringify([check.check_id, check.target]);
    const old = selected.get(key);
    if (old?.provider?.flagged) {
      if (
        check.provider?.flagged &&
        JSON.stringify(old.provider.categories) !==
          JSON.stringify(check.provider.categories)
      ) throw Error("CONFLICTING_FLAG_HISTORY");
      continue;
    }
    if (
      !context.reserved_calls.some((s) =>
        s.input_sha256 === check.input_sha256 &&
        s.check_key.startsWith(check.check_id + ":") &&
        JSON.stringify(
            JSON.parse(s.check_key.slice(s.check_key.indexOf(":") + 1)),
          ) === JSON.stringify(check.target)
      )
    ) {
      // JSONB key ordering differs from JS insertion order; compare normalized keys below.
      const target = JSON.stringify(Object.entries(check.target).sort());
      if (
        !context.reserved_calls.some((s) =>
          s.input_sha256 === check.input_sha256 &&
          s.check_key.startsWith(check.check_id + ":") &&
          JSON.stringify(
              Object.entries(
                JSON.parse(s.check_key.slice(s.check_key.indexOf(":") + 1)),
              ).sort(),
            ) === target
        )
      ) throw Error("UNRESERVED_PRIOR_CHECKPOINT");
    }
    selected.set(key, check);
  }
  return [...selected.values()];
}
