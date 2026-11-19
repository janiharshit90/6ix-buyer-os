import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PageHeader } from "@/components/app/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireActiveProfile } from "@/lib/auth/current-profile";
import { EMPTY_DRAFT } from "@/lib/offers/draft";
import { listAdvertiserNames } from "@/lib/offers/queries";

import { OfferForm } from "../offer-form";

export const metadata: Metadata = { title: "New offer" };

export default function NewOfferPage() {
  return (
    <>
      <PageHeader
        title="New offer"
        description="Fill in what you know. Leave anything unconfirmed blank: it's stored as unknown."
      />
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-3xl" />}>
        <NewOfferForm />
      </Suspense>
    </>
  );
}

async function NewOfferForm() {
  const profile = await requireActiveProfile();
  if (profile.role === "creative") redirect("/offers");
  const advertiserNames = await listAdvertiserNames();
  return (
    <OfferForm initial={EMPTY_DRAFT} advertiserNames={advertiserNames} submitLabel="Save draft" />
  );
}
