import { classifyIndiaChatSafety } from "../moderation/v2/india-fraud.ts";
import { z } from "zod";

interface RpcResult { data: unknown; error: unknown }
export interface ChatSafetyClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
}

const batchSchema = z.array(z.object({
  message_id: z.string().uuid(), lease_token: z.string().uuid(), content: z.string().max(2000),
}).strict()).max(20);

/** Inject a server/service client. No environment loading, transport, or content logs. */
export async function runChatSafetyBatch(client: ChatSafetyClient): Promise<{
  claimed: number; completed: number; failed: number;
}> {
  let claim: RpcResult;
  try {
    claim = await client.rpc("chat_safety_claim", { batch_size: 20 });
  } catch {
    throw new Error("CHAT_SAFETY_CLAIM_FAILED");
  }
  const parsed = batchSchema.safeParse(claim.data);
  if (claim.error || !parsed.success) {
    throw new Error("CHAT_SAFETY_CLAIM_FAILED");
  }
  let completed = 0;
  for (const job of parsed.data) {
    try {
      const result = classifyIndiaChatSafety(job.content);
      const response = await client.rpc("chat_safety_complete", {
        message_id: job.message_id, lease_token: job.lease_token, rule_ids: result.rule_ids,
      });
      if (!response.error && response.data === true) completed++;
    } catch {
      // Lease expiry provides bounded retry. Never log raw upstream errors/content.
    }
  }
  return { claimed: parsed.data.length, completed, failed: parsed.data.length - completed };
}
