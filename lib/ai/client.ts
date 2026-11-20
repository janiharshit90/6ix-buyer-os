import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { getAiEnv, type AiEnv } from "@/lib/env/server";

import { CLIENT_OPTIONS } from "./config";
import { AiError } from "./errors";
import { createFakeClient } from "./fake";

export type AiRequest = {
  /** e.g. "offer-check@1". Lets the fake client answer per prompt. */
  promptId: string;
  params: Anthropic.MessageCreateParamsNonStreaming;
};

export type AiResponse = Anthropic.Message & { _request_id?: string | null };

/** The only thing lib/ai needs from a provider. Tests pass their own implementation. */
export type AiClient = {
  createMessage(req: AiRequest): Promise<AiResponse>;
};

/**
 * The real Anthropic client, or the canned fake when AI_FAKE=1 outside production.
 * The API key comes from the environment only and is never logged.
 */
export function getAiClient(env: AiEnv = getAiEnv(), nodeEnv = process.env.NODE_ENV): AiClient {
  if (env.AI_FAKE) {
    if (nodeEnv === "production") {
      throw new Error("AI_FAKE=1 is not allowed in production.");
    }
    return createFakeClient();
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new AiError(
      "not_configured",
      "AI is not configured on this server (no Anthropic API key). Ask an admin.",
      { retryable: false },
    );
  }
  const anthropic = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: CLIENT_OPTIONS.maxRetries,
    timeout: CLIENT_OPTIONS.timeoutMs,
  });
  return { createMessage: ({ params }) => anthropic.messages.create(params) };
}
