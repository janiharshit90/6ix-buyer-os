import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SignOutButton } from "@/components/app/user-menu";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile } from "@/lib/auth/current-profile";
import { DEFAULT_AFTER_LOGIN } from "@/lib/auth/redirect";

export const metadata: Metadata = { title: "Awaiting activation" };

export default function PendingPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Awaiting activation</CardTitle>
          <CardDescription>
            You&apos;re signed in, but an admin still needs to activate your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense>
            <PendingDetails />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}

async function PendingDetails() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.active) redirect(DEFAULT_AFTER_LOGIN);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Signed in as <span className="font-medium">{profile.email ?? profile.displayName}</span>.
      </p>
      <SignOutButton />
    </div>
  );
}
