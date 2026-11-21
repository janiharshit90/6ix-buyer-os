// Test-only host mapping for e2e (Decisions log M3): FETCHER_TEST_HOSTS lets the fetcher
// reach a local fixture server, which the SSRF rules otherwise block. Strictly limited:
//   - only names under the reserved .test TLD (never resolvable on the public internet)
//   - only to loopback addresses
//   - refused outright on Vercel (VERCEL_ENV set), whatever else is configured
//   - refused in production builds unless ALLOW_E2E_TEST_HOSTS=1 (only the e2e run sets it)
// Format: "lander.fixture.test=127.0.0.1:3198,offer.fixture.test=127.0.0.1:3198"

export type TestHostMap = ReadonlyMap<string, { address: string; port: number }>;

export function parseTestHosts(env: NodeJS.ProcessEnv = process.env): TestHostMap {
  const raw = env.FETCHER_TEST_HOSTS?.trim();
  if (!raw) return new Map();
  if (env.VERCEL_ENV) {
    throw new Error("FETCHER_TEST_HOSTS is test-only and is refused on Vercel.");
  }
  // SEC-3: also refused in any production build, except the e2e run (playwright.config.ts sets
  // ALLOW_E2E_TEST_HOSTS=1 for its own `next start`).
  if (env.NODE_ENV === "production" && env.ALLOW_E2E_TEST_HOSTS !== "1") {
    throw new Error("FETCHER_TEST_HOSTS is test-only and is refused in production builds.");
  }
  const map = new Map<string, { address: string; port: number }>();
  for (const entry of raw.split(",")) {
    const m = entry
      .trim()
      .match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.test)=(127\.0\.0\.1|\[::1\]):(\d{2,5})$/i);
    if (!m?.[1] || !m[2] || !m[3]) {
      throw new Error(
        "FETCHER_TEST_HOSTS entries must look like name.test=127.0.0.1:PORT (only .test names, only loopback).",
      );
    }
    map.set(m[1].toLowerCase(), { address: m[2].replace(/^\[|\]$/g, ""), port: Number(m[3]) });
  }
  return map;
}
