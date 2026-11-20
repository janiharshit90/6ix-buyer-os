import { serve } from "inngest/next";

import { inngest } from "@/lib/jobs/client";
import { functions } from "@/lib/jobs/research";

// Inngest calls this endpoint to run job steps. It has no user session: requests are
// authenticated by INNGEST_SIGNING_KEY (checked by the SDK). The proxy lets it through.
export const { GET, POST, PUT } = serve({ client: inngest, functions });

// Fetches + an AI call per step; well within Vercel's limit.
export const maxDuration = 300;
