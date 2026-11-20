// Offer form state <-> Zod input <-> stored version rows. Pure, shared by the client
// form and the server pages, and unit-tested.
import type { Json } from "@/lib/db/types";

import type { VersionViewLike } from "./types";
import {
  OFFER_STATUSES,
  OFFER_URL_KINDS,
  WEEKDAYS,
  type ChecklistFacts,
  type OfferFormInput,
} from "./schema";

type Weekday = (typeof WEEKDAYS)[number];
type TimeWindow = { start: string; end: string };

/** Form state. Numbers stay strings while typing; "" means unknown (sent as null). */
export type OfferDraft = {
  offerId: string | null;
  name: string;
  advertiserName: string;
  vertical: string;
  status: (typeof OFFER_STATUSES)[number];
  payoutModel: string;
  tiers: { label: string; amount: string; condition: string }[];
  targetCpl: string;
  targetRoi: string;
  states: string[];
  capAmount: string;
  capCounts: string;
  capPeriod: string;
  callHoursKnown: boolean;
  timezone: string;
  days: Record<Weekday, TimeWindow[]>;
  optimisationEvent: string;
  feedbackDelayDays: string;
  approvalRequired: "" | "yes" | "no";
  restrictionsKnown: boolean;
  bannedClaims: string;
  bannedWords: string;
  restrictionNotes: string;
  urls: { url: string; kind: (typeof OFFER_URL_KINDS)[number] }[];
};

export const EMPTY_DRAFT: OfferDraft = {
  offerId: null,
  name: "",
  advertiserName: "",
  vertical: "",
  status: "active",
  payoutModel: "",
  tiers: [],
  targetCpl: "",
  targetRoi: "",
  states: [],
  capAmount: "",
  capCounts: "",
  capPeriod: "",
  callHoursKnown: false,
  timezone: "America/New_York",
  days: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  optimisationEvent: "",
  feedbackDelayDays: "",
  approvalRequired: "",
  restrictionsKnown: false,
  bannedClaims: "",
  bannedWords: "",
  restrictionNotes: "",
  urls: [{ url: "", kind: "our_lander" }],
};

const orNull = (s: string) => (s.trim() === "" ? null : s.trim());
/** "" → null (unknown); otherwise a number, or the raw text so Zod reports it as invalid. */
const num = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return (Number.isFinite(n) ? n : s) as number;
};
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function toPayload(d: OfferDraft): OfferFormInput {
  return {
    offerId: d.offerId,
    offer: {
      name: d.name,
      advertiserName: orNull(d.advertiserName),
      vertical: orNull(d.vertical),
      status: d.status,
    },
    version: {
      payoutModel: (orNull(d.payoutModel) as OfferFormInput["version"]["payoutModel"]) ?? null,
      states: d.states.length ? (d.states as OfferFormInput["version"]["states"]) : null,
      capAmount: num(d.capAmount),
      capCounts: (orNull(d.capCounts) as OfferFormInput["version"]["capCounts"]) ?? null,
      capPeriod: (orNull(d.capPeriod) as OfferFormInput["version"]["capPeriod"]) ?? null,
      callHours: d.callHoursKnown
        ? {
            timezone: d.timezone,
            days: Object.fromEntries(
              WEEKDAYS.filter((day) => d.days[day].length).map((day) => [day, d.days[day]]),
            ),
          }
        : null,
      optimisationEvent: orNull(d.optimisationEvent),
      feedbackDelayDays: num(d.feedbackDelayDays),
      restrictions: d.restrictionsKnown
        ? {
            banned_claims: lines(d.bannedClaims),
            banned_words: lines(d.bannedWords),
            notes: orNull(d.restrictionNotes),
          }
        : null,
      approvalRequired: d.approvalRequired === "" ? null : d.approvalRequired === "yes",
    },
    economics: {
      payoutTiers: d.tiers.length
        ? d.tiers.map((t) => ({
            label: t.label,
            amount_usd: num(t.amount),
            condition: orNull(t.condition),
          }))
        : null,
      targetCpl: num(d.targetCpl),
      targetRoi: num(d.targetRoi),
    },
    urls: d.urls
      .filter((u) => u.url.trim() !== "")
      .map((u) => ({ url: u.url.trim(), kind: u.kind })),
  };
}

