import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requireActiveProfile } from "@/lib/auth/current-profile";
import type { Json } from "@/lib/db/types";
import {
  formatBoolean,
  formatCap,
  formatDateTime,
  formatPercent,
  formatUsd,
  formatValue,
  UNKNOWN,
} from "@/lib/offers/format";
import {
  canApprove,
  canEditOffer,
  canSeeEconomics,
  getApprovals,
  getOffer,
  getVersions,
  listAssignableOwners,
  type VersionView,
} from "@/lib/offers/queries";
import { getLatestCheck } from "@/lib/offers/ai-check";
import { missingFields, WEEKDAYS } from "@/lib/offers/schema";

import { MissingChecklist } from "../offer-form";
import { AiCheckButton, AiCheckResults } from "./ai-check";
import {
  ApproveForm,
  DiscardDraftButton,
  ReassignOwnerForm,
  StartDraftButton,
} from "./version-actions";

export const metadata: Metadata = { title: "Offer" };

export default function OfferPage({ params, searchParams }: PageProps<"/offers/[offerId]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full max-w-4xl" />}>
      <OfferDetail params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function OfferDetail({ params, searchParams }: PageProps<"/offers/[offerId]">) {
  const { offerId } = await params;
  if (!z.uuid().safeParse(offerId).success) notFound();
  const { v } = await searchParams;

  const profile = await requireActiveProfile();
  const offer = await getOffer(offerId);
  if (!offer) notFound();

  const versions = await getVersions(offerId, profile);
  const approvals = await getApprovals(versions.map((x) => x.id));
  const draft = versions.find((x) => x.status === "draft");
  const current = versions.find((x) => x.id === offer.current_version_id);
  const requested =
    typeof v === "string" ? versions.find((x) => String(x.version) === v) : undefined;
  const shown = requested ?? draft ?? current ?? versions[0];

  const editable = canEditOffer(profile, offer);
  const showEconomics = canSeeEconomics(profile);
  const nextVersion = (versions[0]?.version ?? 0) + 1;
  const assignableOwners = canApprove(profile) ? await listAssignableOwners() : [];
  // Creatives never see checks (findings may mention economics); RLS enforces it too.
  const latestCheck = shown && showEconomics ? await getLatestCheck(shown.id) : null;
  const canRunCheck = shown?.status === "draft" && editable && showEconomics;

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{offer.name}</h1>
          <Badge variant="outline">{offer.status}</Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          {formatValue(offer.advertiser?.name)} · {formatValue(offer.vertical)} · owner{" "}
          {formatValue(offer.owner?.display_name)}
        </p>
      </div>

      {editable && (
        <div className="flex flex-wrap items-start gap-2">
          {draft ? (
            <>
              <Link href={`/offers/${offer.id}/edit`} className={buttonVariants()}>
                Edit draft v{draft.version}
              </Link>
              <DiscardDraftButton offerId={offer.id} versionId={draft.id} />
            </>
          ) : (
            current && <StartDraftButton offerId={offer.id} nextVersion={nextVersion} />
          )}
        </div>
      )}

      {draft && canApprove(profile) && (
        <ApproveForm
          offerId={offer.id}
          versionId={draft.id}
          version={draft.version}
          missingCount={
            missingFields(checklistFacts(offer.advertiser?.name ?? null, offer.vertical, draft))
              .length
          }
        />
      )}

      {canApprove(profile) && (
        <ReassignOwnerForm
          offerId={offer.id}
          currentOwnerId={offer.owner_id}
          owners={assignableOwners}
        />
      )}

      <nav aria-label="Versions" className="flex flex-wrap gap-2">
        {versions.map((x) => (
          <Link
            key={x.id}
            href={`/offers/${offer.id}?v=${x.version}`}
            aria-current={x.id === shown?.id ? "page" : undefined}
            className="aria-[current=page]:bg-muted rounded-md border px-2 py-1 text-sm"
          >
            v{x.version} · {x.status}
            {x.id === offer.current_version_id && " · current"}
          </Link>
        ))}
      </nav>

      {shown && (canRunCheck || latestCheck) && (
        <section className="flex flex-col gap-2" aria-label="AI check">
          <h2 className="font-medium">AI check</h2>
          {canRunCheck && (
            <AiCheckButton
              offerId={offer.id}
              versionId={shown.id}
              version={shown.version}
              hasCheck={latestCheck !== null}
            />
          )}
          {latestCheck && (
            <AiCheckResults
              check={latestCheck}
              checkedAt={formatDateTime(latestCheck.created_at)}
            />
          )}
        </section>
      )}

      {shown ? (
        <VersionFacts
          version={shown}
          showEconomics={showEconomics}
          checklist={
            editable
              ? missingFields(
                  checklistFacts(
                    offer.advertiser?.name ?? null,
                    offer.vertical,
                    shown,
                    showEconomics,
                  ),
                )
              : null
          }
        />
      ) : (
        <p className="text-muted-foreground text-sm">No versions you can see.</p>
      )}

      {approvals.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Approval history</h2>
          <ul className="text-sm">
            {approvals.map((a) => (
              <li key={`${a.entity_id}-${a.at}`}>
                v{a.version} {a.action} by {formatValue(a.approver?.display_name)} on{" "}
                {formatDateTime(a.at)}
                {a.note && <span className="text-muted-foreground"> — {a.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function checklistFacts(
  advertiserName: string | null,
  vertical: string | null,
  v: VersionView,
  withEconomics = true,
) {
  return {
    advertiser_name: advertiserName,
    vertical,
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
    ...(withEconomics
      ? {
          economics: v.economics ?? { payout_tiers: null, target_cpl: null, target_roi: null },
        }
      : {}),
  };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (j: Json | null): JsonObject | null =>
  typeof j === "object" && j !== null && !Array.isArray(j) ? j : null;
const asArray = (j: Json | undefined): Json[] => (Array.isArray(j) ? j : []);

function VersionFacts({
  version: v,
  showEconomics,
  checklist,
}: {
  version: VersionView;
  showEconomics: boolean;
  checklist: string[] | null;
}) {
  const hours = asObject(v.call_hours);
  const days = asObject(hours?.days ?? null);
  const restrictions = asObject(v.restrictions);

  return (
    <section className="flex flex-col gap-4" data-testid="version-facts">
      <h2 className="font-medium">
        Version {v.version}{" "}
        <Badge variant={v.status === "approved" ? "secondary" : "outline"}>{v.status}</Badge>
        {v.status === "approved" && (
          <span className="text-muted-foreground ml-2 text-xs">
            approved {formatDateTime(v.approved_at)} · read-only
          </span>
        )}
      </h2>

      {checklist && <MissingChecklist missing={checklist} />}

      <dl className="grid gap-3 sm:grid-cols-3">
        <Fact label="Payout model">{formatValue(v.payout_model)}</Fact>
        {showEconomics && (
          <>
            <Fact label="Target CPL">{formatUsd(v.economics?.target_cpl)}</Fact>
            <Fact label="Target ROI">{formatPercent(v.economics?.target_roi)}</Fact>
          </>
        )}
        <Fact label="States">{v.states?.length ? v.states.join(", ") : UNKNOWN}</Fact>
        <Fact label="Cap">{formatCap(v.cap_amount, v.cap_counts, v.cap_period)}</Fact>
        <Fact label="Optimisation event">{formatValue(v.optimisation_event)}</Fact>
        <Fact label="Feedback delay">
          {v.feedback_delay_days == null ? UNKNOWN : `${v.feedback_delay_days} days`}
        </Fact>
        <Fact label="Network approval required">{formatBoolean(v.approval_required)}</Fact>
      </dl>

      {showEconomics && (
        <div data-testid="payout-tiers">
          <h3 className="text-sm font-medium">Payout tiers</h3>
          {asArray(v.economics?.payout_tiers ?? undefined).length === 0 ? (
            <p className="text-sm">{UNKNOWN}</p>
          ) : (
            <ul className="text-sm">
              {asArray(v.economics?.payout_tiers ?? undefined).map((t, i) => {
                const tier = asObject(t);
                return (
                  <li key={i}>
                    {formatValue(tier?.label as string)}:{" "}
                    {formatUsd(typeof tier?.amount_usd === "number" ? tier.amount_usd : null)}
                    {typeof tier?.condition === "string" && ` (${tier.condition})`}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium">Call hours</h3>
        {!hours ? (
          <p className="text-sm">{UNKNOWN}</p>
        ) : (
          <ul className="text-sm">
            <li className="text-muted-foreground">
              Timezone: {formatValue(hours.timezone as string)}
            </li>
            {WEEKDAYS.map((day) => {
              const windows = asArray(days?.[day]).map(asObject);
              return (
                <li key={day}>
                  <span className="inline-block w-10 capitalize">{day}</span>
                  {windows.length
                    ? windows.map((w) => `${w?.start}–${w?.end}`).join(", ")
                    : "closed"}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium">Restrictions</h3>
        {!restrictions ? (
          <p className="text-sm">{UNKNOWN}</p>
        ) : (
          <dl className="grid gap-2 sm:grid-cols-2">
            <Fact label="Banned claims">
              {asArray(restrictions.banned_claims).join("; ") || "none"}
            </Fact>
            <Fact label="Banned words">
              {asArray(restrictions.banned_words).join(", ") || "none"}
            </Fact>
            {typeof restrictions.notes === "string" && (
              <Fact label="Notes">{restrictions.notes}</Fact>
            )}
          </dl>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium">URLs</h3>
        {v.urls.length === 0 ? (
          <p className="text-sm">{UNKNOWN}</p>
        ) : (
          <ul className="text-sm">
            {v.urls.map((u) => (
              <li key={u.id} className="break-all">
                <Badge variant="outline" className="mr-2">
                  {u.kind}
                </Badge>
                {/* Plain text, not a link: external pages are read by the fetcher, never clicked here. */}
                {u.url}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
