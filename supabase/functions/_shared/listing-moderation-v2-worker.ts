import { z } from "zod";
import {
  type EvaluationResultV2,
  ModerationResultV2Schema,
  type SnapshotV2,
  SnapshotV2Schema,
} from "../../../src/lib/moderation/v2/contract";
import { evaluateModerationV2 } from "../../../src/lib/moderation/v2/evaluate";
import { moderateOpenAI } from "../../../src/lib/moderation/v2/openai";
import {
  type Locator,
  priorChecks,
  type ReadContext,
  readContext,
} from "./listing-moderation-v2-context.ts";

type Check = EvaluationResultV2["checks"][number];
type Input = Parameters<typeof evaluateModerationV2>[0];
type Image = NonNullable<Input["images"]>[number];
type Observation = NonNullable<Input["observations"]>[number];
const UUID = z.string().uuid().regex(/^[0-9a-f-]+$/);
const Claim = z.object({
  request_id: UUID,
  attempt_id: UUID,
  claim_token: z.string().regex(/^[0-9a-f]{64}$/),
  snapshot: SnapshotV2Schema,
  source_manifest: z.array(z.unknown()),
  original_title: z.string(),
  original_description: z.string(),
  evaluator_build: z.string().regex(/^[0-9a-f]{64}$/),
  lease_expires_at: z.string().datetime({ offset: true }),
  attempt_number: z.number().int().min(1).max(3),
}).strict();
export type WorkerClaim = z.infer<typeof Claim>;
export type WorkerDatabase = {
  claim(requestId: string, worker: string, build: string): Promise<unknown>;
  heartbeat(claim: WorkerClaim): Promise<unknown>;
  reserve(
    claim: WorkerClaim,
    check: "openai_text_v2" | "openai_image_v2",
    target: Check["target"],
    sha: string,
  ): Promise<unknown>;
  checkpoint(
    claim: WorkerClaim,
    check: Check,
    retryAfterSeconds: number | null,
  ): Promise<unknown>;
  finalize(claim: WorkerClaim, result: EvaluationResultV2): Promise<unknown>;
  getAttempt(claim: WorkerClaim): Promise<unknown>;
  readContext(claim: WorkerClaim): Promise<unknown>;
  terminal(claim: WorkerClaim, result: EvaluationResultV2): Promise<unknown>;
  recover(claim: WorkerClaim): Promise<unknown>;
};
export type WorkerDependencies = {
  db: WorkerDatabase;
  build: string;
  workerId: string;
  apiKey: string;
  transport: Parameters<typeof moderateOpenAI>[1]["transport"];
  now(): number;
  // Separately trusted registry/sealer resolver. Hash matching alone is NOT lineage evidence.
  // Must resolve opaque object IDs, never fetch caller-supplied paths/URLs, and honor abort.
  media(
    claim: WorkerClaim,
    media: SnapshotV2["media"][number],
    signal: AbortSignal,
    locator: Locator,
  ): Promise<Image>;
};
const ok = z.object({ success: z.literal(true) }).passthrough();
const terminalDecision = z.object({
  success: z.literal(true),
  decision: z.enum([
    "routed_to_admin",
    "awaiting_retry",
    "escalated_to_admin",
    "superseded",
  ]),
}).passthrough();
function stable(v: unknown): string {
  const normalize = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(normalize)
      : x !== null && typeof x === "object"
      ? Object.fromEntries(
        Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map((
          [k, v],
        ) => [k, normalize(v)]),
      )
      : x;
  return JSON.stringify(normalize(v));
}
function freezeEvidence<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const textHash = (s: string) => hash(new TextEncoder().encode(s));

/** One explicit C2 request; sequential calls (one in flight per admitted attempt).
 * No queue scans, trusted-role impersonation, publication, logging or live defaults.
 * DB owns global admission, three starts/check, retries, circuits and finalization.
 * An uncertain reserve/checkpoint/finalization stops: never resend a provider call.
 */
