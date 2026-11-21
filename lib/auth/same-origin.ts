import type { NextRequest } from "next/server";

import { getPublicEnv } from "@/lib/env/public";

/**
 * SEC-5: only same-origin POSTs may sign the user out, so another site can't log people out
 * (logout CSRF). Browsers send Origin (and Sec-Fetch-Site) on form POSTs.
 */
export function isSameOriginPost(request: NextRequest): boolean {
  const allowed = new Set([request.nextUrl.origin]);
  try {
    allowed.add(new URL(getPublicEnv().NEXT_PUBLIC_SITE_URL).origin);
  } catch {
    // Misconfigured site URL: the request's own origin still counts.
  }
  const origin = request.headers.get("origin");
  if (origin) return allowed.has(origin);
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  return false; // neither header: not a browser form POST from our pages
}
