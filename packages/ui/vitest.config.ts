import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    name: "ui",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
