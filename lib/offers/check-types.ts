import { z } from "zod";

// Shared shape for offer check findings, from code rules and from the AI.
// Pure module: used by the server, the prompt and the UI.

export const CHECK_FIELDS = [
  "name",
  "advertiser",
  "vertical",
  "payout_model",
  "payout_tiers",
  "target_cpl",
  "target_roi",
  "states",
  "cap",
  "call_hours",
  "optimisation_event",
  "feedback_delay_days",
  "restrictions",
  "approval_required",
  "urls",
  "general",
] as const;
export type CheckField = (typeof CHECK_FIELDS)[number];

export const CHECK_FIELD_LABELS: Record<CheckField, string> = {
  name: "Offer name",
  advertiser: "Advertiser",
  vertical: "Vertical",
  payout_model: "Payout model",
  payout_tiers: "Payout tiers",
  target_cpl: "Target CPL",
  target_roi: "Target ROI",
  states: "States",
  cap: "Cap",
  call_hours: "Call hours",
  optimisation_event: "Optimisation event",
  feedback_delay_days: "Feedback delay",
  restrictions: "Restrictions",
  approval_required: "Network approval",
  urls: "URLs",
  general: "General",
};

export const FINDING_KINDS = ["missing", "inconsistent", "suspicious"] as const;
export const FINDING_SEVERITIES = ["info", "warning"] as const;

export const findingSchema = z.object({
  field: z.enum(CHECK_FIELDS),
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(FINDING_SEVERITIES),
  message: z.string().trim().min(1).max(600),
});
export type Finding = z.infer<typeof findingSchema>;

/** What the offer-check prompt must return. No numeric fields: the AI never produces numbers. */
export const aiCheckOutputSchema = z.object({
  findings: z.array(findingSchema).max(20),
});
export type AiCheckOutput = z.infer<typeof aiCheckOutputSchema>;

/** A stored check as the UI reads it. */
export const storedCheckSchema = z.object({
  id: z.uuid(),
  created_at: z.string(),
  prompt_version: z.string(),
  model: z.string(),
  rule_findings: z.array(findingSchema),
  ai_findings: z.array(findingSchema),
});
export type StoredCheck = z.infer<typeof storedCheckSchema>;
