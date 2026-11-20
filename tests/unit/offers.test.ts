import { describe, expect, it } from "vitest";

import { draftFromVersion, EMPTY_DRAFT, toPayload, type OfferDraft } from "@/lib/offers/draft";
import { formatCap, formatPercent, formatUsd, formatValue } from "@/lib/offers/format";
import {
  missingFields,
  offerFormSchema,
  toSaveDraftArgs,
  US_STATES,
  type ChecklistFacts,
} from "@/lib/offers/schema";
import type { VersionViewLike } from "@/lib/offers/types";

const filled: OfferDraft = {
  ...EMPTY_DRAFT,
  name: "  Final Expense  ",
  advertiserName: "Acme Life",
  vertical: "insurance",
  payoutModel: "ppc",
  tiers: [{ label: "base", amount: "35.50", condition: "call > 90s" }],
  targetCpl: "42.5",
  targetRoi: "30",
  states: ["CA", "DC"],
  capAmount: "50",
  capCounts: "calls",
  capPeriod: "day",
  callHoursKnown: true,
  timezone: "America/Chicago",
  days: { ...EMPTY_DRAFT.days, mon: [{ start: "09:00", end: "17:00" }] },
  optimisationEvent: "qualified call",
  feedbackDelayDays: "3",
  approvalRequired: "yes",
  restrictionsKnown: true,
  bannedClaims: "guaranteed approval\n\n  free money ",
  bannedWords: "free",
  restrictionNotes: "",
  urls: [
    { url: " https://acme.example/lp ", kind: "our_lander" },
    { url: "", kind: "other" },
  ],
};

describe("offer form schema", () => {
  it("accepts an empty form except the name: everything else is unknown (null)", () => {
    const parsed = offerFormSchema.parse(toPayload({ ...EMPTY_DRAFT, name: "Just a name" }));
    expect(parsed.offer).toEqual({
      name: "Just a name",
      advertiserName: null,
      vertical: null,
      status: "active",
    });
    expect(Object.values(parsed.version).every((v) => v === null)).toBe(true);
    expect(parsed.economics).toEqual({ payoutTiers: null, targetCpl: null, targetRoi: null });
    expect(parsed.urls).toEqual([]);
  });

  it("requires a name", () => {
    const result = offerFormSchema.safeParse(toPayload(EMPTY_DRAFT));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["offer", "name"]);
  });

  it("parses a filled form and trims values", () => {
    const parsed = offerFormSchema.parse(toPayload(filled));
    expect(parsed.offer.name).toBe("Final Expense");
    expect(parsed.version.restrictions).toEqual({
      banned_claims: ["guaranteed approval", "free money"],
      banned_words: ["free"],
      notes: null,
    });
    expect(parsed.urls).toEqual([{ url: "https://acme.example/lp", kind: "our_lander" }]);
    expect(parsed.economics.payoutTiers).toEqual([
      { label: "base", amount_usd: 35.5, condition: "call > 90s" },
    ]);
  });

  it("accepts all 50 states plus DC, and nothing else", () => {
    expect(US_STATES).toHaveLength(51);
    expect(US_STATES).toContain("DC");
    const bad = offerFormSchema.safeParse(toPayload({ ...filled, states: ["CA", "PR"] }));
    expect(bad.success).toBe(false);
  });

  it.each([
    ["targetCpl", "12.345", "economics.targetCpl"],
    ["targetCpl", "-1", "economics.targetCpl"],
    ["targetCpl", "abc", "economics.targetCpl"],
    ["capAmount", "1.5", "version.capAmount"],
    ["feedbackDelayDays", "400", "version.feedbackDelayDays"],
  ] as const)("rejects %s = %s", (field, value, path) => {
    const result = offerFormSchema.safeParse(toPayload({ ...filled, [field]: value }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain(path);
  });

  it("rejects non-http URLs and duplicates", () => {
    const js = offerFormSchema.safeParse(
      toPayload({ ...filled, urls: [{ url: "javascript:alert(1)", kind: "other" }] }),
    );
    expect(js.success).toBe(false);
    const dup = offerFormSchema.safeParse(
      toPayload({
        ...filled,
        urls: [
          { url: "https://a.example", kind: "our_lander" },
          { url: "https://a.example", kind: "other" },
        ],
      }),
    );
    expect(dup.success).toBe(false);
  });

  it("validates call hours: real timezone, start before end", () => {
    const badTz = offerFormSchema.safeParse(toPayload({ ...filled, timezone: "Mars/Olympus" }));
    expect(badTz.success).toBe(false);
    const backwards = offerFormSchema.safeParse(
      toPayload({ ...filled, days: { ...filled.days, tue: [{ start: "17:00", end: "09:00" }] } }),
    );
    expect(backwards.success).toBe(false);
  });
});

describe("toSaveDraftArgs", () => {
  it("omits p_offer_id for a new offer and maps to snake_case", () => {
    const args = toSaveDraftArgs(offerFormSchema.parse(toPayload(filled)));
    expect(args).not.toHaveProperty("p_offer_id");
    expect(args.p_offer).toEqual({
      name: "Final Expense",
      advertiser_name: "Acme Life",
      vertical: "insurance",
      status: "active",
    });
    expect(args.p_version).toMatchObject({
      payout_model: "ppc",
      cap_amount: 50,
      states: ["CA", "DC"],
    });
    expect(args.p_economics).toMatchObject({ target_cpl: 42.5, target_roi: 30 });
  });

  it("passes p_offer_id when editing", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const args = toSaveDraftArgs(offerFormSchema.parse(toPayload({ ...filled, offerId: id })));
    expect(args.p_offer_id).toBe(id);
  });
});

