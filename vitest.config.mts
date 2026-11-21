import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
      // `server-only` throws outside React Server Components; tests are server-side anyway.
      "server-only": path.join(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // One file at a time: some tests change global state briefly (e.g. the last-admin race
          // test deactivates other admins), which would leak into files running alongside.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Opt-in, billed: real Anthropic calls. Skipped unless AI_LIVE_TESTS=1. Never in CI.
        extends: true,
        test: {
          name: "live",
          include: ["tests/live/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
        },
      },
    ],
  },
});
