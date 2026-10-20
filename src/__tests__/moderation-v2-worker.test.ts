import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  moderationV2Handler,
  runModerationV2,
  type WorkerClaim,
  type WorkerDatabase,
} from "../../supabase/functions/_shared/listing-moderation-v2-worker";
import {
  type SqlConnection,
  workerDatabase,
} from "../../supabase/functions/_shared/listing-moderation-v2-postgres";
import { createTestModerationV2Runtime } from "../../supabase/functions/_shared/listing-moderation-v2-runtime";
import type { ReadContext } from "../../supabase/functions/_shared/listing-moderation-v2-context";
import { canonicalResolver } from "../../supabase/functions/_shared/listing-moderation-v2-media";
import { syntheticDependencies } from "../../supabase/functions/_shared/listing-moderation-v2-synthetic";
import {
  CATEGORIES,
  type EvaluationResultV2,
  IMAGE_CATEGORIES,
  MODEL,
  ModerationResultV2Schema,
  POLICY,
} from "../lib/moderation/v2/contract";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (b: string | Uint8Array) =>
  createHash("sha256").update(b).digest("hex");
function context(c: WorkerClaim, now: number): ReadContext {
  return {
    success: true,
    request_id: c.request_id,
    attempt_id: c.attempt_id,
    snapshot_sha256: c.snapshot.snapshot_sha256,
    evaluator_build: c.evaluator_build,
    lease_expires_at: c.lease_expires_at,
    provider_work_until: new Date(now + 210000).toISOString(),
    prior_checks: [],
    reserved_calls: [],
    canonical_objects: c.snapshot.media.map((m) => ({
      media_id: m.media_id,
      asset_version: m.asset_version,
      ...m.canonical,
      bucket: "listing-originals",
      logical_key:
        `${c.snapshot.listing_id}/${m.media_id}/v2/${m.asset_version}/${m.canonical.sha256}/canonical.webp`,
      recipe: "seal_v1",
    })),
  };
}
function fixture(count = 1) {
  const bytes = new Uint8Array([1, 2, 3]),
    title = "Synthetic bicycle",
    description = "Synthetic bicycle for local pickup.";
  const object = (n: number) => ({
    object_id: uuid(n),
    sha256: sha(bytes),
    bytes: bytes.length,
    width: 1,
    height: 1,
  });
  const media = Array.from({ length: count }, (_, i) => ({
    media_id: uuid(10 + i * 10),
    asset_version: uuid(11 + i * 10),
    display_order: i,
    source_sha256: sha(bytes),
    recipe: "seal_v1" as const,
    original: object(12 + i * 10),
    canonical: object(13 + i * 10),
    thumb: object(14 + i * 10),
    medium: object(15 + i * 10),
    large: object(16 + i * 10),
  }));
  const manifest = [
    "fairswap:v2:manifest_v1",
    uuid(1),
    media[0].media_id,
    media.map(
      (m) => [
        m.media_id,
        m.display_order,
        "ready",
        "synthetic/original",
        "synthetic/thumb",
        "synthetic/medium",
        "synthetic/large",
        m.source_sha256,
        m.asset_version,
        m.recipe,
        ...[m.original, m.canonical, m.thumb, m.medium, m.large].map(
          (o) => [o.object_id, o.sha256, o.bytes, o.width, o.height],
        ),
      ],
    ),
  ];
  const snapshot = {
    listing_id: uuid(1),
    listing_revision: 2,
    generation_id: uuid(2),
    canonicalization: "snapshot_v1" as const,
    title_sha256: sha(title),
    description_sha256: sha(description),
    media_manifest_sha256: sha(JSON.stringify(manifest)),
    snapshot_sha256: "",
    cover_media_id: media[0].media_id,
    media,
  };
  snapshot.snapshot_sha256 = sha(
    JSON.stringify([
      "fairswap:v2:snapshot_v1",
      "2.0.0",
      POLICY,
      snapshot.listing_id,
      2,
      snapshot.generation_id,
      snapshot.title_sha256,
      snapshot.description_sha256,
      snapshot.media_manifest_sha256,
    ]),
  );
  const now = Date.parse("2026-10-20T12:00:00Z");
  const claim: WorkerClaim = {
    request_id: uuid(3),
    attempt_id: uuid(4),
    claim_token: "c".repeat(64),
    snapshot,
    source_manifest: manifest,
    original_title: title,
    original_description: description,
    evaluator_build: "b".repeat(64),
    lease_expires_at: new Date(now + 120000).toISOString(),
    attempt_number: 1,
  };
  const events: string[] = [];
  const read = context(claim, now);
  let final: EvaluationResultV2 | undefined;
  const db: WorkerDatabase = {
    readContext: vi.fn(async () => read),
    terminal: vi.fn(async () => null),
    getAttempt: vi.fn(async () => null),
    recover: vi.fn(async () => ({ success: false })),
    claim: vi.fn(async () => claim),
    heartbeat: vi.fn(async () => ({
      success: true,
      lease_expires_at: new Date(now + 120000).toISOString(),
    })),
    reserve: vi.fn(async () => {
      events.push("reserve");
      return { success: true };
    }),
    checkpoint: vi.fn(async () => {
      events.push("checkpoint");
      return { success: true };
    }),
    finalize: vi.fn(async (_c, r) => {
      events.push("finalize");
      final = r;
      return { success: true, decision: "routed_to_admin" };
    }),
  };
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    events.push("provider");
    const body = JSON.parse(init.body as string);
    const kind = body.input[0].type === "text" ? "text" : "image";
    return new Response(JSON.stringify({
      id: "synthetic_response",
      model: MODEL,
      results: [{
        flagged: false,
        categories: Object.fromEntries(CATEGORIES.map((c) => [c, false])),
        category_scores: Object.fromEntries(CATEGORIES.map((c) => [c, 0])),
        category_applied_input_types: Object.fromEntries(
          CATEGORIES.map(
            (c) => [
              c,
              kind === "text" || IMAGE_CATEGORIES.includes(c) ? [kind] : [],
            ],
          ),
        ),
      }],
    }));
  });
  const deps = {
    db,
    build: claim.evaluator_build,
    workerId: "synthetic-worker",
    apiKey: "fake-key",
    transport,
    now: () => now,
    media: vi.fn(async (
      _c: WorkerClaim,
      m: typeof media[number],
      _signal: AbortSignal,
    ) => ({
      media_id: m.media_id,
      canonicalWebp: bytes,
      integrity: {
        snapshot_sha256: snapshot.snapshot_sha256,
        sealed_media: m,
        check: {
          check_id: "image_integrity_v2" as const,
          target: { kind: "image" as const, media_id: m.media_id },
          input_sha256: m.canonical.sha256,
          state: "passed" as const,
          reason_codes: [],
          retryable: false,
          provider: null,
        },
      },
    })),
  };
  return { deps, claim, read, events, final: () => final };
}
describe("C2 V2 worker: injected SQL, bytes and provider", () => {
  it.each([1, 8])(
    "executes independent fields and %i images with exact reservations and coverage",
    async (n) => {
      const f = fixture(n);
      expect(await runModerationV2(f.claim.request_id, f.deps)).toEqual({
        code: "FINALIZED_WITHOUT_PUBLICATION",
      });
      expect(f.deps.transport).toHaveBeenCalledTimes(n + 2);
      expect(f.final()!.checks).toHaveLength(8 + 2 * n);
      expect(ModerationResultV2Schema.safeParse(f.final()).success).toBe(true);
      expect(f.final()!.outcome).toBe("no_review_flags");
      expect(f.events).toEqual([
        ...Array.from(
          { length: n + 2 },
          () => ["reserve", "provider", "checkpoint"],
        ).flat(),
        "finalize",
      ]);
      for (const [url, init] of f.deps.transport.mock.calls) {
        expect(url).toBe("https://api.openai.com/v1/moderations");
        const b = JSON.parse(init.body as string);
        expect(b.model).toBe(MODEL);
        expect(b.input).toHaveLength(1);
        expect(init.body).not.toContain(f.claim.request_id);
        expect(init.body).not.toContain("synthetic/original");
      }
      expect(
        f.final()!.checks.find((c) => c.check_id === "openai_image_v2")!
          .provider!.categories.filter((c) => c.applicability === "evaluated"),
      ).toHaveLength(6);
    },
  );
  it("does no work when disabled", async () => {
    const f = fixture();
    vi.mocked(f.deps.db.claim).mockResolvedValue(null);
    expect((await runModerationV2(f.claim.request_id, f.deps)).code).toBe(
      "IDLE_OR_DISABLED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it.each(["text", "manifest", "identity", "build", "unknown"])(
    "rejects corrupted claim %s before media/provider",
    async (kind) => {
      const f = fixture();
      if (kind === "text") f.claim.original_title += "x";
      if (kind === "manifest") f.claim.source_manifest.pop();
      if (kind === "identity") f.claim.request_id = uuid(99);
      if (kind === "build") f.claim.evaluator_build = "e".repeat(64);
      if (kind === "unknown") Object.assign(f.claim, { unrecognized: true });
      expect((await runModerationV2(uuid(3), f.deps)).code).toMatch(/REJECTED/);
      expect(f.deps.transport).not.toHaveBeenCalled();
    },
  );
  it("rejects self-consistent digest with substituted manifest object", async () => {
    const f = fixture();
    const rows = f.claim.source_manifest[3] as unknown[][];
    rows[0][10] = [uuid(900), "a".repeat(64), 3, 1, 1];
    f.claim.snapshot.media_manifest_sha256 = sha(
      JSON.stringify(f.claim.source_manifest),
    );
    const s = f.claim.snapshot;
    s.snapshot_sha256 = sha(
      JSON.stringify([
        "fairswap:v2:snapshot_v1",
        "2.0.0",
        POLICY,
        s.listing_id,
        s.listing_revision,
        s.generation_id,
        s.title_sha256,
        s.description_sha256,
        s.media_manifest_sha256,
      ]),
    );
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "SNAPSHOT_REJECTED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("rejects digest-mismatched canonical bytes", async () => {
    const f = fixture();
    const image = await f.deps.media(
      f.claim,
      f.claim.snapshot.media[0],
      new AbortController().signal,
    );
    image.canonicalWebp = new Uint8Array([9]);
    f.deps.media.mockResolvedValue(image);
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "MEDIA_REJECTED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("does not manufacture trusted seal evidence from hashes", async () => {
    const f = fixture();
    const image = await f.deps.media(
      f.claim,
      f.claim.snapshot.media[0],
      new AbortController().signal,
    );
    image.integrity.check.state = "failed" as "passed";
    image.integrity.check.reason_codes = ["SEAL_INVALID"] as never[];
    f.deps.media.mockResolvedValue(image);
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "MEDIA_REJECTED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it.each([401, 429, 503])(
    "checkpoints HTTP %i failure and leaves DB to select retry/circuit",
    async (status) => {
      const f = fixture();
      f.deps.transport.mockImplementation(async () =>
        new Response("synthetic error", {
          status,
          headers: { "retry-after": "12" },
        })
      );
      expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
        "FINALIZED_WITHOUT_PUBLICATION",
      );
      expect(f.deps.transport).toHaveBeenCalledTimes(1);
      expect(f.final()!.outcome).toBe("checks_incomplete");
      expect(f.final()!.checks.filter((c) => c.check_id.startsWith("openai")))
        .toHaveLength(1);
      expect(ModerationResultV2Schema.safeParse(f.final()).success).toBe(true);
      if (status === 429) {
        expect(vi.mocked(f.deps.db.checkpoint).mock.calls[0][2]).toBe(12);
      }
    },
  );
  it.each(["reserve", "checkpoint", "finalize"] as const)(
    "stops on ambiguous %s without blind provider replay",
    async (operation) => {
      const f = fixture();
      vi.mocked(f.deps.db[operation]).mockRejectedValue(
        Error("sensitive diagnostic"),
      );
      expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
        "STOPPED_FAIL_CLOSED",
      );
      expect(f.deps.transport.mock.calls.length).toBe(
        operation === "reserve" ? 0 : operation === "checkpoint" ? 1 : 3,
      );
    },
  );
  it("renews a short lease before any call", async () => {
    const f = fixture();
    f.claim.lease_expires_at = new Date(f.deps.now() + 19000).toISOString();
    await runModerationV2(uuid(3), f.deps);
    expect(f.deps.db.heartbeat).toHaveBeenCalledTimes(1);
  });
  it("failed renewal sends no provider requests", async () => {
    const f = fixture();
    f.claim.lease_expires_at = new Date(f.deps.now() + 19000).toISOString();
    vi.mocked(f.deps.db.heartbeat).mockResolvedValue({
      success: false,
      error: "LEASE_EXPIRED",
    });
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "STOPPED_FAIL_CLOSED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("reservation lock delay cannot start a late provider call", async () => {
    const f = fixture();
    let tick = 0;
    f.deps.now = () => Date.parse("2026-10-20T12:00:00Z") + tick;
    vi.mocked(f.deps.db.reserve).mockImplementation(async () => {
      tick = 115000;
      return { success: true };
    });
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "LEASE_OR_BUDGET_LOST",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("retains a provider flag in its checkpoint and final result", async () => {
    const f = fixture();
    const real = f.deps.transport.getMockImplementation()!;
    f.deps.transport.mockImplementation(async (url, init) => {
      const r = await real(url, init);
      const body = await r.json();
      body.results[0].flagged = true;
      body.results[0].categories.violence = true;
      return new Response(JSON.stringify(body));
    });
    await runModerationV2(uuid(3), f.deps);
    expect(f.final()!.outcome).toBe("needs_review");
    expect(f.final()!.checks.filter((c) => c.state === "flagged")).toHaveLength(
      3,
    );
    expect(vi.mocked(f.deps.db.checkpoint).mock.calls[0][1].state).toBe(
      "flagged",
    );
  });
  it("malformed model becomes failure, never clean evidence", async () => {
    const f = fixture();
    f.deps.transport.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          id: "synthetic",
          model: "omni-moderation-latest",
          results: [],
        }),
      )
    );
    await runModerationV2(uuid(3), f.deps);
    expect(
      f.final()!.checks.find((c) => c.check_id === "openai_text_v2")!
        .reason_codes,
    ).toContain("PROVIDER_SCHEMA");
    expect(f.deps.transport).toHaveBeenCalledTimes(1);
  });
  it("aborts a hung provider at the 15-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let aborted = false;
      f.deps.transport.mockImplementation(async (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => {
            aborted = true;
            reject(Error("aborted"));
          });
        })
      );
      const work = runModerationV2(uuid(3), f.deps);
      for (
        let i = 0;
        i < 100 && f.deps.transport.mock.calls.length === 0;
        i++
      ) await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(15001);
      expect((await work).code).toBe("FINALIZED_WITHOUT_PUBLICATION");
      expect(aborted).toBe(true);
      expect(
        f.final()!.checks.find((c) => c.check_id === "openai_text_v2")!
          .reason_codes,
      ).toContain("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds an uncooperative media resolver and signals cancellation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.deps.media.mockImplementation(async () => new Promise(() => {}));
      const work = runModerationV2(uuid(3), f.deps);
      for (let i = 0; i < 100 && f.deps.media.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(210001);
      expect((await work).code).toBe("STOPPED_FAIL_CLOSED");
      expect(f.deps.media.mock.calls[0][2].aborted).toBe(true);
      expect(f.deps.transport).not.toHaveBeenCalled();
      expect(f.deps.db.finalize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("sanitizes connection failures without reflecting SQL or credentials", async () => {
    const f = fixture();
    vi.mocked(f.deps.db.claim).mockRejectedValue(
      Error("fake-secret SQL text source payload"),
    );
    expect(await runModerationV2(uuid(3), f.deps)).toEqual({
      code: "DATABASE_UNAVAILABLE",
    });
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("looks up a lost finalizer response without replaying it", async () => {
    const f = fixture();
    vi.mocked(f.deps.db.finalize).mockRejectedValue(Error("lost response"));
    vi.mocked(f.deps.db.terminal).mockImplementation(async (c, p) => ({
      success: true,
      request_id: c.request_id,
      attempt_id: c.attempt_id,
      snapshot_sha256: c.snapshot.snapshot_sha256,
      evaluator_build: c.evaluator_build,
      payload: p,
      decision: "routed_to_admin",
    }));
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "FINALIZED_WITHOUT_PUBLICATION",
    );
    expect(f.deps.db.finalize).toHaveBeenCalledOnce();
    expect(f.deps.db.terminal).toHaveBeenCalledOnce();
    expect(f.deps.transport).toHaveBeenCalledTimes(3);
  });
  it("never re-runs a retry generation without its prior checkpoints", async () => {
    const f = fixture();
    f.claim.attempt_number = 2;
    vi.mocked(f.deps.db.readContext).mockResolvedValue({ success: false });
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "DATABASE_UNAVAILABLE",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
});
describe("authenticated bounded dispatch", () => {
  it("denies unauthorized invocation before any claim", async () => {
    const f = fixture();
    const handler = moderationV2Handler("s".repeat(32), f.deps);
    expect(
      (await handler(
        new Request("https://synthetic.invalid", {
          method: "POST",
          body: "{}",
        }),
      )).status,
    ).toBe(401);
    expect(f.deps.db.claim).not.toHaveBeenCalled();
  });
  it.each(["extra-fields", "oversize", "invalid-json"])(
    "rejects %s invocation",
    async (kind) => {
      const f = fixture();
      const handler = moderationV2Handler("s".repeat(32), f.deps);
      const body = kind === "oversize"
        ? "x".repeat(257)
        : kind === "invalid-json"
        ? "{"
        : JSON.stringify({
          request_id: uuid(3),
          media_url: "https://synthetic.invalid",
        });
      expect(
        (await handler(
          new Request("https://synthetic.invalid", {
            method: "POST",
            body,
            headers: { authorization: `Bearer ${"s".repeat(32)}` },
          }),
        )).status,
      ).toBe(400);
      expect(f.deps.db.claim).not.toHaveBeenCalled();
    },
  );
  it("completes the injected HTTP-to-finalizer lifecycle with sanitized response", async () => {
    const f = fixture();
    const handler = moderationV2Handler("s".repeat(32), f.deps);
    const r = await handler(
      new Request("https://synthetic.invalid", {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(32)}` },
        body: JSON.stringify({ request_id: uuid(3) }),
      }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ code: "FINALIZED_WITHOUT_PUBLICATION" });
    expect(f.deps.db.finalize).toHaveBeenCalledOnce();
  });
  it("assembles HTTP, genuine-session checks, bound SQL and mocked provider end to end", async () => {
    const f = fixture();
    const queries: string[] = [];
    const unsafe = async (q: string, _p?: readonly unknown[]) => {
      queries.push(q);
      if (q.startsWith("SELECT session_user")) {
        return [{
          identity: "mv2_worker_test_synthetic",
          worker: true,
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
        }];
      }
      return [{
        result: q.includes("p3_claim_evaluation")
          ? f.claim
          : q.includes("p3_read_worker_context")
          ? f.read
          : { success: true, decision: "routed_to_admin" },
      }];
    };
    const connection: SqlConnection = {
      unsafe,
      begin: async (body) => body({ unsafe }),
    };
    const handler = createTestModerationV2Runtime({
      ...f.deps,
      connection,
      workerSecret: "fake-sql-secret",
      dispatchSecret: "s".repeat(32),
    });
    const r = await handler(
      new Request("https://synthetic.invalid", {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(32)}` },
        body: JSON.stringify({ request_id: uuid(3) }),
      }),
    );
    expect(r.status).toBe(200);
    expect(queries.some((q) => q.includes("p3_finalize_evaluation"))).toBe(
      true,
    );
    expect(queries.filter((q) => q.includes("p3_reserve_call"))).toHaveLength(
      3,
    );
    expect(f.deps.transport).toHaveBeenCalledTimes(3);
  });
});
describe("private PostgreSQL adapter", () => {
  function setup(
    identity: Record<string, unknown> = {
      identity: "mv2_worker_test_synthetic",
      worker: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
    },
  ) {
    const calls: Array<{ query: string; params?: readonly unknown[] }> = [];
    const unsafe = async (query: string, params?: readonly unknown[]) => {
      calls.push({ query, params });
      return query.startsWith("SELECT session_user")
        ? [identity]
        : [{ result: { success: true } }];
    };
    const conn: SqlConnection = {
      unsafe,
      begin: async (body) => body({ unsafe }),
    };
    return { calls, db: workerDatabase(conn, "fake-secret") };
  }
  it("checks genuine session, uses transaction-local worker role and bound parameters", async () => {
    const f = setup();
    const claim = fixture().claim;
    await f.db.reserve(claim, "openai_text_v2", {
      kind: "text",
      field: "title",
    }, "d".repeat(64));
    expect(f.calls[1].query).toBe("SET LOCAL ROLE mv2_p3_worker");
    expect(f.calls[2].query).not.toContain("fake-secret");
    expect(f.calls[2].params).toEqual([
      "fake-secret",
      claim.request_id,
      claim.attempt_id,
      claim.claim_token,
      "openai_text_v2",
      '{"kind":"text","field":"title"}',
      "d".repeat(64),
    ]);
  });
  it.each(["postgres", "service_role", "authenticated"])(
    "rejects %s session before protected API",
    async (identity) => {
      const f = setup({
        identity,
        worker: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
      });
      await expect(f.db.authenticate()).rejects.toThrow(
        "WORKER_IDENTITY_REJECTED",
      );
      expect(f.calls).toHaveLength(1);
    },
  );
  it.each(["rolsuper", "rolbypassrls", "rolcreaterole"])(
    "rejects overprivileged worker %s",
    async (attribute) => {
      const f = setup({
        identity: "mv2_worker_test_synthetic",
        worker: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        [attribute]: true,
      });
      await expect(f.db.authenticate()).rejects.toThrow(
        "WORKER_IDENTITY_REJECTED",
      );
    },
  );
});

describe("retry evidence, terminal identity and restricted resolver", () => {
  it("freezes the revalidated submission so post-validation mutation fails closed", async () => {
    const f = fixture();
    vi.mocked(f.deps.db.finalize).mockImplementation(async (_c, p) => {
      p.checks.pop();
      return { success: true, decision: "routed_to_admin" };
    });
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "STOPPED_FAIL_CLOSED",
    );
  });
  async function previous(flag = false) {
    const seed = fixture();
    await runModerationV2(uuid(3), seed.deps);
    const f = fixture();
    f.claim.attempt_number = 2;
    const checks = structuredClone(
      seed.final()!.checks.filter((c) => c.provider),
    );
    if (flag) {
      const c = checks[0];
      c.state = "flagged";
      c.reason_codes = ["PROVIDER_FLAG"];
      c.provider!.flagged = true;
      c.provider!.categories.find((c) => c.category === "violence")!.flagged =
        true;
    }
    f.read.prior_checks = checks.map((check) => ({
      attempt_id: uuid(700),
      attempt_number: 1,
      check,
      retry_after_seconds: null,
      recorded_at: new Date(f.deps.now() - 30000).toISOString(),
    }));
    f.read.reserved_calls = checks.map((check) => ({
      attempt_id: uuid(700),
      check_key: check.check_id + ":" + JSON.stringify(check.target),
      input_sha256: check.input_sha256,
      start_number: 1,
      deadline: new Date(f.deps.now() - 20000).toISOString(),
    }));
    return f;
  }
  it.each([false, true])(
    "reuses completed previous checks and retains flag=%s without new calls",
    async (flag) => {
      const f = await previous(flag);
      expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
        "FINALIZED_WITHOUT_PUBLICATION",
      );
      expect(f.deps.transport).not.toHaveBeenCalled();
      expect(f.deps.db.reserve).not.toHaveBeenCalled();
      expect(f.final()!.outcome).toBe(
        flag ? "needs_review" : "no_review_flags",
      );
    },
  );
  it("retains a previous flag even if a later clean checkpoint is presented", async () => {
    const f = await previous(true);
    const clean = structuredClone(f.read.prior_checks[0]);
    const c = clean.check as EvaluationResultV2["checks"][number];
    c.state = "passed";
    c.reason_codes = [];
    c.provider!.flagged = false;
    c.provider!.categories.forEach((x) => {
      if (x.applicability === "evaluated") x.flagged = false;
    });
    f.read.prior_checks.push(clean);
    await runModerationV2(uuid(3), f.deps);
    expect(f.final()!.outcome).toBe("needs_review");
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("rejects stale-snapshot context before any reads or provider calls", async () => {
    const f = fixture();
    f.read.snapshot_sha256 = "f".repeat(64);
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "DATABASE_UNAVAILABLE",
    );
    expect(f.deps.media).not.toHaveBeenCalled();
  });
  it("rejects substituted locator even if it is in the same bucket", async () => {
    const f = fixture();
    f.read.canonical_objects[0].logical_key = "another-listing/canonical.webp";
    await runModerationV2(uuid(3), f.deps);
    expect(f.deps.media).not.toHaveBeenCalled();
  });
  it("waits for an interrupted reservation deadline rather than overlapping work", async () => {
    const f = fixture();
    f.read.reserved_calls.push({
      attempt_id: uuid(700),
      check_key: 'openai_text_v2:{"field":"title","kind":"text"}',
      input_sha256: f.claim.snapshot.title_sha256,
      start_number: 1,
      deadline: new Date(f.deps.now() + 15000).toISOString(),
    });
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "RESERVATION_RECOVERY_REQUIRED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("does not reset generation call count on retry", async () => {
    const f = fixture();
    f.claim.attempt_number = 3;
    f.read.reserved_calls = Array.from({ length: 3 }, (_, i) => ({
      attempt_id: uuid(700 + i),
      check_key: 'openai_text_v2:{"field":"title","kind":"text"}',
      input_sha256: f.claim.snapshot.title_sha256,
      start_number: i + 1,
      deadline: new Date(f.deps.now() - 1000).toISOString(),
    }));
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "RESERVATION_RECOVERY_REQUIRED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it.each(["request", "attempt", "snapshot", "build", "payload", "decision"])(
    "rejects mismatching terminal ledger %s",
    async (key) => {
      const f = fixture();
      vi.mocked(f.deps.db.finalize).mockRejectedValue(Error("lost response"));
      vi.mocked(f.deps.db.terminal).mockImplementation(async (c, p) => {
        const t = {
          success: true,
          request_id: c.request_id,
          attempt_id: c.attempt_id,
          snapshot_sha256: c.snapshot.snapshot_sha256,
          evaluator_build: c.evaluator_build,
          payload: structuredClone(p),
          decision: "routed_to_admin",
        };
        if (key === "request") t.request_id = uuid(999);
        if (key === "attempt") t.attempt_id = uuid(999);
        if (key === "snapshot") t.snapshot_sha256 = "f".repeat(64);
        if (key === "build") t.evaluator_build = "f".repeat(64);
        if (key === "payload") t.payload.evaluated_at = "2026-10-20T10:00:00Z";
        if (key === "decision") t.decision = "auto_approved";
        return t;
      });
      expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
        "STOPPED_FAIL_CLOSED",
      );
    },
  );
  function resolver(
    f: ReturnType<typeof fixture>,
    read = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/webp", "content-length": "3" },
      })),
  ) {
    const seal = vi.fn(async () => ({
      authority: "reviewed_synthetic_seal" as const,
      processor_build: "e".repeat(64),
      snapshot_sha256: f.claim.snapshot.snapshot_sha256,
      sealed_media: f.claim.snapshot.media[0],
    }));
    return {
      resolve: canonicalResolver({
        read,
        seal,
        processorBuild: "e".repeat(64),
      }),
      seal,
    };
  }
  it("loads only an authorized canonical buffer with independent trusted seal evidence", async () => {
    const f = fixture();
    f.deps.media = vi.fn(resolver(f).resolve) as typeof f.deps.media;
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "FINALIZED_WITHOUT_PUBLICATION",
    );
  });
  it.each(["status", "oversize", "digest", "content-type"])(
    "rejects resolver %s failure before provider",
    async (kind) => {
      const f = fixture();
      const read = async () =>
        kind === "status" ? new Response(null, { status: 404 }) : new Response(
          new Uint8Array(
            kind === "oversize"
              ? [1, 2, 3, 4]
              : kind === "digest"
              ? [3, 2, 1]
              : [1, 2, 3],
          ),
          {
            headers: {
              "content-type": kind === "content-type"
                ? "image/png"
                : "image/webp",
            },
          },
        );
      f.deps.media = vi.fn(resolver(f, read).resolve) as typeof f.deps.media;
      expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
        "STOPPED_FAIL_CLOSED",
      );
      expect(f.deps.transport).not.toHaveBeenCalled();
    },
  );
  it("rejects missing trusted lineage even when the hash matches", async () => {
    const f = fixture();
    const r = resolver(f);
    r.seal.mockResolvedValue({
      ...await r.seal(),
      processor_build: "d".repeat(64),
    });
    f.deps.media = vi.fn(r.resolve) as typeof f.deps.media;
    expect((await runModerationV2(uuid(3), f.deps)).code).toBe(
      "STOPPED_FAIL_CLOSED",
    );
    expect(f.deps.transport).not.toHaveBeenCalled();
  });
  it("cancels a stalled canonical stream on AbortSignal", async () => {
    const f = fixture();
    let cancelled = false;
    const read = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/webp" } },
      );
    const r = resolver(f, read);
    const abort = new AbortController();
    const work = r.resolve(
      f.claim,
      f.claim.snapshot.media[0],
      abort.signal,
      f.read.canonical_objects[0],
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    abort.abort();
    await expect(work).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("synthetic runtime pins fixture provenance and has no live provider fallback", async () => {
    const f = fixture();
    const fixturePackage = JSON.stringify({
      synthetic_only: true,
      processor_build: "e".repeat(64),
      entries: [{
        snapshot: f.claim.snapshot,
        media_id: f.claim.snapshot.media[0].media_id,
        canonical_base64: btoa(String.fromCharCode(1, 2, 3)),
      }],
    });
    const deps = await syntheticDependencies(
      fixturePackage,
      sha(fixturePackage),
      "e".repeat(64),
    );
    expect((await runModerationV2(uuid(3), { ...f.deps, ...deps })).code).toBe(
      "FINALIZED_WITHOUT_PUBLICATION",
    );
    await expect(
      syntheticDependencies(fixturePackage, "d".repeat(64), "e".repeat(64)),
    ).rejects.toThrow("FIXTURE_PACKAGE_REJECTED");
  });
});
