import "server-only";

import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

// AI usage reads for Settings. All through the USER's client: RLS decides which rows come
// back (own calls for buyers/creatives, everyone's for managers/admins). Totals come from SQL.

const budgetStatusSchema = z.object({
  month_start: z.string(),
  workspace_cap_usd: z.number().nullable(),
  workspace_spent_usd: z.number(),
  user_cap_usd: z.number().nullable(),
  user_spent_usd: z.number(),
});
export type BudgetStatus = z.infer<typeof budgetStatusSchema>;

export async function getBudgetStatus(): Promise<BudgetStatus> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ai_budget_status");
  if (error) throw new Error(`Could not load AI budget: ${error.message}`);
  return budgetStatusSchema.parse(data);
}

export type UserUsage = {
  userId: string;
  displayName: string;
  role: string;
  calls: number;
  failed: number;
  blocked: number;
  /** Settled cost + live reservations, from the view's SQL sums. */
  spentUsd: number;
  capUsd: number | null;
};

/** Per-user usage for one month (managers/admins see everyone; RLS-enforced). */
export async function getTeamUsage(monthStart: string): Promise<UserUsage[]> {
  const supabase = await createClient();
  const [usage, profiles, caps] = await Promise.all([
    supabase
      .from("ai_usage_monthly")
      .select("user_id, calls, failed, blocked, cost_usd, reserved_usd")
      .eq("month_start", monthStart),
    supabase.from("profiles").select("id, display_name, role, active").order("display_name"),
    supabase.from("budgets").select("scope_id, monthly_cap_usd").eq("scope", "user"),
  ]);
  if (usage.error) throw new Error(`Could not load AI usage: ${usage.error.message}`);
  if (profiles.error) throw new Error(`Could not load users: ${profiles.error.message}`);
  if (caps.error) throw new Error(`Could not load AI caps: ${caps.error.message}`);

  const capBy = new Map(caps.data.map((c) => [c.scope_id, c.monthly_cap_usd]));
  const rowsBy = new Map<string, typeof usage.data>();
  for (const row of usage.data) {
    if (!row.user_id) continue;
    rowsBy.set(row.user_id, [...(rowsBy.get(row.user_id) ?? []), row]);
  }

  return profiles.data
    .filter((p) => p.active || rowsBy.has(p.id))
    .map((p) => {
      const rows = rowsBy.get(p.id) ?? [];
      const sum = (pick: (r: (typeof rows)[number]) => number | null) =>
        rows.reduce((total, r) => total + (pick(r) ?? 0), 0);
      return {
        userId: p.id,
        displayName: p.display_name,
        role: p.role,
        calls: sum((r) => r.calls),
        failed: sum((r) => r.failed),
        blocked: sum((r) => r.blocked),
        spentUsd: Math.round((sum((r) => r.cost_usd) + sum((r) => r.reserved_usd)) * 1e6) / 1e6,
        capUsd: capBy.get(p.id) ?? null,
      };
    });
}

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd4 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Spend: cents normally, up to 4 decimals for sub-dollar amounts so cheap calls aren't $0.00. */
export function formatSpend(usd: number): string {
  return usd > 0 && usd < 1 ? usd4.format(usd) : usd2.format(usd);
}

export function formatCapUsd(usd: number | null): string {
  return usd == null ? "no cap" : usd2.format(usd);
}

export function formatMonth(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}
