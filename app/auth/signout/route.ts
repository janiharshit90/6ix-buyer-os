import { NextResponse, type NextRequest } from "next/server";

import { isSameOriginPost } from "@/lib/auth/same-origin";
import { createClient } from "@/lib/supabase/server";

// SEC-5: same-origin form POSTs only (see lib/auth/same-origin.ts).
export async function POST(request: NextRequest) {
  if (!isSameOriginPost(request)) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  const to = new URL(error ? "/login?error=signout_failed" : "/login", request.nextUrl.origin);
  return NextResponse.redirect(to, 303);
}
