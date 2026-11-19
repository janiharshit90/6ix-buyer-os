// One-off: invite BOOTSTRAP_ADMIN_EMAIL so the first admin can sign in
// (public sign-ups are disabled, so nobody can sign in without an invite).
// Their first sign-in then makes them the active admin (see public.bootstrap_admin).
//
//   pnpm admin:bootstrap            # uses .env.local
//
// Prints only the email it invited — never keys.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

const missing = Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: url,
  SUPABASE_SECRET_KEY: secretKey,
  BOOTSTRAP_ADMIN_EMAIL: email,
  NEXT_PUBLIC_SITE_URL: siteUrl,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(url!, secretKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { error } = await supabase.auth.admin.inviteUserByEmail(email!, {
  redirectTo: `${siteUrl}/auth/callback`,
});

if (error) {
  console.error(`Invite failed: ${error.message}`);
  process.exit(1);
}
console.log(`Invite sent to ${email}. Open the email link to sign in; you'll become the admin.`);
