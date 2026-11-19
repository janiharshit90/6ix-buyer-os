// The invite server action delegates to inviteUserAs(callerClient, serviceClient, …).
// These tests call it with REAL signed-in clients against the local stack, the same
// way a direct POST to the server action would, and check nothing reaches auth.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inviteUserAs } from "@/lib/admin/invite";
import type { Database } from "@/lib/db/types";

import {
  adminClient,
  anonClient,
  createTestUser,
  deleteTestUsers,
  signedInClient,
} from "./local-supabase";

const SITE_URL = "http://localhost:3000";
const cleanup: string[] = [];
const clients: Record<string, SupabaseClient<Database>> = {};

beforeAll(async () => {
  const users = {
    admin: await createTestUser("inv_admin", "admin"),
    inactiveAdmin: await createTestUser("inv_inactive_admin", "admin", false),
    manager: await createTestUser("inv_manager", "manager"),
    buyer: await createTestUser("inv_buyer", "buyer"),
    creative: await createTestUser("inv_creative", "creative"),
    inactive: await createTestUser("inv_inactive", "buyer", false),
  };
  for (const [key, user] of Object.entries(users)) {
    cleanup.push(user.id);
    clients[key] = await signedInClient(user.email);
  }
});

afterAll(async () => deleteTestUsers(cleanup));

async function authUserByEmail(email: string) {
  const { data, error } = await adminClient().auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email === email);
}

const uniqueEmail = (label: string) =>
  `invitee-${label}-${crypto.randomUUID().slice(0, 8)}@test.local`;

describe("inviteUserAs: only active admins can invite", () => {
  it.each(["manager", "buyer", "creative", "inactive", "inactiveAdmin"])(
    "rejects a %s and creates no auth user",
    async (who) => {
      const email = uniqueEmail(who);
      const result = await inviteUserAs(clients[who], adminClient(), { email, siteUrl: SITE_URL });
      expect(result).toMatchObject({ ok: false, reason: "not_admin" });
      expect(await authUserByEmail(email)).toBeUndefined();
    },
  );

  it("rejects a signed-out caller and creates no auth user", async () => {
    const email = uniqueEmail("anon");
    const result = await inviteUserAs(anonClient(), adminClient(), { email, siteUrl: SITE_URL });
    expect(result).toMatchObject({ ok: false, reason: "not_admin" });
    expect(await authUserByEmail(email)).toBeUndefined();
  });

  it("lets an active admin invite; the invitee is an inactive buyer created_by the admin", async () => {
    const email = uniqueEmail("ok");
    const result = await inviteUserAs(clients.admin, adminClient(), { email, siteUrl: SITE_URL });
    expect(result).toEqual({ ok: true, email });

    const invited = await authUserByEmail(email);
    expect(invited).toBeDefined();
    cleanup.push(invited!.id);

    const { data: profile } = await adminClient()
      .from("profiles")
      .select("role, active, created_by")
      .eq("id", invited!.id)
      .single();
    const { data: claims } = await clients.admin.auth.getClaims();
    expect(profile).toEqual({ role: "buyer", active: false, created_by: claims?.claims?.sub });
  });

  it("rejects an invalid email even for an admin", async () => {
    const result = await inviteUserAs(clients.admin, adminClient(), {
      email: "not-an-email",
      siteUrl: SITE_URL,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_email" });
  });
});
