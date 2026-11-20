"use client";

import { useActionState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CHECK_FIELD_LABELS, type Finding, type StoredCheck } from "@/lib/offers/check-types";

import { runAiCheck, type FormState } from "../actions";

const IDLE: FormState = { status: "idle" };

export function AiCheckButton({
  offerId,
  versionId,
  version,
  hasCheck,
}: {
  offerId: string;
  versionId: string;
  version: number;
  hasCheck: boolean;
}) {
  const [state, action, pending] = useActionState(runAiCheck, IDLE);
  const failed = state.status === "error";
  const label = pending
    ? "Checking…"
    : failed && state.retryable
      ? "Retry AI check"
      : hasCheck
        ? `Re-run AI check on v${version}`
        : `AI check v${version}`;
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="versionId" value={versionId} />
      <Button type="submit" variant="outline" disabled={pending} className="w-fit">
        {label}
      </Button>
      <p className="text-muted-foreground text-xs">
        Checks the saved draft. Suggestions only: nothing is changed.
      </p>
      {failed && state.message && (
        <p role="alert" className="text-destructive text-sm" data-testid="ai-check-error">
          {state.message}
        </p>
      )}
    </form>
  );
}

function FindingList({ findings, empty }: { findings: Finding[]; empty: string }) {
  if (findings.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {findings.map((f, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-2">
          <Badge variant={f.severity === "warning" ? "destructive" : "outline"}>{f.kind}</Badge>
          <span className="font-medium">{CHECK_FIELD_LABELS[f.field]}:</span>
          {/* Plain text: model output is never rendered as HTML or links. */}
          <span>{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function AiCheckResults({ check, checkedAt }: { check: StoredCheck; checkedAt: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="ai-check-results">
      <p className="text-muted-foreground text-xs">
        Checked {checkedAt} · {check.prompt_version} · {check.model}
      </p>
      <div className="flex flex-col gap-1" data-testid="ai-check-rules">
        <h3 className="text-sm font-medium">Rule check</h3>
        <FindingList findings={check.rule_findings} empty="No rule findings." />
      </div>
      <div className="flex flex-col gap-1" data-testid="ai-check-suggestions">
        <h3 className="text-sm font-medium">AI suggestions</h3>
        <FindingList findings={check.ai_findings} empty="No AI suggestions." />
        <p className="text-muted-foreground text-xs">
          AI suggestions can be wrong. Confirm with the network before changing the offer.
        </p>
      </div>
    </div>
  );
}
