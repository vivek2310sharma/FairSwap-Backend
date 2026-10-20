// Explicit disposable-local suite. No hosted client, URL, dotenv or provider.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  inspect,
  query,
  raw,
  stream,
} from "../../scripts/moderation-v2/worker-local-db.mjs";
import { scramVerifier } from "../../scripts/moderation-v2/worker-local-db.mjs";
import {
  runModerationV2,
  type WorkerClaim,
  type WorkerDatabase,
} from "../../supabase/functions/_shared/listing-moderation-v2-worker";
import { syntheticDependencies } from "../../supabase/functions/_shared/listing-moderation-v2-synthetic";
import {
  CATEGORIES,
  type EvaluationResultV2,
  IMAGE_CATEGORIES,
} from "../lib/moderation/v2/contract";
const lit = (x: unknown) => "'" + String(x).replaceAll("'", "''") + "'",
  json = (x: unknown) => lit(JSON.stringify(x)) + "::jsonb";
const parse = (s: string) =>
  JSON.parse(
    s.split(/\r?\n/).filter((x) => x.startsWith("{") || x.startsWith("[")).at(
      -1,
    )!,
  );
const actors: Array<{ user: string; password: string; group: string }> = [];
let secret: string;
let worker: typeof actors[number],
  broker: typeof actors[number],
  retire: typeof actors[number];
function actor(group: string) {
  const user = "mv2_worker_test_" +
      randomUUID().replaceAll("-", "").slice(0, 16),
    password = randomBytes(32).toString("base64url");
  query(
    `CREATE ROLE ${user} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD ${
      lit(scramVerifier(password))
    };GRANT ${group} TO ${user} WITH ADMIN FALSE,INHERIT FALSE,SET TRUE;`,
  );
  const a = { user, password, group };
  actors.push(a);
  expect(query("SELECT session_user;", a)).toBe(user);
  return a;
}
function act(a: typeof worker, sql: string) {
  return query(`BEGIN;SET LOCAL ROLE ${a.group};${sql};COMMIT;`, a);
}
function fixture() {
  const f = parse(query("SELECT p3_local_test.fixture();"));
  const c = parse(
    query(
      `SELECT json_build_object('request_id',r.id,'attempt_id',c.attempt_id,'claim_token',${
        lit(f.token)
      },'snapshot',e.snapshot,'source_manifest',e.source_manifest,'original_title',r.original_title,'original_description',r.original_description,'evaluator_build',e.evaluator_build,'lease_expires_at',c.lease_expires_at,'attempt_number',c.attempt_number) FROM app_moderation_v2.requests r JOIN app_moderation_v2.input_claims c ON c.request_id=r.id JOIN app_moderation_v2.p3_evaluation_evidence e USING(request_id,attempt_id) WHERE r.id=${
        lit(f.request)
      } AND c.attempt_id=${lit(f.attempt)};`,
    ),
  ) as WorkerClaim;
  return { f, c };
}
function release(x: ReturnType<typeof fixture>) {
  query(
    `SELECT p3_local_test.drop_lease(${lit(x.c.request_id)},${
      lit(x.c.attempt_id)
    });`,
  );
}
function retry(x: ReturnType<typeof fixture>) {
  release(x);
  const a = randomUUID(),
    token = randomBytes(32).toString("hex"),
    claim = randomUUID();
  query(
    `BEGIN;SET LOCAL ROLE mv2_p3_lease;INSERT INTO app_moderation_v2.input_claims(id,request_id,attempt_id,attempt_number,claim_token_hash,slot_id,worker_id,lease_expires_at,attempt_started_at,max_renewal_until,status,phase) SELECT ${
      lit(claim)
    },request_id,${lit(a)},2,encode(sha256(convert_to(${
      lit(token)
    },'UTF8')),'hex'),slot_id,worker_id,clock_timestamp()+interval '120 seconds',clock_timestamp(),clock_timestamp()+interval '300 seconds','evaluation_active','evaluation' FROM app_moderation_v2.input_claims WHERE request_id=${
      lit(x.c.request_id)
    } AND attempt_id=${
      lit(x.c.attempt_id)
    };INSERT INTO app_moderation_v2.p3_evaluation_evidence(request_id,attempt_id,snapshot,source_manifest,evaluator_build) SELECT request_id,${
      lit(a)
    },snapshot,source_manifest,evaluator_build FROM app_moderation_v2.p3_evaluation_evidence WHERE request_id=${
      lit(x.c.request_id)
    } AND attempt_id=${
      lit(x.c.attempt_id)
    };UPDATE app_moderation_v2.input_admission_slots SET active_claim_id=${
      lit(claim)
    },slot_acquired_at=clock_timestamp(),slot_expires_at=clock_timestamp()+interval '120 seconds' WHERE slot_id=(SELECT slot_id FROM app_moderation_v2.input_claims WHERE id=${
      lit(claim)
    });UPDATE app_moderation_v2.requests SET status='claimed',phase='evaluation',attempt_count=2 WHERE id=${
      lit(x.c.request_id)
    };COMMIT;`,
  );
  x.c = {
    ...x.c,
    attempt_id: a,
    claim_token: token,
    attempt_number: 2,
    lease_expires_at: parse(
      query(
        `SELECT json_build_object('expiry',lease_expires_at) FROM app_moderation_v2.input_claims WHERE id=${
          lit(claim)
        }`,
      ),
    ).expiry,
  };
}
const metrics: Array<{ name: string; waitMs: number }> = [];
async function race(
  name: string,
  holder: typeof worker,
  sql: string,
  contender: () => unknown,
) {
  const child = stream(
    `BEGIN;SET LOCAL ROLE ${holder.group};${sql};SELECT 'WORKER_PARENT_HELD';SELECT pg_sleep(1);COMMIT;`,
    holder,
  );
  let ran = false, result: unknown, waitMs = 0, error: unknown, output = "";
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill();
      reject(Error("RACE_TIMEOUT"));
    }, 15000);
    child.stdout.on("data", (b: Buffer) => {
      output += b.toString();
      if (!ran && output.includes("WORKER_PARENT_HELD")) {
        ran = true;
        const start = Date.now();
        try {
          result = contender();
        } catch (e) {
          error = e;
        }
        waitMs = Date.now() - start;
      }
    });
    child.on("error", reject);
    child.on("close", (code: number) => {
      clearTimeout(deadline);
      if (code !== 0) reject(Error("RACE_HOLDER_FAILED"));
      else resolve();
    });
  });
  if (error) throw error;
  expect(ran).toBe(true);
  expect(waitMs).toBeGreaterThan(400);
  metrics.push({ name, waitMs });
  return result;
}
const args = (c: WorkerClaim) =>
  [secret, c.request_id, c.attempt_id, c.claim_token].map(lit).join(",");