export async function runModerationV2(
  requestId: string,
  deps: WorkerDependencies,
): Promise<{ code: string }> {
  if (
    !UUID.safeParse(requestId).success || !/^[0-9a-f]{64}$/.test(deps.build) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(deps.workerId)
  ) return { code: "CONFIG_INVALID" };
  let claim: WorkerClaim;
  let context: ReadContext;
  let retained: Check[];
  try {
    const raw = await deps.db.claim(requestId, deps.workerId, deps.build);
    if (raw === null) return { code: "IDLE_OR_DISABLED" };
    const parsed = Claim.safeParse(raw);
    if (!parsed.success) return { code: "CLAIM_REJECTED" };
    claim = parsed.data;
    if (
      claim.request_id !== requestId || claim.evaluator_build !== deps.build
    ) return { code: "CLAIM_REJECTED" };
    const s = claim.snapshot;
    if (
      await textHash(claim.original_title) !== s.title_sha256 ||
      await textHash(claim.original_description) !== s.description_sha256 ||
      await textHash(JSON.stringify(claim.source_manifest)) !==
        s.media_manifest_sha256 ||
      await textHash(
          JSON.stringify([
            "fairswap:v2:snapshot_v1",
            "2.0.0",
            "fairswap_moderation_v2.0.0",
            s.listing_id,
            s.listing_revision,
            s.generation_id,
            s.title_sha256,
            s.description_sha256,
            s.media_manifest_sha256,
          ]),
        ) !== s.snapshot_sha256
    ) return { code: "SNAPSHOT_REJECTED" };
    // Validate the complete manifest against every opaque identity, order and cover.
    const mf = claim.source_manifest;
    if (
      mf.length !== 4 || mf[0] !== "fairswap:v2:manifest_v1" ||
      mf[1] !== s.listing_id || mf[2] !== s.cover_media_id ||
      !Array.isArray(mf[3]) || mf[3].length !== s.media.length
    ) return { code: "SNAPSHOT_REJECTED" };
    for (let i = 0; i < s.media.length; i++) {
      const m = s.media[i], row = mf[3][i];
      if (
        !Array.isArray(row) || row.length !== 15 || row[0] !== m.media_id ||
        row[1] !== m.display_order || row[2] !== "ready" ||
        !row.slice(3, 7).every((x) => typeof x === "string" && x.length > 0) ||
        row[7] !== m.source_sha256 || row[8] !== m.asset_version ||
        row[9] !== "seal_v1" ||
        JSON.stringify(row.slice(10)) !==
          JSON.stringify(
            [m.original, m.canonical, m.thumb, m.medium, m.large].map(
              (o) => [o.object_id, o.sha256, o.bytes, o.width, o.height],
            ),
          )
      ) return { code: "SNAPSHOT_REJECTED" };
    }
    context = readContext(await deps.db.readContext(claim), claim);
    retained = priorChecks(context, claim);
  } catch {
    return { code: "DATABASE_UNAVAILABLE" };
  }
  const started = deps.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 210_000);
  const images: Image[] = [], observations: Observation[] = [];
  let expiry = Math.min(
    Date.parse(claim.lease_expires_at),
    Date.parse(context.lease_expires_at),
  );
  const workUntil = Math.min(
    started + 210_000,
    Date.parse(context.provider_work_until),
  );
  for (const check of retained) {
    const p = check.provider;
    if (!p) throw Error("INVALID_RETAINED_PROVIDER");
    observations.push({
      snapshot_sha256: claim.snapshot.snapshot_sha256,
      input_sha256: check.input_sha256,
      result: {
        ok: true,
        target: check.target.kind === "text"
          ? check.target
          : { kind: "image", imageId: check.target.media_id },
        model: p.returned_model,
        responseId: p.response_id,
        requestId: p.request_id,
        flagged: p.flagged,
        findings: p.categories.map((c) =>
          c.applicability === "evaluated"
            ? {
              category: c.category,
              applicable: true as const,
              flag: c.flagged!,
              score: c.score!,
            }
            : {
              category: c.category,
              applicable: false as const,
              flag: null,
              score: null,
            }
        ),
      },
    });
  }
  const input = (): Input => ({
    request_id: requestId,
    attempt_id: claim.attempt_id,
    evaluated_at: new Date(deps.now()).toISOString(),
    listing_id: claim.snapshot.listing_id,
    listing_revision: claim.snapshot.listing_revision,
    generation_id: claim.snapshot.generation_id,
    title: claim.original_title,
    description: claim.original_description,
    snapshot: claim.snapshot,
    images,
    observations,
  });
  const budget = async () => {
    if (controller.signal.aborted || workUntil - deps.now() < 20_000) {
      throw Error("BUDGET");
    }
    if (expiry - deps.now() < 20_000) {
      const renewed = z.object({
        success: z.literal(true),
        lease_expires_at: z.string().datetime({ offset: true }),
      }).passthrough().parse(await deps.db.heartbeat(claim));
      expiry = Date.parse(renewed.lease_expires_at);
      if (expiry - deps.now() < 20_000) throw Error("LEASE");
    }
  };
  try {
    for (const m of claim.snapshot.media) {
      await budget();
      // A stalled resolver cannot retain the invocation indefinitely, even if
      // its implementation violates the required abort contract. Underlying
      // I/O cancellation still requires resolver/runtime verification.
      let abort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(Error("MEDIA_CANCELLED"));
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      let image: Image;
      try {
        image = await Promise.race([
          deps.media(
            claim,
            m,
            controller.signal,
            context.canonical_objects.find((o) => o.media_id === m.media_id)!,
          ),
          cancelled,
        ]);
      } finally {
        if (abort) controller.signal.removeEventListener("abort", abort);
      }
      if (
        image.media_id !== m.media_id ||
        image.canonicalWebp.length !== m.canonical.bytes ||
        await hash(image.canonicalWebp) !== m.canonical.sha256
      ) return { code: "MEDIA_REJECTED" };
      images.push(image);
    }
    // The approved evaluator validates all supplied trusted integrity evidence BEFORE any provider work.
    const preliminary = await evaluateModerationV2(input());
    if (
      preliminary.phase !== "evaluation" ||
      preliminary.checks.some((c) =>
        c.check_id === "image_integrity_v2" && c.state !== "passed"
      )
    ) return { code: "MEDIA_REJECTED" };
    const calls: Array<
      {
        input: Parameters<typeof moderateOpenAI>[0];
        target: Check["target"];
        digest: string;
        id: "openai_text_v2" | "openai_image_v2";
      }
    > = [];
    for (const field of ["title", "description"] as const) {
      calls.push({
        id: "openai_text_v2",
        target: { kind: "text", field },
        digest: claim
          .snapshot[
            field + "_sha256" as "title_sha256" | "description_sha256"
          ],
        input: {
          kind: "text",
          field,
          text: field === "title"
            ? claim.original_title
            : claim.original_description,
        },
      });
    }
    for (const image of images) {
      calls.push({
        id: "openai_image_v2",
        target: { kind: "image", media_id: image.media_id },
        digest: claim.snapshot.media.find((m) =>
          m.media_id === image.media_id
        )!.canonical.sha256,
        input: {
          kind: "image",
          imageId: image.media_id,
          canonicalWebp: image.canonicalWebp,
        },
      });
    }
    for (const call of calls) {
      if (
        retained.some((c) =>
          c.check_id === call.id &&
          JSON.stringify(c.target) === JSON.stringify(call.target)
        )
      ) continue;
      // A crash may have left a durable reservation without a checkpoint. Never
      // overlap its deadline or reset its generation-wide three-start budget.
      const reservations = context.reserved_calls.filter((r) =>
        r.input_sha256 === call.digest &&
        r.check_key.startsWith(call.id + ":") &&
        JSON.stringify(
            Object.entries(
              JSON.parse(r.check_key.slice(r.check_key.indexOf(":") + 1)),
            ).sort(),
          ) === JSON.stringify(Object.entries(call.target).sort())
      );
      if (
        reservations.some((r) => Date.parse(r.deadline) > deps.now()) ||
        reservations.length >= 3
      ) return { code: "RESERVATION_RECOVERY_REQUIRED" };
      await budget();
      ok.parse(await deps.db.reserve(claim, call.id, call.target, call.digest));
      // Recheck budget after SQL reservation; ambiguous reservation never leads to a blind retry.
      if (
        expiry - deps.now() < 20_000 || workUntil - deps.now() < 20_000
      ) return { code: "LEASE_OR_BUDGET_LOST" };
      const result = await moderateOpenAI(call.input, {
        apiKey: deps.apiKey,
        transport: deps.transport,
        timeoutMs: 15_000,
      });
      observations.push({
        snapshot_sha256: claim.snapshot.snapshot_sha256,
        input_sha256: call.digest,
        result,
      });
      const partial = await evaluateModerationV2(input());
      if (partial.phase !== "evaluation") throw Error("EVALUATION");
      const check = partial.checks.find((c) =>
        c.check_id === call.id &&
        JSON.stringify(c.target) === JSON.stringify(call.target)
      )!;
      const delay = !result.ok && result.code === "PROVIDER_RATE_LIMIT" &&
          result.retryAfterMs !== undefined
        ? Math.ceil(result.retryAfterMs / 1000)
        : null;
      ok.parse(await deps.db.checkpoint(claim, check, delay));
      // Retain flags already checkpointed; stop on failure and let DB select retry/escalation/circuit policy.
      if (!result.ok) break;
    }
    const result = await evaluateModerationV2(input());
    if (result.phase !== "evaluation") throw Error("EVALUATION");
    // Build a fresh envelope and revalidate AFTER selecting/merging evidence.
    // Missing observations mean unexecuted work, not fabricated schema errors.
    const checks = result.checks.filter((c) =>
      c.check_id !== "openai_text_v2" && c.check_id !== "openai_image_v2" ||
      observations.some((o) =>
        c.target.kind === "text"
          ? o.result.target.kind === "text" &&
            c.target.field === o.result.target.field
          : o.result.target.kind === "image" &&
            c.target.media_id === o.result.target.imageId
      )
    ).map((c) =>
      retained.find((p) =>
        p.check_id === c.check_id &&
        JSON.stringify(p.target) === JSON.stringify(c.target)
      ) ?? c
    );
    const outcome = checks.length !== 8 + 2 * claim.snapshot.media.length ||
        checks.some((c) => c.state === "failed")
      ? "checks_incomplete"
      : checks.some((c) => c.state === "flagged")
      ? "needs_review"
      : "no_review_flags";
    const final = ModerationResultV2Schema.parse({
      ...result,
      checks,
      outcome,
    });
    if (final.phase !== "evaluation") throw Error("INVALID_FINAL_EVIDENCE");
    const expectedTerminal = stable(final);
    freezeEvidence(final);
    try {
      terminalDecision.parse(await deps.db.finalize(claim, final));
    } catch {
      // A lost commit response is not permission to finalize or call OpenAI again.
      // Read the installed idempotency ledger exactly once; DB recovery handles
      // an absent/uncertain record after its own lease/call-deadline safeguards.
      const terminal = z.object({
        success: z.literal(true),
        request_id: UUID,
        attempt_id: UUID,
        snapshot_sha256: z.string(),
        evaluator_build: z.string(),
        payload: ModerationResultV2Schema,
        decision: terminalDecision.shape.decision,
      }).strict().parse(await deps.db.terminal(claim, final));
      if (
        terminal.request_id !== claim.request_id ||
        terminal.attempt_id !== claim.attempt_id ||
        terminal.snapshot_sha256 !== claim.snapshot.snapshot_sha256 ||
        terminal.evaluator_build !== claim.evaluator_build ||
        stable(terminal.payload) !== expectedTerminal
      ) throw Error("TERMINAL_LEDGER_MISMATCH");
    }
    return { code: "FINALIZED_WITHOUT_PUBLICATION" };
  } catch {
    return { code: "STOPPED_FAIL_CLOSED" };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** Invocation authentication is distinct from SQL/Vault authentication. Caller
 * supplies a server-created dependency closure, never SQL/media/provider settings
 * from the HTTP request. No identifiers, content or raw errors in responses.
 */
export function moderationV2Handler(
  dispatchSecret: string,
  deps: WorkerDependencies,
) {
  return async (request: Request): Promise<Response> => {
    const response = (code: string, status: number) =>
      Response.json({ code }, { status });
    if (request.method !== "POST") return response("METHOD_NOT_ALLOWED", 405);
    if (
      dispatchSecret.length < 32 ||
      request.headers.get("authorization") !== `Bearer ${dispatchSecret}`
    ) return response("UNAUTHORIZED", 401);
    if (!request.body) return response("INVALID_REQUEST", 400);
    const reader = request.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 256) {
          await reader.cancel();
          return response("INVALID_REQUEST", 400);
        }
        chunks.push(part.value);
      }
      const buffer = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      const parsed = z.object({ request_id: UUID }).strict().safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
      );
      if (!parsed.success) return response("INVALID_REQUEST", 400);
      const result = await runModerationV2(parsed.data.request_id, deps);
      return response(
        result.code,
        result.code === "FINALIZED_WITHOUT_PUBLICATION" ||
          result.code === "IDLE_OR_DISABLED"
          ? 200
          : 503,
      );
    } catch {
      return response("INVALID_REQUEST", 400);
    } finally {
      reader.releaseLock();
    }
  };
}
