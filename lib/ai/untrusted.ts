// Prompt-injection guard (Non-negotiable #6). Untrusted text (scraped pages, uploads,
// free-text fields people typed or pasted) is DATA. It is:
//   - placed only in the user turn, never in the system prompt (enforced in run.ts)
//   - wrapped in a tag whose name carries a random per-call nonce, so text inside
//     can't close the block early: it can't guess the nonce
//   - scrubbed of anything that looks like our block tags, and of invisible characters
//     that could hide instructions from a human reviewer
// The system prompt (prompts/_shared/untrusted-data.v1.ts) tells the model the rules.
// This lowers the risk; it doesn't remove it. That's why the model gets no tools and every
// output is schema-validated before it's stored or shown.

import { randomBytes } from "node:crypto";

export type UntrustedBlock = { nonce: string; tag: string; text: string };

/** Per-call nonce: 12 hex chars. One per prompt, shared by all its blocks. */
export function newNonce(): string {
  return randomBytes(6).toString("hex");
}

// Zero-width and bidi-control characters, BOM, and C0/C1 controls except \t \n \r.
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Anything resembling our tags, opening or closing, any case/spacing.
const TAG_LOOKALIKE = /<\s*(\/?)\s*(untrusted[\w-]*)/gi;

export function sanitizeUntrusted(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(TAG_LOOKALIKE, "[$1$2");
}

const SOURCE_SAFE = /[^a-zA-Z0-9_.:/-]/g;

/**
 * Wraps untrusted text for a prompt. `source` says where it came from (e.g.
 * "offer.restrictions.notes" or a URL); it's sanitized too since it may be user input.
 */
export function wrapUntrusted(text: string, opts: { nonce: string; source: string }): string {
  const tag = `untrusted_${opts.nonce}`;
  const source = opts.source.replace(SOURCE_SAFE, "_").slice(0, 200);
  return `<${tag} source="${source}">\n${sanitizeUntrusted(text)}\n</${tag}>`;
}

/** The tag name for a nonce, for the system prompt to reference. */
export function untrustedTag(nonce: string): string {
  return `untrusted_${nonce}`;
}
