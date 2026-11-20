import { defineConfig, devices } from "@playwright/test";

import { localStack } from "./tests/integration/local-supabase";

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;
const stack = localStack();

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  // `next dev` compiles routes on first hit; under parallel load that alone can pass 5s
  // (seen on main before M2 too). Assertions still fail fast when something is really missing.
  expect: { timeout: 15_000 },
  // Multi-page flows (intake → approve → v2) chain many such compiles.
  timeout: 60_000,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Its own port + env, always wired to the LOCAL stack (overrides .env.local).
    command: `npx next dev --port ${PORT}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: stack.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
      SUPABASE_SECRET_KEY: stack.secretKey,
      NEXT_PUBLIC_SITE_URL: baseURL,
      BOOTSTRAP_ADMIN_EMAIL: "",
      // Canned in-process model: e2e never calls the Anthropic API.
      AI_FAKE: "1",
      ANTHROPIC_API_KEY: "",
    },
  },
});
