// Canned in-process model for local dev and e2e (AI_FAKE=1). Never calls the network.
// getAiClient refuses it in production. Unit tests build their own fakes instead.
//
// Trigger words in the user message (dev/e2e only):
//   fake-ai:invalid   → output that fails schema validation
//   fake-ai:refusal   → stop_reason "refusal"
import type Anthropic from "@anthropic-ai/sdk";

import type { AiClient, AiResponse } from "./client";

export const FAKE_MESSAGE =
  "Fake AI suggestion: no model was called (test stub). Confirm the vertical with the network.";

function userText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  return params.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
    )
    .join("\n");
}

export function fakeMessage(opts: {
  model: string;
  text: string;
  stopReason?: Anthropic.StopReason;
  inputTokens?: number;
  outputTokens?: number;
}): AiResponse {
  return {
    id: `msg_fake_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: opts.model,
    container: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text: opts.text, citations: null }],
    usage: {
      input_tokens: opts.inputTokens ?? 1000,
      output_tokens: opts.outputTokens ?? 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
      speed: "standard",
    },
    _request_id: "req_fake",
  } as AiResponse;
}

export function createFakeClient(): AiClient {
  return {
    async createMessage({ promptId, params }) {
      const user = userText(params);
      const model = params.model;
      const inputTokens = Math.ceil(user.length / 4);
      if (user.includes("fake-ai:refusal")) {
        return fakeMessage({
          model,
          text: "",
          stopReason: "refusal",
          inputTokens,
          outputTokens: 0,
        });
      }
      if (user.includes("fake-ai:invalid")) {
        return fakeMessage({ model, text: '{"findings": "not a list"}', inputTokens });
      }
      if (promptId.startsWith("fingerprint@")) {
        return fakeMessage({ model, text: JSON.stringify(fakeFingerprint(user)), inputTokens });
      }
      if (promptId.startsWith("offer-check@")) {
        const text = JSON.stringify({
          findings: [
            { field: "vertical", kind: "suspicious", severity: "info", message: FAKE_MESSAGE },
          ],
        });
        return fakeMessage({ model, text, inputTokens });
      }
      return fakeMessage({ model, text: "{}", inputTokens });
    },
  };
}

/**
 * Fake fingerprint: quotes the first lines of each page verbatim, so the code-side quote
 * verification passes exactly as it would for a real model that follows the rules.
 */
function fakeFingerprint(user: string) {
  const out = {
    brand: [] as { value: string; page_id: string; quote: string }[],
    advertiser: [] as { value: string; page_id: string; quote: string }[],
    product: [] as { value: string; page_id: string; quote: string }[],
    claims: [] as { value: string; page_id: string; quote: string }[],
    phrases: [] as { value: string; page_id: string; quote: string }[],
    open_questions: ["Fake fingerprint: no model was called (test stub)."],
  };
  const blocks = user.matchAll(
    /<untrusted_[0-9a-f]+ source="page:([^"]+)">\s([\s\S]*?)\s<\/untrusted_[0-9a-f]+>/g,
  );
  for (const [, pageId, json] of blocks) {
    if (!pageId || !json) continue;
    let text = "";
    try {
      text = String((JSON.parse(json) as { text?: unknown }).text ?? "");
    } catch {
      continue;
    }
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 3);
    const [first, second] = lines;
    if (first && out.brand.length === 0) {
      const quote = first.slice(0, 80);
      out.brand.push({ value: quote.slice(0, 60), page_id: pageId, quote });
    }
    if (second) {
      const quote = second.slice(0, 120);
      out.claims.push({ value: quote, page_id: pageId, quote });
    }
  }
  return out;
}
