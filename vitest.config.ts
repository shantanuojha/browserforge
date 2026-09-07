import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each package/extension owns its own vitest.config.ts; this root config
    // just fans out to them so `pnpm test` runs everything.
    projects: ["packages/*", "extensions/*"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
