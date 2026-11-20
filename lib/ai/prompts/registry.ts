import { createHash } from "node:crypto";

import { z } from "zod";

import { fingerprintV1 } from "./fingerprint/v1";
import { offerCheckV1 } from "./offer-check/v1";
import { promptId, type PromptDefinition } from "./types";

const FINGERPRINT_NONCE = "000000000000";

/**
 * Hash of everything the model receives for a prompt version: rendered system prompt,
 * rendered user message for exampleInput, output JSON schema and call settings. Shared
 * pieces (rules text, finding schema) are inside it, so changing them also trips the freeze.
 */
export function fingerprint<I, O>(p: PromptDefinition<I, O>): string {
  const rendered = p.build(p.exampleInput, { nonce: FINGERPRINT_NONCE });
  const material = JSON.stringify({
    id: promptId(p),
    tier: p.tier,
    maxTokens: p.maxTokens,
    effort: p.effort ?? null,
    system: rendered.system,
    user: rendered.user,
    schema: z.toJSONSchema(p.outputSchema),
  });
  return createHash("sha256").update(material).digest("hex");
}

const entry = <I, O>(p: PromptDefinition<I, O>) => ({
  id: promptId(p),
  fingerprint: () => fingerprint(p),
});

/** Every released prompt version. Each must have a frozen fingerprint in prompts/hashes.json. */
export const RELEASED_PROMPTS = [entry(offerCheckV1), entry(fingerprintV1)];
