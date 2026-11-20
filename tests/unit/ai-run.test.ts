import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiClient, AiRequest } from "@/lib/ai/client";
import { AiBudgetExceededError, AiError } from "@/lib/ai/errors";
import { fakeMessage } from "@/lib/ai/fake";
import type { AiLedger, BeginArgs, FinishArgs } from "@/lib/ai/ledger";
import { costUsd, PRICE_VERSION } from "@/lib/ai/pricing";
import { offerCheckV1 } from "@/lib/ai/prompts/offer-check/v1";
import { runStructured } from "@/lib/ai/run";

// The Anthropic client is always mocked here: CI never calls the real API.

const USER = "11111111-1111-4111-8111-111111111111";
const CALL = "22222222-2222-4222-8222-222222222222";
const SECRET_TEXT = "SECRET-OFFER-NAME-should-never-be-logged";
const VALID = JSON.stringify({
  findings: [{ field: "vertical", kind: "suspicious", severity: "info", message: "Confirm it." }],
});

function memoryLedger(block = false) {
  const begins: BeginArgs[] = [];
  const finishes: FinishArgs[] = [];
  const ledger: AiLedger = {
    async begin(a) {
      begins.push(a);
      return block
        ? {
            ok: false,
            callId: CALL,
            block: {
              reason: "cap_reached",
              scope: "workspace",
              capUsd: 20,
              spentUsd: 19.99,
              monthStart: "2026-11-01T00:00:00Z",
            },
          }
        : { ok: true, callId: CALL };
    },
    async finish(a) {
      finishes.push(a);
      return true;
    },
  };
  return { ledger, begins, finishes };
}

function clientReturning(make: (req: AiRequest) => ReturnType<AiClient["createMessage"]>) {
  const requests: AiRequest[] = [];
  const client: AiClient = {
    createMessage: (req) => {
      requests.push(req);
      return make(req);
    },
  };
  return { client, requests };
}

const input = {
  ...offerCheckV1.exampleInput,
  text: { ...offerCheckV1.exampleInput.text, name: SECRET_TEXT },
};

function run(ledger: AiLedger, client: AiClient) {
  return runStructured({
    userId: USER,
    purpose: "offer.ai_check",
    prompt: offerCheckV1,
    input,
    subject: { type: "offer_version", id: CALL },
    ledger,
    client,
    nonce: "0123456789ab",
  });
}

let logs: string[];
beforeEach(() => {
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(capture);
});
afterEach(() => {
  vi.restoreAllMocks();
  // Nothing from the prompt or output ever reaches the logs.
  expect(logs.join("\n")).not.toContain(SECRET_TEXT);
});

