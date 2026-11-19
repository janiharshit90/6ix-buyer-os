import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { isBootstrapAdminEmail } from "./bootstrap";

/**
 * Called right after a successful sign-in. If the user's verified email equals
 * BOOTSTRAP_ADMIN_EMAIL, asks the DB to make them the active admin. The DB only
 * agrees while there is no active admin, so this can't undo a later demotion.
 */
export async function maybeBootstrapAdmin(user: { id: string; email?: string | null }) {
  const { BOOTSTRAP_ADMIN_EMAIL } = getServerEnv();
  if (!isBootstrapAdminEmail(user.email, BOOTSTRAP_ADMIN_EMAIL)) return false;

  const { data, error } = await createAdminClient().rpc("bootstrap_admin", {
    target_user_id: user.id,
  });
  if (error) throw new Error(`bootstrap_admin failed: ${error.message}`);

  if (data) {
    // User id only: no emails or tokens in logs.
    console.info(`[auth] bootstrap admin granted to user ${user.id}`);
    // TODO(M1): write an audit_log row (actor = user, action = 'bootstrap_admin').
  }
  return data === true;
}
