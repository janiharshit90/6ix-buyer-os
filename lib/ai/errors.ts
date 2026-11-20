// Typed AI failures. `userMessage` is safe to show in the UI (no internals, no content);
// `code` is what ai_calls.error_code stores.

export type AiErrorCode =
  | "not_configured"
  | "budget_exceeded"
  | "refusal"
  | "truncated"
  | "invalid_output"
  | "provider_error"
  | "ledger_error";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly userMessage: string;
  /** Whether trying again can help (shown as a Retry button). */
  readonly retryable: boolean;
  readonly callId: string | null;

  constructor(
    code: AiErrorCode,
    userMessage: string,
    opts: { retryable: boolean; callId?: string | null; cause?: unknown },
  ) {
    super(`${code}: ${userMessage}`, { cause: opts.cause });
    this.name = "AiError";
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = opts.retryable;
    this.callId = opts.callId ?? null;
  }
}

export type BudgetBlock = {
  reason: "cap_reached" | "no_workspace_budget";
  scope: "workspace" | "user";
  capUsd: number | null;
  spentUsd: number | null;
  monthStart: string | null;
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const monthName = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(iso),
      )
    : "this month";

/**
 * Numbers in the message come from the DB (begin_ai_call); code only formats them.
 * The workspace message never states amounts: buyers don't see team totals (PR #12 review);
 * managers and admins see them in Settings.
 */
export function budgetMessage(block: BudgetBlock): string {
  if (block.reason === "no_workspace_budget") {
    return "AI is switched off: no workspace AI budget is set. Ask an admin to set one in Settings.";
  }
  if (block.scope === "workspace") {
    return "The team's monthly AI budget is used up. Ask an admin to raise it.";
  }
  const cap = block.capUsd == null ? "" : ` of ${usd.format(block.capUsd)}`;
  const spent = block.spentUsd == null ? "" : ` (${usd.format(block.spentUsd)} used or reserved)`;
  return `Your AI budget${cap} for ${monthName(block.monthStart)} doesn't cover this call${spent}. Ask an admin to raise it in Settings.`;
}

export class AiBudgetExceededError extends AiError {
  readonly block: BudgetBlock;
  constructor(block: BudgetBlock, callId: string | null) {
    super("budget_exceeded", budgetMessage(block), { retryable: false, callId });
    this.name = "AiBudgetExceededError";
    this.block = block;
  }
}
