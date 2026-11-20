// Local stand-in for the Anthropic Messages API, for e2e only. The app talks to it through
// the REAL SDK and code path (ANTHROPIC_BASE_URL), so e2e works against a production build,
// where AI_FAKE is refused. Answers come from lib/ai/fake.ts, same as AI_FAKE in dev.
// Listens on 127.0.0.1 only. Never used outside tests.
import { createServer } from "node:http";

import { createFakeClient } from "../../lib/ai/fake.ts";

const PORT = Number(process.env.ANTHROPIC_STUB_PORT ?? 3199);
const fake = createFakeClient();

/** The stub only sees HTTP, so it recognises prompts by their system text. */
function promptIdFor(params) {
  const system = Array.isArray(params.system)
    ? params.system.map((b) => b.text ?? "").join("\n")
    : String(params.system ?? "");
  if (system.includes("You review offer intake records")) return "offer-check@1";
  if (system.includes("You extract a factual fingerprint of an offer")) return "fingerprint@1";
  return "unknown@0";
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const params = JSON.parse(body);
    const { _request_id, ...message } = await fake.createMessage({
      promptId: promptIdFor(params),
      params,
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "request-id": _request_id ?? "req_stub",
    });
    res.end(JSON.stringify(message));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stub" } }),
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[anthropic-stub] listening on http://127.0.0.1:${PORT}`);
});
