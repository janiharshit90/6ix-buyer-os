import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
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
import { formatDateTime, formatValue } from "@/lib/offers/format";
import { listProjects } from "@/lib/research/queries";

export const metadata: Metadata = { title: "Research" };

export default function ResearchPage() {
  return (
    <>
      <PageHeader
        title="Research"
        description="Start research from an offer. Each project fetches the offer's URLs and fingerprints them."
      />
      <Suspense fallback={<Skeleton className="h-40 w-full max-w-4xl" />}>
        <ProjectList />
      </Suspense>
    </>
  );
}

async function ProjectList() {
  const profile = await requireActiveProfile();
  if (profile.role === "creative") {
    return (
      <p className="text-muted-foreground text-sm">
        Research projects are for buyers and managers. Approved briefs will appear in the Library.
      </p>
    );
  }
  const projects = await listProjects();
  if (projects.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No research yet. Open an offer and click “Start research”.
      </p>
    );
  }
  return (
    <Table className="max-w-4xl">
      <TableHeader>
        <TableRow>
          <TableHead>Offer</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Fingerprint</TableHead>
          <TableHead>Started</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((p) => (
          <TableRow key={p.id}>
            <TableCell>
              <Link
                href={`/research/${p.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {formatValue(p.offer?.name)}
              </Link>
            </TableCell>
            <TableCell>{formatValue(p.owner?.display_name)}</TableCell>
            <TableCell>
              <Badge variant={p.status === "active" ? "secondary" : "outline"}>{p.status}</Badge>
            </TableCell>
            <TableCell>{p.fingerprint_status}</TableCell>
            <TableCell>{formatDateTime(p.created_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
