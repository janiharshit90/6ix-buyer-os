import type { Metadata } from "next";

import { PageHeader } from "@/components/app/page-header";

export const metadata: Metadata = { title: "Offers" };

export default function OffersPage() {
  return <PageHeader title="Offers" description="Offer intake and versions arrive in M1." />;
}
