import type { Metadata } from "next";

import { PageHeader } from "@/components/app/page-header";

export const metadata: Metadata = { title: "Research" };

export default function ResearchPage() {
  return (
    <PageHeader
      title="Research"
      description="Fetch, fingerprint and research projects arrive in M3."
    />
  );
}
