import {
  moderationV2Handler,
  type WorkerDependencies,
} from "./listing-moderation-v2-worker.ts";
import {
  type SqlConnection,
  workerDatabase,
} from "./listing-moderation-v2-postgres.ts";

/** Test runtime assembly. Provider/media implementations have no live defaults.
 * The Edge entrypoint supplies the pinned synthetic read-only fixture resolver
 * and mock provider; SQL remains a genuine restricted worker connection.
 */
export function createTestModerationV2Runtime(
  options: Omit<WorkerDependencies, "db"> & {
    connection: SqlConnection;
    workerSecret: string;
    dispatchSecret: string;
  },
) {
  const db = workerDatabase(options.connection, options.workerSecret);
  return moderationV2Handler(options.dispatchSecret, { ...options, db });
}
