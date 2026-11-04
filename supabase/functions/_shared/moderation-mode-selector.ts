// supabase/functions/_shared/moderation-mode-selector.ts
// Secure server-side moderation mode selector.
// Fails closed if settings conflict, Google Cloud is active, or killswitch vetoes.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ModerationProviderMode = "baseline" | "azure" | "google_cloud";

export interface ModerationSettingsState {
  automationEnabled: boolean;
  azureEnabled: boolean;
  googleCloudEnabled: boolean;
}

export interface ModerationModeResolution {
  enabled: boolean;
  allowed: boolean;
  mode?: ModerationProviderMode;
  reason?: string;
  error?: string;
  settings: ModerationSettingsState;
}

export async function resolveModerationMode(
  supabase: SupabaseClient
): Promise<ModerationModeResolution> {
  const { data, error } = await supabase
    .from("app_system_settings")
    .select("setting_key, setting_value")
    .in("setting_key", [
      "moderation_automation_enabled",
      "moderation_azure_enabled",
      "moderation_google_cloud_enabled",
    ]);

  if (error) {
    return {
      enabled: false,
      allowed: false,
      error: `SYSTEM_SETTINGS_QUERY_FAILED: ${error.message}`,
      settings: { automationEnabled: false, azureEnabled: false, googleCloudEnabled: false },
    };
  }

  if (!data) {
    return {
      enabled: false,
      allowed: false,
      error: "FAILED_TO_LOAD_MODERATION_SETTINGS: NO_DATA",
      settings: { automationEnabled: false, azureEnabled: false, googleCloudEnabled: false },
    };
  }

  const map = new Map<string, string>();
  for (const row of data) {
    map.set(row.setting_key, row.setting_value);
  }

  // Ensure all required system settings exist in database
  const requiredKeys = [
    "moderation_automation_enabled",
    "moderation_azure_enabled",
    "moderation_google_cloud_enabled",
  ];
  for (const key of requiredKeys) {
    if (!map.has(key)) {
      return {
        enabled: false,
        allowed: false,
        error: `MISSING_SYSTEM_SETTING: ${key}`,
        settings: { automationEnabled: false, azureEnabled: false, googleCloudEnabled: false },
      };
    }
  }

  const automationEnabled = map.get("moderation_automation_enabled") === "true";
  const azureEnabled = map.get("moderation_azure_enabled") === "true";
  const googleCloudEnabled = map.get("moderation_google_cloud_enabled") === "true";

  const settings: ModerationSettingsState = {
    automationEnabled,
    azureEnabled,
    googleCloudEnabled,
  };

  // Kill switch: when moderation_automation_enabled is false, automation is disabled
  if (!automationEnabled) {
    return {
      enabled: false,
      allowed: false,
      reason: "MODERATION_AUTOMATION_DISABLED",
      settings,
    };
  }

  // Rule 2 & 4: Both provider flags true must fail closed
  if (azureEnabled && googleCloudEnabled) {
    return {
      enabled: false,
      allowed: false,
      error: "MODERATION_PROVIDER_CONFLICT_FAIL_CLOSED",
      settings,
    };
  }

  // Rule 2 & 4: Google Cloud enabled without an implemented adapter must fail closed
  if (googleCloudEnabled) {
    return {
      enabled: true,
      allowed: false,
      mode: "google_cloud",
      error: "UNIMPLEMENTED_PROVIDER: Google Cloud moderation adapter is not configured or implemented",
      settings,
    };
  }

  if (azureEnabled) {
    return {
      enabled: true,
      allowed: true,
      mode: "azure",
      settings,
    };
  }

  // Baseline default when neither cloud provider switch is active
  return {
    enabled: true,
    allowed: true,
    mode: "baseline",
    settings,
  };
}
