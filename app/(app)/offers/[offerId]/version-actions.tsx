"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { approveOfferVersion, discardDraft, startNewDraft, type FormState } from "../actions";

const IDLE: FormState = { status: "idle" };

function Feedback({ state }: { state: FormState }) {
  if (state.status !== "error" || !state.message) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {state.message}
    </p>
  );
}

export function StartDraftButton({
  offerId,
  nextVersion,
}: {
  offerId: string;
  nextVersion: number;
}) {
  const [state, action, pending] = useActionState(startNewDraft, IDLE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="offerId" value={offerId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Creating…" : `Edit (creates draft v${nextVersion})`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function DiscardDraftButton({ offerId, versionId }: { offerId: string; versionId: string }) {
  const [state, action, pending] = useActionState(discardDraft, IDLE);
  return (
    <form
      action={action}
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        if (!confirm("Discard this draft? Its changes are deleted.")) e.preventDefault();
      }}
    >
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="versionId" value={versionId} />
      <Button type="submit" variant="destructive" disabled={pending}>
        Discard draft
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function ApproveForm({
  offerId,
  versionId,
  version,
  missingCount,
}: {
  offerId: string;
  versionId: string;
  version: number;
  missingCount: number;
}) {
  const [state, action, pending] = useActionState(approveOfferVersion, IDLE);
  return (
    <form action={action} className="flex max-w-md flex-col gap-2 rounded-lg border p-3">
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="versionId" value={versionId} />
      <Label htmlFor="approve-note">Approve v{version}</Label>
      {missingCount > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {missingCount} fact{missingCount === 1 ? " is" : "s are"} still unknown. Approving freezes
          them as unknown.
        </p>
      )}
      <textarea
        id="approve-note"
        name="note"
        rows={2}
        maxLength={2000}
        placeholder="Note (optional)"
        className="border-input rounded-md border bg-transparent px-2 py-1 text-sm"
      />
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? "Approving…" : `Approve v${version}`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
