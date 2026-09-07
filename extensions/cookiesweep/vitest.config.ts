import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest({ root: import.meta.dirname })],
  test: {
    name: "cookiesweep",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
