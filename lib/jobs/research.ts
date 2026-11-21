import "server-only";

import { NonRetriableError } from "inngest";

import { UserInactiveError } from "@/lib/db/as-user";
import { fetchPage, fingerprintProject, pendingPageIds } from "@/lib/research/steps";
import { createAdminClient } from "@/lib/supabase/admin";

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
    onFailure: async ({ event, error }) => {
      const parsed = researchRunEvent.safeParse(event.data.event.data);
      if (!parsed.success) return;
      // BUG-2: the user may be deactivated (nothing can be written AS them), so recovery uses
      // the narrow service-role RPC that can only move running/pending/fetching to failed.
      const reason =
        error?.message === new UserInactiveError().message
          ? "The research job stopped because the user who started it is no longer active."
          : "The research job failed after retries. Use Retry or Run again.";
      const { error: rpcError } = await createAdminClient().rpc("abort_stalled_research_run", {
        p_project_id: parsed.data.projectId,
        p_reason: reason,
      });
      if (rpcError) {
        // Visible in the logs; the page's 2-minute "Run again" fallback still applies.
        console.error(
          `[research] could not abort stalled run ${parsed.data.projectId}: ${rpcError.code}`,
        );
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
