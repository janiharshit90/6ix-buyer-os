import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireActiveProfile } from "@/lib/auth/current-profile";
import { formatValue } from "@/lib/offers/format";
import { listOffers } from "@/lib/offers/queries";

export const metadata: Metadata = { title: "Offers" };

export default function OffersPage() {
  return (
    <>
      <PageHeader
        title="Offers"
        description="Offer facts, versioned. Approved versions are frozen."
      />
      <Suspense fallback={<Skeleton className="h-40 w-full max-w-5xl" />}>
        <OffersList />
      </Suspense>
    </>
  );
}

async function OffersList() {
  const profile = await requireActiveProfile();
  const offers = await listOffers();
  const canCreate = profile.role !== "creative";

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      {canCreate && (
        <Link href="/offers/new" className={buttonVariants({ className: "w-fit" })}>
          New offer
        </Link>
      )}
      {offers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {canCreate ? "No offers yet." : "No approved offers yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Offer</TableHead>
              <TableHead>Advertiser</TableHead>
              <TableHead>Vertical</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {offers.map((o) => {
              const approved = o.versions
                .filter((v) => v.status === "approved")
                .map((v) => v.version);
              const draft = o.versions.find((v) => v.status === "draft");
              return (
                <TableRow key={o.id}>
                  <TableCell className="font-medium">
                    <Link className="hover:underline" href={`/offers/${o.id}`}>
                      {o.name}
                    </Link>
                  </TableCell>
                  <TableCell>{formatValue(o.advertiser?.name)}</TableCell>
                  <TableCell>{formatValue(o.vertical)}</TableCell>
                  <TableCell>{formatValue(o.owner?.display_name)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{o.status}</Badge>
                  </TableCell>
                  <TableCell className="flex gap-1">
                    {approved.length > 0 ? (
                      <Badge variant="secondary">v{Math.max(...approved)} approved</Badge>
                    ) : (
                      <Badge variant="outline">not approved</Badge>
                    )}
                    {draft && <Badge variant="outline">v{draft.version} draft</Badge>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