const numOrNull = (v: unknown) => (typeof v === "number" ? v : null);

/** Checklist facts from the form's current payload (invalid numbers count as unknown). */
export function draftChecklistFacts(p: OfferFormInput): ChecklistFacts {
  return {
    advertiser_name: p.offer.advertiserName ?? null,
    vertical: p.offer.vertical ?? null,
    payout_model: p.version.payoutModel ?? null,
    states: p.version.states ?? null,
    cap_amount: numOrNull(p.version.capAmount),
    cap_counts: p.version.capCounts ?? null,
    cap_period: p.version.capPeriod ?? null,
    call_hours: p.version.callHours,
    optimisation_event: p.version.optimisationEvent ?? null,
    feedback_delay_days: numOrNull(p.version.feedbackDelayDays),
    restrictions: p.version.restrictions,
    approval_required: p.version.approvalRequired ?? null,
    urls: p.urls,
    economics: {
      payout_tiers: p.economics.payoutTiers,
      target_cpl: numOrNull(p.economics.targetCpl),
      target_roi: numOrNull(p.economics.targetRoi),
    },
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const numStr = (v: number | null | undefined) => (v == null ? "" : String(v));
const strArray = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

function isObject(v: Json | undefined): v is { [key: string]: Json | undefined } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pre-fills the form from a stored draft (and its offer). */
export function draftFromVersion(
  offer: {
    id: string;
    name: string;
    vertical: string | null;
    status: OfferDraft["status"];
    advertiserName: string | null;
  },
  v: VersionViewLike,
): OfferDraft {
  const hours = isObject(v.call_hours) ? v.call_hours : null;
  const hourDays = hours && isObject(hours.days) ? hours.days : {};
  const restrictions = isObject(v.restrictions) ? v.restrictions : null;
  const tiers = Array.isArray(v.economics?.payout_tiers) ? v.economics.payout_tiers : [];

  return {
    offerId: offer.id,
    name: offer.name,
    advertiserName: offer.advertiserName ?? "",
    vertical: offer.vertical ?? "",
    status: offer.status,
    payoutModel: v.payout_model ?? "",
    tiers: tiers.filter(isObject).map((t) => ({
      label: str(t.label),
      amount: typeof t.amount_usd === "number" ? String(t.amount_usd) : "",
      condition: str(t.condition),
    })),
    targetCpl: numStr(v.economics?.target_cpl),
    targetRoi: numStr(v.economics?.target_roi),
    states: v.states ?? [],
    capAmount: numStr(v.cap_amount),
    capCounts: v.cap_counts ?? "",
    capPeriod: v.cap_period ?? "",
    callHoursKnown: hours !== null,
    timezone: hours ? str(hours.timezone) || "America/New_York" : "America/New_York",
    days: Object.fromEntries(
      WEEKDAYS.map((day) => {
        const windows = hourDays[day];
        return [
          day,
          Array.isArray(windows)
            ? windows.filter(isObject).map((w) => ({ start: str(w.start), end: str(w.end) }))
            : [],
        ];
      }),
    ) as OfferDraft["days"],
    optimisationEvent: v.optimisation_event ?? "",
    feedbackDelayDays: numStr(v.feedback_delay_days),
    approvalRequired: v.approval_required == null ? "" : v.approval_required ? "yes" : "no",
    restrictionsKnown: restrictions !== null,
    bannedClaims: restrictions ? strArray(restrictions.banned_claims).join("\n") : "",
    bannedWords: restrictions ? strArray(restrictions.banned_words).join("\n") : "",
    restrictionNotes: restrictions ? str(restrictions.notes) : "",
    urls: v.urls.map((u) => ({ url: u.url, kind: u.kind })),
  };
}