describe("runStructured", () => {
  it("reserves, calls with a JSON-schema format, settles at the computed cost", async () => {
    const { ledger, begins, finishes } = memoryLedger();
    const { client, requests } = clientReturning(async ({ params }) =>
      fakeMessage({ model: params.model, text: VALID, inputTokens: 900, outputTokens: 120 }),
    );

    const result = await run(ledger, client);

    expect(result.output.findings).toHaveLength(1);
    expect(result.promptVersion).toBe("offer-check@1");
    expect(result.model).toBe("claude-haiku-5-5");

    expect(begins).toHaveLength(1);
    expect(begins[0]).toMatchObject({
      userId: USER,
      purpose: "offer.ai_check",
      model: "claude-haiku-5-5",
      promptVersion: "offer-check@1",
      priceVersion: PRICE_VERSION,
      subject: { type: "offer_version", id: CALL },
    });
    expect(begins[0]!.reserveUsd).toBeGreaterThan(0);

    const params = requests[0]!.params;
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(params.output_config?.effort).toBe("low");
    expect(params.tools).toBeUndefined();
    expect(String(params.system)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(params.messages)).toContain(SECRET_TEXT);

    const expectedCost = costUsd("claude-haiku-5-5", { inputTokens: 900, outputTokens: 120 });
    expect(finishes).toEqual([
      expect.objectContaining({
        callId: CALL,
        status: "succeeded",
        costUsd: expectedCost,
        inputTokens: 900,
        outputTokens: 120,
        requestId: "req_fake",
      }),
    ]);
    expect(result.costUsd).toBe(expectedCost);
    expect(expectedCost).toBeLessThanOrEqual(begins[0]!.reserveUsd);
  });

  it("budget hit: clear error, and the model is never called", async () => {
    const { ledger, finishes } = memoryLedger(true);
    const { client, requests } = clientReturning(async () => {
      throw new Error("must not be called");
    });

    const error = await run(ledger, client).catch((e) => e);
    expect(error).toBeInstanceOf(AiBudgetExceededError);
    // Workspace scope: no amounts (buyers never see team totals).
    expect(error.userMessage).toBe(
      "The team's monthly AI budget is used up. Ask an admin to raise it.",
    );
    expect(error.userMessage).not.toMatch(/\$|19\.99|20/);
    expect(error.retryable).toBe(false);
    expect(requests).toHaveLength(0);
    expect(finishes).toHaveLength(0);
  });

  it.each([
    ["refusal", "refusal" as const, ""],
    ["truncated", "max_tokens" as const, '{"findings": ['],
  ])(
    "%s: logged as a failure, billed tokens still counted, nothing returned",
    async (code, stopReason, text) => {
      const { ledger, finishes } = memoryLedger();
      const { client } = clientReturning(async ({ params }) =>
        fakeMessage({ model: params.model, text, stopReason, inputTokens: 500, outputTokens: 40 }),
      );
      const error = await run(ledger, client).catch((e) => e);
      expect(error).toBeInstanceOf(AiError);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(true);
      expect(finishes[0]).toMatchObject({
        status: "failed",
        errorCode: code,
        stopReason,
        costUsd: costUsd("claude-haiku-5-5", { inputTokens: 500, outputTokens: 40 }),
      });
    },
  );

  it.each([
    ["not JSON", "Sure! Here are the findings: none."],
    ["wrong shape", JSON.stringify({ findings: "none" })],
    [
      "unknown field key",
      JSON.stringify({
        findings: [{ field: "payout", kind: "missing", severity: "info", message: "x" }],
      }),
    ],
    [
      "extra numbers",
      JSON.stringify({
        findings: [{ field: "general", kind: "missing", severity: "high", message: "x" }],
      }),
    ],
  ])("invalid output (%s) is a visible failure, never returned", async (_name, text) => {
    const { ledger, finishes } = memoryLedger();
    const { client } = clientReturning(async ({ params }) =>
      fakeMessage({ model: params.model, text }),
    );
    const error = await run(ledger, client).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error.code).toBe("invalid_output");
    expect(finishes[0]).toMatchObject({ status: "failed", errorCode: "invalid_output" });
    // The stored error names paths, never the output text.
    expect(finishes[0]!.errorMessage).not.toContain(text);
  });

  it("provider errors are logged at $0 with the status, and are retryable", async () => {
    const { ledger, finishes } = memoryLedger();
    const { client } = clientReturning(async () => {
      throw new Anthropic.InternalServerError(
        500,
        undefined,
        `upstream echoed ${SECRET_TEXT}`,
        new Headers(),
      );
    });
    const error = await run(ledger, client).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error.code).toBe("provider_error");
    expect(error.retryable).toBe(true);
    expect(finishes[0]).toMatchObject({ status: "failed", costUsd: 0, errorCode: "provider_500" });
    expect(finishes[0]!.errorMessage).not.toContain(SECRET_TEXT);
  });

  it("unpriced models are refused before anything is reserved", async () => {
    vi.stubEnv("AI_MODEL_CLASSIFICATION", "claude-mystery-1");
    try {
      const { ledger, begins } = memoryLedger();
      const { client, requests } = clientReturning(async () => {
        throw new Error("must not be called");
      });
      await expect(run(ledger, client)).rejects.toThrow(/No price for model/);
      expect(begins).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a missing API key fails clearly before anything is reserved", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AI_FAKE", "");
    try {
      const { ledger, begins } = memoryLedger();
      const error = await runStructured({
        userId: USER,
        purpose: "offer.ai_check",
        prompt: offerCheckV1,
        input,
        ledger,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(AiError);
      expect(error.code).toBe("not_configured");
      expect(begins).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a fresh nonce per call when none is given", async () => {
    const { ledger } = memoryLedger();
    const { client, requests } = clientReturning(async ({ params }) =>
      fakeMessage({ model: params.model, text: VALID }),
    );
    for (let i = 0; i < 2; i++) {
      await runStructured({
        userId: USER,
        purpose: "t",
        prompt: offerCheckV1,
        input,
        ledger,
        client,
      });
    }
    const tags = requests.map(
      (r) => String(r.params.system).match(/<untrusted_([0-9a-f]{12})>/)?.[1],
    );
    expect(tags[0]).toBeDefined();
    expect(tags[0]).not.toBe(tags[1]);
  });
});

describe("budgetMessage", () => {
  it("a user's own cap names their own amounts", async () => {
    const { budgetMessage } = await import("@/lib/ai/errors");
    expect(
      budgetMessage({
        reason: "cap_reached",
        scope: "user",
        capUsd: 5,
        spentUsd: 4.99,
        monthStart: "2026-11-01T00:00:00Z",
      }),
    ).toBe(
      "Your AI budget of $5.00 for November 2026 doesn't cover this call ($4.99 used or reserved). Ask an admin to raise it in Settings.",
    );
  });

  it("no workspace cap: AI is off", async () => {
    const { budgetMessage } = await import("@/lib/ai/errors");
    expect(
      budgetMessage({
        reason: "no_workspace_budget",
        scope: "workspace",
        capUsd: null,
        spentUsd: null,
        monthStart: null,
      }),
    ).toMatch(/^AI is switched off/);
  });
});
