import { createHash } from "node:crypto";

// TEMPORARY (remove once Inngest sync works): describes a signing key WITHOUT revealing it,
// so an admin can compare it with the key copied from the Inngest dashboard.
//
// The fingerprint matches how the SDK signs requests: it strips the "signkey-<env>-" prefix
// and uses the rest, as UTF-8 text, as the HMAC key. So if two keys give the same
// fingerprint, the SDK will verify Inngest's signatures with either.
// Showing 8 hex chars (32 bits) of a hash of a ~256-bit random key reveals nothing usable.

export type SigningKeyDiagnostic = {
  /** Env var the client took the key from, e.g. "APP_INNGEST_SIGNING_KEY". */
  variable: string;
  present: boolean;
  /** Length of the key the client uses (after trimming). */
  length: number | null;
  /** Whether the RAW env var value has leading/trailing whitespace (trimmed before use). */
  rawHasOuterWhitespace: boolean;
  /** Prefix up to the second dash, e.g. "signkey-prod". */
  prefix: string | null;
  /** First 8 hex chars of SHA-256(key without "signkey-<env>-", as UTF-8). */
  sha256First8: string | null;
};

const SDK_PREFIX = /^signkey-[\w]+-/; // same pattern as the Inngest SDK's removeSigningKeyPrefix

export function signingKeyFingerprint(key: string): string {
  return createHash("sha256").update(key.replace(SDK_PREFIX, ""), "utf8").digest("hex").slice(0, 8);
}

export function describeSigningKey(
  variable: string,
  effectiveKey: string | undefined,
  rawValue: string | undefined,
): SigningKeyDiagnostic {
  if (!effectiveKey) {
    return {
      variable,
      present: false,
      length: null,
      rawHasOuterWhitespace: rawValue !== undefined && rawValue !== rawValue.trim(),
      prefix: null,
      sha256First8: null,
    };
  }
  return {
    variable,
    present: true,
    length: effectiveKey.length,
    rawHasOuterWhitespace: rawValue !== undefined && rawValue !== rawValue.trim(),
    prefix: effectiveKey.match(/^([^-]+-[^-]+)-/)?.[1] ?? null,
    sha256First8: signingKeyFingerprint(effectiveKey),
  };
}
