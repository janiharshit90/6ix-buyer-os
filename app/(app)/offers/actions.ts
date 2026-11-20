"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireActiveProfile } from "@/lib/auth/current-profile";
import { runOfferCheck } from "@/lib/offers/ai-check";
import { offerFormSchema, toSaveDraftArgs } from "@/lib/offers/schema";
import { createClient } from "@/lib/supabase/server";

// Server actions are public endpoints. Each one validates its input with Zod and then
// calls the DB with the USER's client: RLS, column grants and the RPCs' own role checks
// decide what's allowed, not these functions.

export type FormState = {
  status: "idle" | "ok" | "error";
  message?: string;
  issues?: { path: string; message: string }[];
  /** Whether trying again can help (shows a Retry button). */
  retryable?: boolean;
};

/** Turns DB errors into something a buyer can act on (no SQL internals). */
function dbMessage(error: { code?: string; message: string }) {
  switch (error.code) {
    case "42501":
      return "You don't have permission to do that.";
    case "23505":
      return "That conflicts with an existing record (e.g. an open draft or a duplicate URL).";
    case "23514":
      return "A value failed a database check. Review the highlighted fields.";
    case "P0001":
    case "P0002":
      return error.message;
    default:
      return `Save failed: ${error.message}`;
  }
}

export async function saveOfferDraft(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireActiveProfile();

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return { status: "error", message: "The form could not be read. Reload and try again." };
  }
  const parsed = offerFormSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Fix the fields below.",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_offer_draft", toSaveDraftArgs(parsed.data));
  if (error) return { status: "error", message: dbMessage(error) };

  const offerId = (data as { offer_id: string }).offer_id;
  revalidatePath("/offers");
  redirect(`/offers/${offerId}`);
}

const offerIdSchema = z.object({ offerId: z.uuid() });

export async function startNewDraft(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireActiveProfile();
  const parsed = offerIdSchema.safeParse({ offerId: formData.get("offerId") });
  if (!parsed.success) return { status: "error", message: "Invalid offer." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_draft_from_approved", {
    p_offer_id: parsed.data.offerId,
  });
  if (error) return { status: "error", message: dbMessage(error) };

  redirect(`/offers/${parsed.data.offerId}/edit`);
}

const versionSchema = z.object({ offerId: z.uuid(), versionId: z.uuid() });

export async function discardDraft(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireActiveProfile();
  const parsed = versionSchema.safeParse({
    offerId: formData.get("offerId"),
    versionId: formData.get("versionId"),
  });
  if (!parsed.success) return { status: "error", message: "Invalid draft." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("offer_versions")
    .delete()
    .eq("id", parsed.data.versionId)
    .eq("status", "draft")
    .select("id");
  if (error) return { status: "error", message: dbMessage(error) };
  if (!data.length) {
    return {
      status: "error",
      message: "Draft not discarded: it doesn't exist or you can't edit it.",
    };
  }

  revalidatePath("/offers");
  redirect(`/offers/${parsed.data.offerId}`);
}

const approveSchema = versionSchema.extend({
  note: z.string().trim().max(2000, "Max 2000 characters.").optional(),
});

export async function approveOfferVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireActiveProfile();
  const parsed = approveSchema.safeParse({
    offerId: formData.get("offerId"),
    versionId: formData.get("versionId"),
    note: formData.get("note") ?? undefined,
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_offer_version", {
    p_version_id: parsed.data.versionId,
    p_note: parsed.data.note || undefined,
  });
  if (error) return { status: "error", message: dbMessage(error) };

  revalidatePath("/offers");
  redirect(`/offers/${parsed.data.offerId}`);
}

const reassignSchema = z.object({ offerId: z.uuid(), newOwnerId: z.uuid() });

export async function reassignOfferOwner(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireActiveProfile();
  const parsed = reassignSchema.safeParse({
    offerId: formData.get("offerId"),
    newOwnerId: formData.get("newOwnerId"),
  });
  if (!parsed.success) return { status: "error", message: "Pick a new owner." };

  // The RPC checks manager/admin and that the new owner is an active buyer/manager/admin.
  const supabase = await createClient();
  const { error } = await supabase.rpc("reassign_offer_owner", {
    p_offer_id: parsed.data.offerId,
    p_new_owner_id: parsed.data.newOwnerId,
  });
  if (error) return { status: "error", message: dbMessage(error) };

  revalidatePath("/offers");
  revalidatePath(`/offers/${parsed.data.offerId}`);
  return { status: "ok", message: "Owner changed." };
}

/**
 * AI check of the saved draft: code rules + AI suggestions, stored in offer_ai_checks.
 * Never edits the offer. Short (seconds), so it runs here rather than in a background job.
 */
export async function runAiCheck(_prev: FormState, formData: FormData): Promise<FormState> {
  const profile = await requireActiveProfile();
  const parsed = versionSchema.safeParse({
    offerId: formData.get("offerId"),
    versionId: formData.get("versionId"),
  });
  if (!parsed.success) return { status: "error", message: "Invalid draft.", retryable: false };

  const result = await runOfferCheck(profile, parsed.data.offerId, parsed.data.versionId);
  if (!result.ok) return { status: "error", message: result.message, retryable: result.retryable };

  revalidatePath(`/offers/${parsed.data.offerId}`);
  return { status: "ok", message: "AI check finished." };
}
