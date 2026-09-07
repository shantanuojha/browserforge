import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "licensing",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
