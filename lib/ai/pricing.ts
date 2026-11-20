// Versioned price table. cost_usd for every AI call is computed HERE, in code, never by
// the model (Non-negotiable #5). PRICE_VERSION is stored on each ai_calls row.
//
// To change prices: add the new rates, bump PRICE_VERSION (YYYY-MM[-n]), keep history in git.
// Source: Anthropic first-party API list prices, USD per million tokens.

export const PRICE_VERSION = "2026-11";

type Rates = {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write (1.25× input). */
  cacheWrite: number;
};

type ModelPrice = Rates & {
  /** Above this many prompt tokens (input + cache read + cache write), longRates apply. */
  longContext?: { thresholdTokens: number; rates: Rates };
};

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longContext: {
      thresholdTokens: 100_000,
      rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
};

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(
      `No price for model "${model}" in price table ${PRICE_VERSION}. Add it to lib/ai/pricing.ts.`,
    );
    this.name = "UnknownModelPriceError";
  }
}

export function priceFor(model: string): ModelPrice {
  const price = PRICES[model];
  if (!price) throw new UnknownModelPriceError(model);
  return price;
}

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

const PER_MILLION = 1_000_000;
/** Round to 6 decimals (the ai_calls.cost_usd scale) without float noise like 0.1+0.2. */
const toMicroUsd = (usd: number) => Math.round(usd * PER_MILLION) / PER_MILLION;

function ratesFor(price: ModelPrice, promptTokens: number): Rates {
  return price.longContext && promptTokens > price.longContext.thresholdTokens
    ? price.longContext.rates
    : price;
}

/** Actual cost of a finished call. Thinking tokens are already inside outputTokens. */
export function costUsd(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const rates = ratesFor(price, usage.inputTokens + cacheRead + cacheWrite);
  return toMicroUsd(
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite) /
      PER_MILLION,
  );
}

/** Deliberately pessimistic chars→tokens ratio for reservations (real text is ~4 chars/token). */
const CHARS_PER_TOKEN_ESTIMATE = 2;
const REQUEST_OVERHEAD_TOKENS = 500;

/**
 * Worst-case cost reserved against the budget BEFORE a call: an over-estimate of the
 * input plus every allowed output token. Settled to the actual cost afterwards.
 */
export function maxCostUsd(model: string, promptChars: number, maxOutputTokens: number): number {
  const estimatedInput =
    Math.ceil(promptChars / CHARS_PER_TOKEN_ESTIMATE) + REQUEST_OVERHEAD_TOKENS;
  return costUsd(model, { inputTokens: estimatedInput, outputTokens: maxOutputTokens });
}
