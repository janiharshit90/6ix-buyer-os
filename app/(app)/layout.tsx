import { Suspense, type ReactNode } from "react";

import { AppSidebar } from "@/components/app/app-sidebar";
import { UserMenu } from "@/components/app/user-menu";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { requireActiveProfile } from "@/lib/auth/current-profile";

// The shell (sidebar, header) is static; the session check streams in behind Suspense.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar
        footer={
          <Suspense fallback={<Skeleton className="h-16 w-full" />}>
            <UserMenu />
          </Suspense>
        }
      />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <div className="flex-1 p-6">
          <Suspense fallback={<Skeleton className="h-32 w-full max-w-2xl" />}>
            <RequireActiveProfile>{children}</RequireActiveProfile>
          </Suspense>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Signed-out → /login, not yet activated → /pending. RLS still guards every query. */
async function RequireActiveProfile({ children }: { children: ReactNode }) {
  await requireActiveProfile();
  return children;
}
