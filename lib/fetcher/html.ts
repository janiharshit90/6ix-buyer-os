// Turns HTML into clean, visible text plus a few structural facts. Parsing only: nothing
// on the page is executed, loaded or submitted. Hidden text (hidden attribute, aria-hidden,
// inline display:none / visibility:hidden) is dropped, which also removes the commonest
// place to hide prompt-injection text from a human reviewer.
import { Parser } from "htmlparser2";

export type HtmlFacts = {
  title: string | null;
  siteName: string | null;
  description: string | null;
  text: string;
  /** Absolute URL from <meta http-equiv="refresh">, if any (followed as a redirect hop). */
  metaRefresh: string | null;
  linkHosts: string[];
  formActionHosts: string[];
  formCount: number;
  telNumbers: string[];
  scriptCount: number;
  /** A JS-app mount point like <div id="root"> / id="__next" / id="app". */
  appRoot: boolean;
};

const SKIP_TEXT = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "head",
  "iframe",
  "object",
  "canvas",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "tr",
  "td",
  "th",
  "table",
  "form",
  "label",
  "button",
  "blockquote",
  "pre",
  "hr",
  "dd",
  "dt",
  "figcaption",
]);
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function isHidden(attrs: Record<string, string>): boolean {
  if ("hidden" in attrs) return true;
  if ((attrs["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const style = (attrs.style ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function absoluteHost(href: string, base: URL): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function extractHtml(html: string, baseUrl: string): HtmlFacts {
  const base = new URL(baseUrl);
  const chunks: string[] = [];
  // Stack of open elements: whether each one suppresses text.
  const stack: { name: string; suppress: boolean }[] = [];
  let title = "";
  let inTitle = false;
  let siteName: string | null = null;
  let description: string | null = null;
  let metaRefresh: string | null = null;
  const linkHosts = new Set<string>();
  const formActionHosts = new Set<string>();
  const telNumbers = new Set<string>();
  let formCount = 0;
  let scriptCount = 0;
  let appRoot = false;

  const suppressed = () => stack.some((e) => e.suppress);

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title") inTitle = true;
        if (name === "script") scriptCount++;
        if (name === "meta") {
          const prop = (attrs.property ?? attrs.name ?? "").toLowerCase();
          if (prop === "og:site_name" && attrs.content)
            siteName = attrs.content.trim().slice(0, 300);
          if (
            (prop === "description" || prop === "og:description") &&
            attrs.content &&
            !description
          ) {
            description = attrs.content.trim().slice(0, 1000);
          }
          if ((attrs["http-equiv"] ?? "").toLowerCase() === "refresh" && attrs.content) {
            const m = attrs.content.match(/url\s*=\s*['"]?([^'";]+)/i);
            if (m?.[1]) {
              try {
                metaRefresh = new URL(m[1].trim(), base).toString();
              } catch {
                /* malformed refresh target: ignored, recorded as no refresh */
              }
            }
          }
        }
        if (name === "a" && attrs.href) {
          const href = attrs.href.trim();
          if (/^tel:/i.test(href)) telNumbers.add(href.slice(4).trim());
          else {
            const host = absoluteHost(href, base);
            if (host) linkHosts.add(host);
          }
        }
        if (name === "form") {
          formCount++;
          const host = absoluteHost(attrs.action || base.toString(), base);
          if (host) formActionHosts.add(host);
        }
        if (name === "div" && ["root", "__next", "app", "__nuxt"].includes(attrs.id ?? ""))
          appRoot = true;
        if (BLOCK.has(name)) chunks.push("\n");
        if (!VOID.has(name)) {
          stack.push({ name, suppress: SKIP_TEXT.has(name) || isHidden(attrs) });
        }
      },
      ontext(text) {
        if (inTitle) {
          title += text;
          return;
        }
        if (!suppressed()) chunks.push(text);
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (BLOCK.has(name)) chunks.push("\n");
        if (VOID.has(name)) return;
        // Pop to the matching element (tolerates sloppy HTML).
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]!.name === name) {
            stack.length = i;
            break;
          }
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const text = chunks
    .join("")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

  return {
    title: title.replace(/\s+/g, " ").trim().slice(0, 1000) || null,
    siteName,
    description,
    text,
    metaRefresh,
    linkHosts: [...linkHosts].slice(0, 200),
    formActionHosts: [...formActionHosts].slice(0, 50),
    formCount,
    telNumbers: [...telNumbers].slice(0, 50),
    scriptCount,
    appRoot,
  };
}
