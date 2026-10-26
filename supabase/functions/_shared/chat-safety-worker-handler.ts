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

const countsSchema=z.object({claimed:z.number().int().min(0).max(20),completed:z.number().int().min(0).max(20),failed:z.number().int().min(0).max(20)});
const beginSchema=z.union([
  countsSchema.extend({state:z.literal("completed")}).strict(),
  z.object({state:z.literal("claimed"),lease_token:z.string().uuid()}).strict(),
  z.object({state:z.enum(["disabled","busy","failed","exhausted"])}).strict(),
]);

/** The Vault verification RPC is the sole permitted DB operation before authentication. */
export function createChatSafetyHandler(deps: ChatSafetyHandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      const response = reply(405, { error: "Method not allowed" });
      response.headers.set("Allow", "POST");
      return response;
    }
    const legacyToken=request.headers.get("x-chat-safety-worker-secret");
    const authorization=request.headers.get("authorization");
    // Dedicated opaque credential, NOT a user JWT/API key. Never log headers or request objects.
    if(legacyToken&&authorization)return reply(401,{error:"Unauthorized"});
    const token=authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]??(!authorization?legacyToken:null);
    if (!token || token.length !== 64 || !/^[a-f0-9]{64}$/.test(token)) return reply(401, { error: "Unauthorized" });
    const invocation=request.headers.get("x-chat-safety-invocation-id");
    const target=request.headers.get("x-chat-safety-target");
    if(!invocation||!target||!['test','prod'].includes(target)||!new RegExp(`^gha:[1-9][0-9]{0,19}:${target}$`).test(invocation))return reply(400,{error:"Invalid schedule"});
    try {
      const config = configSchema.safeParse(deps.getConfiguration());
      if (!config.success) return reply(503, { error: "Worker unavailable" });
      const expected=target==='test'?'wpppxlnbzqynvhpeuavd':'kriuhwppxgxsyyrbjsau';
      if(new URL(config.data.supabaseUrl).origin!==`https://${expected}.supabase.co`)return reply(503,{error:"Worker unavailable"});
      const client = deps.createClient(config.data.supabaseUrl, config.data.serviceRoleKey);
      let authorized = false;
      try {
        const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
        const digest=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
        const result = await client.rpc("verify_chat_safety_worker_digest", { candidate_sha256: digest });
        authorized = !result.error && result.data === true;
      } catch {
        // No upstream error bodies or candidate credentials enter responses/logs.
      }
      if (!authorized) return reply(401, { error: "Unauthorized" });
      const begin=await client.rpc('chat_safety_schedule_begin',{invocation_id:invocation,target});
      const parsed=beginSchema.safeParse(begin.data);
      if(begin.error||!parsed.success)return reply(503,{error:"Worker unavailable"});
      if(parsed.data.state==='disabled')return reply(200,{state:'disabled',claimed:0,completed:0,failed:0});
      if(parsed.data.state==='completed'){
        if(parsed.data.failed!==0||parsed.data.claimed!==parsed.data.completed)return reply(503,{error:"Worker unavailable"});
        return reply(200,parsed.data);
      }
      if(parsed.data.state==='busy')return reply(409,{error:'Worker busy'});
      if(parsed.data.state==='failed')return reply(503,{error:'Worker unavailable'});
      if(parsed.data.state==='exhausted')return reply(422,{error:'Schedule exhausted'});
      if(parsed.data.state!=='claimed')return reply(503,{error:'Worker unavailable'});
      const result = await runChatSafetyBatch(client);
      const finish=await client.rpc('chat_safety_schedule_finish',{invocation_id:invocation,lease_token:parsed.data.lease_token,...result});
      if(finish.error||finish.data!==true||result.failed)return reply(503,{error:'Worker unavailable'});
      return reply(200,{state:'completed',...result});
    } catch {
      return reply(503, { error: "Worker unavailable" });
    }
  };
}
