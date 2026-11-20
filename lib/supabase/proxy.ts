import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/db/types";
import { getPublicEnv } from "@/lib/env/public";

/** Paths reachable without a session. Everything else redirects to /login. */
export const PUBLIC_PATHS = ["/login", "/auth/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

/**
 * Refreshes the Supabase session cookie and does an optimistic signed-in check.
 * This is NOT the authorization layer: RLS is. Pages still verify the profile.
 */
export async function updateSession(request: NextRequest) {
  const env = getPublicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    },
  );

  // Don't put code between client creation and getClaims(): it refreshes the session.
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  const signedIn = Boolean(userId);
  const { pathname, search } = request.nextUrl;

  if (!signedIn && !isPublicPath(pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    const redirect = NextResponse.redirect(loginUrl);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  // Signed in but not (or no longer) active → /pending, before any page renders.
  // Redirecting here instead of inside the (app) layout's <Suspense> keeps dev-time
  // instant-navigation validation from aborting on a redirect mid-render. Still not the
  // authorization layer: RLS denies inactive users everywhere, and the layout re-checks.
  if (userId && !isPublicPath(pathname) && pathname !== "/pending") {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("active")
      .eq("id", userId)
      .maybeSingle();
    // On a lookup error, fall through: the layout's requireActiveProfile() handles it visibly.
    if (!error && !profile?.active) {
      const pendingUrl = request.nextUrl.clone();
      pendingUrl.pathname = "/pending";
      pendingUrl.search = "";
      const redirect = NextResponse.redirect(pendingUrl);
      for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
      return redirect;
    }
  }

  return response;
}
