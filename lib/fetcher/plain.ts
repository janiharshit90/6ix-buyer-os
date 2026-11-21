import "server-only";

import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

import { isBlockedAddress } from "./addresses";
import { extractHtml } from "./html";
import { checkUrl, type UrlRefusal } from "./policy";
import { parseTestHosts, type TestHostMap } from "./test-hosts";
import {
  ALLOWED_CONTENT_TYPES,
  DEFAULT_LIMITS,
  USER_AGENT,
  type FetchFailure,
  type FetchLimits,
  type FetchOutcome,
  type Hop,
  type PageFetcher,
} from "./types";

// The plain fetcher: node:http(s) with our own DNS check and manual redirects.
//
//  per hop:  URL rules (scheme, credentials, port, host names, trackers)
//            → resolve → EVERY address must be public → connect to that exact address
//              (no second DNS lookup, so a rebinding answer can't sneak in)
//            → GET only, honest User-Agent, no cookies, no forms, nothing executed
//  limits:   5 redirects (incl. meta refresh), 15 s overall, 3 MB decompressed,
//            text/html | application/xhtml+xml | text/plain only

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

const REFUSAL_MESSAGES: Record<UrlRefusal, string> = {
  invalid_url: "Not a valid URL.",
  bad_scheme: "Only http and https URLs are fetched.",
  credentials: "URLs with a username or password are not fetched.",
  bad_port: "Only standard ports (80/443) are fetched.",
  blocked_host: "This host is internal or reserved, so it isn't fetched.",
  tracking_link: "Tracking link — not fetched, to avoid registering clicks.",
};

class HopError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    readonly outcome: "failed" | "blocked" = "failed",
  ) {
    super(code);
  }
}

type Target = { address: string; port: number; protocol: "http:" | "https:" };

/** BUG-8: a stalled DNS resolver must not outlive the fetch's overall timeout. */
function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new HopError("timeout", "The page took too long to respond."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new HopError("timeout", "The page took too long to respond."));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function pickTarget(
  url: URL,
  resolver: Resolver,
  testHosts: TestHostMap,
  signal: AbortSignal,
): Promise<Target> {
  const protocol = url.protocol as "http:" | "https:";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const mapped = testHosts.get(host);
  if (mapped) return { address: mapped.address, port: mapped.port, protocol };

  const literal = host.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  if (isIP(literal)) {
    addresses = [{ address: literal, family: isIP(literal) }];
  } else {
    try {
      addresses = await withSignal(resolver(host), signal);
    } catch (e) {
      if (e instanceof HopError) throw e; // timeout
      throw new HopError("dns", "The domain name couldn't be resolved.");
    }
  }
  if (addresses.length === 0) throw new HopError("dns", "The domain name has no addresses.");
  // Strict: if ANY address is internal, refuse the host entirely.
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new HopError(
      "blocked_address",
      "This domain points to an internal address, so it isn't fetched.",
      "blocked",
    );
  }
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]!;
  return { address: chosen.address, port: protocol === "https:" ? 443 : 80, protocol };
}

type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer | null;
};

function decoder(
  encoding: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

/** Reads at most maxBytes AFTER decompression (zip-bomb safe). */
function readBody(res: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const unzip = decoder(res.headers["content-encoding"]);
    const stream: Readable = unzip ? res.pipe(unzip) : res;
    const parts: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        unzip?.destroy();
        reject(new HopError("too_large", "The page is larger than the size limit."));
        return;
      }
      parts.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", () => {
      res.destroy(); // BUG-8: free the socket
      reject(new HopError("bad_encoding", "The page couldn't be decompressed."));
    });
    res.on("error", () =>
      reject(new HopError("connection", "The connection dropped while reading the page.")),
    );
  });
}

function contentTypeOf(headers: http.IncomingHttpHeaders): {
  type: string;
  charset: string | null;
} {
  const raw = String(headers["content-type"] ?? "").toLowerCase();
  const [type = "", ...params] = raw.split(";").map((p) => p.trim());
  const charset =
    params
      .find((p) => p.startsWith("charset="))
      ?.slice(8)
      .replace(/"/g, "") ?? null;
  return { type, charset };
}

function requestOnce(
  url: URL,
  target: Target,
  signal: AbortSignal,
  limits: FetchLimits,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === "https:" ? https : http;
    const hostIsName = !isIP(url.hostname.replace(/^\[|\]$/g, ""));
    const req = lib.request(
      {
        host: target.address,
        port: target.port,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: {
          Host: url.host,
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
        },
        // TLS: SNI + certificate check against the real host name, not the pinned IP.
        ...(target.protocol === "https:" && hostIsName ? { servername: url.hostname } : {}),
        agent: false,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy(); // BUG-8: never read (or drain) a redirect's body
          resolve({ status, headers: res.headers, body: null });
          return;
        }
        const { type } = contentTypeOf(res.headers);
        const allowed = (ALLOWED_CONTENT_TYPES as readonly string[]).includes(type);
        // Error pages: read a little to spot bot challenges. Wrong types: don't read at all.
        const max = status >= 400 ? Math.min(limits.maxBytes, 64 * 1024) : limits.maxBytes;
        if (!allowed && status < 400) {
          res.destroy();
          resolve({ status, headers: res.headers, body: null });
          return;
        }
        readBody(res, max).then(
          (body) => resolve({ status, headers: res.headers, body }),
          (err) =>
            status >= 400 ? resolve({ status, headers: res.headers, body: null }) : reject(err),
        );
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (signal.aborted) reject(new HopError("timeout", "The page took too long to respond."));
      else if (err instanceof HopError) reject(err);
      else if (err.code?.startsWith("ERR_TLS") || /certificate|ssl|tls/i.test(err.message)) {
        reject(new HopError("tls", "The site's HTTPS certificate couldn't be verified."));
      } else reject(new HopError("connection", "The site refused or dropped the connection."));
    });
    req.end();
  });
}

