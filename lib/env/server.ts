import "server-only";

import { z } from "zod";

import { formatEnvError } from "./format";

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.email().optional(),
);

export const serverEnvSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  BOOTSTRAP_ADMIN_EMAIL: optionalEmail,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Server-only secrets. Importing this from a client component fails the build. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const result = serverEnvSchema.safeParse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL,
  });
  if (!result.success) throw new Error(formatEnvError(result.error));
  cached = result.data;
  return cached;
}

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

/**
 * AI settings. Separate from getServerEnv so the app runs without an Anthropic key:
 * AI features then fail clearly ("AI is not configured") instead of the whole app failing.
 */
export const aiEnvSchema = z.object({
  ANTHROPIC_API_KEY: optionalString,
  AI_MODEL_GENERATION: optionalString,
  AI_MODEL_CLASSIFICATION: optionalString,
  // Dev/test only: a canned in-process model. Refused when NODE_ENV=production.
  AI_FAKE: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() === "1" : false),
    z.boolean(),
  ),
});

export type AiEnv = z.infer<typeof aiEnvSchema>;

export function getAiEnv(source: NodeJS.ProcessEnv = process.env): AiEnv {
  const result = aiEnvSchema.safeParse({
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    AI_MODEL_GENERATION: source.AI_MODEL_GENERATION,
    AI_MODEL_CLASSIFICATION: source.AI_MODEL_CLASSIFICATION,
    AI_FAKE: source.AI_FAKE,
  });
  if (!result.success) throw new Error(formatEnvError(result.error));
  return result.data;
}

/**
 * Direct Postgres URL for background jobs (lib/db/as-user.ts). TOP-TIER SECRET: server-only,
 * never logged, never sent to the client (the CI bundle canary greps for it). On Vercel this
 * is the Supabase transaction-pooler URL (port 6543).
 */
export function getDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const result = z.string().trim().startsWith("postgres").safeParse(source.DATABASE_URL);
  if (!result.success) {
    // Names the variable, never echoes its value.
    throw new Error(
      "Missing or invalid DATABASE_URL (see .env.example): required for background jobs.",
    );
  }
  return result.data;
}

/**
 * Inngest keys. The APP_INNGEST_* names exist because the standard INNGEST_* variables on Vercel
 * are owned (and locked) by Vercel integrations pointing at a different Inngest account. When an
 * APP_ name is set it wins; otherwise the SDK reads the standard names (local dev, CI).
 * Values are never echoed in errors.
 */
const signingKey = optionalString.refine(
  (v) => v === undefined || v.startsWith("signkey-"),
  "must be an Inngest signing key (starts with signkey-)",
);

export const inngestEnvSchema = z.object({
  APP_INNGEST_EVENT_KEY: optionalString,
  APP_INNGEST_SIGNING_KEY: signingKey,
  APP_INNGEST_SIGNING_KEY_FALLBACK: signingKey,
});

export type InngestEnv = z.infer<typeof inngestEnvSchema>;

export function getInngestEnv(source: NodeJS.ProcessEnv = process.env): InngestEnv {
  const result = inngestEnvSchema.safeParse({
    APP_INNGEST_EVENT_KEY: source.APP_INNGEST_EVENT_KEY,
    APP_INNGEST_SIGNING_KEY: source.APP_INNGEST_SIGNING_KEY,
    APP_INNGEST_SIGNING_KEY_FALLBACK: source.APP_INNGEST_SIGNING_KEY_FALLBACK,
  });
  if (!result.success) throw new Error(formatEnvError(result.error));
  return result.data;
}
