"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireActiveProfile } from "@/lib/auth/current-profile";
import { requestResearchRun } from "@/lib/jobs/client";
import { createClient } from "@/lib/supabase/server";

// Every action checks rights in the DB with the user's client (definer RPCs re-check roles),
// THEN queues the background job with ids only.

export type ActionState = { status: "idle" | "ok" | "error"; message?: string };

const QUEUE_FAILED =
  "Saved, but the background job couldn't be queued. Try “Run again” in a moment; if it keeps failing, background jobs aren't configured on this server.";

async function queue(projectId: string, userId: string): Promise<boolean> {
  try {
    await requestResearchRun({ projectId, userId });
    return true;
  } catch (error) {
    console.error(`[research] could not queue run for ${projectId}: ${(error as Error).name}`);
    return false;
  }
}

const startSchema = z.object({ versionId: z.uuid() });

export async function startResearch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireActiveProfile();
  const parsed = startSchema.safeParse({ versionId: formData.get("versionId") });
  if (!parsed.success) return { status: "error", message: "Invalid offer version." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_research", {
    p_offer_version_id: parsed.data.versionId,
  });
  if (error) {
    return {
      status: "error",
      message: error.code === "42501" ? "You can't start research on this offer." : error.message,
    };
  }
  const {
    project_id: projectId,
    created,
    added_urls: addedUrls,
  } = data as {
    project_id: string;
    created: boolean;
    added_urls?: number;
  };
  // BUG-3: queue whenever there's work, not only for a new project: a previous queue attempt
  // may have failed, or new URLs were just added. Runs per project are serialised, so an extra
  // event is harmless.
  let needsRun = created || (addedUrls ?? 0) > 0;
  if (!needsRun) {
    const { count } = await supabase
      .from("fetched_pages")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("fetch_status", "pending");
    needsRun = (count ?? 0) > 0;
  }
  if (needsRun && !(await queue(projectId, profile.id))) {
    return { status: "error", message: QUEUE_FAILED };
  }
  revalidatePath("/research");
  redirect(`/research/${projectId}`);
}

const pageSchema = z.object({ pageId: z.uuid() });

export async function retryPage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireActiveProfile();
  const parsed = pageSchema.safeParse({ pageId: formData.get("pageId") });
  if (!parsed.success) return { status: "error", message: "Invalid page." };

  const supabase = await createClient();
  const { data: projectId, error } = await supabase.rpc("retry_fetched_page", {
    p_page_id: parsed.data.pageId,
  });
  if (error)
    return {
      status: "error",
      message: error.code === "42501" ? "You can't retry this page." : error.message,
    };
  if (!(await queue(projectId as string, profile.id)))
    return { status: "error", message: QUEUE_FAILED };
  revalidatePath(`/research/${projectId}`);
  return { status: "ok", message: "Queued." };
}

const projectSchema = z.object({ projectId: z.uuid() });

/** Fetches any pending pages again, then makes a new fingerprint version. */
export async function runAgain(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireActiveProfile();
  const parsed = projectSchema.safeParse({ projectId: formData.get("projectId") });
  if (!parsed.success) return { status: "error", message: "Invalid project." };

  const supabase = await createClient();
  const { data: allowed, error } = await supabase.rpc("can_edit_research_project", {
    p_project_id: parsed.data.projectId,
  });
  if (error) return { status: "error", message: error.message };
  if (!allowed) return { status: "error", message: "You can't run this research project." };
  if (!(await queue(parsed.data.projectId, profile.id)))
    return { status: "error", message: QUEUE_FAILED };
  revalidatePath(`/research/${parsed.data.projectId}`);
  return { status: "ok", message: "Queued." };
}
