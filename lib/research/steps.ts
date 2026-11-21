import "server-only";

import type postgres from "postgres";

import type { AiClient } from "@/lib/ai/client";
import { AiError } from "@/lib/ai/errors";
import { supabaseLedger, type AiLedger } from "@/lib/ai/ledger";
import { fingerprintV1, type FingerprintPage } from "@/lib/ai/prompts/fingerprint/v1";
import { runStructured } from "@/lib/ai/run";
import { withUserTx } from "@/lib/db/as-user";
import { createPlainFetcher } from "@/lib/fetcher/plain";
import type { FetchFailure, FetchOutcome, PageFetcher } from "@/lib/fetcher/types";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  collectDomains,
  computeConfidence,
  extractPhones,
  looksCloaked,
  verifyItems,
  type PageForRules,
} from "./fingerprint-rules";

// Job steps. Each runs AS THE USER (withUserTx) in short transactions; network fetches and
// AI calls happen between transactions, never inside one. Expected failures (a page that
// won't load, a refused URL, an AI error) are stored with a reason for the UI and Retry; only
// unexpected errors (DB down) throw, so Inngest retries the step.

/** JSONB parameter (postgres.js would otherwise send a pre-stringified value as a JSON string). */
const json = (tx: postgres.TransactionSql, value: unknown) => tx.json(value as postgres.JSONValue);

export const FINGERPRINT_PURPOSE = "research.fingerprint";
/** Per-page text sent to the model. Longer pages are cut and an open question says so. */
export const PROMPT_PAGE_CHARS = 30_000;

const SKIP_MESSAGES = {
  offer_page:
    "Offer page URLs are fetched only when marked “not a tracking link” on the offer (to avoid registering clicks).",
  other: "URLs of kind “other” aren't fetched. Use our lander, competitor lander or preview.",
} as const;

