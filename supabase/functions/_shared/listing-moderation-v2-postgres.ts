import type {
  WorkerClaim,
  WorkerDatabase,
} from "./listing-moderation-v2-worker.ts";

// The driver is injected to test exact SQL and parameter binding without sockets.
export type SqlSession = {
  unsafe(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<Array<Record<string, unknown>>>;
};
export type SqlConnection = SqlSession & {
  begin<T>(body: (sql: SqlSession) => Promise<T>): Promise<T>;
};
export function workerDatabase(
  connection: SqlConnection,
  secret: string,
): WorkerDatabase & { authenticate(): Promise<void> } {
  const invoke = async (query: string, parameters: unknown[]) =>
    connection.begin(async (sql) => {
      const [identity] = await sql.unsafe(
        "SELECT session_user AS identity, pg_has_role(session_user,'mv2_p3_worker','SET') AS worker, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname=session_user",
      );
      if (
        !identity || typeof identity.identity !== "string" ||
        !/^mv2_worker_test_[a-z0-9_]{1,32}$/.test(identity.identity) ||
        identity.worker !== true || identity.rolsuper !== false ||
        identity.rolbypassrls !== false || identity.rolcreaterole !== false
      ) throw Error("WORKER_IDENTITY_REJECTED");
      await sql.unsafe("SET LOCAL ROLE mv2_p3_worker");
      const rows = await sql.unsafe(query, parameters);
      return rows[0]?.result;
    });
  const args = (
    c: WorkerClaim,
  ) => [secret, c.request_id, c.attempt_id, c.claim_token];
  return {
    async authenticate() {
      await invoke(
        "SELECT app_moderation_v2.p3_get_attempt($1::text,$2::uuid,$3::uuid) AS result",
        [
          secret,
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ],
      );
    },
    claim: (request, worker, build) =>
      invoke(
        "SELECT app_moderation_v2.p3_claim_evaluation($1::text,$2::uuid,$3::text,$4::text) AS result",
        [secret, request, worker, build],
      ),
    heartbeat: (c) =>
      invoke(
        "SELECT app_moderation_v2.p3_heartbeat_evaluation($1::text,$2::uuid,$3::uuid,$4::text) AS result",
        args(c),
      ),
    readContext: (c) =>
      invoke(
        "SELECT app_moderation_v2.p3_read_worker_context($1::text,$2::uuid,$3::uuid,$4::text) AS result",
        args(c),
      ),
    terminal: (c, p) =>
      invoke(
        "SELECT app_moderation_v2.p3_read_worker_terminal($1::text,$2::uuid,$3::uuid,$4::text,$5::jsonb) AS result",
        [...args(c), JSON.stringify(p)],
      ),
    reserve: (c, check, target, sha) =>
      invoke(
        "SELECT app_moderation_v2.p3_reserve_call($1::text,$2::uuid,$3::uuid,$4::text,$5::text,$6::jsonb,$7::text) AS result",
        [...args(c), check, JSON.stringify(target), sha],
      ),
    checkpoint: (c, check, delay) =>
      invoke(
        "SELECT app_moderation_v2.p3_checkpoint_evaluation($1::text,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::integer) AS result",
        [...args(c), JSON.stringify(check), delay],
      ),
    finalize: (c, result) =>
      invoke(
        "SELECT app_moderation_v2.p3_finalize_evaluation($1::text,$2::uuid,$3::uuid,$4::text,$5::jsonb) AS result",
        [...args(c), JSON.stringify(result)],
      ),
    getAttempt: (c) =>
      invoke(
        "SELECT app_moderation_v2.p3_get_attempt($1::text,$2::uuid,$3::uuid) AS result",
        [secret, c.request_id, c.attempt_id],
      ),
    recover: (c) =>
      invoke(
        "SELECT app_moderation_v2.p3_recover_evaluation($1::text,$2::uuid,$3::uuid) AS result",
        [secret, c.request_id, c.attempt_id],
      ),
  };
}
