// SSRF guard, part 2: which URLs may be requested at all. Applied to the requested URL and
// to EVERY redirect hop. Part 1 (addresses.ts) is applied to every resolved address.
import { isIP } from "node:net";

import { isBlockedAddress } from "./addresses";
import { isTrackerHost } from "./trackers";

export type UrlRefusal =
  "invalid_url" | "bad_scheme" | "credentials" | "bad_port" | "blocked_host" | "tracking_link";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRefusal };

const BLOCKED_NAMES =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|test|example|invalid)$/i;
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "instance-data"]);

/**
 * `testHosts`: host names (only under the reserved .test TLD) that tests may map to a local
 * fixture server. Empty in production (see testHosts.ts).
 */
export function checkUrl(raw: string, opts: { testHosts?: ReadonlySet<string> } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: "bad_scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };

  // WHATWG URL already canonicalises IPv4 tricks (2130706433, 0x7f.1, 0177.0.0.1 → 127.0.0.1).
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (opts.testHosts?.has(host)) return { ok: true, url };

  if (url.port !== "") return { ok: false, reason: "bad_port" }; // only the default 80/443
  if (
    !host ||
    METADATA_NAMES.has(host) ||
    BLOCKED_NAMES.test(host) ||
    (!host.includes(".") && !isIP(host.replace(/^\[|\]$/g, "")))
  ) {
    return { ok: false, reason: "blocked_host" };
  }
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isBlockedAddress(literal)) return { ok: false, reason: "blocked_host" };
  if (isTrackerHost(host)) return { ok: false, reason: "tracking_link" };
  return { ok: true, url };
}
