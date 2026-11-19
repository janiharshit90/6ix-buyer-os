// Same isolation rules as supabase/tests/database/010_profiles_rls.test.sql, but
// exercised through the real Data API (PostgREST + JWTs), the path the app uses.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/db/types";

import {
  adminClient,
  anonClient,
  createTestUser,
  deleteTestUsers,
  signedInClient,
} from "./local-supabase";

let buyerA: { id: string; email: string };
let buyerB: { id: string; email: string };
let pending: { id: string; email: string };
let asBuyerA: SupabaseClient<Database>;
let asPending: SupabaseClient<Database>;

beforeAll(async () => {
  buyerA = await createTestUser("buyer_a", "buyer");
  buyerB = await createTestUser("buyer_b", "buyer");
  pending = await createTestUser("pending", "buyer", false);
  asBuyerA = await signedInClient(buyerA.email);
  asPending = await signedInClient(pending.email);
});

afterAll(async () => {
  await deleteTestUsers([buyerA, buyerB, pending].filter(Boolean).map((u) => u.id));
});

async function profileOf(id: string) {
  const { data, error } = await adminClient()
    .from("profiles")
    .select("display_name, role, active")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

describe("profiles RLS via the Data API", () => {
  it("anon gets nothing", async () => {
    const { data, error } = await anonClient().from("profiles").select("id");
    expect(data ?? []).toHaveLength(0);
    expect(error?.code).toBe("42501");
  });

  it("an inactive user sees only their own profile", async () => {
    const { data, error } = await asPending.from("profiles").select("id");
    expect(error).toBeNull();
    expect(data?.map((r) => r.id)).toEqual([pending.id]);
  });

  it("buyer A can read buyer B's profile (names are shared)", async () => {
    const { data, error } = await asBuyerA.from("profiles").select("id").eq("id", buyerB.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("buyer A cannot change buyer B's display name", async () => {
    const { data, error } = await asBuyerA
      .from("profiles")
      .update({ display_name: "hacked" })
      .eq("id", buyerB.id)
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    expect((await profileOf(buyerB.id)).display_name).toBe("buyer_b");
  });

  it("buyer A cannot change buyer B's role", async () => {
    await asBuyerA.from("profiles").update({ role: "creative" }).eq("id", buyerB.id);
    expect((await profileOf(buyerB.id)).role).toBe("buyer");
  });

  it("buyer A cannot make themselves admin", async () => {
    const { error } = await asBuyerA.from("profiles").update({ role: "admin" }).eq("id", buyerA.id);
    expect(error?.code).toBe("42501");
    expect((await profileOf(buyerA.id)).role).toBe("buyer");
  });

  it("buyer A cannot call bootstrap_admin", async () => {
    const { error } = await asBuyerA.rpc("bootstrap_admin", { target_user_id: buyerA.id });
    expect(error).not.toBeNull();
    expect((await profileOf(buyerA.id)).role).toBe("buyer");
  });

  it("an inactive user cannot activate themselves", async () => {
    await asPending.from("profiles").update({ active: true }).eq("id", pending.id);
    expect((await profileOf(pending.id)).active).toBe(false);
  });

  it("buyer A can rename themselves", async () => {
    const { error } = await asBuyerA
      .from("profiles")
      .update({ display_name: "Buyer A" })
      .eq("id", buyerA.id);
    expect(error).toBeNull();
    expect((await profileOf(buyerA.id)).display_name).toBe("Buyer A");
  });
});
