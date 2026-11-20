"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_ROLES, type AppRole } from "@/lib/db/roles";

import {
  inviteUser,
  setUserCap,
  setWorkspaceCap,
  updateDisplayName,
  updateUserAccess,
  type ActionState,
} from "./actions";

const IDLE: ActionState = { status: "idle" };

function Feedback({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={
        state.status === "error" ? "text-destructive text-sm" : "text-muted-foreground text-sm"
      }
    >
      {state.message}
    </p>
  );
}

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DisplayNameForm({ displayName }: { displayName: string }) {
  const [state, action, pending] = useActionState(updateDisplayName, IDLE);
  return (
    <form action={action} className="flex max-w-sm flex-col gap-2">
      <Label htmlFor="displayName">Display name</Label>
      <div className="flex gap-2">
        <Input
          id="displayName"
          name="displayName"
          defaultValue={displayName}
          maxLength={100}
          required
        />
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteUser, IDLE);
  return (
    <form action={action} className="flex max-w-md flex-col gap-2">
      <Label htmlFor="inviteEmail">Invite by email</Label>
      <div className="flex gap-2">
        <Input id="inviteEmail" name="email" type="email" placeholder="name@gmail.com" required />
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function UserAccessForm({
  userId,
  role,
  active,
}: {
  userId: string;
  role: AppRole;
  active: boolean;
}) {
  const [state, action, pending] = useActionState(updateUserAccess, IDLE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <select name="role" defaultValue={role} aria-label="Role" className={selectClass}>
        {APP_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <select
        name="active"
        defaultValue={String(active)}
        aria-label="Status"
        className={selectClass}
      >
        <option value="true">active</option>
        <option value="false">inactive</option>
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Save
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function WorkspaceCapForm({ capUsd }: { capUsd: number | null }) {
  const [state, action, pending] = useActionState(setWorkspaceCap, IDLE);
  return (
    <form action={action} className="flex max-w-md flex-col gap-2">
      <Label htmlFor="workspaceCap">Workspace monthly cap (USD)</Label>
      <div className="flex gap-2">
        <Input
          id="workspaceCap"
          name="capUsd"
          inputMode="decimal"
          defaultValue={capUsd == null ? "" : capUsd.toFixed(2)}
          placeholder="20.00"
          required
          className="w-32"
        />
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function UserCapForm({
  userId,
  displayName,
  capUsd,
}: {
  userId: string;
  displayName: string;
  capUsd: number | null;
}) {
  const [state, action, pending] = useActionState(setUserCap, IDLE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <Input
        name="capUsd"
        aria-label={`Monthly AI cap for ${displayName} (USD, blank = none)`}
        inputMode="decimal"
        defaultValue={capUsd == null ? "" : capUsd.toFixed(2)}
        placeholder="none"
        className="h-8 w-24"
      />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Set
      </Button>
      <Feedback state={state} />
    </form>
  );
}
