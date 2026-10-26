import { z } from "zod";
import { runChatSafetyBatch, type ChatSafetyClient } from "../../../src/lib/chat-v2/safety-worker.ts";

const configSchema = z.object({
  supabaseUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === "/";
  }),
  // This hosted default is the existing legacy service-role credential, not a new API-key JWT.
  serviceRoleKey: z.string().min(20).max(4096).refine(value => !/^sb_(?:secret|publishable)_/.test(value)),
});

export interface ChatSafetyHandlerDependencies {
  getConfiguration(): unknown;
  createClient(url: string, key: string): ChatSafetyClient;
}

const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

/** The Vault verification RPC is the sole permitted DB operation before authentication. */
export function createChatSafetyHandler(deps: ChatSafetyHandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      const response = reply(405, { error: "Method not allowed" });
      response.headers.set("Allow", "POST");
      return response;
    }
    const token = request.headers.get("x-chat-safety-worker-secret");
    // Do not accept Bearer credentials, publishable keys or a caller-selected config/body.
    if (!token || token.length !== 64 || !/^[a-f0-9]{64}$/.test(token)) return reply(401, { error: "Unauthorized" });
    try {
      const config = configSchema.safeParse(deps.getConfiguration());
      if (!config.success) return reply(503, { error: "Worker unavailable" });
      const client = deps.createClient(config.data.supabaseUrl, config.data.serviceRoleKey);
      let authorized = false;
      try {
        const result = await client.rpc("verify_chat_safety_worker_secret", { candidate: token });
        authorized = !result.error && result.data === true;
      } catch {
        // No upstream error bodies or candidate credentials enter responses/logs.
      }
      if (!authorized) return reply(401, { error: "Unauthorized" });
      const result = await runChatSafetyBatch(client);
      return reply(result.failed ? 503 : 200, result);
    } catch {
      return reply(503, { error: "Worker unavailable" });
    }
  };
}
