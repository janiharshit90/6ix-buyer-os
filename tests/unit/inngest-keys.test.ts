import { Inngest } from "inngest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getInngestEnv } from "@/lib/env/server";
import { inngestKeyOptions, inngestKeySources } from "@/lib/jobs/keys";

// Fake values only. They never leave this file and are never real keys.
const APP_SIGNING = "signkey-test-app-0000";
const APP_FALLBACK = "signkey-test-appfallback-0000";
const STD_SIGNING = "signkey-test-standard-1111";
const STD_FALLBACK = "signkey-test-standardfallback-1111";

const env = (vars: Record<string, string>) => getInngestEnv(vars as unknown as NodeJS.ProcessEnv);

afterEach(() => vi.unstubAllEnvs());

describe("inngestKeyOptions", () => {
  it("without APP_ names: no explicit options, so the SDK reads INNGEST_* (local dev, CI)", () => {
    expect(inngestKeyOptions(env({}))).toEqual({});
    expect(inngestKeySources(env({}))).toEqual({
      eventKey: "INNGEST_EVENT_KEY",
      signingKey: "INNGEST_SIGNING_KEY",
    });
  });

  it("blank APP_ values count as unset", () => {
    expect(
      inngestKeyOptions(env({ APP_INNGEST_EVENT_KEY: "  ", APP_INNGEST_SIGNING_KEY: "" })),
    ).toEqual({});
  });

  it("APP signing key wins and pins the fallback to itself", () => {
    expect(inngestKeyOptions(env({ APP_INNGEST_SIGNING_KEY: APP_SIGNING }))).toEqual({
      signingKey: APP_SIGNING,
      signingKeyFallback: APP_SIGNING,
    });
  });

  it("APP fallback is used when given", () => {
    expect(
      inngestKeyOptions(
        env({
          APP_INNGEST_SIGNING_KEY: APP_SIGNING,
          APP_INNGEST_SIGNING_KEY_FALLBACK: APP_FALLBACK,
        }),
      ),
    ).toEqual({ signingKey: APP_SIGNING, signingKeyFallback: APP_FALLBACK });
  });

  it("event and signing keys are independent", () => {
    expect(inngestKeyOptions(env({ APP_INNGEST_EVENT_KEY: "test-event-key" }))).toEqual({
      eventKey: "test-event-key",
    });
    expect(inngestKeySources(env({ APP_INNGEST_EVENT_KEY: "test-event-key" }))).toEqual({
      eventKey: "APP_INNGEST_EVENT_KEY",
      signingKey: "INNGEST_SIGNING_KEY",
    });
  });

  it("rejects a non-signing key in a signing variable without echoing it", () => {
    const pasted = "test-event-key-pasted-into-the-wrong-var";
    let message = "";
    try {
      env({ APP_INNGEST_SIGNING_KEY: pasted });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("APP_INNGEST_SIGNING_KEY");
    expect(message).not.toContain(pasted);
  });
});

describe("the real Inngest client", () => {
  it("uses the APP_ keys even when the locked INNGEST_* ones are set", () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", STD_SIGNING);
    vi.stubEnv("INNGEST_SIGNING_KEY_FALLBACK", STD_FALLBACK);
    vi.stubEnv("INNGEST_EVENT_KEY", "test-standard-event-key");
    const client = new Inngest({
      id: "test",
      ...inngestKeyOptions(
        env({
          APP_INNGEST_SIGNING_KEY: APP_SIGNING,
          APP_INNGEST_EVENT_KEY: "test-app-event-key",
        }),
      ),
    });
    expect(client.signingKey).toBe(APP_SIGNING);
    // The other account's fallback must not be accepted.
    expect(client.signingKeyFallback).toBe(APP_SIGNING);
    expect(client.eventKey).toBe("test-app-event-key");
  });

  it("falls back to the standard INNGEST_* names when no APP_ names are set", () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", STD_SIGNING);
    vi.stubEnv("INNGEST_EVENT_KEY", "test-standard-event-key");
    const client = new Inngest({ id: "test", ...inngestKeyOptions(env({})) });
    expect(client.signingKey).toBe(STD_SIGNING);
    expect(client.eventKey).toBe("test-standard-event-key");
  });
});

describe("APP_INNGEST_* values are trimmed when loaded", () => {
  it("strips spaces, tabs and newlines from pasted keys", () => {
    const loaded = getInngestEnv({
      APP_INNGEST_SIGNING_KEY: `  ${APP_SIGNING}\r\n`,
      APP_INNGEST_EVENT_KEY: "\ttest-event-key ",
    } as unknown as NodeJS.ProcessEnv);
    expect(loaded.APP_INNGEST_SIGNING_KEY).toBe(APP_SIGNING);
    expect(inngestKeyOptions(loaded)).toEqual({
      eventKey: "test-event-key",
      signingKey: APP_SIGNING,
      signingKeyFallback: APP_SIGNING,
    });
  });
});
