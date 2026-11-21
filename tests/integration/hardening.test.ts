// Hardening regressions that need real concurrency or a real login (Gemini audit items, verified
// against the code). Runs against the local stack; files run one at a time (vitest.config.mts).
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setJobSqlForTests, UserInactiveError, withUserTx } from "@/lib/db/as-user";
import type { PageFetcher } from "@/lib/fetcher/types";
import { fetchPage, pendingPageIds } from "@/lib/research/steps";

import {
  adminClient,
  createTestUser,
  jobRunnerDbUrl,
  localStack,
  signedInClient,
} from "./local-supabase";

let asJob: postgres.Sql; // job_runner, like production jobs
let asOwner: postgres.Sql; // table owner, only to fake "stuck for 10 minutes" timestamps
const tag = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  asJob = postgres(await jobRunnerDbUrl(), { prepare: false, max: 4, onnotice: () => {} });
  asOwner = postgres(localStack().dbUrl, { prepare: false, max: 1, onnotice: () => {} });
  setJobSqlForTests(asJob);
});
afterAll(async () => {
  setJobSqlForTests(undefined);
  await asJob.end();
  await asOwner.end();
});

describe("job_runner: a real login with least privilege", () => {
  it("can't read any table on its own, or become a privileged role", async () => {
    await expect(asJob`select count(*) from public.offers`).rejects.toThrow(/permission denied/);
    await expect(asJob.begin((tx) => tx`set local role service_role`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asJob.begin((tx) => tx`set local role postgres`)).rejects.toThrow(
      /permission denied/,
    );
    const [r] =
      await asJob`select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = current_user`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false });
  });

  it("as authenticated + a user's claims, RLS decides what it sees", async () => {
    const buyer = await createTestUser("hj_reader", "buyer");
    const creative = await createTestUser("hj_creative", "creative");
    const asBuyer = await signedInClient(buyer.email);
    await asBuyer.rpc("save_offer_draft", {
      p_offer: { name: `RLS ${tag}` },
      p_version: {},
      p_economics: {},
      p_urls: [],
    });
    const count = (userId: string) =>
      withUserTx(userId, async (tx) => {
        const [row] = await tx<
          { n: number }[]
        >`select count(*)::int as n from public.offers where name = ${`RLS ${tag}`}`;
        return row!.n;
      });
    expect(await count(buyer.id)).toBe(1);
    expect(await count(creative.id)).toBe(0); // creatives don't see drafts
  });
});

describe("SEC-5: two admins demoting each other at once can't leave zero admins", () => {
  it("always keeps at least one active admin (10 races)", async () => {
    const admin = adminClient();
    // Make the two test admins the ONLY active admins for the race, then restore the others.
    const { data: others } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "admin")
      .eq("active", true);
    const a = await createTestUser("race_a", "admin");
    const b = await createTestUser("race_b", "admin");
    const otherIds = (others ?? []).map((o) => o.id);
    if (otherIds.length) await admin.from("profiles").update({ active: false }).in("id", otherIds);
    try {
      for (let i = 0; i < 10; i++) {
        await admin.from("profiles").update({ role: "admin", active: true }).in("id", [a.id, b.id]);
        const [asA, asB] = await Promise.all([signedInClient(a.email), signedInClient(b.email)]);
        await Promise.all([
          asA.from("profiles").update({ role: "buyer" }).eq("id", b.id),
          asB.from("profiles").update({ role: "buyer" }).eq("id", a.id),
        ]);
        const { count } = await admin
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("role", "admin")
          .eq("active", true);
        expect(count, `race ${i}`).toBeGreaterThanOrEqual(1);
      }
    } finally {
      if (otherIds.length) await admin.from("profiles").update({ active: true }).in("id", otherIds);
    }
  });
});

