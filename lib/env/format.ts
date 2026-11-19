import type { z } from "zod";

/** Names the bad env vars without ever echoing their values (no secrets in logs). */
export function formatEnvError(error: z.ZodError): string {
  const problems = error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
  return `Invalid or missing environment variables (see .env.example):\n${problems.join("\n")}`;
}
