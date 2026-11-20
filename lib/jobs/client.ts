import "server-only";

import { Inngest } from "inngest";
import { z } from "zod";

// One Inngest app. Keys come from the environment only (INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY,
// set by the Vercel integration); locally INNGEST_DEV=1 talks to `pnpm inngest:dev`.
export const inngest = new Inngest({ id: "6ix-buyer-os" });

/** Job payloads carry ids only: never tokens, never content (Decisions log, option c). */
export const researchRunEvent = z.object({
  projectId: z.uuid(),
  userId: z.uuid(),
});
export type ResearchRunEvent = z.infer<typeof researchRunEvent>;

export const RESEARCH_RUN = "research/run.requested";

/** Sent by server actions AFTER they've checked the user's rights through RLS. */
export async function requestResearchRun(data: ResearchRunEvent) {
  await inngest.send({ name: RESEARCH_RUN, data: researchRunEvent.parse(data) });
}
