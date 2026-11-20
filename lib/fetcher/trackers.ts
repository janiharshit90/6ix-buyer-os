// Known affiliate tracker / redirect domains (config, Decisions log M3). URLs on these
// domains, as the requested URL or as any redirect hop, are NEVER fetched: requesting them
// can register a click with the network. Most trackers also run on custom domains this list
// can't know; that's why offer_page URLs need the buyer's explicit "not a tracking link".
//
// Matching is by registrable suffix: "redtrack.io" also matches "x.redtrack.io".
// Add domains here (lowercase, no scheme). Changes ship like any code change.
export const TRACKER_DOMAINS: readonly string[] = [
  // RedTrack
  "redtrack.io",
  "rdtk.io",
  // ClickFlare
  "clickflare.io",
  // Voluum
  "voluum.com",
  "volumtrk.com",
  // Everflow
  "everflow.io",
  "eflow.team",
  // CAKE
  "getcake.com",
  // TUNE / HasOffers
  "hasoffers.com",
  "go2cloud.org",
  // Binom, Keitaro, BeMob, ThriveTracker, FunnelFlux
  "binom.org",
  "keitaro.io",
  "bemob.com",
  "thrivetracker.com",
  "funnelflux.pro",
];

export function isTrackerHost(
  hostname: string,
  list: readonly string[] = TRACKER_DOMAINS,
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}