const read = (c: WorkerClaim) =>
  `SELECT app_moderation_v2.p3_read_worker_context(${args(c)})`;
function database(c: WorkerClaim): WorkerDatabase {
  return {
    // Gates stay disabled. Claim provisioning is an explicit synthetic controller
    // fixture, not a claimed positive production queue-dispatch proof.
    claim: async () => c,
    readContext: async (c) => parse(act(worker, read(c))),
    heartbeat: async (c) =>
      parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_heartbeat_evaluation(${args(c)})`,
        ),
      ),
    reserve: async (c, id, target, sha) =>
      parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_reserve_call(${args(c)},${lit(id)},${
            json(target)
          },${lit(sha)})`,
        ),
      ),
    checkpoint: async (c, check, delay) =>
      parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_checkpoint_evaluation(${args(c)},${
            json(check)
          },${delay ?? "NULL"})`,
        ),
      ),
    finalize: async (c, p) =>
      parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_finalize_evaluation(${args(c)},${
            json(p)
          })`,
        ),
      ),
    terminal: async (c, p) =>
      parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_read_worker_terminal(${args(c)},${
            json(p)
          })`,
        ),
      ),
    getAttempt: async (c) =>
      parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_get_attempt(${lit(secret)},${
            lit(c.request_id)
          },${lit(c.attempt_id)})`,
        ),
      ),
    recover: async (c) =>
      parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_recover_evaluation(${lit(secret)},${
            lit(c.request_id)
          },${lit(c.attempt_id)})`,
        ),
      ),
  };
}
function seedCompleted(c: WorkerClaim, flag = false) {
  const checks: EvaluationResultV2["checks"] = [];
  for (const field of ["title", "description"] as const) {
    checks.push(
      providerCheck(
        "openai_text_v2",
        { kind: "text", field },
        c.snapshot[field === "title" ? "title_sha256" : "description_sha256"],
        flag && field === "title",
      ),
    );
  }
  for (const m of c.snapshot.media) {
    checks.push(
      providerCheck(
        "openai_image_v2",
        { kind: "image", media_id: m.media_id },
        m.canonical.sha256,
        false,
      ),
    );
  }
  for (const check of checks) {
    query(
      `INSERT INTO app_moderation_v2.p3_call_starts VALUES(${
        lit(c.request_id)
      },${lit(c.attempt_id)},${lit(check.check_id)}||':'||(${
        json(check.target)
      })::text,${
        lit(check.input_sha256)
      },1,clock_timestamp()-interval '1 second');`,
    );
    const r = parse(
      act(
        worker,
        `SELECT app_moderation_v2.p3_checkpoint_evaluation(${args(c)},${
          json(check)
        })`,
      ),
    );
    expect(r.success).toBe(true);
  }
}
function providerCheck(
  id: "openai_text_v2" | "openai_image_v2",
  target: EvaluationResultV2["checks"][number]["target"],
  digest: string,
  flag: boolean,
): EvaluationResultV2["checks"][number] {
  return {
    check_id: id,
    target,
    input_sha256: digest,
    state: flag ? "flagged" : "passed",
    reason_codes: flag ? ["PROVIDER_FLAG"] : [],
    retryable: false,
    provider: {
      name: "openai",
      requested_model: "omni-moderation-2024-09-26",
      returned_model: "omni-moderation-2024-09-26",
      response_id: "synthetic_completed_response",
      request_id: null,
      flagged: flag,
      categories: CATEGORIES.map((category) => {
        const applies = target.kind === "text" ||
          IMAGE_CATEGORIES.includes(category);
        return {
          category,
          applicability: applies ? "evaluated" : "not_applicable",
          flagged: applies ? flag && category === "violence" : null,
          score: applies ? 0 : null,
        };
      }),
    },
  };
}
async function deps(c: WorkerClaim) {
  const fixtureDocument = JSON.parse(
    readFileSync(
      "artifacts/mod-v2-worker-complete/fixtures/five-object.json",
      "utf8",
    ),
  );
  const bytes = fixtureDocument.objects.canonical.base64;
  const p = JSON.stringify({
    synthetic_only: true,
    processor_build: fixtureDocument.processor_build,
    entries: c.snapshot.media.map((m) => ({
      snapshot: c.snapshot,
      media_id: m.media_id,
      canonical_base64: bytes,
    })),
  });
  return {
    ...await syntheticDependencies(
      p,
      createHash("sha256").update(p).digest("hex"),
      fixtureDocument.processor_build,
    ),
    db: database(c),
    build: c.evaluator_build,
    workerId: "synthetic-local-worker",
    now: () => Date.now(),
  };
}
beforeAll(() => {
  inspect();
  expect(query("SELECT app_moderation_v2.p3_publication_boundary_verified();"))
    .toBe("f");
  secret = randomBytes(32).toString("hex");
  query(
    `SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name='moderation_worker_secret'),${
      lit(secret)
    });`,
    { user: "p3_local_bootstrap" },
  );
  worker = actor("mv2_p3_worker");
  broker = actor("mv2_p3_media_editor");
  retire = actor("mv2_p3_retirement");
});
afterAll(() => {
  for (const a of actors.reverse()) {
    query(
      `ALTER ROLE ${a.user} NOLOGIN PASSWORD NULL;REVOKE ${a.group} FROM ${a.user};DROP ROLE ${a.user};`,
    );
  }
  writeFileSync(
    "artifacts/mod-v2-worker-complete/native-race-metrics.json",
    JSON.stringify(metrics, null, 2),
  );
});
describe("native registered synthetic media integration", () => {
  it.each([false, true])(
    "reads real encoded registered media, preserves prior flag=%s, finalizes through genuine worker",
    async (flag) => {
      const x = fixture();
      try {
        seedCompleted(x.c, flag);
        const d = await deps(x.c);
        const result = await runModerationV2(x.c.request_id, d);
        expect(result.code).toBe("FINALIZED_WITHOUT_PUBLICATION");
        const terminal = parse(
          query(
            `SELECT payload FROM app_moderation_v2.p3_evaluation_results WHERE request_id=${
              lit(x.c.request_id)
            };`,
          ),
        );
        expect(terminal.outcome).toBe(
          flag ? "needs_review" : "no_review_flags",
        );
        expect(
          query(
            `SELECT status FROM public.listings WHERE id=${lit(x.f.listing)};`,
          ),
        ).toBe("pending_review");
      } finally {
        release(x);
      }
    },
  );
  it("lost response recovers only the exact native terminal payload", async () => {
    const x = fixture();
    try {
      seedCompleted(x.c);
      const d = await deps(x.c);
      const real = d.db.finalize;
      let submitted: EvaluationResultV2 | undefined;
      d.db.finalize = async (c, p) => {
        submitted = p;
        await real(c, p);
        throw Error("response lost");
      };
      expect((await runModerationV2(x.c.request_id, d)).code).toBe(
        "FINALIZED_WITHOUT_PUBLICATION",
      );
      expect(
        parse(
          act(
            worker,
            `SELECT app_moderation_v2.p3_read_worker_terminal(${args(x.c)},${
              json({ ...submitted, evaluated_at: "2026-10-20T00:00:00Z" })
            })`,
          ),
        ).error,
      ).toBe("TERMINAL_RESULT_MISMATCH");
      expect(
        parse(
          act(
            worker,
            `SELECT app_moderation_v2.p3_read_worker_terminal(${
              [secret, x.c.request_id, x.c.attempt_id, "0".repeat(64)].map(lit)
                .join(",")
            },${json(submitted)})`,
          ),
        ).error,
      ).toBe("LEASE_TOKEN_MISMATCH");
    } finally {
      release(x);
    }
  });
  it("disabled gate prevents new provider reservation and real queue claims", async () => {
    const x = fixture();
    try {
      const r = parse(
        act(
          worker,
          `SELECT app_moderation_v2.p3_reserve_call(${
            args(x.c)
          },'openai_text_v2','{"kind":"text","field":"title"}',${
            lit(x.c.snapshot.title_sha256)
          })`,
        ),
      );
      expect(r.error).toBe("LEASE_EXPIRED");
      expect(
        act(
          worker,
          `SELECT app_moderation_v2.p3_claim_evaluation(${lit(secret)},${
            lit(x.c.request_id)
          },'synthetic',${lit(x.c.evaluator_build)}) IS NULL`,
        ),
      ).toBe("t");
    } finally {
      release(x);
    }
  });
  it("stale revision and retirement prevent subsequent canonical reads", async () => {
    const x = fixture();
    try {
      act(
        retire,
        `SELECT app_moderation_v2.p3_retire_bundle(${lit(x.f.assets[0])})`,
      );
      expect(parse(act(worker, read(x.c))).success).toBe(false);
    } finally {
      release(x);
    }
  });
  it.each([false, true])(
    "same-generation second attempt reuses registered native checkpoints, flag=%s",
    async (flag) => {
      const x = fixture();
      try {
        seedCompleted(x.c, flag);
        retry(x);
        expect((await runModerationV2(x.c.request_id, await deps(x.c))).code)
          .toBe("FINALIZED_WITHOUT_PUBLICATION");
        const p = parse(
          query(
            `SELECT payload FROM app_moderation_v2.p3_evaluation_results WHERE request_id=${
              lit(x.c.request_id)
            } AND attempt_id=${lit(x.c.attempt_id)}`,
          ),
        );
        expect(p.outcome).toBe(flag ? "needs_review" : "no_review_flags");
        expect(
          query(
            `SELECT count(*) FROM app_moderation_v2.p3_call_starts WHERE request_id=${
              lit(x.c.request_id)
            }`,
          ),
        ).toBe("4");
      } finally {
        release(x);
      }
    },
  );
  it("concurrent retirement holds parent lock and makes waiting read fail closed", async () => {
    const x = fixture();
    try {
      const r = await race(
        "retire-versus-read",
        retire,
        `SELECT app_moderation_v2.p3_retire_bundle(${lit(x.f.assets[0])})`,
        () => parse(act(worker, read(x.c))),
      );
      expect((r as { success: boolean }).success).toBe(false);
    } finally {
      release(x);
    }
  });
  it("concurrent seller edit holds parent lock and supersedes the waiting read", async () => {
    const x = fixture();
    try {
      const r = await race(
        "edit-versus-read",
        broker,
        `SET LOCAL request.jwt.claim.sub='c3900000-0000-4000-8000-000000000001';SELECT app_moderation_v2.p3_edit_text(${
          lit(x.f.listing)
        },${x.f.revision},'Synthetic concurrent edit','Synthetic description after concurrent edit')`,
        () => parse(act(worker, read(x.c))),
      );
      expect((r as { success: boolean }).success).toBe(false);
    } finally {
      release(x);
    }
  });
  it("retirement wins against finalization after a canonical read", async () => {
    const x = fixture();
    try {
      seedCompleted(x.c);
      const d = await deps(x.c);
      const real = d.db.finalize;
      d.db.finalize = async (c, p) => {
        const r = await race(
          "retire-versus-finalize",
          retire,
          `SELECT app_moderation_v2.p3_retire_bundle(${lit(x.f.assets[0])})`,
          () => real(c, p),
        );
        return await r;
      };
      expect((await runModerationV2(x.c.request_id, d)).code).toBe(
        "FINALIZED_WITHOUT_PUBLICATION",
      );
      expect(
        query(
          `SELECT response->>'decision' FROM app_moderation_v2.p3_evaluation_results WHERE request_id=${
            lit(x.c.request_id)
          }`,
        ),
      ).toBe("superseded");
    } finally {
      release(x);
    }
  });
});
