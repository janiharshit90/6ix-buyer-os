import { expect, test, type Page } from "@playwright/test";

import { NAV_ITEMS } from "../../components/app/nav-items";
import { createTestUser, deleteTestUsers, magicLinkTokenHash } from "../integration/local-supabase";

const created: string[] = [];
test.afterAll(async () => deleteTestUsers(created));

async function signInAs(
  page: Page,
  role: "admin" | "manager" | "buyer" | "creative",
  active = true,
) {
  const user = await createTestUser(`e2e_${role}`, role, active);
  created.push(user.id);
  const tokenHash = await magicLinkTokenHash(user.email);
  await page.goto(`/auth/callback?token_hash=${tokenHash}&type=email`);
  return user;
}

test("signed-out users are sent to /login", async ({ page }) => {
  await page.goto("/offers");
  await expect(page).toHaveURL(/\/login\?next=%2Foffers$/);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
});

test("an active buyer gets the app shell with all five sections", async ({ page }) => {
  await signInAs(page, "buyer");
  await expect(page).toHaveURL(/\/offers$/);
  const nav = page.getByRole("list", { name: "Main" });
  for (const item of NAV_ITEMS) {
    await expect(nav.getByRole("link", { name: item.label })).toBeVisible();
  }
  await expect(page.getByTestId("current-user")).toHaveText("e2e_buyer");
});

test("an inactive user is held on /pending", async ({ page }) => {
  await signInAs(page, "buyer", false);
  await expect(page).toHaveURL(/\/pending$/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/pending$/);
});

test("a buyer does not get user management", async ({ page }) => {
  await signInAs(page, "buyer");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Users" })).toHaveCount(0);
});

test("an admin sees user management", async ({ page }) => {
  await signInAs(page, "admin");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByLabel("Invite by email")).toBeVisible();
});
