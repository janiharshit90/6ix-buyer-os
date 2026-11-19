import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  requireActiveProfile,
  requireAdmin,
  type CurrentProfile,
} from "@/lib/auth/current-profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { DisplayNameForm, InviteForm, UserAccessForm } from "./forms";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <Suspense fallback={<Skeleton className="h-40 w-full max-w-4xl" />}>
        <SettingsContent />
      </Suspense>
    </>
  );
}

async function SettingsContent() {
  const profile = await requireActiveProfile();
  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <ProfileSection profile={profile} />
      {profile.role === "admin" && <UsersSection />}
    </div>
  );
}

function ProfileSection({ profile }: { profile: CurrentProfile }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium">Your profile</h2>
      <p className="text-muted-foreground text-sm">
        {profile.email} · <Badge variant="secondary">{profile.role}</Badge>
      </p>
      <DisplayNameForm displayName={profile.displayName} />
    </section>
  );
}

async function UsersSection() {
  await requireAdmin();

  const supabase = await createClient();
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, display_name, role, active, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load users: ${error.message}`);

  // Emails live in auth.users, which only the service role can read. Admin-checked above.
  const { data: authData, error: authError } = await createAdminClient().auth.admin.listUsers({
    perPage: 1000,
  });
  if (authError) throw new Error(`Could not load user emails: ${authError.message}`);
  const emailById = new Map(authData.users.map((u) => [u.id, u.email ?? ""]));

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium">Users</h2>
      <p className="text-muted-foreground text-sm">
        Invited users start as inactive buyers. Activate them and set their role here.
      </p>
      <InviteForm />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Access</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {profiles.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.display_name}</TableCell>
              <TableCell>{emailById.get(p.id) || "unknown"}</TableCell>
              <TableCell>
                <UserAccessForm userId={p.id} role={p.role} active={p.active} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
