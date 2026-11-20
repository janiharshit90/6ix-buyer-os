import "server-only";

import { z } from "zod";

import type { Tables } from "@/lib/db/types";
import { createClient } from "@/lib/supabase/server";

// Reads for the research screens, all through the signed-in user's client (RLS decides;
// creatives get nothing).

export type ResearchPage = Pick<
  Tables<"fetched_pages">,
  | "id"
  | "url_kind"
  | "requested_url"
  | "final_url"
  | "final_domain"
  | "redirect_chain"
  | "http_status"
  | "title"
  | "fetch_status"
  | "error_code"
  | "error_message"
  | "attempts"
  | "fetched_at"
  | "truncated"
  | "text_chars"
>;

export async function listProjects() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("research_projects")
    .select(
      `id, status, fingerprint_status, created_at, offer_id,
       offer:offers(name), owner:profiles!research_projects_owner_id_fkey(display_name)`,
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load research projects: ${error.message}`);
  return data;
}

export async function getActiveProjectId(offerId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("research_projects")
    .select("id")
    .eq("offer_id", offerId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`Could not load research project: ${error.message}`);
  return data?.id ?? null;
}

export async function getProject(projectId: string) {
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("research_projects")
    .select(
      `id, status, fingerprint_status, fingerprint_error, current_fingerprint_id, offer_id,
       offer_version_id, owner_id, created_at,
       offer:offers(name, vertical), owner:profiles!research_projects_owner_id_fkey(display_name)`,
    )
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw new Error(`Could not load research project: ${error.message}`);
  if (!project) return null;

  const [pages, fingerprints, version] = await Promise.all([
    supabase
      .from("fetched_pages")
      .select(
        "id, url_kind, requested_url, final_url, final_domain, redirect_chain, http_status, title, fetch_status, error_code, error_message, attempts, fetched_at, truncated, text_chars",
      )
      .eq("project_id", projectId)
      // Pages are inserted together (same created_at): order by kind (our_lander first), then URL.
      .order("url_kind")
      .order("requested_url"),
    supabase
      .from("fingerprints")
      .select("*")
      .eq("project_id", projectId)
      .order("version", { ascending: false }),
    supabase
      .from("offer_versions")
      .select("version, status")
      .eq("id", project.offer_version_id)
      .maybeSingle(),
  ]);
  if (pages.error) throw new Error(`Could not load pages: ${pages.error.message}`);
  if (fingerprints.error)
    throw new Error(`Could not load fingerprints: ${fingerprints.error.message}`);

  return {
    project,
    pages: pages.data as ResearchPage[],
    fingerprints: fingerprints.data,
    offerVersion: version.data,
  };
}

/** Stored item shapes (written by lib/research/steps.ts). */
export const itemSchema = z.object({ value: z.string(), page_id: z.string(), quote: z.string() });
export const phoneSchema = z.object({ value: z.string(), page_ids: z.array(z.string()) });
export const domainSchema = z.object({
  value: z.string(),
  roles: z.array(z.string()),
  page_ids: z.array(z.string()),
});
export const parseList = <T>(schema: z.ZodType<T>, value: unknown): T[] =>
  z.array(schema).catch([]).parse(value);
