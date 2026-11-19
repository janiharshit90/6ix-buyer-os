import "server-only";

import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import type { AppRole } from "@/lib/db/roles";
import { createClient } from "@/lib/supabase/server";

export type CurrentProfile = {
  id: string;
  email: string | null;
  displayName: string;
  role: AppRole;
  active: boolean;
};

/**
 * The signed-in user's profile, read through RLS. Null when signed out.
 * Deduplicated per request with React cache().
 */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  // Session checks compare token expiry to the current time, so they must run at
  // request time, never during prerender (Cache Components).
  await connection();
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims?.sub) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, role, active")
    .eq("id", claimsData.claims.sub)
    .maybeSingle();
  if (error) throw new Error(`Could not load your profile: ${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    email: typeof claimsData.claims.email === "string" ? claimsData.claims.email : null,
    displayName: data.display_name,
    role: data.role,
    active: data.active,
  };
});

/** Signed in and activated by an admin, or redirected away. */
export async function requireActiveProfile(): Promise<CurrentProfile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.active) redirect("/pending");
  return profile;
}

/** For server actions and admin pages. UI hiding is not security; RLS still applies. */
export async function requireAdmin(): Promise<CurrentProfile> {
  const profile = await requireActiveProfile();
  if (profile.role !== "admin") throw new Error("Admins only.");
  return profile;
}
