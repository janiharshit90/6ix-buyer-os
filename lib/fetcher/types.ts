// lib/fetcher/ public types. A PageFetcher fetches ONE user-supplied URL safely.
// Implementations: plainFetcher (now). A rendering fetcher (e.g. Firecrawl) can implement the
// same interface later for script-heavy landers (Decisions log M3).

export type Hop = {
  url: string;
  /** HTTP status of this hop; null when refused before a request was made. */
  status: number | null;
  /** e.g. "meta-refresh", "refused: tracking_link". */
  note?: string;
};

export type FetchFailureStatus = "failed" | "blocked" | "tracking_link";

export type FetchedPage = {
  status: "fetched" | "needs_render";
  finalUrl: string;
  finalDomain: string;
  chain: Hop[];
  httpStatus: number;
  contentType: string;
  title: string | null;
  siteName: string | null;
  description: string | null;
  text: string;
  truncated: boolean;
  linkHosts: string[];
  formHosts: string[];
  formCount: number;
  telNumbers: string[];
  scriptCount: number;
};

export type FetchFailure = {
  status: FetchFailureStatus;
  chain: Hop[];
  finalUrl: string | null;
  httpStatus: number | null;
  errorCode: string;
  /** Plain-language reason for the UI. Never contains page content. */
  errorMessage: string;
};

export type FetchOutcome = FetchedPage | FetchFailure;

export type PageFetcher = {
  fetch(url: string): Promise<FetchOutcome>;
};

export const USER_AGENT = "6ixBuyerOS-Fetcher/1.0 (+internal research tool; no form submission)";

export const DEFAULT_LIMITS = {
  maxRedirects: 5,
  timeoutMs: 15_000,
  /** Decompressed bytes. */
  maxBytes: 3 * 1024 * 1024,
  /** Stored text; the fingerprint prompt uses less (see lib/research). */
  maxTextChars: 200_000,
} as const;

export type FetchLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

export const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"] as const;
