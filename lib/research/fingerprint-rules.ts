// Code-side fingerprint work (Decisions log M3). Pure functions, unit-tested:
//   - verifyItems: keep only AI items whose quote really appears on the cited page
//   - extractPhones / collectDomains: deterministic extraction (never asked of the model)
//   - computeConfidence: high|medium|low from corroboration (never a model number)
//   - looksCloaked: heuristic for "safe pages" shown to bots
import type { FingerprintItem, FingerprintOutput } from "@/lib/ai/prompts/fingerprint/v1";

export type PageForRules = {
  id: string;
  url_kind: string;
  requested_url: string;
  final_domain: string | null;
  redirect_chain: { url: string; status: number | null; note?: string }[];
  text: string;
  title: string | null;
  link_domains: string[];
  form_domains: string[];
  tel_numbers: string[];
  form_count: number;
};

/** Case/whitespace/quote-style-insensitive form for verbatim checks. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type VerifiedLists = Pick<
  FingerprintOutput,
  "brand" | "advertiser" | "product" | "claims" | "phrases"
>;

/** Drops items that cite an unknown page or whose quote isn't in that page's text. */
export function verifyItems(
  output: FingerprintOutput,
  pages: Pick<PageForRules, "id" | "text" | "title">[],
): { lists: VerifiedLists; dropped: number } {
  const byId = new Map(pages.map((p) => [p.id, normalizeForMatch(`${p.title ?? ""}\n${p.text}`)]));
  let dropped = 0;
  const keep = (items: FingerprintItem[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const haystack = byId.get(item.page_id);
      const quote = normalizeForMatch(item.quote);
      const ok = haystack !== undefined && quote.length >= 2 && haystack.includes(quote);
      const key = `${item.page_id}|${normalizeForMatch(item.value)}`;
      if (!ok || seen.has(key)) {
        if (!ok) dropped++;
        return false;
      }
      seen.add(key);
      return true;
    });
  };
  return {
    lists: {
      brand: keep(output.brand),
      advertiser: keep(output.advertiser),
      product: keep(output.product),
      claims: keep(output.claims),
      phrases: keep(output.phrases),
    },
    dropped,
  };
}

const US_PHONE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/g;

function toE164(digits: string): string | null {
  const d = digits.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

/** US phone numbers from page text and tel: links, with the pages they appear on. */
export function extractPhones(pages: Pick<PageForRules, "id" | "text" | "tel_numbers">[]) {
  const found = new Map<string, Set<string>>();
  const add = (n: string | null, pageId: string) => {
    if (!n) return;
    if (!found.has(n)) found.set(n, new Set());
    found.get(n)!.add(pageId);
  };
  for (const p of pages) {
    for (const m of p.text.matchAll(US_PHONE)) add(toE164(m[0]), p.id);
    for (const t of p.tel_numbers) add(toE164(t), p.id);
  }
  return [...found].map(([value, ids]) => ({ value, page_ids: [...ids] }));
}

export type DomainRole = "requested" | "redirect" | "final" | "link" | "form";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Every domain seen, with its roles and pages. Link domains: only the top ones per page. */
export function collectDomains(pages: PageForRules[]) {
  const found = new Map<string, { roles: Set<DomainRole>; pages: Set<string> }>();
  const add = (host: string | null, role: DomainRole, pageId: string) => {
    if (!host) return;
    if (!found.has(host)) found.set(host, { roles: new Set(), pages: new Set() });
    const entry = found.get(host)!;
    entry.roles.add(role);
    entry.pages.add(pageId);
  };
  for (const p of pages) {
    add(hostOf(p.requested_url), "requested", p.id);
    for (const hop of p.redirect_chain.slice(0, -1)) add(hostOf(hop.url), "redirect", p.id);
    add(p.final_domain, "final", p.id);
    for (const f of p.form_domains) add(f, "form", p.id);
    for (const l of p.link_domains.slice(0, 20)) add(l, "link", p.id);
  }
  return [...found].map(([value, e]) => ({ value, roles: [...e.roles], page_ids: [...e.pages] }));
}

/**
 * high   = a verified brand appears on 2+ pages, or on 1 page AND in that page's final domain
 * medium = a verified brand on 1 page
 * low    = no verified brand
 */
export function computeConfidence(
  brand: FingerprintItem[],
  pages: Pick<PageForRules, "id" | "final_domain">[],
): "high" | "medium" | "low" {
  if (brand.length === 0) return "low";
  const pagesWithBrand = new Set(brand.map((b) => b.page_id));
  if (pagesWithBrand.size >= 2) return "high";
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const inDomain = brand.some((b) => {
    const domain = pages.find((p) => p.id === b.page_id)?.final_domain ?? "";
    const name = squash(b.value);
    return name.length >= 3 && squash(domain).includes(name);
  });
  return inDomain ? "high" : "medium";
}

const PLACEHOLDER =
  /\b(coming soon|under construction|domain (is )?for sale|parked|lorem ipsum|privacy policy|terms of (use|service))\b/i;
const STOP = new Set([
  "and",
  "the",
  "for",
  "with",
  "insurance",
  "offer",
  "offers",
  "plan",
  "plans",
]);

/**
 * "Safe page" heuristic: a lander-type page with no form, no phone link, and none of the
 * offer's vertical words, or that is mostly placeholder text. Only ever produces an open
 * question; it never hides or drops a page.
 */
export function looksCloaked(
  page: Pick<PageForRules, "url_kind" | "text" | "form_count" | "tel_numbers">,
  vertical: string | null,
): boolean {
  if (!["our_lander", "preview", "offer_page", "competitor_lander"].includes(page.url_kind))
    return false;
  const text = page.text.toLowerCase();
  const noAction = page.form_count === 0 && page.tel_numbers.length === 0;
  const short = text.length < 2000;
  if (short && PLACEHOLDER.test(text) && noAction) return true;
  const words = (vertical ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  if (words.length === 0) return false;
  return noAction && !words.some((w) => text.includes(w));
}
