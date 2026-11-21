import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { requireActiveProfile } from "@/lib/auth/current-profile";
import { formatDateTime, formatValue } from "@/lib/offers/format";
import {
  domainSchema,
  getProject,
  itemSchema,
  parseList,
  phoneSchema,
  type ResearchPage,
} from "@/lib/research/queries";
import { researchState } from "@/lib/research/status";
import { createClient } from "@/lib/supabase/server";

import { LiveRefresh, RetryPageButton, RunAgainButton } from "../controls";

export const metadata: Metadata = { title: "Research project" };

export default function ResearchProjectPage({ params }: PageProps<"/research/[projectId]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full max-w-4xl" />}>
      <ProjectDetail params={params} />
    </Suspense>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending: "queued",
  fetching: "fetching…",
  fetched: "fetched",
  failed: "failed",
  blocked: "blocked",
  needs_render: "needs a renderer",
  tracking_link: "tracking link — not fetched",
  skipped: "skipped",
};
const RETRYABLE = new Set(["failed", "blocked", "needs_render", "skipped"]);

async function ProjectDetail({ params }: Pick<PageProps<"/research/[projectId]">, "params">) {
  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success) notFound();
  await requireActiveProfile();

  const data = await getProject(projectId);
  if (!data) notFound();
  const { project, pages, fingerprints, offerVersion } = data;

  const supabase = await createClient();
  const { data: canEdit } = await supabase.rpc("can_edit_research_project", {
    p_project_id: projectId,
  });

  const { busy, stalled, working } = researchState(project, pages);
  const current =
    fingerprints.find((f) => f.id === project.current_fingerprint_id) ?? fingerprints[0];
  const pageById = new Map(pages.map((p) => [p.id, p]));

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">Research: {formatValue(project.offer?.name)}</h1>
          <Badge variant={project.status === "active" ? "secondary" : "outline"}>
            {project.status}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          <Link href={`/offers/${project.offer_id}`} className="underline-offset-4 hover:underline">
            Offer v{offerVersion?.version ?? "?"} ({offerVersion?.status ?? "unknown"})
          </Link>{" "}
          · owner {formatValue(project.owner?.display_name)} · started{" "}
          {formatDateTime(project.created_at)}
        </p>
        {/* Stalled projects still poll, slowly, so a "Run again" shows its progress. */}
        <LiveRefresh active={busy} slow={stalled} />
        {stalled && (
          <p
            role="status"
            className="text-sm text-amber-700 dark:text-amber-400"
            data-testid="research-stalled"
          >
            Nothing has changed for a few minutes; the job may not be running. Use “Run again”.
          </p>
        )}
      </div>

      <section className="flex flex-col gap-2" aria-label="Pages">
        <h2 className="font-medium">Pages</h2>
        <ul className="flex flex-col gap-3" data-testid="research-pages">
          {pages.map((p) => (
            <PageRow
              key={p.id}
              page={p}
              canRetry={Boolean(canEdit) && RETRYABLE.has(p.fetch_status)}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3" aria-label="Fingerprint" data-testid="fingerprint">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium">Fingerprint</h2>
          {current && (
            <>
              <Badge variant="outline">
                v{current.version} of {fingerprints.length}
              </Badge>
              <Badge variant={current.confidence === "high" ? "secondary" : "outline"}>
                confidence: {current.confidence}
              </Badge>
            </>
          )}
          {canEdit && !working && <RunAgainButton projectId={project.id} label="Run again" />}
        </div>
        {project.fingerprint_status === "failed" && project.fingerprint_error && (
          <p role="alert" className="text-destructive text-sm" data-testid="fingerprint-error">
            {project.fingerprint_error}
          </p>
        )}
        {project.fingerprint_status === "running" && (
          <p className="text-muted-foreground text-sm">Fingerprinting…</p>
        )}
        {current ? (
          <Fingerprint fp={current} pageById={pageById} />
        ) : (
          project.fingerprint_status !== "running" && (
            <p className="text-muted-foreground text-sm">No fingerprint yet.</p>
          )
        )}
      </section>
    </div>
  );
}

function PageRow({ page: p, canRetry }: { page: ResearchPage; canRetry: boolean }) {
  const chain = z
    .array(
      z.object({ url: z.string(), status: z.number().nullable(), note: z.string().optional() }),
    )
    .catch([])
    .parse(p.redirect_chain);
  return (
    <li className="flex flex-col gap-1 rounded-lg border p-3" data-testid="research-page">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{p.url_kind}</Badge>
        <Badge
          variant={
            p.fetch_status === "fetched"
              ? "secondary"
              : p.fetch_status === "failed"
                ? "destructive"
                : "outline"
          }
          data-testid="fetch-status"
        >
          {STATUS_LABEL[p.fetch_status] ?? p.fetch_status}
        </Badge>
        {/* Plain text: external URLs are read by the fetcher, never clicked here. */}
        <span className="text-sm break-all">{p.requested_url}</span>
      </div>
      {p.error_message && <p className="text-sm">{p.error_message}</p>}
      <p className="text-muted-foreground text-xs">
        {p.final_domain && <>final domain {p.final_domain} · </>}
        {p.title && <>title “{p.title}” · </>}
        {p.text_chars != null && (
          <>
            {p.text_chars.toLocaleString("en-US")} chars{p.truncated ? " (truncated)" : ""} ·{" "}
          </>
        )}
        attempts {p.attempts}
        {p.fetched_at && <> · {formatDateTime(p.fetched_at)}</>}
      </p>
      {chain.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer">Redirect chain ({chain.length - 1} hops)</summary>
          <ol className="mt-1 list-decimal pl-5">
            {chain.map((h, i) => (
              <li key={i} className="break-all">
                {h.status ?? "—"} {h.url}
                {h.note && <span className="text-muted-foreground"> ({h.note})</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {canRetry && <RetryPageButton pageId={p.id} url={p.requested_url} />}
    </li>
  );
}

type FingerprintRow = NonNullable<Awaited<ReturnType<typeof getProject>>>["fingerprints"][number];

function Fingerprint({
  fp,
  pageById,
}: {
  fp: FingerprintRow;
  pageById: Map<string, ResearchPage>;
}) {
  const lists: [string, unknown][] = [
    ["Brand", fp.brand],
    ["Advertiser", fp.advertiser],
    ["Product", fp.product],
    ["Claims", fp.claims],
    ["Key phrases", fp.phrases],
  ];
  const phones = parseList(phoneSchema, fp.phones);
  const domains = parseList(domainSchema, fp.domains);
  const questions = z.array(z.string()).catch([]).parse(fp.open_questions);
  const source = (id: string) => pageById.get(id)?.requested_url ?? "unknown page";
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        {fp.prompt_version} · {formatValue(fp.model)} · {formatDateTime(fp.created_at)}
        {fp.dropped_items > 0 && (
          <>
            {" "}
            · {fp.dropped_items} AI item{fp.dropped_items === 1 ? "" : "s"} dropped (quote not found
            on the page)
          </>
        )}
      </p>
      {lists.map(([label, value]) => {
        const items = parseList(itemSchema, value);
        return (
          <Block key={label} label={label}>
            {items.length === 0 ? (
              <p className="text-sm">unknown</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {items.map((it, i) => (
                  <li key={i}>
                    <span className="font-medium">{it.value}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      — “{it.quote}” · {source(it.page_id)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        );
      })}
      <Block label="Phones (found by code)">
        {phones.length === 0 ? (
          <p className="text-sm">none found</p>
        ) : (
          <ul className="text-sm">
            {phones.map((p) => (
              <li key={p.value}>
                {p.value}{" "}
                <span className="text-muted-foreground">· {p.page_ids.map(source).join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block label="Domains (found by code)">
        <ul className="text-sm">
          {domains.map((d) => (
            <li key={d.value}>
              {d.value} <span className="text-muted-foreground">· {d.roles.join(", ")}</span>
            </li>
          ))}
        </ul>
      </Block>
      <Block label="Open questions">
        {questions.length === 0 ? (
          <p className="text-sm">none</p>
        ) : (
          <ul className="list-disc pl-5 text-sm" data-testid="open-questions">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{label}</h3>
      {children}
    </div>
  );
}
