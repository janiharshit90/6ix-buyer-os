import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

import {
  createTestUser,
  deleteTestUsers,
  localStack,
  magicLinkTokenHash,
  signedInClient,
} from "../integration/local-supabase";

// Hardening regressions visible in the browser (Gemini audit items, verified against the code).
const created: string[] = [];
test.afterAll(async () => deleteTestUsers(created));

async function newUser(role: "buyer" | "manager") {
  const user = await createTestUser(`e2e_hd_${role}`, role);
  created.push(user.id);
  return user;
}

async function signIn(page: Page, email: string) {
  const tokenHash = await magicLinkTokenHash(email);
  await page.goto(`/auth/callback?token_hash=${tokenHash}&type=email`);
  await expect(page).toHaveURL(/\/offers$/);
}

const EXPECTED_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

test("SEC-6: security headers on public and signed-in pages", async ({ page }) => {
  const login = await page.request.get("/login");
  expect(login.status()).toBe(200);
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(login.headers()[name], name).toBe(value);
  }
  expect(login.headers()["permissions-policy"]).toContain("camera=()");

  const buyer = await newUser("buyer");
  await signIn(page, buyer.email);
  const app = await page.request.get("/offers");
  expect(app.headers()["x-frame-options"]).toBe("DENY");
  // Pages still work with the headers on (no CSP breakage).
  await expect(page.getByRole("link", { name: "New offer" })).toBeVisible();
});

test("SEC-5: another site can't sign a user out; our own Sign out works", async ({ page }) => {
  const buyer = await newUser("buyer");
  await signIn(page, buyer.email);

  const forged = await page.request.post("/auth/signout", {
    headers: { origin: "https://evil.example" },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  await page.goto("/offers");
  await expect(page).toHaveURL(/\/offers$/); // still signed in

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("BUG-4: an offer's only draft has no Discard button", async ({ page }) => {
  const buyer = await newUser("buyer");
  const asBuyer = await signedInClient(buyer.email);
  const { data } = await asBuyer.rpc("save_offer_draft", {
    p_offer: { name: `E2E Solo ${crypto.randomUUID().slice(0, 6)}` },
    p_version: {},
    p_economics: {},
    p_urls: [],
  });
  await signIn(page, buyer.email);
  await page.goto(`/offers/${(data as { offer_id: string }).offer_id}`);
  await expect(page.getByRole("link", { name: "Edit draft v1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard draft" })).toHaveCount(0);
});

test("BUG-3: a research project that stopped changing offers Run again", async ({ page }) => {
  test.setTimeout(120_000); // waits for a real (local) job run
  const buyer = await newUser("buyer");
  const asBuyer = await signedInClient(buyer.email);
  const { data } = await asBuyer.rpc("save_offer_draft", {
    p_offer: { name: `E2E Stalled ${crypto.randomUUID().slice(0, 6)}` },
    p_version: {},
    p_economics: {},
    p_urls: [{ url: "http://lander.fixture.test/lp", kind: "our_lander" }],
  });
  // Start research WITHOUT queueing a job (as if the queue call had failed), then age it.
  const started = await asBuyer.rpc("start_research", {
    p_offer_version_id: (data as { version_id: string }).version_id,
  });
  const projectId = (started.data as { project_id: string }).project_id;
  const sql = postgres(localStack().dbUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`alter table public.fetched_pages disable trigger fetched_pages_set_updated_at`;
      await tx`alter table public.research_projects disable trigger research_projects_set_updated_at`;
      await tx`update public.fetched_pages set updated_at = now() - interval '10 minutes' where project_id = ${projectId}`;
      await tx`update public.research_projects set updated_at = now() - interval '10 minutes' where id = ${projectId}`;
      await tx`alter table public.fetched_pages enable trigger fetched_pages_set_updated_at`;
      await tx`alter table public.research_projects enable trigger research_projects_set_updated_at`;
    });
  } finally {
    await sql.end();
  }

  await signIn(page, buyer.email);
  await page.goto(`/research/${projectId}`);
  await expect(page.getByTestId("research-stalled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();
  await page.getByRole("button", { name: "Run again" }).click();
  // The job really runs now: the fixture page gets fetched.
  await expect(
    page
      .getByTestId("research-page")
      .filter({ hasText: "http://lander.fixture.test/lp" })
      .getByTestId("fetch-status"),
  ).toHaveText("fetched", { timeout: 60_000 });
});
