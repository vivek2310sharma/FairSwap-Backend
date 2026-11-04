import { describe, it, expect, vi } from "vitest";
import { resolveModerationMode } from "../../supabase/functions/_shared/moderation-mode-selector";

describe("Server-Side Moderation Mode Selector", () => {
  const createMockSupabase = (settings: Record<string, string | null>, error: any = null) => {
    const queryResult = {
      data: Object.entries(settings).map(([setting_key, setting_value]) => ({
        setting_key,
        setting_value,
      })),
      error,
    };

    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue(queryResult),
        }),
      }),
    } as any;
  };

  it("disables automation when moderation_automation_enabled is false", async () => {
    const supabase = createMockSupabase({
      moderation_automation_enabled: "false",
      moderation_azure_enabled: "true",
      moderation_google_cloud_enabled: "false",
    });

    const res = await resolveModerationMode(supabase);
    expect(res.enabled).toBe(false);
    expect(res.reason).toBe("MODERATION_AUTOMATION_DISABLED");
    expect(res.mode).toBeUndefined();
  });

  it("selects baseline mode when both Azure and Google Cloud are false", async () => {
    const supabase = createMockSupabase({
      moderation_automation_enabled: "true",
      moderation_azure_enabled: "false",
      moderation_google_cloud_enabled: "false",
    });

    const res = await resolveModerationMode(supabase);
    expect(res.enabled).toBe(true);
    expect(res.mode).toBe("baseline");
    expect(res.error).toBeUndefined();
  });

  it("selects azure mode when moderation_azure_enabled is true", async () => {
    const supabase = createMockSupabase({
      moderation_automation_enabled: "true",
      moderation_azure_enabled: "true",
      moderation_google_cloud_enabled: "false",
    });

    const res = await resolveModerationMode(supabase);
    expect(res.enabled).toBe(true);
    expect(res.mode).toBe("azure");
    expect(res.error).toBeUndefined();
  });

  it("fails closed on conflicting configuration (both providers enabled)", async () => {
    const supabase = createMockSupabase({
      moderation_automation_enabled: "true",
      moderation_azure_enabled: "true",
      moderation_google_cloud_enabled: "true",
    });

    const res = await resolveModerationMode(supabase);
    expect(res.enabled).toBe(false);
    expect(res.error).toBe("MODERATION_PROVIDER_CONFLICT_FAIL_CLOSED");
    expect(res.mode).toBeUndefined();
  });

  it("identifies google_cloud mode when moderation_google_cloud_enabled is true", async () => {
    const supabase = createMockSupabase({
      moderation_automation_enabled: "true",
      moderation_azure_enabled: "false",
      moderation_google_cloud_enabled: "true",
    });

    const res = await resolveModerationMode(supabase);
    expect(res.enabled).toBe(true);
    expect(res.mode).toBe("google_cloud");
  });

  it("fails closed when any required system setting is missing from database", async () => {
    const supabase = createMockSupabase({
      moderation_automation_enabled: "true",
      // moderation_azure_enabled missing
      moderation_google_cloud_enabled: "false",
    });

    const res = await resolveModerationMode(supabase);
    expect(res.enabled).toBe(false);
    expect(res.error).toContain("MISSING_SYSTEM_SETTING: moderation_azure_enabled");
  });

  it("fails closed on database query error", async () => {
    const supabase = createMockSupabase({}, { message: "connection refused" });

    const res = await resolveModerationMode(supabase);
    expect(res.enabled).toBe(false);
    expect(res.error).toBe("SYSTEM_SETTINGS_QUERY_FAILED: connection refused");
  });
});
