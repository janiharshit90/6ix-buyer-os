import { describe, expect, it } from "vitest";

import {
  costUsd,
  maxCostUsd,
  PRICE_VERSION,
  priceFor,
  UnknownModelPriceError,
} from "@/lib/ai/pricing";

describe("AI pricing (cost is computed in code)", () => {
  it("prices Sonnet 5.5 per million tokens", () => {
    // 10k in × $2 + 2k out × $10 = $0.02 + $0.02
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 10_000, outputTokens: 2_000 })).toBe(0.04);
  });

  it("prices Haiku 5.5 and keeps sub-cent precision", () => {
    // 900 × $0.10/M + 120 × $0.50/M = 0.00009 + 0.00006
    expect(costUsd("claude-haiku-5-5", { inputTokens: 900, outputTokens: 120 })).toBe(0.00015);
  });

  it("charges cache reads and writes at their own rates", () => {
    const cost = costUsd("claude-sonnet-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBe(2 + 0.1 + 2.5);
  });

  it("switches Haiku 5.5 to long-context rates above 100K prompt tokens", () => {
    const short = costUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 1_000_000 });
    const long = costUsd("claude-haiku-5-5", { inputTokens: 100_001, outputTokens: 1_000_000 });
    expect(short).toBe(0.01 + 0.5);
    expect(long).toBeCloseTo(100_001 * 0.5e-6 + 2.5, 5); // rounded to 6 decimals
  });

  it("counts cache tokens toward the long-context threshold", () => {
    const cost = costUsd("claude-haiku-5-5", {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 100_000,
    });
    expect(cost).toBeCloseTo(1_000 * 0.5e-6 + 100_000 * 0.05e-6, 6);
  });

  it("rounds to 6 decimals without float noise", () => {
    const cost = costUsd("claude-haiku-5-5", { inputTokens: 3, outputTokens: 7 });
    expect(cost).toBe(Number(cost.toFixed(6)));
  });

  it("refuses models without a price instead of guessing", () => {
    expect(() => priceFor("claude-unknown-9")).toThrow(UnknownModelPriceError);
    expect(() => costUsd("claude-unknown-9", { inputTokens: 1, outputTokens: 1 })).toThrow(
      UnknownModelPriceError,
    );
  });

  it("reserves at least the real worst case", () => {
    const chars = 8_000;
    const maxTokens = 4_000;
    const reserve = maxCostUsd("claude-haiku-5-5", chars, maxTokens);
    // Real text is ~4 chars/token; even at 1 token per 2 chars the reserve covers it.
    const realisticWorstCase = costUsd("claude-haiku-5-5", {
      inputTokens: chars / 2,
      outputTokens: maxTokens,
    });
    expect(reserve).toBeGreaterThanOrEqual(realisticWorstCase);
  });

  it("has a version label for ai_calls.price_version", () => {
    expect(PRICE_VERSION).toMatch(/^\d{4}-\d{2}(-\d+)?$/);
  });
});
