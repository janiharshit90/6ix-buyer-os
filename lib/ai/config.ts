import "server-only";

import { getAiEnv, type AiEnv } from "@/lib/env/server";

/**
 * Model per tier. The ONLY place model ids live (CLAUDE.md §3). Override per environment
 * with AI_MODEL_GENERATION / AI_MODEL_CLASSIFICATION.
 *   generation      research, briefs, angles, scripts, copy
 *   classification  classification, tagging, match scoring, field checks
 */
export const DEFAULT_MODELS = {
  generation: "claude-sonnet-5-5",
  classification: "claude-haiku-5-5",
} as const;

export type ModelTier = keyof typeof DEFAULT_MODELS;

export function modelForTier(tier: ModelTier, env: AiEnv = getAiEnv()): string {
  const override = tier === "generation" ? env.AI_MODEL_GENERATION : env.AI_MODEL_CLASSIFICATION;
  return override ?? DEFAULT_MODELS[tier];
}

/** Provider settings. Retries cover 408/409/429/5xx and connection errors only. */
export const CLIENT_OPTIONS = {
  maxRetries: 2,
  timeoutMs: 60_000,
} as const;
