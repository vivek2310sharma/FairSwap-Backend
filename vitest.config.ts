import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    globals: false,
    passWithNoTests: false,
    setupFiles: ["./tests/setup/no-network.ts"],
    include: [
      "src/__tests__/moderation-text-checker.test.ts",
      "src/__tests__/moderation-target-guard.test.ts",
      "src/__tests__/moderation-worker.test.ts",
      "src/__tests__/moderation-worker-vault-auth.test.ts",
      "tests/unit/email-outbox-worker.test.ts",
    ],
  },
});