/** Pages the job should fetch now: pending ones of an active project. */
export async function pendingPageIds(userId: string, projectId: string): Promise<string[]> {
  return withUserTx(userId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select p.id from public.fetched_pages p
      join public.research_projects r on r.id = p.project_id
      where p.project_id = ${projectId} and r.status = 'active'
        -- BUG-1: a page left in 'fetching' by a crashed step is claimable again after a while
        -- (same interval as the retry RPC: private.stale_fetch_after()).
        and (p.fetch_status = 'pending'
             or (p.fetch_status = 'fetching' and p.updated_at < now() - private.stale_fetch_after()))
      order by p.url_kind, p.requested_url`; // our_lander first (enum order); deterministic
    return rows.map((r) => r.id);
  });
}

export async function fetchPage(
  userId: string,
  pageId: string,
  deps: { fetcher?: PageFetcher } = {},
): Promise<string> {
  // 1. Claim the page (or skip it by policy).
  const claim = await withUserTx(userId, async (tx) => {
    const [page] = await tx<
      { requested_url: string; url_kind: string; not_tracking_link: boolean }[]
    >`
      select requested_url, url_kind, not_tracking_link from public.fetched_pages
      where id = ${pageId}
        and (fetch_status = 'pending'
             or (fetch_status = 'fetching' and updated_at < now() - private.stale_fetch_after()))`;
    if (!page) return null;
    const skip =
      page.url_kind === "offer_page" && !page.not_tracking_link
        ? SKIP_MESSAGES.offer_page
        : page.url_kind === "other"
          ? SKIP_MESSAGES.other
          : null;
    if (skip) {
      await tx`update public.fetched_pages
        set fetch_status = 'skipped', error_code = 'policy', error_message = ${skip}
        where id = ${pageId}`;
      return null;
    }
    const updated = await tx`update public.fetched_pages
      set fetch_status = 'fetching', attempts = attempts + 1, error_code = null, error_message = null
      where id = ${pageId} returning id`;
    if (updated.length === 0) throw new Error("Couldn't claim the page (no permission?).");
    return page;
  });
  if (!claim) return "skipped";

  // 2. Fetch (outside any transaction).
  const fetcher = deps.fetcher ?? createPlainFetcher();
  let outcome: FetchOutcome;
  try {
    outcome = await fetcher.fetch(claim.requested_url);
  } catch (error) {
    // BUG-1: an unexpected throw must not leave the page in 'fetching' forever.
    await withUserTx(
      userId,
      (tx) => tx`update public.fetched_pages
      set fetch_status = 'failed', error_code = 'unexpected',
          error_message = 'The fetch failed unexpectedly. Use Retry.', fetched_at = now()
      where id = ${pageId} and fetch_status = 'fetching'`,
    );
    throw error;
  }

  // 3. Store the result.
  await withUserTx(userId, async (tx) => {
    const chain = json(tx, outcome.chain);
    if (outcome.status === "fetched" || outcome.status === "needs_render") {
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(outcome.text).digest("hex");
      await tx`update public.fetched_pages set
        fetch_status = ${outcome.status}::public.fetch_status,
        final_url = ${outcome.finalUrl}, final_domain = ${outcome.finalDomain},
        redirect_chain = ${chain}, http_status = ${outcome.httpStatus},
        content_type = ${outcome.contentType}, title = ${outcome.title}, site_name = ${outcome.siteName},
        text = ${outcome.text}, text_chars = ${outcome.text.length}, truncated = ${outcome.truncated},
        text_sha256 = ${sha}, link_domains = ${outcome.linkHosts}, form_domains = ${outcome.formHosts},
        tel_numbers = ${outcome.telNumbers},
        signals = ${json(tx, { form_count: outcome.formCount, script_count: outcome.scriptCount, description: outcome.description })},
        error_code = ${outcome.status === "needs_render" ? "script_heavy" : null},
        error_message = ${outcome.status === "needs_render" ? "Mostly scripts and little text: this page needs a browser renderer to read." : null},
        fetched_at = now()
        where id = ${pageId}`;
    } else {
      const failure = outcome as FetchFailure;
      await tx`update public.fetched_pages set
        fetch_status = ${outcome.status}::public.fetch_status,
        final_url = ${outcome.finalUrl}, redirect_chain = ${chain},
        http_status = ${failure.httpStatus}, error_code = ${failure.errorCode},
        error_message = ${failure.errorMessage.slice(0, 500)}, fetched_at = now()
        where id = ${pageId}`;
    }
  });
  return outcome.status;
}

type PageRow = PageForRules & {
  requested_url: string;
  final_url: string | null;
  site_name: string | null;
  fetch_status: string;
  truncated: boolean;
};

export type FingerprintResult =
  { ok: true; fingerprintId: string } | { ok: false; message: string };

export async function fingerprintProject(
  userId: string,
  projectId: string,
  deps: { ledger?: AiLedger; client?: AiClient } = {},
): Promise<FingerprintResult> {
  // 1. Load pages and mark the run.
  const loaded = await withUserTx(userId, async (tx) => {
    const [project] = await tx<{ status: string; name: string; vertical: string | null }[]>`
      select r.status, o.name, o.vertical
      from public.research_projects r join public.offers o on o.id = r.offer_id
      where r.id = ${projectId}`;
    if (!project || project.status !== "active") return null;
    const pages = await tx<PageRow[]>`
      select id, url_kind, requested_url, final_url, final_domain, redirect_chain, title, site_name,
             coalesce(text, '') as text, link_domains, form_domains, tel_numbers,
             coalesce((signals ->> 'form_count')::int, 0) as form_count, fetch_status, truncated
      from public.fetched_pages where project_id = ${projectId} order by url_kind, requested_url`;
    await tx`update public.research_projects
      set fingerprint_status = 'running', fingerprint_error = null where id = ${projectId}`;
    return { project, pages };
  });
  if (!loaded) return { ok: false, message: "This research project is archived or not visible." };

  const setFailed = async (message: string) => {
    await withUserTx(
      userId,
      (tx) => tx`update public.research_projects
      set fingerprint_status = 'failed', fingerprint_error = ${message.slice(0, 500)} where id = ${projectId}`,
    );
    return { ok: false as const, message };
  };

  const usable = loaded.pages.filter(
    (p) => p.fetch_status === "fetched" && p.text.trim().length > 0,
  );
  if (usable.length === 0) {
    return setFailed(
      "No page could be read, so there's nothing to fingerprint. Fix or retry the URLs above.",
    );
  }

  // 2. AI extraction (outside any transaction). Page text only ever goes in as untrusted data.
  const promptPages: FingerprintPage[] = usable.map((p) => ({
    page_id: p.id,
    url_kind: p.url_kind,
    requested_url: p.requested_url,
    final_url: p.final_url,
    redirect_hosts: p.redirect_chain.slice(0, -1).flatMap((h) => {
      try {
        return [new URL(h.url).hostname];
      } catch {
        return [];
      }
    }),
    title: p.title,
    site_name: p.site_name,
    text: p.text.slice(0, PROMPT_PAGE_CHARS),
    text_truncated: p.truncated || p.text.length > PROMPT_PAGE_CHARS,
  }));
  let run;
  try {
    run = await runStructured({
      userId,
      purpose: FINGERPRINT_PURPOSE,
      prompt: fingerprintV1,
      input: {
        offer: { name: loaded.project.name, vertical: loaded.project.vertical },
        pages: promptPages,
      },
      projectId,
      subject: { type: "research_project", id: projectId },
      ledger: deps.ledger ?? supabaseLedger(createAdminClient()),
      client: deps.client,
    });
  } catch (error) {
    if (error instanceof AiError) return setFailed(error.userMessage);
    throw error;
  }

  // 3. Code-side checks: verify quotes, extract phones/domains, compute confidence.
  const promptTextById = new Map(promptPages.map((p) => [p.page_id, p.text]));
  const { lists, dropped } = verifyItems(
    run.output,
    usable.map((p) => ({ id: p.id, title: p.title, text: promptTextById.get(p.id) ?? "" })),
  );
  const questions = [...run.output.open_questions];
  if (lists.brand.length === 0) {
    const finals = [...new Set(usable.map((p) => p.final_domain).filter(Boolean))].join(", ");
    questions.push(
      `The brand isn't stated on the fetched pages${finals ? ` (final domains: ${finals})` : ""}. Confirm it with the network; it was not guessed.`,
    );
  }
  for (const p of loaded.pages) {
    if (p.fetch_status === "fetched" && looksCloaked(p, loaded.project.vertical)) {
      questions.push(
        `${p.requested_url} looks like a generic "safe page" rather than the offer (no form, no phone link${loaded.project.vertical ? `, no mention of "${loaded.project.vertical}"` : ""}). Paste the direct money-page URL if you have it.`,
      );
    }
    if (p.fetch_status === "fetched" && (p.truncated || p.text.length > PROMPT_PAGE_CHARS)) {
      questions.push(
        `Only the first ${PROMPT_PAGE_CHARS.toLocaleString("en-US")} characters of ${p.requested_url} were read.`,
      );
    }
    if (p.fetch_status === "needs_render") {
      questions.push(
        `${p.requested_url} is mostly scripts; its text couldn't be read without a browser renderer.`,
      );
    }
  }
  const notFetched = loaded.pages.filter((p) =>
    ["tracking_link", "skipped", "blocked", "failed"].includes(p.fetch_status),
  ).length;
  if (notFetched > 0) {
    questions.push(
      `${notFetched} URL${notFetched === 1 ? " was" : "s were"} not read (see statuses above); the fingerprint uses the rest.`,
    );
  }

  const phones = extractPhones(usable);
  const domains = collectDomains(loaded.pages);
  const confidence = computeConfidence(lists.brand, usable);

  // 4. Store the new version and point the project at it.
  return withUserTx(userId, async (tx) => {
    const [fp] = await tx<{ id: string }[]>`
      insert into public.fingerprints (project_id, ai_call_id, prompt_version, model, brand, advertiser,
        product, claims, phrases, phones, domains, confidence, open_questions, page_ids, dropped_items, created_by)
      values (${projectId}, ${run.callId}, ${run.promptVersion}, ${run.model},
        ${json(tx, lists.brand)}, ${json(tx, lists.advertiser)},
        ${json(tx, lists.product)}, ${json(tx, lists.claims)},
        ${json(tx, lists.phrases)}, ${json(tx, phones)},
        ${json(tx, domains)}, ${confidence}::public.fingerprint_confidence,
        ${json(tx, questions.slice(0, 30))}, ${usable.map((p) => p.id)}::uuid[],
        ${dropped}, ${userId})
      returning id`;
    if (!fp) throw new Error("Fingerprint insert returned nothing.");
    await tx`update public.research_projects
      set current_fingerprint_id = ${fp.id}, fingerprint_status = 'done', fingerprint_error = null
      where id = ${projectId}`;
    return { ok: true as const, fingerprintId: fp.id };
  });
}
