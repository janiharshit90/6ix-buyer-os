// Offer intake: one Zod schema shared by the client form and the server action, plus the
// mapping to the save_offer_draft RPC and the code-computed missing-fields checklist.
// Pure module (no server/client-only imports) so unit tests can cover it.
//
// Unknown is null, never a guessed default (Non-negotiable #1). The DB re-checks every shape.
import { z } from "zod";

import { Constants, type Json } from "@/lib/db/types";

import type { CheckField } from "./check-types";

const E = Constants.public.Enums;
export const PAYOUT_MODELS = E.payout_model;
export const CAP_COUNTS = E.cap_counts;
export const CAP_PERIODS = E.cap_period;
export const OFFER_STATUSES = E.offer_status;
export const OFFER_URL_KINDS = E.offer_url_kind;

// 50 states + DC. Must match private.us_state_codes() in the offers migration.
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
] as const; // prettier-ignore

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const US_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Up to 2 decimal places, as stored in numeric(12,2) / numeric(6,2). */
const cents = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const usd = z
  .number()
  .min(0, "Must be 0 or more.")
  .max(9_999_999_999.99, "Too large.")
  .refine(cents, "At most 2 decimal places.");

const trimmedOrNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Max ${max} characters.`)
    .nullable()
    .transform((v) => (v ? v : null));

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h).");

const timeWindow = z
  .object({ start: time, end: time })
  .refine((w) => w.start < w.end, "Start must be before end.");

export const callHoursSchema = z.object({
  timezone: z.string().refine(isTimeZone, "Unknown timezone."),
  days: z.partialRecord(z.enum(WEEKDAYS), z.array(timeWindow).max(4)),
});

export const restrictionsSchema = z.object({
  banned_claims: z.array(z.string().trim().min(1).max(500)).max(200),
  banned_words: z.array(z.string().trim().min(1).max(100)).max(500),
  notes: trimmedOrNull(5000),
});

export const payoutTierSchema = z.object({
  label: z.string().trim().min(1, "Tier label is required.").max(100),
  amount_usd: usd.nullable(),
  condition: trimmedOrNull(500),
});

export const offerUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2048, "URL too long.")
    .pipe(z.url({ protocol: /^https?$/, error: "Enter a full http(s) URL." })),
  kind: z.enum(OFFER_URL_KINDS),
  /** Buyer confirms an offer_page URL is a direct page, not a tracking link (OK to fetch). */
  not_tracking_link: z.boolean().default(false),
});

export const offerFormSchema = z.object({
  offerId: z.uuid().nullable(),
  offer: z.object({
    name: z.string().trim().min(1, "Offer name is required.").max(200, "Max 200 characters."),
    advertiserName: trimmedOrNull(200),
    vertical: trimmedOrNull(100),
    status: z.enum(OFFER_STATUSES),
  }),
  version: z.object({
    payoutModel: z.enum(PAYOUT_MODELS).nullable(),
    states: z
      .array(z.enum(US_STATES))
      .refine((s) => new Set(s).size === s.length, "Duplicate states.")
      .nullable()
      .transform((s) => (s && s.length ? s : null)),
    capAmount: z.int("Whole number.").min(0, "Must be 0 or more.").nullable(),
    capCounts: z.enum(CAP_COUNTS).nullable(),
    capPeriod: z.enum(CAP_PERIODS).nullable(),
    callHours: callHoursSchema.nullable(),
    optimisationEvent: trimmedOrNull(200),
    feedbackDelayDays: z.int("Whole number.").min(0).max(365, "Max 365 days.").nullable(),
    restrictions: restrictionsSchema.nullable(),
    approvalRequired: z.boolean().nullable(),
  }),
  economics: z.object({
    payoutTiers: z.array(payoutTierSchema).max(20).nullable(),
    targetCpl: usd.nullable(),
    targetRoi: z
      .number()
      .min(-9999.99)
      .max(9999.99)
      .refine(cents, "At most 2 decimal places.")
      .nullable(),
  }),
  urls: z
    .array(offerUrlSchema)
    .max(50, "Max 50 URLs.")
    .refine((u) => new Set(u.map((x) => x.url)).size === u.length, "Each URL only once."),
});

export type OfferFormInput = z.input<typeof offerFormSchema>;
export type OfferForm = z.output<typeof offerFormSchema>;

/** Arguments for public.save_offer_draft (snake_case jsonb, nulls kept as "unknown"). */
export function toSaveDraftArgs(form: OfferForm) {
  const { offer, version: v, economics: e } = form;
  return {
    ...(form.offerId ? { p_offer_id: form.offerId } : {}),
    p_offer: {
      name: offer.name,
      advertiser_name: offer.advertiserName,
      vertical: offer.vertical,
      status: offer.status,
    },
    p_version: {
      payout_model: v.payoutModel,
      states: v.states,
      cap_amount: v.capAmount,
      cap_counts: v.capCounts,
      cap_period: v.capPeriod,
      call_hours: v.callHours as Json,
      optimisation_event: v.optimisationEvent,
      feedback_delay_days: v.feedbackDelayDays,
      restrictions: v.restrictions as Json,
      approval_required: v.approvalRequired,
    },
    p_economics: {
      payout_tiers: e.payoutTiers as Json,
      target_cpl: e.targetCpl,
      target_roi: e.targetRoi,
    },
    p_urls: form.urls,
  };
}

/** The facts the checklist looks at (DB column names, so it works on stored rows too). */
export type ChecklistFacts = {
  advertiser_name: string | null;
  vertical: string | null;
  payout_model: string | null;
  states: string[] | null;
  cap_amount: number | null;
  cap_counts: string | null;
  cap_period: string | null;
  call_hours: unknown;
  optimisation_event: string | null;
  feedback_delay_days: number | null;
  restrictions: unknown;
  approval_required: boolean | null;
  urls: { kind: string }[];
  /** Omit for viewers who can't see economics: those items are then skipped, not flagged. */
  economics?: { payout_tiers: unknown; target_cpl: number | null; target_roi: number | null };
};

/**
 * Which offer facts are still unknown. Code, not AI (M1); AI flagging of unconfirmed
 * values arrives with the AI service in M2. Call hours only matter for pay-per-call.
 */
/** One unknown checklist fact: a stable field key (for code) and a label (for people). */
export type MissingItem = { field: CheckField; label: string };

/**
 * Which offer facts are still unknown. Code, not AI. Call hours only matter for pay-per-call.
 * Code uses the `field` keys; labels are display copy and can change freely.
 */
export function missingItems(f: ChecklistFacts): MissingItem[] {
  const missing: MissingItem[] = [];
  const add = (unknown: boolean, field: CheckField, label: string) =>
    unknown && missing.push({ field, label });

  add(!f.advertiser_name, "advertiser", "Advertiser");
  add(!f.vertical, "vertical", "Vertical");
  add(!f.payout_model, "payout_model", "Payout model");
  if (f.economics) {
    const tiers = f.economics.payout_tiers;
    add(!Array.isArray(tiers) || tiers.length === 0, "payout_tiers", "Payout tiers");
    add(f.economics.target_cpl == null, "target_cpl", "Target CPL");
    add(f.economics.target_roi == null, "target_roi", "Target ROI");
  }
  add(!f.states?.length, "states", "States");
  add(
    f.cap_amount == null || !f.cap_counts || !f.cap_period,
    "cap",
    "Cap (amount, what counts, period)",
  );
  if (f.payout_model === "ppc") add(f.call_hours == null, "call_hours", "Call hours");
  add(!f.optimisation_event, "optimisation_event", "Optimisation event");
  add(f.feedback_delay_days == null, "feedback_delay_days", "Feedback delay");
  add(f.restrictions == null, "restrictions", "Restrictions (banned claims/words)");
  add(f.approval_required == null, "approval_required", "Network approval required?");
  add(
    !f.urls.some((u) => u.kind === "our_lander" || u.kind === "offer_page"),
    "urls",
    "Our lander or offer page URL",
  );
  return missing;
}

/** Labels of the unknown facts, for the checklist UI. */
export function missingFields(f: ChecklistFacts): string[] {
  return missingItems(f).map((m) => m.label);
}
