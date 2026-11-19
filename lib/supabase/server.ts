import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/db/types";
import { getPublicEnv } from "@/lib/env/public";

/**
 * Supabase client scoped to the signed-in user: every query runs under their RLS.
 * Create one per request; never share across requests.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const env = getPublicEnv();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components can't set cookies. That's expected here: proxy.ts
            // refreshes the session on every request, so nothing is lost.
          }
        },
      },
    },
  );
}
