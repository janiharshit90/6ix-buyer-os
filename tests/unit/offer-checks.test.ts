import { describe, expect, it } from "vitest";

import { findingSchema } from "@/lib/offers/check-types";
import { ruleFindings, type RuleCheckInput } from "@/lib/offers/checks";

const complete: RuleCheckInput = {
  advertiser_name: "Acme",
  vertical: "auto insurance",
  payout_model: "cpl",
  states: ["TX"],
  cap_amount: 50,
  cap_counts: "submissions",
  cap_period: "day",
  call_hours: null,
  optimisation_event: "Lead",
  feedback_delay_days: 3,
  restrictions: { banned_claims: ["free"], banned_words: [], notes: null },
  approval_required: false,
  urls: [{ kind: "our_lander" }],
  economics: {
    payout_tiers: [{ label: "base", amount_usd: 30, condition: null }],
    target_cpl: 20,
    target_roi: 30,
  },
};

const fields = (input: RuleCheckInput) => ruleFindings(input).map((f) => `${f.field}:${f.kind}`);

describe("offer rule checks (code, not AI)", () => {
  it("a complete, consistent offer has no findings", () => {
    expect(ruleFindings(complete)).toEqual([]);
  });

  it("every finding fits the stored schema", () => {
    const messy: RuleCheckInput = {
      ...complete,
      payout_model: "ppc",
      cap_amount: 0,
      call_hours: { timezone: "America/Chicago", days: {} },
      economics: {
        payout_tiers: [
          { label: "A", amount_usd: 0, condition: null },
          { label: "a", amount_usd: 10, condition: null },
        ],
        target_cpl: 99,
        target_roi: null,
      },
    };
    const findings = ruleFindings(messy);
    expect(findings.length).toBeGreaterThan(4);
    for (const f of findings) expect(findingSchema.safeParse(f).success).toBe(true);
  });

  it("maps every unknown checklist item to a real field", () => {
    const empty: RuleCheckInput = {
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
    };
    const missing = ruleFindings(empty).filter((f) => f.kind === "missing");
    expect(missing.length).toBe(13);
    expect(missing.some((f) => f.field === "general")).toBe(false);
  });

  it("flags target CPL above the top payout, with code-formatted numbers", () => {
    const f = ruleFindings({ ...complete, economics: { ...complete.economics, target_cpl: 31.5 } });
    expect(f).toEqual([
      expect.objectContaining({ field: "target_cpl", kind: "inconsistent", severity: "warning" }),
    ]);
    expect(f[0]!.message).toContain("$31.50");
    expect(f[0]!.message).toContain("$30.00");
  });

  it("compares against the HIGHEST tier", () => {
    const tiers = [
      { label: "base", amount_usd: 30, condition: null },
      { label: "qualified", amount_usd: 45, condition: "over 90s" },
    ];
    expect(
      fields({
        ...complete,
        economics: { ...complete.economics, payout_tiers: tiers, target_cpl: 40 },
      }),
    ).toEqual([]);
  });

  it("flags target CPL equal to the top payout (no margin)", () => {
    expect(fields({ ...complete, economics: { ...complete.economics, target_cpl: 30 } })).toEqual([
      "target_cpl:inconsistent",
    ]);
  });

  it("skips the CPL comparison for revshare", () => {
    expect(
      fields({
        ...complete,
        payout_model: "revshare",
        economics: { ...complete.economics, target_cpl: 99 },
      }),
    ).toEqual([]);
  });

  it("pay-per-call capped in submissions is inconsistent", () => {
    const f = fields({
      ...complete,
      payout_model: "ppc",
      call_hours: {
        timezone: "America/Chicago",
        days: { mon: [{ start: "09:00", end: "17:00" }] },
      },
    });
    expect(f).toContain("cap:inconsistent");
  });

  it("a cap counted in calls on a non-call offer is inconsistent", () => {
    expect(fields({ ...complete, cap_counts: "calls" })).toEqual(["cap:inconsistent"]);
  });

  it("call hours on a non-call offer is info; all days closed is a warning", () => {
    const f = ruleFindings({ ...complete, call_hours: { timezone: "America/Chicago", days: {} } });
    expect(f.map((x) => `${x.field}:${x.severity}`)).toEqual([
      "call_hours:info",
      "call_hours:warning",
    ]);
  });

  it("flags a $0 tier, duplicate tier labels, a 0 cap and empty restrictions", () => {
    const f = fields({
      ...complete,
      cap_amount: 0,
      restrictions: { banned_claims: [], banned_words: [], notes: null },
      economics: {
        ...complete.economics,
        payout_tiers: [
          { label: "Base", amount_usd: 0, condition: null },
          { label: "base ", amount_usd: 30, condition: null },
        ],
      },
    });
    expect(f).toEqual([
      "payout_tiers:suspicious",
      "payout_tiers:inconsistent",
      "cap:suspicious",
      "restrictions:suspicious",
    ]);
  });
});
