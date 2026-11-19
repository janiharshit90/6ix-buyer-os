import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { maybeBootstrapAdmin } from "@/lib/auth/bootstrap.server";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

const EMAIL_LINK_TYPES: readonly EmailOtpType[] = ["email", "magiclink", "invite"];

/**
 * Lands every sign-in:
 *  - Google OAuth (PKCE) → ?code=
 *  - magic link / invite email → ?token_hash=&type=  (see supabase/templates)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next"));

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/login?error=${reason}`, request.url));

  // Supabase redirects here with an error (e.g. an uninvited Google account).
  const providerError = searchParams.get("error_code") ?? searchParams.get("error");
  if (providerError) {
    return fail(providerError === "signup_disabled" ? "not_invited" : "link_invalid");
  }

  const supabase = await createClient();

  let result;
  if (code) {
    result = await supabase.auth.exchangeCodeForSession(code);
  } else if (tokenHash && type && EMAIL_LINK_TYPES.includes(type)) {
    result = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  } else {
    return fail("missing_token");
  }

  if (result.error || !result.data.user) {
    // Supabase returns this when sign-ups are disabled and the account wasn't invited.
    const reason = result.error?.code === "signup_disabled" ? "not_invited" : "link_invalid";
    return fail(reason);
  }

  await maybeBootstrapAdmin(result.data.user);

  // Not yet activated → straight to the holding page instead of bouncing off the gate.
  // Read through the user's own RLS (inactive users can read their own row).
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("active")
    .eq("id", result.data.user.id)
    .maybeSingle();
  if (profileError) return fail("profile_unavailable");
  const destination = profile?.active ? next : "/pending";

  return NextResponse.redirect(new URL(destination, request.url));
}
