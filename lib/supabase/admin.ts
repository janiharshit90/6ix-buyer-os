import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/db/types";
import { getPublicEnv } from "@/lib/env/public";
import { getServerEnv } from "@/lib/env/server";

/**
 * Service-role client: BYPASSES RLS. Only for auth admin calls (invites, listing
 * emails) and the bootstrap RPC. Every caller must check permissions first.
 */
export function createAdminClient() {
  return createClient<Database>(
    getPublicEnv().NEXT_PUBLIC_SUPABASE_URL,
    getServerEnv().SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
