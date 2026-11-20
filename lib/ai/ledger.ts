import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/db/types";

import type { BudgetBlock } from "./errors";

// The ledger: budget reservation + ai_calls logging, through the service-role-only RPCs
// public.begin_ai_call / public.finish_ai_call. Callers must have verified the user first.

export type BeginArgs = {
  userId: string;
  purpose: string;
  model: string;
  promptVersion: string;
  priceVersion: string;
  reserveUsd: number;
  projectId?: string | null;
  subject?: { type: string; id: string } | null;
};

export type BeginResult =
  { ok: true; callId: string } | { ok: false; callId: string; block: BudgetBlock };

export type FinishArgs = {
  callId: string;
  status: "succeeded" | "failed";
  costUsd: number;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  stopReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestId?: string | null;
  latencyMs?: number | null;
};

export type AiLedger = {
  begin(args: BeginArgs): Promise<BeginResult>;
  /** False when the call was no longer pending (already settled or expired). */
  finish(args: FinishArgs): Promise<boolean>;
};

const beginResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), call_id: z.uuid() }),
  z.object({
    ok: z.literal(false),
    call_id: z.uuid(),
    reason: z.enum(["cap_reached", "no_workspace_budget"]),
    scope: z.enum(["workspace", "user"]),
    cap_usd: z.number().nullish(),
    spent_usd: z.number().nullish(),
    month_start: z.string().nullish(),
  }),
]);

/** `admin` must be a service-role client (lib/supabase/admin.ts). */
export function supabaseLedger(admin: SupabaseClient<Database>): AiLedger {
  return {
    async begin(a) {
      const { data, error } = await admin.rpc("begin_ai_call", {
        p_user_id: a.userId,
        p_purpose: a.purpose,
        p_model: a.model,
        p_prompt_version: a.promptVersion,
        p_price_version: a.priceVersion,
        p_reserve_usd: a.reserveUsd,
        p_project_id: a.projectId ?? undefined,
        p_subject_type: a.subject?.type,
        p_subject_id: a.subject?.id,
      });
      if (error) throw new Error(`begin_ai_call failed: ${error.message}`);
      const r = beginResultSchema.parse(data);
      if (r.ok) return { ok: true, callId: r.call_id };
      return {
        ok: false,
        callId: r.call_id,
        block: {
          reason: r.reason,
          scope: r.scope,
          capUsd: r.cap_usd ?? null,
          spentUsd: r.spent_usd ?? null,
          monthStart: r.month_start ?? null,
        },
      };
    },

    async finish(a) {
      const { data, error } = await admin.rpc("finish_ai_call", {
        p_call_id: a.callId,
        p_status: a.status,
        p_cost_usd: a.costUsd,
        p_model: a.model ?? undefined,
        p_input_tokens: a.inputTokens ?? undefined,
        p_output_tokens: a.outputTokens ?? undefined,
        p_cache_read: a.cacheReadTokens ?? undefined,
        p_cache_creation: a.cacheWriteTokens ?? undefined,
        p_stop_reason: a.stopReason ?? undefined,
        p_error_code: a.errorCode ?? undefined,
        p_error_message: a.errorMessage ?? undefined,
        p_request_id: a.requestId ?? undefined,
        p_latency_ms: a.latencyMs ?? undefined,
      });
      if (error) throw new Error(`finish_ai_call failed: ${error.message}`);
      return data === true;
    },
  };
}
