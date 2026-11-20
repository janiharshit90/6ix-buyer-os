import type { Tables } from "@/lib/db/types";

/** A stored version as the pages load it: row + optional economics + URLs. Pure type. */
export type VersionViewLike = Tables<"offer_versions"> & {
  economics: Pick<
    Tables<"offer_version_economics">,
    "payout_tiers" | "target_cpl" | "target_roi"
  > | null;
  urls: Pick<Tables<"offer_urls">, "url" | "kind" | "not_tracking_link">[];
};
