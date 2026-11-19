"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { inviteUserAs } from "@/lib/admin/invite";
import { requireActiveProfile, requireAdmin } from "@/lib/auth/current-profile";
import { APP_ROLES } from "@/lib/db/types";
import { getPublicEnv } from "@/lib/env/public";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { status: "idle" | "ok" | "error"; message?: string };

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
  if (error) return { status: "error", message: error.message };
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
  await requireAdmin();
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
  if (error) return { status: "error", message: error.message };
  if (!data?.length) return { status: "error", message: "Not saved: you don't have permission." };

  revalidatePath("/settings");
  return { status: "ok", message: "Saved." };
}
