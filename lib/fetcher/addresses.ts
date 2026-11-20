// SSRF guard, part 1: which IP addresses the server may connect to.
// Everything that isn't plainly a public unicast address is refused.
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();

// IPv4
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}

// IPv6. Note: no "::/n" rules here. Node's BlockList matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so "::ffff:0:0/96" would block every IPv4 address. Addresses that
// start with "::" (unspecified, loopback, v4-mapped/compatible) are refused in code below.
for (const [net, prefix] of [
  ["64:ff9b::", 96], // NAT64 (could map to anything)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (Teredo etc.)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped/compatible IPv6 address, if any. */
function embeddedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) return dotted[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return null;
}

/** True when the server must NOT connect to this address. Unparseable = blocked. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    // Canonical form first, so 0:0:0:0:0:0:0:1 and 0000::1 become ::1.
    const canonical = new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (canonical !== ip.toLowerCase()) return isBlockedAddress(canonical);
    // ::, ::1, ::ffff:a.b.c.d, ::a.b.c.d, ::7f00:1 ... Public unicast (2000::/3) never starts with "::".
    if (ip.startsWith("::") || embeddedIPv4(ip) !== null) return true;
    return blocked.check(ip, "ipv6");
  }
  return true;
}
