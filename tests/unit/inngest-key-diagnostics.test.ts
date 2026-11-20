import { describe, expect, it } from "vitest";

import { getInngestEnv } from "@/lib/env/server";
import { describeSigningKey, signingKeyFingerprint } from "@/lib/jobs/key-diagnostics";
import { inngestKeyOptions } from "@/lib/jobs/keys";

// Fake values only.
const FAKE = "signkey-test-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("signing key fingerprint", () => {
  it("is SHA-256 of the key without its signkey-<env>- prefix, as UTF-8 (known vector)", () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(signingKeyFingerprint("signkey-test-abc")).toBe("ba7816bf");
    expect(signingKeyFingerprint("abc")).toBe("ba7816bf");
  });

  it("ignores the environment part of the prefix, like the SDK's signing does", () => {
    expect(signingKeyFingerprint("signkey-prod-abc")).toBe(
      signingKeyFingerprint("signkey-branch-abc"),
    );
  });
});

describe("describeSigningKey", () => {
  it("reports source, length, prefix and fingerprint, never the key", () => {
    const d = describeSigningKey("APP_INNGEST_SIGNING_KEY", FAKE, FAKE);
    expect(d).toEqual({
      variable: "APP_INNGEST_SIGNING_KEY",
      present: true,
      length: FAKE.length,
      rawHasOuterWhitespace: false,
      prefix: "signkey-test",
      sha256First8: signingKeyFingerprint(FAKE),
    });
    const json = JSON.stringify(d);
    expect(json).not.toContain(FAKE.slice("signkey-test-".length));
    expect(json).not.toContain("0123456789abcdef");
  });

  it("flags whitespace in the raw env value", () => {
    expect(describeSigningKey("X", FAKE, ` ${FAKE}\n`).rawHasOuterWhitespace).toBe(true);
  });

  it("handles a missing key", () => {
    expect(describeSigningKey("INNGEST_SIGNING_KEY", undefined, undefined)).toMatchObject({
      present: false,
      length: null,
      prefix: null,
      sha256First8: null,
    });
  });
});

describe("APP_INNGEST_* values are trimmed when loaded", () => {
  it("strips spaces and newlines from pasted keys", () => {
    const env = getInngestEnv({
      APP_INNGEST_SIGNING_KEY: `  ${FAKE}\r\n`,
      APP_INNGEST_EVENT_KEY: "\ttest-event-key ",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.APP_INNGEST_SIGNING_KEY).toBe(FAKE);
    expect(inngestKeyOptions(env)).toEqual({
      eventKey: "test-event-key",
      signingKey: FAKE,
      signingKeyFallback: FAKE,
    });
  });
});
