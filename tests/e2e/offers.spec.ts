import { expect, test, type Page } from "@playwright/test";

import {
  createTestUser,
  deleteTestUsers,
  magicLinkTokenHash,
  signedInClient,
} from "../integration/local-supabase";

// Users that end up owning offers can't be deleted (approved data is immutable);
// deleteTestUsers leaves them in the throwaway local DB.
const created: string[] = [];
test.afterAll(async () => deleteTestUsers(created));

type Role = "admin" | "manager" | "buyer" | "creative";

async function newUser(role: Role) {
  const user = await createTestUser(`e2e_${role}`, role);
  created.push(user.id);
  return user;
}

async function signIn(page: Page, email: string) {
  const tokenHash = await magicLinkTokenHash(email);
  await page.goto(`/auth/callback?token_hash=${tokenHash}&type=email`);
  await expect(page).toHaveURL(/\/offers$/);
}

/** Buyer creates an offer through the API and a manager approves v1. */
async function approvedOfferViaApi(name: string) {
  const buyer = await newUser("buyer");
  const manager = await newUser("manager");
  const asBuyer = await signedInClient(buyer.email);
  const { data, error } = await asBuyer.rpc("save_offer_draft", {
    p_offer: { name, vertical: "insurance" },
    p_version: { payout_model: "ppc", states: ["TX"] },
    p_economics: {
      target_cpl: 77.25,
      target_roi: 31,
      payout_tiers: [{ label: "secret-tier", amount_usd: 55, condition: null }],
    },
    p_urls: [{ url: "https://e2e.example/lp", kind: "our_lander" }],
  });
  if (error) throw error;
  const { offer_id, version_id } = data as { offer_id: string; version_id: string };
  const asManager = await signedInClient(manager.email);
  const approve = await asManager.rpc("approve_offer_version", { p_version_id: version_id });
  if (approve.error) throw approve.error;
  return offer_id;
}

test("buyer intake → manager approves → editing creates v2", async ({ browser }) => {
  const name = `E2E Offer ${crypto.randomUUID().slice(0, 6)}`;
  const buyer = await newUser("buyer");
  const manager = await newUser("manager");

  // Buyer fills in the intake form.
  const buyerPage = await (await browser.newContext()).newPage();
  await signIn(buyerPage, buyer.email);
  await buyerPage.getByRole("link", { name: "New offer" }).click();
  await buyerPage.getByLabel("Offer name (required)").fill(name);
  await buyerPage.getByLabel("Payout model").selectOption("cpl");
  await buyerPage.getByLabel("Target CPL (USD)").fill("25");
  await buyerPage.getByLabel("TX", { exact: true }).check();
  await buyerPage.getByLabel("URL 1", { exact: true }).fill("https://intake.example/lp");
  await expect(buyerPage.getByTestId("missing-fields")).toContainText("Advertiser");
  await buyerPage.getByRole("button", { name: "Save draft" }).click();

  await expect(buyerPage.getByRole("heading", { name })).toBeVisible();
  await expect(buyerPage.getByRole("link", { name: "v1 · draft" })).toBeVisible();
  await expect(buyerPage.getByTestId("version-facts")).toContainText("$25.00");
  // Buyers can't approve, not even their own offer.
  await expect(buyerPage.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  const offerUrl = buyerPage.url();

  // Manager approves.
  const managerPage = await (await browser.newContext()).newPage();
  await signIn(managerPage, manager.email);
  await managerPage.goto(offerUrl);
  await managerPage.getByLabel("Approve v1").fill("Checked against the IO");
  await managerPage.getByRole("button", { name: "Approve v1" }).click();
  await expect(managerPage.getByRole("link", { name: "v1 · approved · current" })).toBeVisible();
  await expect(managerPage.getByText("Checked against the IO")).toBeVisible();

  // Buyer edits: a new draft v2, v1 stays approved.
  await buyerPage.reload();
  await buyerPage.getByRole("button", { name: "Edit (creates draft v2)" }).click();
  await expect(buyerPage).toHaveURL(/\/edit$/);
  await expect(buyerPage.getByLabel("Offer name (required)")).toHaveValue(name);
  await expect(buyerPage.getByLabel("Target CPL (USD)")).toHaveValue("25");
  await buyerPage.getByLabel("Target CPL (USD)").fill("30");
  await buyerPage.getByRole("button", { name: "Save draft v2" }).click();

  await expect(buyerPage.getByRole("link", { name: "v2 · draft" })).toBeVisible();
  await expect(buyerPage.getByTestId("version-facts")).toContainText("$30.00");
  await buyerPage.getByRole("link", { name: "v1 · approved · current" }).click();
  await expect(buyerPage.getByTestId("version-facts")).toContainText("$25.00");
  await expect(buyerPage.getByTestId("version-facts")).toContainText("read-only");
});

test("a creative sees the approved offer without payout tiers or targets", async ({ page }) => {
  const offerId = await approvedOfferViaApi(`E2E Creative ${crypto.randomUUID().slice(0, 6)}`);
  const creative = await newUser("creative");
  await signIn(page, creative.email);

  await page.goto(`/offers/${offerId}`);
  const facts = page.getByTestId("version-facts");
  await expect(facts).toContainText("ppc"); // payout model stays visible
  await expect(facts).toContainText("TX");
  await expect(page.getByTestId("payout-tiers")).toHaveCount(0);
  const html = await page.content();
  for (const secret of ["77.25", "secret-tier", "Target CPL", "Target ROI"]) {
    expect(html).not.toContain(secret);
  }
  await expect(page.getByRole("link", { name: "New offer" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Edit/ })).toHaveCount(0);
});

test("a creative cannot open the intake form", async ({ page }) => {
  const creative = await newUser("creative");
  await signIn(page, creative.email);
  await page.goto("/offers/new");
  await expect(page).toHaveURL(/\/offers$/);
});
