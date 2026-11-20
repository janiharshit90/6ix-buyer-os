import { defineConfig, devices } from "@playwright/test";

import { localStack } from "./tests/integration/local-supabase";

const PORT = 3100;
const STUB_PORT = 3199;
const baseURL = `http://localhost:${PORT}`;
const stack = localStack();

// CI (and `E2E_PROD=1 pnpm test:e2e` locally) tests a PRODUCTION build: `next build` +
// `next start`. Locally by default it's `next dev` for fast iteration, which compiles each
// route on first hit, so dev mode gets longer timeouts.
const prod = Boolean(process.env.CI) || process.env.E2E_PROD === "1";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  // Production: Playwright defaults (5s assertions, 30s tests). Dev: on-demand compiles
  // under parallel load can pass 5s on their own (seen on main before M2 too).
  ...(prod ? {} : { expect: { timeout: 15_000 }, timeout: 60_000 }),
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Stand-in for the Anthropic API (tests/e2e/anthropic-stub.mjs): e2e never calls the
      // real API, and production builds can't use AI_FAKE (refused when NODE_ENV=production).
      command: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/e2e/anthropic-stub.mjs",
      url: `http://127.0.0.1:${STUB_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { ANTHROPIC_STUB_PORT: String(STUB_PORT) },
    },
    {
      // Its own port + env, always wired to the LOCAL stack (overrides .env.local).
      command: prod
        ? `npx next build && npx next start --port ${PORT}`
        : `npx next dev --port ${PORT}`,
      url: `${baseURL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: prod ? 420_000 : 180_000,
      env: {
        NEXT_PUBLIC_SUPABASE_URL: stack.url,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
        SUPABASE_SECRET_KEY: stack.secretKey,
        NEXT_PUBLIC_SITE_URL: baseURL,
        BOOTSTRAP_ADMIN_EMAIL: "",
        // The real SDK, pointed at the local stub. Placeholder key: the stub ignores it.
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
        ANTHROPIC_API_KEY: "e2e-stub-key-not-real",
        AI_FAKE: "",
      },
    },
  ],
});
