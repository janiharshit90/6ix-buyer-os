import { expect, test, type Page } from "@playwright/test";

import {
  createTestUser,
  deleteTestUsers,
  magicLinkTokenHash,
  signedInClient,
} from "../integration/local-supabase";

// Full research flow: the app queues an Inngest job (local dev server), the job fetches
// fixture pages through FETCHER_TEST_HOSTS and fingerprints them via the Anthropic stub.
// No real network or API calls.
const created: string[] = [];
test.afterAll(async () => deleteTestUsers(created));

// Jobs run in the background; give them time, but each assertion still fails fast once the
// expected state is impossible.
const JOB = { timeout: 60_000 };

async function newUser(role: "buyer" | "creative") {
  const user = await createTestUser(`e2e_rs_${role}`, role);
  created.push(user.id);
  return user;
}

async function signIn(page: Page, email: string) {
  const tokenHash = await magicLinkTokenHash(email);
  await page.goto(`/auth/callback?token_hash=${tokenHash}&type=email`);
  await expect(page).toHaveURL(/\/offers$/);
}

test("buyer starts research: per-URL statuses, fingerprint with sources, open questions", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const buyer = await newUser("buyer");
  const asBuyer = await signedInClient(buyer.email);
  const { data, error } = await asBuyer.rpc("save_offer_draft", {
    p_offer: {
      name: `E2E Research ${crypto.randomUUID().slice(0, 6)}`,
      vertical: "final expense insurance",
    },
    p_version: { payout_model: "ppc" },
    p_economics: {},
    p_urls: [
      { url: "http://lander.fixture.test/lp", kind: "our_lander" },
      { url: "http://safe.fixture.test/", kind: "preview" },
      { url: "https://x.redtrack.io/click?id=1", kind: "preview" },
      { url: "https://offer.example.com/direct", kind: "offer_page" },
    ],
  });
  if (error) throw error;
  const offerId = (data as { offer_id: string }).offer_id;

  await signIn(page, buyer.email);
  await page.goto(`/offers/${offerId}`);
  await page.getByRole("button", { name: "Start research on v1" }).click();
  // The action queues a background job before redirecting.
  await expect(page).toHaveURL(/\/research\/[0-9a-f-]{36}$/, JOB);
  const projectUrl = page.url();

  const row = (url: string) => page.getByTestId("research-page").filter({ hasText: url });
  await expect(row("http://lander.fixture.test/lp").getByTestId("fetch-status")).toHaveText(
    "fetched",
    JOB,
  );
  await expect(row("http://safe.fixture.test/").getByTestId("fetch-status")).toHaveText(
    "fetched",
    JOB,
  );
  await expect(row("https://x.redtrack.io/click?id=1")).toContainText(
    "Tracking link — not fetched, to avoid registering clicks.",
  );
  await expect(row("https://offer.example.com/direct").getByTestId("fetch-status")).toHaveText(
    "skipped",
  );
  await expect(row("https://offer.example.com/direct")).toContainText("not a tracking link");
  await expect(
    row("https://offer.example.com/direct").getByRole("button", { name: /^Retry/ }),
  ).toBeVisible();

  const fp = page.getByTestId("fingerprint");
  await expect(fp).toContainText("ShieldLife Final Expense", JOB);
  await expect(fp).toContainText("http://lander.fixture.test/lp"); // every item names its source page
  await expect(fp).toContainText("+18005550100");
  await expect(fp).toContainText("fingerprint@1");
  await expect(fp.getByText("PWNED")).toHaveCount(0);
  await expect(page.getByTestId("open-questions")).toContainText("safe page");
  await expect(page.getByTestId("open-questions")).toContainText("Paste the direct money-page URL");

  // The offer now links to its research project.
  await page.goto(`/offers/${offerId}`);
  await expect(page.getByRole("link", { name: "Open research" })).toHaveAttribute(
    "href",
    new URL(projectUrl).pathname,
  );
});

test("a creative cannot see research projects", async ({ browser }) => {
  const buyer = await newUser("buyer");
  const creative = await newUser("creative");
  const asBuyer = await signedInClient(buyer.email);
  const { data } = await asBuyer.rpc("save_offer_draft", {
    p_offer: { name: `E2E Hidden ${crypto.randomUUID().slice(0, 6)}` },
    p_version: {},
    p_economics: {},
    p_urls: [{ url: "http://lander.fixture.test/lp", kind: "our_lander" }],
  });
  const started = await asBuyer.rpc("start_research", {
    p_offer_version_id: (data as { version_id: string }).version_id,
  });
  const projectId = (started.data as { project_id: string }).project_id;

  const page = await (await browser.newContext()).newPage();
  await signIn(page, creative.email);
  // RLS returns no row for creatives, so the page renders "not found" (status is already
  // streamed as 200 by then, so check the content).
  await page.goto(`/research/${projectId}`);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await expect(page.getByTestId("research-pages")).toHaveCount(0);
  await page.goto("/research");
  await expect(page.getByText("Research projects are for buyers and managers.")).toBeVisible();
});
