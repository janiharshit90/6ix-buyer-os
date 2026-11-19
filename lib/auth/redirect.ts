export const DEFAULT_AFTER_LOGIN = "/offers";

/**
 * Only allow same-site relative paths as post-login redirects (blocks open redirects
 * like `//evil.com`, `/\evil.com` or `https://evil.com`).
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return DEFAULT_AFTER_LOGIN;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return DEFAULT_AFTER_LOGIN;
  }
  // Control characters (e.g. tab/newline) can be stripped by browsers into `//`.
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_AFTER_LOGIN;
  if (next === "/login" || next.startsWith("/auth/")) return DEFAULT_AFTER_LOGIN;
  return next;
}
