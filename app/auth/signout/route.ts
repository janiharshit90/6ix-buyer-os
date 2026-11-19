import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    return NextResponse.redirect(new URL("/login?error=signout_failed", request.url), 303);
  }
  return NextResponse.redirect(new URL("/login", request.url), 303);
}