describe("BUG-9: concurrent saves creating the same new advertiser", () => {
  it("all succeed and share one advertiser", async () => {
    const buyers = await Promise.all([0, 1, 2, 3].map((i) => createTestUser(`adv_${i}`, "buyer")));
    const clients = await Promise.all(buyers.map((b) => signedInClient(b.email)));
    const name = `Race Advertiser ${tag}`;
    const results = await Promise.all(
      clients.map((c, i) =>
        c.rpc("save_offer_draft", {
          p_offer: {
            name: `Adv race ${tag} ${i}`,
            advertiser_name: i % 2 ? name.toUpperCase() : name,
          },
          p_version: {},
          p_economics: {},
          p_urls: [],
        }),
      ),
    );
    for (const r of results) expect(r.error).toBeNull();
    const { data } = await adminClient().from("advertisers").select("id").ilike("name", name);
    expect(data).toHaveLength(1);
  });
});

describe("BUG-1 / BUG-2: research jobs recover instead of sticking", () => {
  let owner: { id: string; email: string };
  let projectId: string;
  let pageId: string;

  beforeAll(async () => {
    owner = await createTestUser("stuck_owner", "buyer");
    const asBuyer = await signedInClient(owner.email);
    const { data } = await asBuyer.rpc("save_offer_draft", {
      p_offer: { name: `Stuck ${tag}` },
      p_version: {},
      p_economics: {},
      p_urls: [{ url: `https://stuck-${tag}.example.com/lp`, kind: "our_lander" }],
    });
    const started = await asBuyer.rpc("start_research", {
      p_offer_version_id: (data as { version_id: string }).version_id,
    });
    projectId = (started.data as { project_id: string }).project_id;
    [pageId] = await pendingPageIds(owner.id, projectId);
  });

  it("an unexpected fetch error marks the page failed (not stuck in 'fetching')", async () => {
    const throwing: PageFetcher = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    await expect(fetchPage(owner.id, pageId, { fetcher: throwing })).rejects.toThrow("boom");
    const { data } = await adminClient()
      .from("fetched_pages")
      .select("fetch_status, error_code")
      .eq("id", pageId)
      .single();
    expect(data).toEqual({ fetch_status: "failed", error_code: "unexpected" });
  });

  it("a page left in 'fetching' by a crash is reclaimed after a few minutes", async () => {
    await asOwner.begin(async (tx) => {
      await tx`alter table public.fetched_pages disable trigger fetched_pages_set_updated_at`;
      await tx`update public.fetched_pages set fetch_status = 'fetching', updated_at = now() - interval '1 minute' where id = ${pageId}`;
      await tx`alter table public.fetched_pages enable trigger fetched_pages_set_updated_at`;
    });
    expect(await pendingPageIds(owner.id, projectId)).toEqual([]); // still being fetched
    await asOwner.begin(async (tx) => {
      await tx`alter table public.fetched_pages disable trigger fetched_pages_set_updated_at`;
      await tx`update public.fetched_pages set updated_at = now() - interval '10 minutes' where id = ${pageId}`;
      await tx`alter table public.fetched_pages enable trigger fetched_pages_set_updated_at`;
    });
    expect(await pendingPageIds(owner.id, projectId)).toEqual([pageId]); // stuck: claimable again
  });

  it("a user deactivated mid-run: their job stops, and the abort RPC unsticks the project", async () => {
    await adminClient().from("profiles").update({ active: false }).eq("id", owner.id);
    try {
      await expect(withUserTx(owner.id, async () => "ran")).rejects.toBeInstanceOf(
        UserInactiveError,
      );
      const { error } = await adminClient().rpc("abort_stalled_research_run", {
        p_project_id: projectId,
        p_reason: "The research job stopped because the user who started it is no longer active.",
      });
      expect(error).toBeNull();
      const { data } = await adminClient()
        .from("fetched_pages")
        .select("fetch_status, error_code")
        .eq("id", pageId)
        .single();
      expect(data).toEqual({ fetch_status: "failed", error_code: "job_aborted" });
    } finally {
      await adminClient().from("profiles").update({ active: true }).eq("id", owner.id);
    }
  });
});
