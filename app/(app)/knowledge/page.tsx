import type { Metadata } from "next";

import { PageHeader } from "@/components/app/page-header";

export const metadata: Metadata = { title: "Knowledge" };

export default function KnowledgePage() {
  return <PageHeader title="Knowledge" description="Course, Q&A and SOP uploads arrive in M4." />;
}
