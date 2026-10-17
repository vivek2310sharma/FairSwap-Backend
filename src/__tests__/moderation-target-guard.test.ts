import { describe, it, expect } from "vitest";
import { validateTestTargetConfig } from "@/lib/moderation/target-guard";

describe("MOD-03A Test Target Guard & Safety Verification", () => {
  it("allows disabled mode with zero connection configuration", () => {
    const res = validateTestTargetConfig({});
    expect(res.isOptedIn).toBe(false);
  });

  it("rejects opted-in run when MOD03A_TASK_RUN_ID is missing or empty", () => {
    expect(() =>
      validateTestTargetConfig({
        MOD03A_RUN_LOCAL_DB_TESTS: "true",
        MOD03A_TASK_RUN_ID: "",
        MOD03A_DB_HOST: "127.0.0.1",
        MOD03A_DB_PORT: "5433",
      })
    ).toThrow("MOD03A_TASK_RUN_ID must be explicitly set and non-empty");

    expect(() =>
      validateTestTargetConfig({
        MOD03A_RUN_LOCAL_DB_TESTS: "true",
        MOD03A_DB_HOST: "127.0.0.1",
        MOD03A_DB_PORT: "5433",
      })
    ).toThrow("MOD03A_TASK_RUN_ID must be explicitly set and non-empty");
  });

  it("rejects opted-in run when MOD03A_DB_HOST is missing or invalid", () => {
    expect(() =>
      validateTestTargetConfig({
        MOD03A_RUN_LOCAL_DB_TESTS: "true",
        MOD03A_TASK_RUN_ID: "mod03a_run_123",
        MOD03A_DB_HOST: "",
        MOD03A_DB_PORT: "5433",
      })
    ).toThrow("MOD03A_DB_HOST must be explicitly specified");

    expect(() =>
      validateTestTargetConfig({
        MOD03A_RUN_LOCAL_DB_TESTS: "true",
        MOD03A_TASK_RUN_ID: "mod03a_run_123",
        MOD03A_DB_HOST: "db.staging.example.com",
        MOD03A_DB_PORT: "5433",
      })
    ).toThrow("not on the loopback allowlist");
  });

  it("rejects opted-in run when MOD03A_DB_PORT is missing or non-integer", () => {
    expect(() =>
      validateTestTargetConfig({
        MOD03A_RUN_LOCAL_DB_TESTS: "true",
        MOD03A_TASK_RUN_ID: "mod03a_run_123",
        MOD03A_DB_HOST: "127.0.0.1",
        MOD03A_DB_PORT: "abc",
      })
    ).toThrow("MOD03A_DB_PORT must be an explicitly specified integer");
  });

  describe("HTTP PostgREST Target URL Validation", () => {
    const validBase = {
      MOD03A_RUN_LOCAL_DB_TESTS: "true",
      MOD03A_TASK_RUN_ID: "mod03a_task_run_valid",
      MOD03A_DB_HOST: "127.0.0.1",
      MOD03A_DB_PORT: "54322",
      MOD03A_DB_NAME: "postgres",
    };

    it("rejects non-loopback / hosted HTTP targets (e.g. Supabase cloud, staging, production)", () => {
      expect(() =>
        validateTestTargetConfig({
          ...validBase,
          NEXT_PUBLIC_SUPABASE_URL: "https://xyz.supabase.co",
        })
      ).toThrow("Insecure/unsupported protocol");

      expect(() =>
        validateTestTargetConfig({
          ...validBase,
          NEXT_PUBLIC_SUPABASE_URL: "http://api.fairswap.com",
        })
      ).toThrow("not on the loopback allowlist. Hosted environments are strictly forbidden.");

      expect(() =>
        validateTestTargetConfig({
          ...validBase,
          NEXT_PUBLIC_SUPABASE_URL: "http://192.168.1.50:54321",
        })
      ).toThrow("not on the loopback allowlist");
    });

    it("rejects malformed URLs and embedded credentials", () => {
      expect(() =>
        validateTestTargetConfig({
          ...validBase,
          NEXT_PUBLIC_SUPABASE_URL: "not-a-url",
        })
      ).toThrow("Invalid NEXT_PUBLIC_SUPABASE_URL format");

      expect(() =>
        validateTestTargetConfig({
          ...validBase,
          NEXT_PUBLIC_SUPABASE_URL: "http://user:pass@127.0.0.1:54321",
        })
      ).toThrow("Embedded credentials in NEXT_PUBLIC_SUPABASE_URL are forbidden");
    });

    it("accepts valid explicitly configured target and run identity on loopback", () => {
      const res = validateTestTargetConfig({
        ...validBase,
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      });
      expect(res.isOptedIn).toBe(true);
      expect(res.runId).toBe("mod03a_task_run_valid");
      expect(res.host).toBe("127.0.0.1");
      expect(res.port).toBe(54322);
      expect(res.db).toBe("postgres");
      expect(res.restUrl).toBe("http://127.0.0.1:54321");
    });
  });
});
