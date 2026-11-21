// Regression tests for the hardening branch (Gemini audit items verified against the code).
// DB-side items: supabase/tests/database/130_hardening.test.sql. Concurrency + job role:
// tests/integration/hardening.test.ts. Headers, sign-out, Discard, stalled research: e2e.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AiClient } from "@/lib/ai/client";
import { AiError } from "@/lib/ai/errors";
import type { AiLedger, FinishArgs } from "@/lib/ai/ledger";
import { offerCheckV1 } from "@/lib/ai/prompts/offer-check/v1";
import { runStructured } from "@/lib/ai/run";
import { isSameOriginPost } from "@/lib/auth/same-origin";
import { dbMessage } from "@/lib/db/errors";
import { isBlockedAddress } from "@/lib/fetcher/addresses";
import { createPlainFetcher } from "@/lib/fetcher/plain";
import { parseTestHosts } from "@/lib/fetcher/test-hosts";
import type { FetchFailure, FetchedPage } from "@/lib/fetcher/types";
import { CHECK_FIELDS } from "@/lib/offers/check-types";
import { EMPTY_DRAFT, toPayload, withRowKeys } from "@/lib/offers/draft";
import { missingItems } from "@/lib/offers/schema";
import {
  looksCloaked,
  quoteIsSubstantial,
  quoteNamesValue,
  verifyItems,
} from "@/lib/research/fingerprint-rules";
import { researchState, STALLED_AFTER_MS } from "@/lib/research/status";

describe("SEC-3: IPv6 is allowlisted to global unicast", () => {
  it.each(["1000::1", "4000::1", "8000::1", "e000::1", "fec0::1"])(
    "blocks %s (outside 2000::/3)",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    },
  );
  it.each(["2606:4700:4700::1111", "2a00:1450:4001::200e", "3fff:ffff::1"])(
    "allows global %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
  it("still blocks special ranges inside 2000::/3", () => {
    expect(isBlockedAddress("2001:db8::1")).toBe(true);
    expect(isBlockedAddress("2002:7f00:1::")).toBe(true);
  });
});

