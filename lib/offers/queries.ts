import "server-only";

import type { CurrentProfile } from "@/lib/auth/current-profile";
import type { Tables } from "@/lib/db/types";
import { createClient } from "@/lib/supabase/server";

// Every read goes through the signed-in user's client, so RLS decides what comes back.
// Creatives are never even ASKED for economics: their queries use offer_versions, not the
// economics view (which returns zero rows for them anyway).

export type OfferVersion = Tables<"offer_versions">;
export type OfferVersionWithEconomics = Tables<"offer_versions_with_economics">;
export type OfferUrl = Pick<Tables<"offer_urls">, "id" | "url" | "kind">;
export type Economics = Pick<
  Tables<"offer_version_economics">,
  "payout_tiers" | "target_cpl" | "target_roi"
>;

export type VersionView = OfferVersion & { economics: Economics | null; urls: OfferUrl[] };

export function canSeeEconomics(profile: Pick<CurrentProfile, "role">) {
  return profile.role !== "creative";
}

/** Display hint only. The DB (RLS + private.can_edit_offer) is what actually decides. */
export function canEditOffer(
  profile: Pick<CurrentProfile, "id" | "role">,
  offer: { owner_id: string },
) {
  return (
    profile.role === "admin" ||
    profile.role === "manager" ||
    (profile.role === "buyer" && offer.owner_id === profile.id)
  );
}

export function canApprove(profile: Pick<CurrentProfile, "role">) {
  return profile.role === "admin" || profile.role === "manager";
}

export async function listOffers() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("offers")
    .select(
      `id, name, vertical, status, owner_id, current_version_id, updated_at,
       advertiser:advertisers(name),
       owner:profiles!offers_owner_id_fkey(display_name),
       versions:offer_versions!offer_versions_offer_id_fkey(version, status)`,
    )
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Could not load offers: ${error.message}`);
  return data;
}

export async function listAdvertiserNames() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("advertisers").select("name").order("name");
  if (error) throw new Error(`Could not load advertisers: ${error.message}`);
  return data.map((a) => a.name);
}

export async function getOffer(offerId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("offers")
    .select(
      `id, name, vertical, status, owner_id, current_version_id,
       advertiser:advertisers(name),
       owner:profiles!offers_owner_id_fkey(display_name)`,
    )
    .eq("id", offerId)
    .maybeSingle();
  if (error) throw new Error(`Could not load offer: ${error.message}`);
  return data;
}

/** All versions the viewer may see, newest first, with URLs and (if allowed) economics. */
export async function getVersions(
  offerId: string,
  profile: Pick<CurrentProfile, "role">,
): Promise<VersionView[]> {
  const supabase = await createClient();

  const { data: versions, error } = await supabase
    .from("offer_versions")
    .select("*")
    .eq("offer_id", offerId)
    .order("version", { ascending: false });
  if (error) throw new Error(`Could not load offer versions: ${error.message}`);
  if (!versions.length) return [];

  const ids = versions.map((v) => v.id);
  const { data: urls, error: urlError } = await supabase
    .from("offer_urls")
    .select("id, url, kind, offer_version_id")
    .in("offer_version_id", ids)
    .order("created_at");
  if (urlError) throw new Error(`Could not load offer URLs: ${urlError.message}`);

  let economics = new Map<string, Economics>();
  if (canSeeEconomics(profile)) {
    const { data: econ, error: econError } = await supabase
      .from("offer_version_economics")
      .select("offer_version_id, payout_tiers, target_cpl, target_roi")
      .in("offer_version_id", ids);
    if (econError) throw new Error(`Could not load economics: ${econError.message}`);
    economics = new Map(econ.map(({ offer_version_id, ...rest }) => [offer_version_id, rest]));
  }

  return versions.map((v) => ({
    ...v,
    economics: economics.get(v.id) ?? null,
    urls: urls
      .filter((u) => u.offer_version_id === v.id)
      .map(({ id, url, kind }) => ({ id, url, kind })),
  }));
}

export async function getApprovals(versionIds: string[]) {
  if (!versionIds.length) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("approvals")
    .select(
      "entity_id, version, action, note, at, approver:profiles!approvals_by_fkey(display_name)",
    )
    .eq("entity_type", "offer_version")
    .in("entity_id", versionIds)
    .order("at", { ascending: false });
  if (error) throw new Error(`Could not load approvals: ${error.message}`);
  return data;
}

/** Who can receive an offer: active buyers, managers and admins (the RPC re-checks this). */
export async function listAssignableOwners() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, role")
    .eq("active", true)
    .in("role", ["buyer", "manager", "admin"])
    .order("display_name");
  if (error) throw new Error(`Could not load users: ${error.message}`);
  return data;
}
