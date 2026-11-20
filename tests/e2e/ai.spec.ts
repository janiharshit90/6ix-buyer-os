import { expect, test, type Page } from "@playwright/test";

import { FAKE_MESSAGE } from "../../lib/ai/fake";
import {
  adminClient,
  createTestUser,
  deleteTestUsers,
  magicLinkTokenHash,
  signedInClient,
} from "../integration/local-supabase";

// The app talks to a local Anthropic stub (playwright.config.ts): no real API calls.
// Users with ai_calls/offers can't be deleted (append-only log); deleteTestUsers leaves them.
const created: string[] = [];
test.afterAll(async () => deleteTestUsers(created));

type Role = "admin" | "manager" | "buyer" | "creative";

async function newUser(role: Role) {
  const user = await createTestUser(`e2e_ai_${role}`, role);
  created.push(user.id);
  return user;
}

async function signIn(page: Page, email: string) {
  const tokenHash = await magicLinkTokenHash(email);
  await page.goto(`/auth/callback?token_hash=${tokenHash}&type=email`);
  await expect(page).toHaveURL(/\/offers$/);
}

/** A draft offer whose target CPL ($77.25) is above its only payout tier ($55). */
async function draftOffer(email: string, name: string) {
  const asBuyer = await signedInClient(email);
  const { data, error } = await asBuyer.rpc("save_offer_draft", {
    p_offer: { name, vertical: "insurance" },
    p_version: { payout_model: "cpl", states: ["TX"], cap_amount: 50 },
    p_economics: {
      target_cpl: 77.25,
      target_roi: 31,
      payout_tiers: [{ label: "base", amount_usd: 55, condition: null }],
    },
    p_urls: [{ url: "https://e2e-ai.example/lp", kind: "our_lander" }],
  });
  if (error) throw error;
  return (data as { offer_id: string }).offer_id;
}

test("buyer runs the AI check: code rules + AI suggestions, stored, offer unchanged", async ({
  page,
}) => {
  const buyer = await newUser("buyer");
  const offerId = await draftOffer(buyer.email, `E2E AI ${crypto.randomUUID().slice(0, 6)}`);
  await signIn(page, buyer.email);
  await page.goto(`/offers/${offerId}`);

  await page.getByRole("button", { name: "AI check v1" }).click();

  const results = page.getByTestId("ai-check-results");
  await expect(results).toBeVisible();
  await expect(page.getByTestId("ai-check-rules")).toContainText("Target CPL ($77.25)");
  await expect(page.getByTestId("ai-check-rules")).toContainText("$55.00");
  await expect(page.getByTestId("ai-check-suggestions")).toContainText(FAKE_MESSAGE);
  await expect(results).toContainText("offer-check@1");

  // Stored: survives a reload. Suggestions only: the offer's facts didn't change.
  await page.reload();
  await expect(page.getByTestId("ai-check-suggestions")).toContainText(FAKE_MESSAGE);
  await expect(page.getByTestId("version-facts")).toContainText("$77.25");
  await expect(page.getByRole("button", { name: "Re-run AI check on v1" })).toBeVisible();

  const { data: calls } = await adminClient()
    .from("ai_calls")
    .select("status, purpose, prompt_version")
    .eq("user_id", buyer.id);
  expect(calls).toEqual([
    { status: "succeeded", purpose: "offer.ai_check", prompt_version: "offer-check@1" },
  ]);
});

test("invalid model output is a visible failure with Retry, and nothing is stored", async ({
  page,
}) => {
  const buyer = await newUser("buyer");
  // The fake returns schema-invalid output when it sees this marker in the prompt.
  const offerId = await draftOffer(
    buyer.email,
    `E2E fake-ai:invalid ${crypto.randomUUID().slice(0, 6)}`,
  );
  await signIn(page, buyer.email);
  await page.goto(`/offers/${offerId}`);

  await page.getByRole("button", { name: "AI check v1" }).click();
  await expect(page.getByTestId("ai-check-error")).toContainText("wrong format");
  await expect(page.getByTestId("ai-check-results")).toHaveCount(0);

  await page.getByRole("button", { name: "Retry AI check" }).click();
  await expect(page.getByTestId("ai-check-error")).toContainText("wrong format");

  // The retry is a second, separately logged call (the error text itself doesn't change).
  await expect
    .poll(async () => {
      const { data } = await adminClient()
        .from("ai_calls")
        .select("status, error_code")
        .eq("user_id", buyer.id);
      return data;
    })
    .toEqual([
      { status: "failed", error_code: "invalid_output" },
      { status: "failed", error_code: "invalid_output" },
    ]);
  await expect(page.getByTestId("ai-check-error")).toContainText("wrong format");
});

test("a buyer over their cap gets a clear budget error and no Retry", async ({ page }) => {
  const buyer = await newUser("buyer");
  const { error } = await adminClient()
    .from("budgets")
    .insert({ scope: "user", scope_id: buyer.id, monthly_cap_usd: 0 });
  if (error) throw error;
  const offerId = await draftOffer(buyer.email, `E2E AI cap ${crypto.randomUUID().slice(0, 6)}`);
  await signIn(page, buyer.email);
  await page.goto(`/offers/${offerId}`);

  await page.getByRole("button", { name: "AI check v1" }).click();
  await expect(page.getByTestId("ai-check-error")).toContainText("Your AI budget of $0.00");
  await expect(page.getByRole("button", { name: "Retry AI check" })).toHaveCount(0);
});

test("admin sees team AI usage and sets a user cap; a buyer sees only their own spend", async ({
  browser,
}) => {
  const admin = await newUser("admin");
  const buyer = await newUser("buyer");

  const adminPage = await (await browser.newContext()).newPage();
  await signIn(adminPage, admin.email);
  await adminPage.goto("/settings");
  const usage = adminPage.getByTestId("ai-usage");
  await expect(usage).toContainText("Your spend");
  await expect(adminPage.getByLabel("Workspace monthly cap (USD)")).toBeVisible();
  await expect(adminPage.getByTestId("ai-team-usage")).toBeVisible();

  // Display names repeat across runs, so find THIS buyer's row by their id.
  const row = adminPage
    .getByTestId("ai-team-usage")
    .locator("form")
    .filter({ has: adminPage.locator(`input[name="userId"][value="${buyer.id}"]`) });
  await row.getByRole("textbox").fill("7.5");
  await row.getByRole("button", { name: "Set" }).click();
  await expect(row.getByRole("status")).toHaveText("Cap saved.");

  const { data: cap } = await adminClient()
    .from("budgets")
    .select("monthly_cap_usd")
    .eq("scope", "user")
    .eq("scope_id", buyer.id)
    .single();
  expect(cap?.monthly_cap_usd).toBe(7.5);

  const buyerPage = await (await browser.newContext()).newPage();
  await signIn(buyerPage, buyer.email);
  await buyerPage.goto("/settings");
  await expect(buyerPage.getByTestId("ai-usage")).toContainText("of $7.50");
  await expect(buyerPage.getByTestId("ai-team-usage")).toHaveCount(0);
  // Buyers never see the workspace total (PR #12 review), only their own spend.
  await expect(buyerPage.getByTestId("ai-usage")).not.toContainText("Workspace spend");
  await expect(adminPage.getByTestId("ai-usage")).toContainText("Workspace spend");
  await expect(buyerPage.getByLabel("Workspace monthly cap (USD)")).toHaveCount(0);
});
