import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/db/types";

type Client = SupabaseClient<Database>;

export type InviteResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not_admin" | "invalid_email" | "invite_failed"; message: string };

/**
 * Returns the caller's id only if the DATABASE says they are an active admin.
 * Reads through the caller's own RLS-scoped client, so it can't see more than they can.
 */
export async function getActiveAdminId(userClient: Client): Promise<string | null> {
  const { data: claimsData } = await userClient.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (!userId) return null;

  const { data, error } = await userClient
    .from("profiles")
    .select("id, role, active")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Could not check admin status: ${error.message}`);

  return data?.active && data.role === "admin" ? data.id : null;
}

/**
 * Invite a user by email. `serviceClient` uses the secret key and bypasses RLS, so
 * the active-admin check MUST pass first; nothing touches auth before it does.
 */
export async function inviteUserAs(
  userClient: Client,
  serviceClient: Client,
  input: { email: unknown; siteUrl: string },
): Promise<InviteResult> {
  const adminId = await getActiveAdminId(userClient);
  if (!adminId) {
    return { ok: false, reason: "not_admin", message: "Only active admins can invite users." };
  }

  const parsed = z.email().safeParse(input.email);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_email", message: "Enter a valid email address." };
  }

  const { error } = await serviceClient.auth.admin.inviteUserByEmail(parsed.data, {
    redirectTo: `${input.siteUrl}/auth/callback`,
    data: { invited_by: adminId },
  });
  if (error) {
    return { ok: false, reason: "invite_failed", message: `Invite failed: ${error.message}` };
  }
  return { ok: true, email: parsed.data };
}
