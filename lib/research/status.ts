// Whether a research project is busy, and whether it looks stalled (BUG-3). Pure; unit-tested.

export const STALLED_AFTER_MS = 2 * 60 * 1000;

type ProjectLike = { status: string; fingerprint_status: string; updated_at: string };
type PageLike = { fetch_status: string; updated_at: string };

export function researchState(project: ProjectLike, pages: PageLike[], now: number = Date.now()) {
  const busy =
    project.status === "active" &&
    (pages.some((p) => p.fetch_status === "pending" || p.fetch_status === "fetching") ||
      project.fingerprint_status === "running");
  // Nothing changed for a while: assume the job isn't running (e.g. it couldn't be queued) and
  // offer "Run again" instead of polling forever.
  const lastChange = Math.max(
    Date.parse(project.updated_at),
    ...pages.map((p) => Date.parse(p.updated_at)),
  );
  const stalled = busy && now - lastChange > STALLED_AFTER_MS;
  return { busy, stalled, working: busy && !stalled };
}
