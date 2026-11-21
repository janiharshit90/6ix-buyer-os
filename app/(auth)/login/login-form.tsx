"use client";

import { useSearchParams } from "next/navigation";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { sendMagicLink, signInWithGoogle, type MagicLinkState } from "./actions";

const ERRORS: Record<string, string> = {
  not_invited: "This account hasn't been invited. Ask an admin for an invite.",
  link_invalid: "That sign-in link is invalid or has expired. Request a new one.",
  callback_failed: "Sign-in couldn't be completed just now. Try the link again in a moment.",
  missing_token: "That sign-in link is incomplete. Request a new one.",
  google_failed: "Couldn't start Google sign-in. Try again.",
  signout_failed: "Sign-out failed. Try again.",
  profile_unavailable: "Signed in, but your profile couldn't be loaded. Try again.",
};

export function LoginForm() {
  const searchParams = useSearchParams();
  const errorKey = searchParams.get("error");
  const next = searchParams.get("next") ?? "";
  const [state, formAction, pending] = useActionState<MagicLinkState, FormData>(sendMagicLink, {
    status: "idle",
  });

  return (
    <div className="flex flex-col gap-6">
      {errorKey && (
        <p
          role="alert"
          className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm"
        >
          {ERRORS[errorKey] ?? "Sign-in failed. Try again."}
        </p>
      )}

      <form action={signInWithGoogle}>
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="outline" className="w-full">
          Continue with Google
        </Button>
      </form>

      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Email me a sign-in link"}
        </Button>
        {state.message && (
          <p
            role={state.status === "error" ? "alert" : "status"}
            className={
              state.status === "error"
                ? "text-destructive text-sm"
                : "text-muted-foreground text-sm"
            }
          >
            {state.message}
          </p>
        )}
      </form>
    </div>
  );
}
