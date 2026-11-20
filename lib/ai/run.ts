import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { getAiClient, type AiClient, type AiResponse } from "./client";
import { modelForTier } from "./config";
import { AiBudgetExceededError, AiError } from "./errors";
import type { AiLedger } from "./ledger";
import { costUsd, maxCostUsd, PRICE_VERSION, PRICES, priceFor } from "./pricing";
import { promptId, type PromptDefinition } from "./prompts/types";
import { newNonce } from "./untrusted";

// The one way to call the model (CLAUDE.md §3, Non-negotiables #1, #5, #6, #9).
//
//   1. resolve the model from config; refuse models without a price (cost must be computable)
//   2. render the prompt with a fresh nonce; untrusted text only ever lands in the user turn
//   3. reserve the worst-case cost against the caps (blocked attempts are logged too)
//   4. call the model with a JSON-schema output format; no tools
//   5. settle the call with its actual cost, whatever happened
//   6. reject refusals, truncation and anything that fails the Zod schema — never returned,
//      so never saved
//
// Callers pass in data they already read with the USER's RLS-scoped client: this module
// never reads app data itself. Nothing here logs prompt or output text.

export type RunArgs<I, O> = {
  userId: string;
  /** What the call is for, e.g. "offer.ai_check". Stored on ai_calls. */
  purpose: string;
  prompt: PromptDefinition<I, O>;
  input: I;
  projectId?: string | null;
  subject?: { type: string; id: string } | null;
  ledger: AiLedger;
  client?: AiClient;
  /** Tests only: deterministic nonce/clock. */
  nonce?: string;
  now?: () => number;
};

export type RunResult<O> = {
  output: O;
  callId: string;
  model: string;
  promptVersion: string;
  costUsd: number;
};

const failureMessages = {
  refusal:
    "The model declined this request. Nothing was saved. Review the content and try again, or ask an admin.",
  truncated: "The model's answer was cut off before it finished. Nothing was saved. Try again.",
  invalid_output: "The model returned an answer in the wrong format. Nothing was saved. Try again.",
  provider_error: "The AI provider didn't respond properly. Nothing was saved. Try again shortly.",
} as const;

function providerErrorCode(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `provider_${error.status ?? "connection"}`;
  return "provider_error";
}

function textOf(message: AiResponse): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

export async function runStructured<I, O>(args: RunArgs<I, O>): Promise<RunResult<O>> {
  const now = args.now ?? Date.now;
  const id = promptId(args.prompt);
  const model = modelForTier(args.prompt.tier);
  priceFor(model); // throws for unpriced models, before anything is spent
  // Resolve the client before reserving: "not configured" must not leave a reservation behind.
  const client = args.client ?? getAiClient();
  // Bill at the served model's price when we know it, else at the requested model's.
  const billModel = (served: string) => (Object.hasOwn(PRICES, served) ? served : model);

  const nonce = args.nonce ?? newNonce();
  const { system, user } = args.prompt.build(args.input, { nonce });

  const reserveUsd = maxCostUsd(model, system.length + user.length, args.prompt.maxTokens);
  let begun;
  try {
    begun = await args.ledger.begin({
      userId: args.userId,
      purpose: args.purpose,
      model,
      promptVersion: id,
      priceVersion: PRICE_VERSION,
      reserveUsd,
      projectId: args.projectId,
      subject: args.subject,
    });
  } catch (cause) {
    throw new AiError("ledger_error", "Couldn't check the AI budget. Nothing was run. Try again.", {
      retryable: true,
      cause,
    });
  }
  if (!begun.ok) throw new AiBudgetExceededError(begun.block, begun.callId);
  const callId = begun.callId;

  const settle = async (outcome: Parameters<AiLedger["finish"]>[0]) => {
    try {
      const settled = await args.ledger.finish(outcome);
      if (!settled) console.warn(`[ai] call ${callId} was no longer pending when settled`);
    } catch (cause) {
      // The reservation stays and expires conservatively; surface the failure.
      throw new AiError("ledger_error", "Couldn't record the AI call. Nothing was saved.", {
        retryable: true,
        callId,
        cause,
      });
    }
  };

  const fail = async (
    code: keyof typeof failureMessages,
    detail: { message?: AiResponse; errorMessage: string; cause?: unknown; latencyMs: number },
  ): Promise<never> => {
    const usage = detail.message?.usage;
    await settle({
      callId,
      status: "failed",
      // Tokens the provider billed still count; API errors before a response cost nothing.
      costUsd: usage
        ? costUsd(billModel(detail.message!.model), {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          })
        : 0,
      model: detail.message?.model ?? model,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      cacheReadTokens: usage?.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
      stopReason: detail.message?.stop_reason ?? null,
      errorCode: code === "provider_error" ? providerErrorCode(detail.cause) : code,
      errorMessage: detail.errorMessage,
      requestId: detail.message?._request_id ?? null,
      latencyMs: detail.latencyMs,
    });
    console.error(`[ai] call ${callId} (${id}) failed: ${code}`);
    throw new AiError(code, failureMessages[code], {
      retryable: true,
      callId,
      cause: detail.cause,
    });
  };

  const started = now();
  let message: AiResponse;
  try {
    message = await client.createMessage({
      promptId: id,
      params: {
        model,
        max_tokens: args.prompt.maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: {
          format: { type: "json_schema", schema: zodOutputFormat(args.prompt.outputSchema).schema },
          ...(args.prompt.effort ? { effort: args.prompt.effort } : {}),
        },
      },
    });
  } catch (cause) {
    if (cause instanceof AiError) throw cause; // e.g. not configured: nothing was sent
    return fail("provider_error", {
      cause,
      // Status + class only: provider messages can echo request content.
      errorMessage:
        cause instanceof Anthropic.APIError
          ? `${cause.constructor.name} (${cause.status ?? "no status"})`
          : "Request failed before a response",
      latencyMs: now() - started,
    });
  }
  const latencyMs = now() - started;

  if (message.stop_reason === "refusal") {
    return fail("refusal", {
      message,
      errorMessage: `Refused${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`,
      latencyMs,
    });
  }
  if (
    message.stop_reason === "max_tokens" ||
    message.stop_reason === "model_context_window_exceeded"
  ) {
    return fail("truncated", {
      message,
      errorMessage: `Stopped: ${message.stop_reason}`,
      latencyMs,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(textOf(message));
  } catch {
    return fail("invalid_output", {
      message,
      errorMessage: "Output was not valid JSON",
      latencyMs,
    });
  }
  const parsed = args.prompt.outputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .slice(0, 5)
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    return fail("invalid_output", {
      message,
      errorMessage: `Output failed schema validation at: ${paths}`,
      latencyMs,
    });
  }

  const cost = costUsd(billModel(message.model), {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  });
  await settle({
    callId,
    status: "succeeded",
    costUsd: cost,
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? null,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? null,
    stopReason: message.stop_reason,
    requestId: message._request_id ?? null,
    latencyMs,
  });

  return { output: parsed.data, callId, model: message.model, promptVersion: id, costUsd: cost };
}
