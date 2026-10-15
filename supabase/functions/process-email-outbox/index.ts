// FairSwap Edge Function: process-email-outbox
// Triggered by Database Webhook on email_outbox INSERT or scheduled batch runner

import { createClient } from "@supabase/supabase-js";
import { handleOutboxWorkerRequest, WorkerConfigSchema } from "../_shared/email-outbox-worker";

// Global Deno declaration for type safety
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response>): void;
};

// Edge function runner
if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(async (req: Request) => {
    // 1. Fail closed on worker configuration (no silent defaults to production values)
    const rawEnv = {
      supabaseUrl: Deno.env.get("SUPABASE_URL"),
      supabaseServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      resendApiKey: Deno.env.get("RESEND_API_KEY"),
      emailFrom: Deno.env.get("EMAIL_FROM"),
      siteUrl: Deno.env.get("SITE_URL"),
      emailWorkerSecret: Deno.env.get("EMAIL_WORKER_SECRET"),
    };

    const parsedConfig = WorkerConfigSchema.safeParse(rawEnv);
    if (!parsedConfig.success) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid worker configuration" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const config = parsedConfig.data;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    return handleOutboxWorkerRequest(req, config, supabase);
  });
}
