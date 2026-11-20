import "server-only";

import { Inngest } from "inngest";
import { z } from "zod";

import { getInngestEnv } from "@/lib/env/server";

import { inngestKeyOptions } from "./keys";

// One Inngest app. Keys come from the environment only: APP_INNGEST_* when set (the standard
// INNGEST_* names on Vercel are locked by integrations for another Inngest account), else the
// standard INNGEST_* names. The serve handler uses the client's keys. Locally INNGEST_DEV=1
// talks to `pnpm inngest:dev`.
export const inngest = new Inngest({ id: "6ix-buyer-os", ...inngestKeyOptions(getInngestEnv()) });

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
