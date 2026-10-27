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
    include: ["tests/idv/*.test.ts"],
  },
});
