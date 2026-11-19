import type { Metadata } from "next";

import { PageHeader } from "@/components/app/page-header";

export const metadata: Metadata = { title: "Library" };

export default function LibraryPage() {
  return (
    <PageHeader
      title="Library"
      description="Saved ads and teardowns arrive in a later milestone."
    />
  );
}
