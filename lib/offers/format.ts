// Display formatting. Numbers come from the DB; code only formats them (Non-negotiable #5).
export const UNKNOWN = "unknown";

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(n: number | null | undefined) {
  return n == null ? UNKNOWN : usdFormat.format(n);
}

export function formatPercent(n: number | null | undefined) {
  return n == null ? UNKNOWN : `${n}%`;
}

export function formatValue(v: string | number | null | undefined) {
  return v == null || v === "" ? UNKNOWN : String(v);
}

export function formatBoolean(v: boolean | null | undefined) {
  return v == null ? UNKNOWN : v ? "yes" : "no";
}

export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return UNKNOWN;
  return (
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso)) + " UTC"
  );
}

/**
 * Cap as one readable line. Fully known: "50 calls per day" / "500 billable total".
 * Partly known: each unknown part is named, e.g. "50 · period unknown · counting unknown".
 */
export function formatCap(
  amount: number | null | undefined,
  counts: string | null | undefined,
  period: string | null | undefined,
) {
  if (amount == null && !counts && !period) return UNKNOWN;
  const periodText = period ? (period === "total" ? "total" : `per ${period}`) : null;
  if (amount != null && counts && periodText) return `${amount} ${counts} ${periodText}`;
  return [
    amount ?? "amount unknown",
    periodText ?? "period unknown",
    counts ?? "counting unknown",
  ].join(" · ");
}
