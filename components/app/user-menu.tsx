import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCurrentProfile } from "@/lib/auth/current-profile";

export async function UserMenu() {
  const profile = await getCurrentProfile();
  if (!profile) return null;

  return (
    <div className="flex flex-col gap-2 px-2 py-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium" data-testid="current-user">
          {profile.displayName}
        </span>
        <Badge variant="secondary">{profile.role}</Badge>
      </div>
      <SignOutButton />
    </div>
  );
}

export function SignOutButton() {
  return (
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );
}
