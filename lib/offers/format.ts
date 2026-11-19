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
