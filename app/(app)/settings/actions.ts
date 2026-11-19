"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

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

const inviteSchema = z.object({ email: z.email("Enter a valid email address.") });

export async function inviteUser(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = inviteSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message };

  // Service role is needed for auth admin calls; permission was checked above.
  const { error } = await createAdminClient().auth.admin.inviteUserByEmail(parsed.data.email, {
    redirectTo: `${getPublicEnv().NEXT_PUBLIC_SITE_URL}/auth/callback`,
    data: { invited_by: admin.id },
  });
  if (error) return { status: "error", message: `Invite failed: ${error.message}` };

  revalidatePath("/settings");
  return {
    status: "ok",
    message: `Invite sent to ${parsed.data.email}. They'll appear below as an inactive buyer.`,
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
