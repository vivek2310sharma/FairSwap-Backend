import { createClient } from "@supabase/supabase-js";
import { createChatSafetyHandler } from "../_shared/chat-safety-worker-handler.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

export const processChatSafetyHandler = createChatSafetyHandler({
  getConfiguration: () => ({
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  }),
  createClient: (url, key) => createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }),
});

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(processChatSafetyHandler);
}
