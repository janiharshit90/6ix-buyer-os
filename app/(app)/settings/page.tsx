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
import {
  formatCapUsd,
  formatMonth,
  formatSpend,
  getBudgetStatus,
  getTeamUsage,
  type BudgetStatus,
} from "@/lib/ai/usage";
import { getInngestEnv } from "@/lib/env/server";
import { inngest } from "@/lib/jobs/client";
import { describeSigningKey, type SigningKeyDiagnostic } from "@/lib/jobs/key-diagnostics";
import { inngestKeySources } from "@/lib/jobs/keys";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  DisplayNameForm,
  InviteForm,
  UserAccessForm,
  UserCapForm,
  WorkspaceCapForm,
} from "./forms";

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
      <AiUsageSection profile={profile} />
      {profile.role === "admin" && <UsersSection />}
      {profile.role === "admin" && <InngestKeyCheck />}
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

async function AiUsageSection({ profile }: { profile: CurrentProfile }) {
  const status = await getBudgetStatus();
  const team = profile.role === "admin" || profile.role === "manager";
  return (
    <section className="flex flex-col gap-4" data-testid="ai-usage">
      <h2 className="font-medium">AI usage · {formatMonth(status.month_start)} (UTC)</h2>
      <BudgetSummary status={status} />
      {profile.role === "admin" && <WorkspaceCapForm capUsd={status.workspace_cap_usd} />}
      {team && <TeamUsage monthStart={status.month_start} canEdit={profile.role === "admin"} />}
    </section>
  );
}

function BudgetSummary({ status }: { status: BudgetStatus }) {
  return (
    <dl className="grid max-w-md grid-cols-2 gap-3 text-sm">
      <div>
        <dt className="text-muted-foreground text-xs">Your spend</dt>
        <dd>
          {formatSpend(status.user_spent_usd)}
          {status.user_cap_usd != null && ` of ${formatCapUsd(status.user_cap_usd)}`}
        </dd>
      </div>
      {/* Workspace totals reach managers/admins only (NULL for others, enforced in SQL). */}
      {status.workspace_spent_usd != null && (
        <div>
          <dt className="text-muted-foreground text-xs">Workspace spend</dt>
          <dd>
            {formatSpend(status.workspace_spent_usd)} of{" "}
            {status.workspace_cap_usd == null
              ? "no cap set (AI is off)"
              : formatCapUsd(status.workspace_cap_usd)}
          </dd>
        </div>
      )}
      {status.workspace_spent_usd == null && !status.workspace_budget_available && (
        <p role="status" className="col-span-2 text-amber-700 dark:text-amber-400">
          The team&apos;s monthly AI budget is used up. Ask an admin to raise it.
        </p>
      )}
      <p className="text-muted-foreground col-span-2 text-xs">
        Includes reservations for calls in progress. Calls stop when a cap would be exceeded.
      </p>
    </dl>
  );
}

async function TeamUsage({ monthStart, canEdit }: { monthStart: string; canEdit: boolean }) {
  const rows = await getTeamUsage(monthStart);
  return (
    <Table data-testid="ai-team-usage">
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Failed</TableHead>
          <TableHead className="text-right">Blocked</TableHead>
          <TableHead className="text-right">Spend</TableHead>
          <TableHead>Monthly cap</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.userId}>
            <TableCell className="font-medium">
              {r.displayName} <span className="text-muted-foreground text-xs">{r.role}</span>
            </TableCell>
            <TableCell className="text-right">{r.calls}</TableCell>
            <TableCell className="text-right">{r.failed}</TableCell>
            <TableCell className="text-right">{r.blocked}</TableCell>
            <TableCell className="text-right">{formatSpend(r.spentUsd)}</TableCell>
            <TableCell>
              {canEdit ? (
                <UserCapForm userId={r.userId} displayName={r.displayName} capUsd={r.capUsd} />
              ) : (
                formatCapUsd(r.capUsd)
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * TEMPORARY admin-only diagnostic for the Inngest sync 401. Shows where the signing key came
 * from and a short fingerprint, never the key. Remove once sync works.
 */
async function InngestKeyCheck() {
  await requireAdmin();
  const sources = inngestKeySources(getInngestEnv());
  // The keys the client actually uses (APP_ wins, else the standard names).
  const rows: SigningKeyDiagnostic[] = [
    describeSigningKey(sources.signingKey, inngest.signingKey, process.env[sources.signingKey]),
    describeSigningKey(
      sources.signingKey === "APP_INNGEST_SIGNING_KEY"
        ? process.env.APP_INNGEST_SIGNING_KEY_FALLBACK
          ? "APP_INNGEST_SIGNING_KEY_FALLBACK"
          : "APP_INNGEST_SIGNING_KEY (pinned as fallback)"
        : "INNGEST_SIGNING_KEY_FALLBACK",
      inngest.signingKeyFallback,
      sources.signingKey === "APP_INNGEST_SIGNING_KEY"
        ? (process.env.APP_INNGEST_SIGNING_KEY_FALLBACK ?? process.env.APP_INNGEST_SIGNING_KEY)
        : process.env.INNGEST_SIGNING_KEY_FALLBACK,
    ),
  ];
  return (
    <section className="flex flex-col gap-3" data-testid="inngest-key-check">
      <h2 className="font-medium">Inngest signing key check (temporary)</h2>
      <p className="text-muted-foreground text-sm">
        Compare the fingerprint with the one computed from the key in the Inngest dashboard. No key
        is shown. Event key source: {sources.eventKey}.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Used as</TableHead>
            <TableHead>Variable</TableHead>
            <TableHead>Prefix</TableHead>
            <TableHead className="text-right">Length</TableHead>
            <TableHead>Outer whitespace</TableHead>
            <TableHead>SHA-256 (first 8)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell>{i === 0 ? "signing key" : "fallback"}</TableCell>
              <TableCell className="font-mono text-xs">{r.variable}</TableCell>
              <TableCell className="font-mono text-xs">
                {r.present ? (r.prefix ?? "no prefix") : "not set"}
              </TableCell>
              <TableCell className="text-right">{r.length ?? "—"}</TableCell>
              <TableCell>{r.rawHasOuterWhitespace ? "yes (trimmed before use)" : "no"}</TableCell>
              <TableCell className="font-mono text-xs">{r.sha256First8 ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
