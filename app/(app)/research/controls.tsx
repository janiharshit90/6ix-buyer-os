"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { Button } from "@/components/ui/button";

import { retryPage, runAgain, startResearch, type ActionState } from "./actions";

const IDLE: ActionState = { status: "idle" };

function Feedback({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={
        state.status === "error" ? "text-destructive text-sm" : "text-muted-foreground text-xs"
      }
    >
      {state.message}
    </p>
  );
}

export function StartResearchButton({
  versionId,
  version,
}: {
  versionId: string;
  version: number;
}) {
  const [state, action, pending] = useActionState(startResearch, IDLE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="versionId" value={versionId} />
      <Button type="submit" variant="outline" disabled={pending} className="w-fit">
        {pending ? "Starting…" : `Start research on v${version}`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function RetryPageButton({ pageId, url }: { pageId: string; url: string }) {
  const [state, action, pending] = useActionState(retryPage, IDLE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="pageId" value={pageId} />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={`Retry ${url}`}
      >
        {pending ? "Queuing…" : "Retry"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function RunAgainButton({ projectId, label }: { projectId: string; label: string }) {
  const [state, action, pending] = useActionState(runAgain, IDLE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending} className="w-fit">
        {pending ? "Queuing…" : label}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

/**
 * Re-renders the server page every few seconds while jobs are running. Pauses while the tab is
 * hidden (no polling from background tabs) and refreshes right away when it becomes visible.
 */
export function LiveRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined) timer = setInterval(() => router.refresh(), 3000);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, router]);
  return active ? (
    <p role="status" className="text-muted-foreground text-xs">
      Working… this page updates by itself.
    </p>
  ) : null;
}
