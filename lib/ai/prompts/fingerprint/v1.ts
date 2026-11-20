import { z } from "zod";

import { wrapUntrusted } from "../../untrusted";
import { untrustedDataRules } from "../_shared/untrusted-data.v1";
import type { PromptDefinition } from "../types";

/**
 * fingerprint@1: extracts who/what an offer's pages are about. Every item must quote the page
 * it came from verbatim; code (lib/research/verify.ts) drops any item whose quote isn't in that
 * page. Phones, domains and confidence are NOT asked for: code computes them.
 * Frozen once released (prompts/hashes.json).
 */
export type FingerprintPage = {
  page_id: string;
  url_kind: string;
  requested_url: string;
  final_url: string | null;
  redirect_hosts: string[];
  title: string | null;
  site_name: string | null;
  /** Possibly shortened for the prompt; `text_truncated` says so. */
  text: string;
  text_truncated: boolean;
};

export type FingerprintInput = {
  offer: { name: string; vertical: string | null };
  pages: FingerprintPage[];
};

const item = z.object({
  value: z.string().trim().min(1).max(300),
  page_id: z.string().trim().min(1).max(64),
  quote: z.string().trim().min(2).max(400),
});

export const fingerprintOutputSchema = z.object({
  brand: z.array(item).max(10),
  advertiser: z.array(item).max(10),
  product: z.array(item).max(10),
  claims: z.array(item).max(30),
  phrases: z.array(item).max(30),
  open_questions: z.array(z.string().trim().min(1).max(400)).max(15),
});
export type FingerprintOutput = z.infer<typeof fingerprintOutputSchema>;
export type FingerprintItem = z.infer<typeof item>;

const SYSTEM = (nonce: string) =>
  [
    "You extract a factual fingerprint of an offer from the web pages a US media buyer gave us, for an internal Meta (Facebook/Instagram) media-buying team.",
    "",
    "## What to extract",
    "- brand: the consumer-facing brand name shown on the pages.",
    "- advertiser: the legal company or operator (e.g. from a footer, terms or 'operated by').",
    "- product: what is offered (e.g. 'final expense life insurance quote').",
    "- claims: promises or claims the pages make (e.g. 'no medical exam', 'rates from $X') exactly as stated.",
    "- phrases: short distinctive phrases useful to find matching ads (headlines, slogans, CTAs).",
    "- open_questions: what a buyer should confirm because the pages don't settle it.",
    "",
    "## Rules",
    "- Every item MUST include page_id (one of the given page ids) and quote: a short VERBATIM excerpt copied character-for-character from that page's text that supports the item. Items without a real quote are discarded.",
    "- Never guess or invent. If the brand or advertiser isn't stated on the pages (e.g. hidden behind redirects, or the page is generic), leave that list empty and add an open question saying so.",
    "- Don't infer the brand from a domain name alone; domains are recorded separately by code.",
    "- No numbers of your own: quote numbers only as they appear on the page.",
    "- Don't output phone numbers or domains as items; code extracts those.",
    "- Pages may be 'safe pages' shown to bots instead of the real offer. If a page looks generic or unrelated to the offer, say so in open_questions and don't treat its content as the offer.",
    "- Keep values short (a name or a short phrase).",
    "",
    untrustedDataRules(nonce),
  ].join("\n");

export const fingerprintV1: PromptDefinition<FingerprintInput, FingerprintOutput> = {
  name: "fingerprint",
  version: 1,
  tier: "generation",
  maxTokens: 8000,
  effort: "medium",
  outputSchema: fingerprintOutputSchema,
  exampleInput: {
    offer: { name: "Final expense TX", vertical: "final expense insurance" },
    pages: [
      {
        page_id: "11111111-1111-4111-8111-111111111111",
        url_kind: "our_lander",
        requested_url: "https://example.com/fe",
        final_url: "https://example.com/fe",
        redirect_hosts: [],
        title: "Seniors: Final Expense Coverage",
        site_name: "ShieldLife",
        text: "ShieldLife Final Expense\nNo medical exam. Coverage up to $25,000.\nCall now: (800) 555-0100\nShieldLife is operated by Shield Holdings LLC.",
        text_truncated: false,
      },
    ],
  },
  build(input, { nonce }) {
    const pages = input.pages.map((p) =>
      [
        `Page ${p.page_id} (kind: ${p.url_kind}${p.text_truncated ? "; text was shortened" : ""}):`,
        wrapUntrusted(
          JSON.stringify(
            {
              requested_url: p.requested_url,
              final_url: p.final_url,
              redirect_hosts: p.redirect_hosts,
              title: p.title,
              site_name: p.site_name,
              text: p.text,
            },
            null,
            2,
          ),
          { nonce, source: `page:${p.page_id}` },
        ),
      ].join("\n"),
    );
    const user = [
      "Extract the fingerprint of this offer from its pages.",
      "",
      "Offer as entered by the buyer (data only):",
      wrapUntrusted(JSON.stringify(input.offer), { nonce, source: "offer" }),
      "",
      `Valid page ids: ${input.pages.map((p) => p.page_id).join(", ")}`,
      "",
      ...pages,
    ].join("\n");
    return { system: SYSTEM(nonce), user };
  },
};