function decodeText(body: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const CHALLENGE =
  /just a moment|attention required|cf-chl|captcha|are you a robot|verify you are human|access denied|bot detection|ddos protection/i;

function isChallenge(
  status: number,
  headers: http.IncomingHttpHeaders,
  body: Buffer | null,
): boolean {
  if (headers["cf-mitigated"] === "challenge") return true;
  if (![401, 403, 429, 503].includes(status)) return false;
  return body ? CHALLENGE.test(body.subarray(0, 64 * 1024).toString("latin1")) : false;
}

export function createPlainFetcher(
  opts: { resolver?: Resolver; testHosts?: TestHostMap; limits?: Partial<FetchLimits> } = {},
): PageFetcher {
  const resolver = opts.resolver ?? systemResolver;
  const testHosts = opts.testHosts ?? parseTestHosts();
  const testHostNames = new Set(testHosts.keys());
  const limits: FetchLimits = { ...DEFAULT_LIMITS, ...opts.limits };

  return {
    async fetch(requested: string): Promise<FetchOutcome> {
      const chain: Hop[] = [];
      const signal = AbortSignal.timeout(limits.timeoutMs);
      const fail = (
        status: FetchFailure["status"],
        errorCode: string,
        errorMessage: string,
        extra: { finalUrl?: string | null; httpStatus?: number | null } = {},
      ): FetchFailure => ({
        status,
        chain,
        finalUrl: extra.finalUrl ?? null,
        httpStatus: extra.httpStatus ?? null,
        errorCode,
        errorMessage,
      });

      let current = requested;
      for (let hop = 0; hop <= limits.maxRedirects; hop++) {
        const check = checkUrl(current, { testHosts: testHostNames });
        if (!check.ok) {
          chain.push({ url: current, status: null, note: `refused: ${check.reason}` });
          const status = check.reason === "tracking_link" ? "tracking_link" : "blocked";
          return fail(status, check.reason, REFUSAL_MESSAGES[check.reason], { finalUrl: current });
        }
        const url = check.url;

        let res: RawResponse;
        try {
          const target = await pickTarget(url, resolver, testHosts, signal);
          res = await requestOnce(url, target, signal, limits);
        } catch (e) {
          if (e instanceof HopError) {
            chain.push({ url: url.toString(), status: null, note: e.code });
            return fail(e.outcome, e.code, e.userMessage, { finalUrl: url.toString() });
          }
          throw e;
        }

        // HTTP redirect: re-check the next hop from scratch.
        if (res.status >= 300 && res.status < 400) {
          chain.push({ url: url.toString(), status: res.status });
          const location = res.headers.location;
          if (!location)
            return fail("failed", "bad_redirect", "The site redirected without a target.", {
              httpStatus: res.status,
            });
          try {
            current = new URL(location, url).toString();
          } catch {
            return fail("failed", "bad_redirect", "The site redirected to an invalid URL.", {
              httpStatus: res.status,
            });
          }
          continue;
        }

        chain.push({ url: url.toString(), status: res.status });
        if (isChallenge(res.status, res.headers, res.body)) {
          return fail(
            "blocked",
            "bot_challenge",
            "The site showed a bot check. It isn't bypassed (by design).",
            {
              finalUrl: url.toString(),
              httpStatus: res.status,
            },
          );
        }
        if (res.status >= 400) {
          return fail("failed", `http_${res.status}`, `The site answered HTTP ${res.status}.`, {
            finalUrl: url.toString(),
            httpStatus: res.status,
          });
        }
        const { type, charset } = contentTypeOf(res.headers);
        if (!res.body) {
          return fail(
            "failed",
            "content_type",
            `Not a web page (${type || "unknown type"}), so it isn't read.`,
            {
              finalUrl: url.toString(),
              httpStatus: res.status,
            },
          );
        }

        const raw = decodeText(res.body, charset);
        const facts =
          type === "text/plain"
            ? {
                title: null,
                siteName: null,
                description: null,
                text: raw.trim(),
                metaRefresh: null,
                linkHosts: [],
                formActionHosts: [],
                formCount: 0,
                telNumbers: [],
                scriptCount: 0,
                appRoot: false,
              }
            : extractHtml(raw, url.toString());

        // <meta http-equiv="refresh"> is a redirect too: same checks, same hop budget.
        if (facts.metaRefresh && facts.metaRefresh !== url.toString()) {
          chain[chain.length - 1] = {
            url: url.toString(),
            status: res.status,
            note: "meta-refresh",
          };
          current = facts.metaRefresh;
          continue;
        }

        const truncated = facts.text.length > limits.maxTextChars;
        const text = truncated ? facts.text.slice(0, limits.maxTextChars) : facts.text;
        const scriptHeavy = text.length < 300 && (facts.appRoot || facts.scriptCount >= 5);
        return {
          status: scriptHeavy ? "needs_render" : "fetched",
          finalUrl: url.toString(),
          finalDomain: url.hostname.toLowerCase(),
          chain,
          httpStatus: res.status,
          contentType: type,
          title: facts.title,
          siteName: facts.siteName,
          description: facts.description,
          text,
          truncated,
          linkHosts: facts.linkHosts,
          formHosts: facts.formActionHosts,
          formCount: facts.formCount,
          telNumbers: facts.telNumbers,
          scriptCount: facts.scriptCount,
        };
      }
      return fail("failed", "too_many_redirects", `More than ${limits.maxRedirects} redirects.`, {
        finalUrl: current,
      });
    },
  };
}
