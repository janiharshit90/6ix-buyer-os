// Offer rule checks: deterministic, in code. Anything involving numbers lives here, never
// in the AI (Non-negotiable #5). The AI check adds qualitative suggestions on top.
// Pure module, unit-tested. No thresholds: only contradictions between the offer's own facts.
import type { CheckField, Finding } from "./check-types";
import { formatUsd } from "./format";
import { missingFields, type ChecklistFacts } from "./schema";

export type RuleCheckInput = ChecklistFacts & {
  economics: { payout_tiers: unknown; target_cpl: number | null; target_roi: number | null };
};

const MISSING_FIELD: Record<string, CheckField> = {
  Advertiser: "advertiser",
  Vertical: "vertical",
  "Payout model": "payout_model",
  "Payout tiers": "payout_tiers",
  "Target CPL": "target_cpl",
  "Target ROI": "target_roi",
  States: "states",
  "Cap (amount, what counts, period)": "cap",
  "Call hours": "call_hours",
  "Optimisation event": "optimisation_event",
  "Feedback delay": "feedback_delay_days",
  "Restrictions (banned claims/words)": "restrictions",
  "Network approval required?": "approval_required",
  "Our lander or offer page URL": "urls",
};

type Tier = { label: string | null; amount_usd: number | null };

function tiersOf(value: unknown): Tier[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((t) =>
    typeof t === "object" && t !== null
      ? [
          {
            label: typeof t.label === "string" ? t.label : null,
            amount_usd: typeof t.amount_usd === "number" ? t.amount_usd : null,
          },
        ]
      : [],
  );
}

function openDays(callHours: unknown): string[] | null {
  if (typeof callHours !== "object" || callHours === null) return null;
  const days = (callHours as { days?: unknown }).days;
  if (typeof days !== "object" || days === null) return [];
  return Object.entries(days).flatMap(([day, windows]) =>
    Array.isArray(windows) && windows.length > 0 ? [day] : [],
  );
}

function restrictionsAreEmpty(r: unknown): boolean {
  if (typeof r !== "object" || r === null) return false;
  const x = r as { banned_claims?: unknown; banned_words?: unknown; notes?: unknown };
  const none = (v: unknown) => !Array.isArray(v) || v.length === 0;
  return none(x.banned_claims) && none(x.banned_words) && !x.notes;
}

export function ruleFindings(f: RuleCheckInput): Finding[] {
  const out: Finding[] = [];
  const add = (finding: Finding) => out.push(finding);

  for (const label of missingFields(f)) {
    add({
      field: MISSING_FIELD[label] ?? "general",
      kind: "missing",
      severity: "info",
      message: `${label} is unknown.`,
    });
  }

  // Economics vs payout.
  const tiers = tiersOf(f.economics.payout_tiers);
  const amounts = tiers.flatMap((t) => (t.amount_usd == null ? [] : [t.amount_usd]));
  const cpl = f.economics.target_cpl;
  if (cpl != null && amounts.length > 0 && f.payout_model !== "revshare") {
    const top = Math.max(...amounts);
    if (cpl > top) {
      add({
        field: "target_cpl",
        kind: "inconsistent",
        severity: "warning",
        message: `Target CPL (${formatUsd(cpl)}) is above the highest payout tier (${formatUsd(top)}): leads at target would lose money.`,
      });
    } else if (cpl === top) {
      add({
        field: "target_cpl",
        kind: "inconsistent",
        severity: "warning",
        message: `Target CPL (${formatUsd(cpl)}) equals the highest payout tier: no margin at target.`,
      });
    }
  }
  if (amounts.some((a) => a === 0)) {
    add({
      field: "payout_tiers",
      kind: "suspicious",
      severity: "warning",
      message: "A payout tier pays $0.00. Confirm the amount with the network.",
    });
  }
  const labels = tiers.flatMap((t) => (t.label ? [t.label.trim().toLowerCase()] : []));
  if (new Set(labels).size !== labels.length) {
    add({
      field: "payout_tiers",
      kind: "inconsistent",
      severity: "info",
      message: "Two payout tiers share the same label. Name each tier distinctly.",
    });
  }

  // Payout model vs cap and call hours.
  if (
    f.payout_model === "ppc" &&
    f.cap_counts &&
    f.cap_counts !== "calls" &&
    f.cap_counts !== "billable"
  ) {
    add({
      field: "cap",
      kind: "inconsistent",
      severity: "warning",
      message: `Pay-per-call offer, but the cap counts ${f.cap_counts}. Confirm whether it counts calls.`,
    });
  }
  if (f.payout_model && f.payout_model !== "ppc" && f.cap_counts === "calls") {
    add({
      field: "cap",
      kind: "inconsistent",
      severity: "warning",
      message: `The cap counts calls, but the payout model is ${f.payout_model}. Confirm the payout model or the cap.`,
    });
  }
  const days = openDays(f.call_hours);
  if (days !== null && f.payout_model && f.payout_model !== "ppc") {
    add({
      field: "call_hours",
      kind: "inconsistent",
      severity: "info",
      message: `Call hours are set, but the payout model is ${f.payout_model}, not pay-per-call.`,
    });
  }
  if (days !== null && days.length === 0) {
    add({
      field: "call_hours",
      kind: "inconsistent",
      severity: "warning",
      message: "Call hours are set but every day is closed.",
    });
  }
  if (f.cap_amount === 0) {
    add({
      field: "cap",
      kind: "suspicious",
      severity: "warning",
      message: "The cap is 0. Confirm whether the offer is paused or the cap is unknown.",
    });
  }
  if (restrictionsAreEmpty(f.restrictions)) {
    add({
      field: "restrictions",
      kind: "suspicious",
      severity: "info",
      message:
        "Restrictions are recorded as none. Confirm the network has no banned claims or words.",
    });
  }

  return out;
}