describe("missingFields", () => {
  const complete: ChecklistFacts = {
    advertiser_name: "Acme",
    vertical: "insurance",
    payout_model: "ppc",
    states: ["CA"],
    cap_amount: 50,
    cap_counts: "calls",
    cap_period: "day",
    call_hours: { timezone: "America/New_York", days: {} },
    optimisation_event: "call",
    feedback_delay_days: 0,
    restrictions: { banned_claims: [], banned_words: [], notes: null },
    approval_required: false,
    urls: [{ kind: "our_lander" }],
    economics: { payout_tiers: [{ label: "base" }], target_cpl: 0, target_roi: 0 },
  };

  it("is empty when every fact is known (0 and false count as known)", () => {
    expect(missingFields(complete)).toEqual([]);
  });

  it("lists unknown facts", () => {
    expect(
      missingFields({
        ...complete,
        states: [],
        approval_required: null,
        urls: [{ kind: "other" }],
      }),
    ).toEqual(["States", "Network approval required?", "Our lander or offer page URL"]);
  });

  it("asks for call hours only on pay-per-call offers", () => {
    expect(missingFields({ ...complete, call_hours: null })).toEqual(["Call hours"]);
    expect(missingFields({ ...complete, payout_model: "cpl", call_hours: null })).toEqual([]);
  });

  it("skips economics items for viewers who can't see economics", () => {
    const { economics: _hidden, ...noEconomics } = complete;
    void _hidden;
    expect(missingFields(noEconomics)).toEqual([]);
  });
});

describe("draftFromVersion round trip", () => {
  it("a stored draft loads back into the form without losing data", () => {
    const parsed = offerFormSchema.parse(toPayload(filled));
    const args = toSaveDraftArgs(parsed);
    const stored = {
      ...args.p_version,
      economics: args.p_economics,
      urls: args.p_urls,
    } as unknown as VersionViewLike;

    const reloaded = draftFromVersion(
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: parsed.offer.name,
        vertical: parsed.offer.vertical,
        status: parsed.offer.status,
        advertiserName: parsed.offer.advertiserName,
      },
      stored,
    );
    const again = offerFormSchema.parse(toPayload(reloaded));
    expect({ ...again, offerId: null }).toEqual(parsed);
  });
});

describe("formatting", () => {
  it("shows unknown for null, never 0", () => {
    expect(formatUsd(null)).toBe("unknown");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(42.5)).toBe("$42.50");
    expect(formatPercent(null)).toBe("unknown");
    expect(formatValue("")).toBe("unknown");
  });
});

describe("formatCap", () => {
  it.each([
    [50, "calls", "day", "50 calls per day"],
    [500, "billable", "total", "500 billable total"],
    [50, null, null, "50 · period unknown · counting unknown"],
    [50, "calls", null, "50 · period unknown · calls"],
    [50, null, "week", "50 · per week · counting unknown"],
    [null, "calls", "day", "amount unknown · per day · calls"],
    [0, "submissions", "month", "0 submissions per month"],
    [null, null, null, "unknown"],
  ] as const)("formatCap(%s, %s, %s) = %s", (amount, counts, period, expected) => {
    expect(formatCap(amount, counts, period)).toBe(expected);
  });
});
