import type { z } from "zod";

import type { ModelTier } from "../config";

/**
 * A released prompt version. Released files are frozen (prompts/hashes.json + a unit test):
 * change a prompt by adding vN+1, never by editing vN.
 *
 * build() returns the two halves separately so run.ts can enforce the rule that untrusted
 * text never goes into the system prompt: `system` must be static apart from the nonce.
 */
export type PromptDefinition<Input, Output> = {
  /** Stable name, e.g. "offer-check". */
  name: string;
  version: number;
  tier: ModelTier;
  maxTokens: number;
  effort?: "low" | "medium" | "high";
  outputSchema: z.ZodType<Output>;
  /** A realistic input. Used to fingerprint the rendered prompt (hash freeze) and by the live smoke test. */
  exampleInput: Input;
  build(input: Input, ctx: { nonce: string }): { system: string; user: string };
};

/** "offer-check@1": stored with every output this prompt produced. */
export function promptId(p: Pick<PromptDefinition<unknown, unknown>, "name" | "version">) {
  return `${p.name}@${p.version}`;
}
