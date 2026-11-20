import { describe, expect, it } from "vitest";

import { getAiClient } from "@/lib/ai/client";
import { DEFAULT_MODELS, modelForTier } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { FAKE_MESSAGE } from "@/lib/ai/fake";
import { aiEnvSchema, getAiEnv } from "@/lib/env/server";

const env = (over: Record<string, string> = {}) => getAiEnv(over as NodeJS.ProcessEnv);

describe("AI config", () => {
  it("defaults: Sonnet for generation, Haiku for classification", () => {
    expect(modelForTier("generation", env())).toBe("claude-sonnet-5-5");
    expect(modelForTier("classification", env())).toBe("claude-haiku-5-5");
    expect(DEFAULT_MODELS).toEqual({
      generation: "claude-sonnet-5-5",
      classification: "claude-haiku-5-5",
    });
  });

  it("env overrides each tier; blank means default", () => {
    expect(modelForTier("generation", env({ AI_MODEL_GENERATION: "claude-x" }))).toBe("claude-x");
    expect(modelForTier("classification", env({ AI_MODEL_CLASSIFICATION: "  " }))).toBe(
      "claude-haiku-5-5",
    );
  });

  it("AI_FAKE is on only for exactly 1", () => {
    expect(aiEnvSchema.parse({ AI_FAKE: "1" }).AI_FAKE).toBe(true);
    expect(aiEnvSchema.parse({ AI_FAKE: "true" }).AI_FAKE).toBe(false);
    expect(aiEnvSchema.parse({}).AI_FAKE).toBe(false);
  });
});

describe("getAiClient", () => {
  it("refuses the fake in production", () => {
    expect(() => getAiClient(env({ AI_FAKE: "1" }), "production")).toThrow(
      /not allowed in production/,
    );
  });

  it("without a key: a clear not_configured error, not a crash", () => {
    const error = (() => {
      try {
        getAiClient(env(), "development");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("not_configured");
  });

  it("the dev fake answers offer checks without any network", async () => {
    const client = getAiClient(env({ AI_FAKE: "1" }), "test");
    const message = await client.createMessage({
      promptId: "offer-check@1",
      params: {
        model: "claude-haiku-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const block = message.content[0];
    expect(block?.type === "text" && block.text).toContain(FAKE_MESSAGE);
  });
});
