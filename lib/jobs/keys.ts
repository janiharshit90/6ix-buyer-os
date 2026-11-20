import type { InngestEnv } from "@/lib/env/server";

export type InngestKeyOptions = {
  eventKey?: string;
  signingKey?: string;
  signingKeyFallback?: string;
};

/**
 * Explicit Inngest client options from the APP_INNGEST_* variables. Keys left out here are
 * read by the SDK from the standard INNGEST_* variables (local dev, CI, the integration).
 *
 * When APP_INNGEST_SIGNING_KEY is set, the fallback is pinned too (to the APP fallback, or
 * to the same key). Otherwise the SDK would still accept INNGEST_SIGNING_KEY_FALLBACK, which
 * may belong to the other Inngest account the locked integration points at.
 */
export function inngestKeyOptions(env: InngestEnv): InngestKeyOptions {
  const options: InngestKeyOptions = {};
  if (env.APP_INNGEST_EVENT_KEY) options.eventKey = env.APP_INNGEST_EVENT_KEY;
  if (env.APP_INNGEST_SIGNING_KEY) {
    options.signingKey = env.APP_INNGEST_SIGNING_KEY;
    options.signingKeyFallback =
      env.APP_INNGEST_SIGNING_KEY_FALLBACK ?? env.APP_INNGEST_SIGNING_KEY;
  }
  return options;
}

/** Which source each key comes from, for logs and diagnostics. Never the values. */
export function inngestKeySources(env: InngestEnv) {
  return {
    eventKey: env.APP_INNGEST_EVENT_KEY ? "APP_INNGEST_EVENT_KEY" : "INNGEST_EVENT_KEY",
    signingKey: env.APP_INNGEST_SIGNING_KEY ? "APP_INNGEST_SIGNING_KEY" : "INNGEST_SIGNING_KEY",
  } as const;
}
