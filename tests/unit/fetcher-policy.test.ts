import { describe, expect, it } from "vitest";

import { isBlockedAddress } from "@/lib/fetcher/addresses";
import { checkUrl } from "@/lib/fetcher/policy";
import { parseTestHosts } from "@/lib/fetcher/test-hosts";
import { isTrackerHost } from "@/lib/fetcher/trackers";

describe("isBlockedAddress (SSRF part 1)", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // AWS/GCP/Azure metadata
    "169.254.170.2", // ECS task metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "198.18.0.1",
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "0000::1",
    "0:0:0:0:0:ffff:7f00:1",
    "FE80::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "ff02::1",
    "not-an-ip",
    "",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "104.16.132.229", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe("checkUrl (SSRF part 2: URL rules)", () => {
  it.each([
    ["file:///etc/passwd", "bad_scheme"],
    ["javascript:alert(1)", "bad_scheme"],
    ["ftp://example.com/x", "bad_scheme"],
    ["gopher://example.com/", "bad_scheme"],
    ["data:text/html,hi", "bad_scheme"],
    ["https://user:pass@shop.com/", "credentials"],
    ["https://shop.com:8443/", "bad_port"],
    ["http://shop.com:22/", "bad_port"],
    ["http://localhost/", "blocked_host"],
    ["http://LOCALHOST./", "blocked_host"],
    ["http://app.localhost/", "blocked_host"],
    ["http://127.0.0.1/", "blocked_host"],
    ["http://2130706433/", "blocked_host"], // decimal 127.0.0.1
    ["http://0x7f.1/", "blocked_host"], // hex shorthand
    ["http://017700000001/", "blocked_host"], // octal
    ["http://127.1/", "blocked_host"],
    ["http://[::1]/", "blocked_host"],
    ["http://[::ffff:127.0.0.1]/", "blocked_host"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_host"],
    ["http://[fd00:ec2::254]/", "blocked_host"], // AWS IPv6 metadata
    ["http://metadata.google.internal/computeMetadata/v1/", "blocked_host"],
    ["http://metadata/", "blocked_host"],
    ["http://intranet/", "blocked_host"], // single label
    ["http://db.internal/", "blocked_host"],
    ["http://printer.local/", "blocked_host"],
    ["http://10.0.0.1/", "blocked_host"],
    ["https://track.redtrack.io/click?id=1", "tracking_link"],
    ["https://abc.rdtk.io/x", "tracking_link"],
    ["https://go.clickflare.io/x", "tracking_link"],
    ["https://x.voluum.com/", "tracking_link"],
    ["https://aff.go2cloud.org/aff_c?offer_id=1", "tracking_link"],
    ["not a url", "invalid_url"],
  ])("refuses %s (%s)", (url, reason) => {
    const result = checkUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it.each([
    "https://shop.com/lp?utm_source=fb",
    "http://www.example.org/",
    "https://[2606:4700:4700::1111]/",
  ])("allows %s", (url) => {
    expect(checkUrl(url).ok).toBe(true);
  });

  it("lets only explicitly mapped test hosts through", () => {
    const testHosts = new Set(["lander.fixture.test"]);
    expect(checkUrl("http://lander.fixture.test/", { testHosts }).ok).toBe(true);
    expect(checkUrl("http://other.fixture.test/", { testHosts }).ok).toBe(false);
  });
});

describe("trackers", () => {
  it("matches the domain and its subdomains, not look-alikes", () => {
    expect(isTrackerHost("redtrack.io")).toBe(true);
    expect(isTrackerHost("x.y.redtrack.io")).toBe(true);
    expect(isTrackerHost("notredtrack.io")).toBe(false);
  });
});

describe("FETCHER_TEST_HOSTS (test-only escape hatch)", () => {
  it("maps .test names to loopback", () => {
    const map = parseTestHosts({
      FETCHER_TEST_HOSTS: "lander.fixture.test=127.0.0.1:3198",
    } as unknown as NodeJS.ProcessEnv);
    expect(map.get("lander.fixture.test")).toEqual({ address: "127.0.0.1", port: 3198 });
  });

  it.each([
    "evil.com=127.0.0.1:80", // not .test
    "lander.fixture.test=10.0.0.1:80", // not loopback
    "lander.fixture.test=169.254.169.254:80",
    "lander.fixture.test", // malformed
  ])("refuses %s", (value) => {
    expect(() =>
      parseTestHosts({ FETCHER_TEST_HOSTS: value } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("is refused outright on Vercel", () => {
    expect(() =>
      parseTestHosts({
        FETCHER_TEST_HOSTS: "lander.fixture.test=127.0.0.1:3198",
        VERCEL_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/refused on Vercel/);
  });

  it("is empty when unset", () => {
    expect(parseTestHosts({} as unknown as NodeJS.ProcessEnv).size).toBe(0);
  });
});
