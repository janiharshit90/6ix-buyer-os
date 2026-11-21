"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { inviteUserAs } from "@/lib/admin/invite";
import { requireActiveProfile } from "@/lib/auth/current-profile";
import { dbMessage } from "@/lib/db/errors";
import { APP_ROLES } from "@/lib/db/roles";
import { getPublicEnv } from "@/lib/env/public";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { status: "idle" | "ok" | "error"; message?: string };

const NOT_ADMIN: ActionState = { status: "error", message: "Only admins can do that." };

/**
 * Admin-only actions return an error state instead of throwing (a throw shows the error page).
 * Still only a UI convenience: RLS, grants and triggers are what enforce admin rights.
 */
async function isAdmin(): Promise<boolean> {
  const profile = await requireActiveProfile();
  return profile.role === "admin";
}

const displayNameSchema = z.object({
  displayName: z.string().trim().min(1, "Name is required.").max(100, "Max 100 characters."),
});

export async function updateDisplayName(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const profile = await requireActiveProfile();
  const parsed = displayNameSchema.safeParse({ displayName: formData.get("displayName") });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message };

  // User-scoped client: RLS decides whether this is allowed.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ display_name: parsed.data.displayName })
    .eq("id", profile.id)
    .select("id");
  if (error) return { status: "error", message: dbMessage(error) };
  if (!data?.length) return { status: "error", message: "Not saved: you don't have permission." };

  revalidatePath("/settings");
  return { status: "ok", message: "Saved." };
}

export async function inviteUser(_prev: ActionState, formData: FormData): Promise<ActionState> {
  // Server actions are public endpoints: the active-admin check happens inside
  // inviteUserAs, against the DB, before the secret-key client is used.
  const result = await inviteUserAs(await createClient(), createAdminClient(), {
    email: formData.get("email"),
    siteUrl: getPublicEnv().NEXT_PUBLIC_SITE_URL,
  });
  if (!result.ok) return { status: "error", message: result.message };

  revalidatePath("/settings");
  return {
    status: "ok",
    message: `Invite sent to ${result.email}. They'll appear below as an inactive buyer.`,
  };
}

const accessSchema = z.object({
  userId: z.uuid(),
  role: z.enum(APP_ROLES),
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function updateUserAccess(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const parsed = accessSchema.safeParse({
    userId: formData.get("userId"),
    role: formData.get("role"),
    active: formData.get("active"),
  });
  if (!parsed.success) return { status: "error", message: "Invalid input." };

  // User-scoped client on purpose: RLS + the profiles_guard trigger enforce who may
  // change roles and protect the last admin, even if this check above were wrong.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ role: parsed.data.role, active: parsed.data.active })
    .eq("id", parsed.data.userId)
    .select("id");
  if (error) return { status: "error", message: dbMessage(error) };
  if (!data?.length) return { status: "error", message: "Not saved: you don't have permission." };

  revalidatePath("/settings");
  return { status: "ok", message: "Saved." };
}

// ---------------------------------------------------------------------------
// AI budgets (admins). User-scoped client: RLS lets only admins write budgets, and every
// change is audited by a DB trigger, even if the requireAdmin check above were wrong.
// ---------------------------------------------------------------------------

const capUsd = z
  .string()
  .trim()
  .regex(/^\d{1,7}(\.\d{1,2})?$/, "Enter a dollar amount like 20 or 20.50.")
  .transform(Number);

const workspaceCapSchema = z.object({ capUsd });

export async function setWorkspaceCap(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const parsed = workspaceCapSchema.safeParse({ capUsd: formData.get("capUsd") });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { data: existing, error: readError } = await supabase
    .from("budgets")
    .select("id")
    .eq("scope", "workspace")
    .maybeSingle();
  if (readError) return { status: "error", message: dbMessage(readError) };

  const { error } = existing
    ? await supabase
        .from("budgets")
        .update({ monthly_cap_usd: parsed.data.capUsd })
        .eq("id", existing.id)
    : await supabase
        .from("budgets")
        .insert({ scope: "workspace", scope_id: null, monthly_cap_usd: parsed.data.capUsd });
  if (error) return { status: "error", message: dbMessage(error) };

  revalidatePath("/settings");
  return { status: "ok", message: "Workspace cap saved." };
}

const userCapSchema = z.object({
  userId: z.uuid(),
  // Blank = remove the user's own cap (the workspace cap still applies).
  capUsd: z.union([z.literal(""), capUsd]),
});

export async function setUserCap(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const parsed = userCapSchema.safeParse({
    userId: formData.get("userId"),
    capUsd: String(formData.get("capUsd") ?? "").trim(),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message };
  const { userId, capUsd: cap } = parsed.data;

  const supabase = await createClient();
  if (cap === "") {
    const { error } = await supabase
      .from("budgets")
      .delete()
      .eq("scope", "user")
      .eq("scope_id", userId);
    if (error) return { status: "error", message: dbMessage(error) };
    revalidatePath("/settings");
    return { status: "ok", message: "Cap removed." };
  }

  const { data: existing, error: readError } = await supabase
    .from("budgets")
    .select("id")
    .eq("scope", "user")
    .eq("scope_id", userId)
    .maybeSingle();
  if (readError) return { status: "error", message: dbMessage(readError) };

  const { error } = existing
    ? await supabase.from("budgets").update({ monthly_cap_usd: cap }).eq("id", existing.id)
    : await supabase
        .from("budgets")
        .insert({ scope: "user", scope_id: userId, monthly_cap_usd: cap });
  if (error) return { status: "error", message: dbMessage(error) };

  revalidatePath("/settings");
  return { status: "ok", message: "Cap saved." };
}
