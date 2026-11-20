// AI ledger through the real Data API: concurrent reservations can't overshoot a cap, the
// runner logs every outcome, and clients can't reach the ledger RPCs or forge rows.
// The model is always a fake: these tests never call the Anthropic API.
//
// Cleanup note: users with ai_calls rows can't be deleted (the log is append-only), so they
// stay in the throwaway local DB like offer owners; `pnpm db:reset` clears them.
import { beforeAll, describe, expect, it } from "vitest";

import type { AiClient } from "@/lib/ai/client";
import { AiBudgetExceededError, AiError } from "@/lib/ai/errors";
import { fakeMessage } from "@/lib/ai/fake";
import { supabaseLedger } from "@/lib/ai/ledger";
import { offerCheckV1 } from "@/lib/ai/prompts/offer-check/v1";
import { runStructured } from "@/lib/ai/run";

import { adminClient, createTestUser, signedInClient } from "./local-supabase";

type User = { id: string; email: string };
let buyer: User, other: User, capped: User;

const VALID = JSON.stringify({ findings: [] });
const okClient: AiClient = {
  createMessage: async ({ params }) =>
    fakeMessage({ model: params.model, text: VALID, inputTokens: 900, outputTokens: 120 }),
};

async function setUserCap(userId: string, cap: number) {
  const { error } = await adminClient()
    .from("budgets")
    .insert({ scope: "user", scope_id: userId, monthly_cap_usd: cap });
  if (error) throw error;
}

beforeAll(async () => {
  [buyer, other, capped] = await Promise.all([
    createTestUser("ai_buyer", "buyer"),
    createTestUser("ai_other", "buyer"),
    createTestUser("ai_capped", "buyer"),
  ]);
});

describe("begin_ai_call under concurrency", () => {
  it("never reserves past a cap, however many calls race", async () => {
    await setUserCap(capped.id, 1.0);
    const admin = adminClient();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        admin.rpc("begin_ai_call", {
          p_user_id: capped.id,
          p_purpose: "test.race",
          p_model: "claude-haiku-5-5",
          p_prompt_version: "test@1",
          p_price_version: "2026-11",
          p_reserve_usd: 0.25,
        }),
      ),
    );
    for (const r of results) expect(r.error).toBeNull();
    const ok = results.filter((r) => (r.data as { ok: boolean }).ok);
    expect(ok).toHaveLength(4);

    const { data: rows } = await admin
      .from("ai_calls")
      .select("status, reserved_usd")
      .eq("user_id", capped.id)
      .eq("purpose", "test.race");
    expect(rows?.filter((r) => r.status === "pending")).toHaveLength(4);
    expect(rows?.filter((r) => r.status === "blocked")).toHaveLength(6);

    // Settle the reservations at $0. Left pending, they'd expire and settle at their full
    // reserved cost, and local workspace spend would creep up with every test run.
    for (const r of ok) {
      const { error } = await admin.rpc("finish_ai_call", {
        p_call_id: (r.data as { call_id: string }).call_id,
        p_status: "failed",
        p_cost_usd: 0,
        p_error_code: "test_cleanup",
      });
      if (error) throw error;
    }
  });
});

describe("runStructured with the real ledger", () => {
  it("logs a succeeded call with tokens and code-computed cost; only the owner reads it", async () => {
    const result = await runStructured({
      userId: buyer.id,
      purpose: "test.offer_check",
      prompt: offerCheckV1,
      input: offerCheckV1.exampleInput,
      ledger: supabaseLedger(adminClient()),
      client: okClient,
    });

    const asBuyer = await signedInClient(buyer.email);
    const { data: row, error } = await asBuyer
      .from("ai_calls")
      .select("*")
      .eq("id", result.callId)
      .single();
    expect(error).toBeNull();
    expect(row).toMatchObject({
      user_id: buyer.id,
      purpose: "test.offer_check",
      model: "claude-haiku-5-5",
      prompt_version: "offer-check@1",
      status: "succeeded",
      input_tokens: 900,
      output_tokens: 120,
      cost_usd: result.costUsd,
      request_id: "req_fake",
    });
    expect(row!.latency_ms).toBeGreaterThanOrEqual(0);

    const asOther = await signedInClient(other.email);
    const { data: hidden } = await asOther.from("ai_calls").select("id").eq("id", result.callId);
    expect(hidden).toEqual([]);
  });

  it("logs invalid output as failed, and returns nothing", async () => {
    const bad: AiClient = {
      createMessage: async ({ params }) => fakeMessage({ model: params.model, text: "not json" }),
    };
    const error = await runStructured({
      userId: buyer.id,
      purpose: "test.invalid",
      prompt: offerCheckV1,
      input: offerCheckV1.exampleInput,
      ledger: supabaseLedger(adminClient()),
      client: bad,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    const { data } = await adminClient()
      .from("ai_calls")
      .select("status, error_code")
      .eq("id", (error as AiError).callId!)
      .single();
    expect(data).toEqual({ status: "failed", error_code: "invalid_output" });
  });

  it("blocks over-cap calls before the model is called, and logs the attempt", async () => {
    await setUserCap(other.id, 0);
    let called = false;
    const spy: AiClient = {
      createMessage: async (req) => {
        called = true;
        return okClient.createMessage(req);
      },
    };
    const error = await runStructured({
      userId: other.id,
      purpose: "test.blocked",
      prompt: offerCheckV1,
      input: offerCheckV1.exampleInput,
      ledger: supabaseLedger(adminClient()),
      client: spy,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(AiBudgetExceededError);
    expect((error as AiBudgetExceededError).block.scope).toBe("user");
    expect((error as AiBudgetExceededError).userMessage).toContain("$0.00");
    expect(called).toBe(false);
    const { data } = await adminClient()
      .from("ai_calls")
      .select("status, error_code")
      .eq("id", (error as AiError).callId!)
      .single();
    expect(data).toEqual({ status: "blocked", error_code: "cap_reached" });
  });
});

describe("clients can't reach the ledger", () => {
  it("signed-in users can't call begin/finish_ai_call or write ai_calls/budgets", async () => {
    const asBuyer = await signedInClient(buyer.email);
    const begin = await asBuyer.rpc("begin_ai_call", {
      p_user_id: buyer.id,
      p_purpose: "forged",
      p_model: "m",
      p_prompt_version: "p@1",
      p_price_version: "x",
      p_reserve_usd: 0,
    });
    expect(begin.error).not.toBeNull();

    const finish = await asBuyer.rpc("finish_ai_call", {
      p_call_id: crypto.randomUUID(),
      p_status: "succeeded",
      p_cost_usd: 0,
    });
    expect(finish.error).not.toBeNull();

    const insert = await asBuyer.from("ai_calls").insert({
      user_id: buyer.id,
      purpose: "forged",
      model: "m",
      prompt_version: "p@1",
      price_version: "x",
    });
    expect(insert.error).not.toBeNull();

    const cap = await asBuyer
      .from("budgets")
      .insert({ scope: "user", scope_id: buyer.id, monthly_cap_usd: 9999 });
    expect(cap.error).not.toBeNull();

    const status = await asBuyer.rpc("ai_budget_status");
    expect(status.error).toBeNull();
    // Buyers get their own spend, never the workspace total (enforced in SQL).
    expect(status.data).toMatchObject({
      user_cap_usd: null,
      workspace_cap_usd: null,
      workspace_spent_usd: null,
      workspace_budget_available: true,
    });
  });
});
