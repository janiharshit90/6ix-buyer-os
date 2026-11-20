import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/app/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireActiveProfile } from "@/lib/auth/current-profile";
import { draftFromVersion } from "@/lib/offers/draft";
import { canEditOffer, getOffer, getVersions, listAdvertiserNames } from "@/lib/offers/queries";

import { OfferForm } from "../../offer-form";

export const metadata: Metadata = { title: "Edit offer draft" };

export default function EditOfferPage({ params }: PageProps<"/offers/[offerId]/edit">) {
  return (
    <>
      <PageHeader
        title="Edit draft"
        description="Changes stay in this draft until a manager or admin approves it."
      />
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-3xl" />}>
        <EditDraft params={params} />
      </Suspense>
    </>
  );
}

async function EditDraft({ params }: Pick<PageProps<"/offers/[offerId]/edit">, "params">) {
  const { offerId } = await params;
  if (!z.uuid().safeParse(offerId).success) notFound();

  const profile = await requireActiveProfile();
  const offer = await getOffer(offerId);
  if (!offer) notFound();
  if (!canEditOffer(profile, offer)) redirect(`/offers/${offerId}`);

  const draft = (await getVersions(offerId, profile)).find((v) => v.status === "draft");
  // No open draft: editing an approved version means starting v(n+1) from the offer page.
  if (!draft) redirect(`/offers/${offerId}`);

  const initial = draftFromVersion(
    {
      id: offer.id,
      name: offer.name,
      vertical: offer.vertical,
      status: offer.status,
      advertiserName: offer.advertiser?.name ?? null,
    },
    draft,
  );

  return (
    <OfferForm
      initial={initial}
      advertiserNames={await listAdvertiserNames()}
      submitLabel={`Save draft v${draft.version}`}
    />
  );
}
