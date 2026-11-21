// SEC-1 (app side): runOfferCheck refuses anyone who can't edit the offer, before reserving any
// budget. The DB re-checks on insert (130_hardening.test.sql).
import { describe, expect, it, vi } from "vitest";

import type { AiLedger } from "@/lib/ai/ledger";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OFFER = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/offers/queries", async (orig) => {
  const real = await orig<typeof import("@/lib/offers/queries")>();
  return {
    ...real,
    getOffer: async () => ({
      id: OFFER,
      name: "Offer",
      vertical: null,
      status: "active",
      owner_id: OWNER,
      current_version_id: null,
      advertiser: null,
      owner: null,
    }),
    getVersions: async () => [
      {
        id: VERSION,
        status: "draft",
        version: 1,
        urls: [],
        economics: null,
        call_hours: null,
        restrictions: null,
      },
    ],
  };
});

const { runOfferCheck } = await import("@/lib/offers/ai-check");

function spyLedger() {
  const begin = vi.fn();
  const ledger = { begin, finish: vi.fn() } as unknown as AiLedger;
  return { ledger, begin };
}

describe("SEC-1: only the offer's editors can run the AI check", () => {
  it("refuses another buyer, before any budget is reserved", async () => {
    const { ledger, begin } = spyLedger();
    const result = await runOfferCheck({ id: OTHER, role: "buyer" }, OFFER, VERSION, { ledger });
    expect(result).toEqual({
      ok: false,
      message: "Only this offer's owner, a manager or an admin can check it.",
      retryable: false,
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it("refuses creatives", async () => {
    const { ledger, begin } = spyLedger();
    const result = await runOfferCheck({ id: OTHER, role: "creative" }, OFFER, VERSION, { ledger });
    expect(result.ok).toBe(false);
    expect(begin).not.toHaveBeenCalled();
  });

  it("lets the owner and managers through to the budget check", async () => {
    for (const profile of [
      { id: OWNER, role: "buyer" as const },
      { id: OTHER, role: "manager" as const },
    ]) {
      const begin = vi.fn().mockRejectedValue(new Error("stop here"));
      const ledger = { begin, finish: vi.fn() } as unknown as AiLedger;
      // A fake client: the real one would stop earlier ("AI is not configured") in tests.
      const client = { createMessage: vi.fn() };
      await runOfferCheck(profile, OFFER, VERSION, { ledger, client }).catch(() => undefined);
      expect(begin, profile.role).toHaveBeenCalledTimes(1);
    }
  });
});