describe("SEC-3: FETCHER_TEST_HOSTS in production builds", () => {
  const hosts = "lander.fixture.test=127.0.0.1:3198";
  it("is refused when NODE_ENV=production", () => {
    expect(() =>
      parseTestHosts({
        FETCHER_TEST_HOSTS: hosts,
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/refused in production builds/);
  });
  it("is allowed only for the e2e run's production build", () => {
    const map = parseTestHosts({
      FETCHER_TEST_HOSTS: hosts,
      NODE_ENV: "production",
      ALLOW_E2E_TEST_HOSTS: "1",
    } as unknown as NodeJS.ProcessEnv);
    expect(map.size).toBe(1);
  });
  it("is still refused on Vercel even with the e2e flag", () => {
    expect(() =>
      parseTestHosts({
        FETCHER_TEST_HOSTS: hosts,
        NODE_ENV: "production",
        ALLOW_E2E_TEST_HOSTS: "1",
        VERCEL_ENV: "preview",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/refused on Vercel/);
  });
});

describe("SEC-4: quotes must really ground an item", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const pages = [
    {
      id: P,
      title: null,
      text: "Welcome to us. GE appliances and ShieldLife cover in all 50 states.",
    },
  ];
  const empty = {
    brand: [],
    advertiser: [],
    product: [],
    claims: [],
    phrases: [],
    open_questions: [],
  };

  it("rejects 2-3 character quotes unless the quote IS the value", () => {
    expect(quoteIsSubstantial("to", "pwned")).toBe(false);
    expect(quoteIsSubstantial("us", "us")).toBe(true);
    expect(quoteIsSubstantial("cover", "x")).toBe(true);
  });

  it("drops a fabricated brand that borrows an unrelated quote", () => {
    const { lists, dropped } = verifyItems(
      {
        ...empty,
        brand: [
          { value: "PWNED Corp", page_id: P, quote: "to" },
          { value: "Fake Brand", page_id: P, quote: "cover in all" },
        ],
      },
      pages,
    );
    expect(lists.brand).toEqual([]);
    expect(dropped).toBe(2);
  });

  it("keeps a real brand whose name is in the quote, including short names", () => {
    const { lists } = verifyItems(
      {
        ...empty,
        brand: [
          { value: "ShieldLife", page_id: P, quote: "ShieldLife cover" },
          { value: "GE", page_id: P, quote: "GE" },
        ],
      },
      pages,
    );
    expect(lists.brand.map((b) => b.value)).toEqual(["ShieldLife", "GE"]);
  });

  it("checks names by their meaningful tokens", () => {
    expect(quoteNamesValue("ge appliances and more", "ge appliances")).toBe(true);
    expect(quoteNamesValue("welcome to us", "ge appliances")).toBe(false);
  });

  it("claims and phrases don't need to contain their value, only a substantial quote", () => {
    const { lists } = verifyItems(
      {
        ...empty,
        claims: [{ value: "Nationwide coverage", page_id: P, quote: "in all 50 states" }],
      },
      pages,
    );
    expect(lists.claims).toHaveLength(1);
  });
});

describe("SEC-5: sign-out accepts same-origin POSTs only", () => {
  const req = (headers: Record<string, string>) =>
    new NextRequest("https://app.example.com/auth/signout", { method: "POST", headers });
  it("allows our own origin", () => {
    expect(isSameOriginPost(req({ origin: "https://app.example.com" }))).toBe(true);
  });
  it("refuses another site's origin", () => {
    expect(isSameOriginPost(req({ origin: "https://evil.example" }))).toBe(false);
  });
  it("falls back to Sec-Fetch-Site, and refuses when neither header is present", () => {
    expect(isSameOriginPost(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginPost(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginPost(req({}))).toBe(false);
  });
});

describe("BUG-3: a research page that stopped changing is 'stalled', not 'working'", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const project = (msAgo: number, fingerprint_status = "idle") => ({
    status: "active",
    fingerprint_status,
    updated_at: iso(msAgo),
  });
  it("is working while pages are pending and recently changed", () => {
    expect(
      researchState(project(10_000), [{ fetch_status: "pending", updated_at: iso(5_000) }], now),
    ).toEqual({
      busy: true,
      stalled: false,
      working: true,
    });
  });
  it("is stalled when nothing changed for longer than the limit", () => {
    const s = researchState(
      project(STALLED_AFTER_MS + 1),
      [{ fetch_status: "pending", updated_at: iso(STALLED_AFTER_MS + 1) }],
      now,
    );
    expect(s).toEqual({ busy: true, stalled: true, working: false });
  });
  it("is idle when nothing is pending", () => {
    expect(
      researchState(project(1, "done"), [{ fetch_status: "fetched", updated_at: iso(1) }], now)
        .busy,
    ).toBe(false);
  });
});

describe("BUG-7: an AiError after reserving settles the reservation at $0", () => {
  it("settles instead of leaving it pending", async () => {
    const finishes: FinishArgs[] = [];
    const ledger: AiLedger = {
      begin: async () => ({ ok: true, callId: "33333333-3333-4333-8333-333333333333" }),
      finish: async (a) => {
        finishes.push(a);
        return true;
      },
    };
    const client: AiClient = {
      createMessage: async () => {
        throw new AiError("not_configured", "no key", { retryable: false });
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runStructured({
        userId: "u",
        purpose: "t",
        prompt: offerCheckV1,
        input: offerCheckV1.exampleInput,
        ledger,
        client,
      }),
    ).rejects.toBeInstanceOf(AiError);
    expect(finishes).toEqual([
      expect.objectContaining({ status: "failed", costUsd: 0, errorCode: "not_configured" }),
    ]);
    vi.restoreAllMocks();
  });
});

describe("BUG-8: fetcher can't hang on DNS or drain redirect bodies", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big-redirect") {
        res.writeHead(302, { location: "/ok", "content-type": "text/html" });
        // A huge body after the headers: the fetcher must not read it.
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 50 * 1024 * 1024 && res.write(chunk)) sent += chunk.length;
          if (sent < 50 * 1024 * 1024) res.once("drain", pump);
          else res.end();
        };
        res.on("error", () => {});
        pump();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<title>OK</title><p>fine</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("a hanging resolver is cut off by the overall timeout", async () => {
    const fetcher = createPlainFetcher({
      resolver: () => new Promise(() => {}), // never answers
      testHosts: new Map(),
      limits: { timeoutMs: 300 },
    });
    const started = Date.now();
    const r = (await fetcher.fetch("https://slow-dns.example.com/")) as FetchFailure;
    expect(r.errorCode).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("follows a redirect without reading its (huge) body", async () => {
    const fetcher = createPlainFetcher({
      testHosts: new Map([["lander.fixture.test", { address: "127.0.0.1", port }]]),
      limits: { timeoutMs: 5000 },
    });
    const started = Date.now();
    const r = (await fetcher.fetch("http://lander.fixture.test/big-redirect")) as FetchedPage;
    expect(r.status).toBe("fetched");
    expect(r.title).toBe("OK");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("BUG-10: footer links don't make a page look cloaked", () => {
  it("a short advertorial with Privacy Policy / Terms links isn't flagged", () => {
    expect(
      looksCloaked(
        {
          url_kind: "our_lander",
          text: "Final expense coverage explained for seniors. Read more. Privacy Policy | Terms of Use",
          form_count: 0,
          tel_numbers: [],
        },
        "final expense insurance",
      ),
    ).toBe(false);
  });
});

describe("P2: missing-field checks use keys, not labels", () => {
  it("every checklist item carries a real field key", () => {
    const all = missingItems({
      advertiser_name: null,
      vertical: null,
      payout_model: "ppc",
      states: null,
      cap_amount: null,
      cap_counts: null,
      cap_period: null,
      call_hours: null,
      optimisation_event: null,
      feedback_delay_days: null,
      restrictions: null,
      approval_required: null,
      urls: [],
      economics: { payout_tiers: null, target_cpl: null, target_roi: null },
    });
    expect(all.length).toBe(13);
    for (const m of all) expect(CHECK_FIELDS).toContain(m.field);
  });
});

describe("P2: stable client-only row keys", () => {
  it("adds keys once, keeps existing ones, and never sends them", () => {
    let n = 0;
    const draft = withRowKeys(
      {
        ...EMPTY_DRAFT,
        name: "X",
        tiers: [{ label: "base", amount: "10", condition: "" }],
        callHoursKnown: true,
        days: { ...EMPTY_DRAFT.days, mon: [{ start: "09:00", end: "17:00" }] },
      },
      () => `k${n++}`,
    );
    expect(draft.tiers[0]?.key).toBe("k0");
    expect(draft.urls[0]?.key).toBe("k1");
    expect(draft.days.mon[0]?.key).toBe("k2");
    expect(withRowKeys(draft, () => "new").tiers[0]?.key).toBe("k0");
    expect(JSON.stringify(toPayload(draft))).not.toMatch(/"key"/);
  });
});

describe("P2: database errors never reach users raw", () => {
  it("maps known codes and hides unknown ones", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(dbMessage({ code: "42501", message: "permission denied for table budgets" })).toBe(
      "You don't have permission to do that.",
    );
    expect(dbMessage({ code: "P0001", message: "Cannot remove the last active admin" })).toBe(
      "Cannot remove the last active admin",
    );
    const raw = 'duplicate key value violates unique constraint "x" DETAIL: Key (secret)=(1)';
    expect(dbMessage({ code: "XX000", message: raw })).not.toContain("Key (secret)");
    vi.restoreAllMocks();
  });
});
