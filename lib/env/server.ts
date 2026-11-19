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
