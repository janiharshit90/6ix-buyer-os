import "server-only";

import type { AiClient } from "@/lib/ai/client";
import { AiError } from "@/lib/ai/errors";
import { supabaseLedger, type AiLedger } from "@/lib/ai/ledger";
import { offerCheckV1, type OfferCheckInput } from "@/lib/ai/prompts/offer-check/v1";
import { runStructured } from "@/lib/ai/run";
import type { CurrentProfile } from "@/lib/auth/current-profile";
import type { Json } from "@/lib/db/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { storedCheckSchema, type Finding, type StoredCheck } from "./check-types";
import { ruleFindings, type RuleCheckInput } from "./checks";
import { canEditOffer, canSeeEconomics, getOffer, getVersions, type VersionView } from "./queries";

export const OFFER_CHECK_PURPOSE = "offer.ai_check";

export type OfferCheckResult =
  { ok: true; checkId: string } | { ok: false; message: string; retryable: boolean };

type OfferRow = NonNullable<Awaited<ReturnType<typeof getOffer>>>;

function ruleInput(offer: OfferRow, v: VersionView): RuleCheckInput {
  return {
    advertiser_name: offer.advertiser?.name ?? null,
    vertical: offer.vertical,
    payout_model: v.payout_model,
    states: v.states,
    cap_amount: v.cap_amount,
    cap_counts: v.cap_counts,
    cap_period: v.cap_period,
    call_hours: v.call_hours,
    optimisation_event: v.optimisation_event,
    feedback_delay_days: v.feedback_delay_days,
    restrictions: v.restrictions,
    approval_required: v.approval_required,
    urls: v.urls,
    economics: v.economics ?? { payout_tiers: null, target_cpl: null, target_roi: null },
  };
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (j: Json | null | undefined): JsonObject | null =>
  typeof j === "object" && j !== null && !Array.isArray(j) ? j : null;
const strings = (j: Json | undefined): string[] =>
  Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];

/** Splits stored facts into structured values (trusted) and free text (untrusted). */
export function promptInput(offer: OfferRow, v: VersionView, rules: Finding[]): OfferCheckInput {
  const tiers = Array.isArray(v.economics?.payout_tiers) ? v.economics.payout_tiers : null;
  const hours = asObject(v.call_hours);
  const days = asObject(hours?.days ?? null);
  const restrictions = asObject(v.restrictions);
  return {
    facts: {
      payout_model: v.payout_model,
      payout_tier_amounts_usd: tiers
        ? tiers.flatMap((t) => {
            const amount = asObject(t)?.amount_usd;
            return typeof amount === "number" ? [amount] : [];
          })
        : null,
      target_cpl_usd: v.economics?.target_cpl ?? null,
      target_roi_percent: v.economics?.target_roi ?? null,
      states: v.states,
      cap_amount: v.cap_amount,
      cap_counts: v.cap_counts,
      cap_period: v.cap_period,
      call_hours_timezone: typeof hours?.timezone === "string" ? hours.timezone : null,
      call_hours_open_days: days
        ? Object.entries(days).flatMap(([d, w]) => (Array.isArray(w) && w.length ? [d] : []))
        : null,
      feedback_delay_days: v.feedback_delay_days,
      network_approval_required: v.approval_required,
      url_kinds: v.urls.map((u) => u.kind),
    },
    text: {
      name: offer.name,
      advertiser: offer.advertiser?.name ?? null,
      vertical: offer.vertical,
      optimisation_event: v.optimisation_event,
      payout_tiers: tiers
        ? tiers.map((t) => {
            const tier = asObject(t);
            return {
              label: typeof tier?.label === "string" ? tier.label : null,
              condition: typeof tier?.condition === "string" ? tier.condition : null,
            };
          })
        : null,
      restrictions: restrictions
        ? {
            banned_claims: strings(restrictions.banned_claims),
            banned_words: strings(restrictions.banned_words),
            notes: typeof restrictions.notes === "string" ? restrictions.notes : null,
          }
        : null,
      urls: v.urls.map((u) => ({ kind: u.kind, url: u.url })),
    },
    ruleFindings: rules,
  };
}

/**
 * Runs code rules + the AI check on a SAVED draft version and stores the result.
 * Reads go through the user's RLS-scoped client; only the ledger and the result insert
 * use the service role, after the checks below. Never edits the offer.
 */
export async function runOfferCheck(
  profile: Pick<CurrentProfile, "id" | "role">,
  offerId: string,
  versionId: string,
  deps: { ledger?: AiLedger; client?: AiClient } = {},
): Promise<OfferCheckResult> {
  if (!canSeeEconomics(profile)) {
    return {
      ok: false,
      message: "Only buyers, managers and admins can run the AI check.",
      retryable: false,
    };
  }

  const offer = await getOffer(offerId);
  const version = offer
    ? (await getVersions(offerId, profile)).find((v) => v.id === versionId)
    : undefined;
  if (!offer || !version) {
    return {
      ok: false,
      message: "That offer version doesn't exist or you can't see it.",
      retryable: false,
    };
  }
  // SEC-1: only the offer's editors (owner buyer, managers, admins) may run it: it spends their
  // budget and stores findings on the draft. The DB re-checks this on insert.
  if (!canEditOffer(profile, offer)) {
    return {
      ok: false,
      message: "Only this offer's owner, a manager or an admin can check it.",
      retryable: false,
    };
  }
  if (version.status !== "draft") {
    return {
      ok: false,
      message: "The AI check runs on drafts only. Start a new draft to check again.",
      retryable: false,
    };
  }

  const rules = ruleFindings(ruleInput(offer, version));
  const admin = createAdminClient();

  let run;
  try {
    run = await runStructured({
      userId: profile.id,
      purpose: OFFER_CHECK_PURPOSE,
      prompt: offerCheckV1,
      input: promptInput(offer, version, rules),
      subject: { type: "offer_version", id: version.id },
      ledger: deps.ledger ?? supabaseLedger(admin),
      client: deps.client,
    });
  } catch (error) {
    if (error instanceof AiError) {
      return { ok: false, message: error.userMessage, retryable: error.retryable };
    }
    throw error;
  }

  const { data, error } = await admin
    .from("offer_ai_checks")
    .insert({
      offer_version_id: version.id,
      ai_call_id: run.callId,
      prompt_version: run.promptVersion,
      model: run.model,
      rule_findings: rules as unknown as NonNullable<Json>,
      ai_findings: run.output.findings as unknown as NonNullable<Json>,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) {
    // The version may have been approved or discarded while the model was running.
    console.error(`[ai] could not store offer check for call ${run.callId}: ${error.code}`);
    return {
      ok: false,
      message:
        "The check ran but couldn't be saved (was the draft approved or discarded meanwhile?). Reload and try again.",
      retryable: true,
    };
  }
  return { ok: true, checkId: data.id };
}

/** Latest stored check for a version, read through RLS (creatives get nothing). */
export async function getLatestCheck(versionId: string): Promise<StoredCheck | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("offer_ai_checks")
    .select("id, created_at, prompt_version, model, rule_findings, ai_findings")
    .eq("offer_version_id", versionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load the AI check: ${error.message}`);
  if (!data) return null;
  const parsed = storedCheckSchema.safeParse(data);
  if (!parsed.success) throw new Error("A stored AI check has an unexpected shape.");
  return parsed.data;
}
