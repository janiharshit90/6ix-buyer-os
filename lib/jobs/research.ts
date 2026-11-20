import "server-only";

import { NonRetriableError } from "inngest";

import { UserInactiveError, withUserTx } from "@/lib/db/as-user";
import { fetchPage, fingerprintProject, pendingPageIds } from "@/lib/research/steps";

import { inngest, RESEARCH_RUN, researchRunEvent } from "./client";

/**
 * One research run: fetch every pending page of the project (one retried step each), then
 * fingerprint. Re-running = queue pages again (retry) or just fingerprint again.
 * Every step acts as the requesting user (lib/db/as-user.ts), so RLS applies throughout and a
 * user deactivated mid-run stops the run instead of being retried.
 */
export const researchRun = inngest.createFunction(
  {
    id: "research-run",
    triggers: [{ event: RESEARCH_RUN }],
    // One run per project at a time; queued runs wait.
    concurrency: { key: "event.data.projectId", limit: 1 },
    retries: 3,
    onFailure: async ({ event }) => {
      const parsed = researchRunEvent.safeParse(event.data.event.data);
      if (!parsed.success) return;
      const { userId, projectId } = parsed.data;
      try {
        await withUserTx(
          userId,
          (tx) => tx`update public.research_projects
          set fingerprint_status = 'failed',
              fingerprint_error = 'The research job failed after retries. Use Retry to run it again.'
          where id = ${projectId} and fingerprint_status = 'running'`,
        );
      } catch {
        // User inactive or DB down: nothing more we can record here.
      }
    },
  },
  async ({ event, step }) => {
    const parsed = researchRunEvent.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError("Invalid research event payload.");
    const { userId, projectId } = parsed.data;

    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof UserInactiveError) throw new NonRetriableError(e.message);
        throw e;
      }
    };

    const pageIds = await step.run("list-pending-pages", () =>
      guard(() => pendingPageIds(userId, projectId)),
    );
    for (const pageId of pageIds) {
      await step.run(`fetch-${pageId}`, () => guard(() => fetchPage(userId, pageId)));
    }
    return step.run("fingerprint", () => guard(() => fingerprintProject(userId, projectId)));
  },
);

export const functions = [researchRun];
