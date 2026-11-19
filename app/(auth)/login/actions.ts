"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { safeNextPath } from "@/lib/auth/redirect";
import { getPublicEnv } from "@/lib/env/public";
import { createClient } from "@/lib/supabase/server";

export type MagicLinkState = { status: "idle" | "sent" | "error"; message?: string };

// Codes Supabase returns when the email isn't an invited user. We answer the same
// way as success so the form can't be used to discover who has an account.
const NOT_INVITED_CODES = new Set(["otp_disabled", "signup_disabled", "user_not_found"]);

export async function sendMagicLink(
  _prev: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  const parsed = z.object({ email: z.email() }).safeParse({ email: formData.get("email") });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${getPublicEnv().NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });

  if (error && !NOT_INVITED_CODES.has(error.code ?? "")) {
    return { status: "error", message: `Couldn't send the link: ${error.message}` };
  }
  return {
    status: "sent",
    message: "If this email has been invited, a sign-in link is on its way.",
  };
}

export async function signInWithGoogle(formData: FormData) {
  const next = safeNextPath(formData.get("next")?.toString());
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${getPublicEnv().NEXT_PUBLIC_SITE_URL}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error || !data.url) redirect("/login?error=google_failed");
  redirect(data.url);
}
