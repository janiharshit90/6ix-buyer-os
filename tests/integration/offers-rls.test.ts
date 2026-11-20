// Offers isolation, economics hiding, immutability and deactivation through the real
// Data API (PostgREST + JWTs), the path the app uses. Mirrors supabase/tests/database/03x–06x.
//
// Cleanup note: approved versions are immutable by design, so users who own offers can't be
// deleted afterwards (FK restrict). They stay in the throwaway local DB; `pnpm db:reset` clears them.
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

type Client = SupabaseClient<Database>;
type User = { id: string; email: string };

let buyerA: User, buyerB: User, manager: User, creative: User;
let asBuyerA: Client, asBuyerB: Client, asManager: Client, asCreative: Client;
let offerId: string;
let v1: string;

const tag = crypto.randomUUID().slice(0, 8);

async function createOffer(client: Client, name: string) {
  const { data, error } = await client.rpc("save_offer_draft", {
    p_offer: { name, advertiser_name: `Advertiser ${name}`, vertical: "insurance" },
    p_version: { payout_model: "ppc", states: ["CA", "DC"], cap_amount: 50 },
    p_economics: {
      target_cpl: 42.5,
      target_roi: 30,
      payout_tiers: [{ label: "base", amount_usd: 30, condition: null }],
    },
    p_urls: [{ url: `https://${tag}.example/lp`, kind: "our_lander" }],
  });
  if (error) throw error;
  return data as { offer_id: string; version_id: string };
}

beforeAll(async () => {
  [buyerA, buyerB, manager, creative] = await Promise.all([
    createTestUser("buyer_a", "buyer"),
    createTestUser("buyer_b", "buyer"),
    createTestUser("manager", "manager"),
    createTestUser("creative", "creative"),
  ]);
  [asBuyerA, asBuyerB, asManager, asCreative] = await Promise.all(
    [buyerA, buyerB, manager, creative].map((u) => signedInClient(u.email)),
  );

  const created = await createOffer(asBuyerA, `Offer ${tag}`);
  offerId = created.offer_id;
  v1 = created.version_id;
  const { error } = await asManager.rpc("approve_offer_version", { p_version_id: v1 });
  if (error) throw error;
});

afterAll(async () => {
  await deleteTestUsers([buyerA, buyerB, manager, creative].filter(Boolean).map((u) => u.id));
});

describe("cross-buyer access via the Data API", () => {
  it("buyer B can read buyer A's offer, version and economics", async () => {
    const { data: offer } = await asBuyerB.from("offers").select("id").eq("id", offerId);
    expect(offer).toHaveLength(1);
    const { data: econ, error } = await asBuyerB
      .from("offer_versions_with_economics")
      .select("target_cpl")
      .eq("id", v1)
      .single();
    expect(error).toBeNull();
    expect(econ?.target_cpl).toBe(42.5);
  });

  it("buyer B cannot change buyer A's offer", async () => {
    const { data, error } = await asBuyerB
      .from("offers")
      .update({ name: "hacked" })
      .eq("id", offerId)
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const rpc = await asBuyerB.rpc("save_offer_draft", {
      p_offer_id: offerId,
      p_offer: { name: "hacked" },
      p_version: {},
      p_economics: {},
      p_urls: [],
    });
    expect(rpc.error?.code).toBe("42501");

    const { data: row } = await adminClient()
      .from("offers")
      .select("name")
      .eq("id", offerId)
      .single();
    expect(row?.name).toBe(`Offer ${tag}`);
  });

  it("a buyer cannot approve, not even their own offer", async () => {
    const draft = await createOffer(asBuyerA, `Own ${tag}`);
    const { error } = await asBuyerA.rpc("approve_offer_version", {
      p_version_id: draft.version_id,
    });
    expect(error?.code).toBe("42501");
  });

  it("anon gets nothing", async () => {
    const { data, error } = await anonClient().from("offers").select("id");
    expect(data ?? []).toHaveLength(0);
    expect(error?.code).toBe("42501");
  });
});

describe("creatives never see economics", () => {
  it("sees the approved version, including payout_model, but no economics columns", async () => {
    const { data, error } = await asCreative
      .from("offer_versions")
      .select("*")
      .eq("id", v1)
      .single();
    expect(error).toBeNull();
    expect(data?.payout_model).toBe("ppc");
    for (const column of ["payout_tiers", "target_cpl", "target_roi"]) {
      expect(data).not.toHaveProperty(column);
    }
  });

  it("gets zero rows from the economics table, even by id", async () => {
    const { data, error } = await asCreative
      .from("offer_version_economics")
      .select("*")
      .eq("offer_version_id", v1);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("gets zero rows from the joined view", async () => {
    const { data, error } = await asCreative.from("offer_versions_with_economics").select("*");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot embed economics through a relationship", async () => {
    const { data } = await asCreative
      .from("offer_versions")
      .select("id, offer_version_economics(target_cpl)")
      .eq("id", v1)
      .single();
    expect(data?.offer_version_economics ?? null).toBeNull();
  });
});

describe("approved versions are immutable", () => {
  it("a manager's direct update of an approved version changes nothing", async () => {
    const { data, error } = await asManager
      .from("offer_versions")
      .update({ cap_amount: 1 })
      .eq("id", v1)
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("the service role is refused by the DB trigger", async () => {
    const { error } = await adminClient()
      .from("offer_versions")
      .update({ cap_amount: 1 })
      .eq("id", v1);
    expect(error?.code).toBe("42501");
    const econ = await adminClient()
      .from("offer_version_economics")
      .update({ target_cpl: 1 })
      .eq("offer_version_id", v1);
    expect(econ.error?.code).toBe("42501");
  });

  it("editing creates v2 and leaves v1 untouched", async () => {
    const { data: v2, error } = await asBuyerA.rpc("create_draft_from_approved", {
      p_offer_id: offerId,
    });
    expect(error).toBeNull();
    expect(v2).not.toBe(v1);
    const { data: rows } = await adminClient()
      .from("offer_versions")
      .select("version, status, cap_amount")
      .eq("offer_id", offerId)
      .order("version");
    expect(rows).toEqual([
      { version: 1, status: "approved", cap_amount: 50 },
      { version: 2, status: "draft", cap_amount: 50 },
    ]);
  });
});

describe("owner reassignment", () => {
  it("a buyer cannot reassign, a manager can, and it is audited", async () => {
    const own = await createOffer(asBuyerA, `Handover ${tag}`);

    const byBuyer = await asBuyerA.rpc("reassign_offer_owner", {
      p_offer_id: own.offer_id,
      p_new_owner_id: buyerB.id,
    });
    expect(byBuyer.error?.code).toBe("42501");

    const direct = await asManager
      .from("offers")
      .update({ owner_id: buyerB.id } as never)
      .eq("id", own.offer_id);
    expect(direct.error).not.toBeNull();

    const { error } = await asManager.rpc("reassign_offer_owner", {
      p_offer_id: own.offer_id,
      p_new_owner_id: buyerB.id,
    });
    expect(error).toBeNull();

    const { data: offer } = await adminClient()
      .from("offers")
      .select("owner_id")
      .eq("id", own.offer_id)
      .single();
    expect(offer?.owner_id).toBe(buyerB.id);

    const { data: audit } = await asManager
      .from("audit_log")
      .select("actor, before, after")
      .eq("action", "offer.reassign_owner")
      .eq("entity_id", own.offer_id)
      .single();
    expect(audit?.actor).toBe(manager.id);
    expect((audit?.before as { owner_id: string }).owner_id).toBe(buyerA.id);
    expect((audit?.after as { owner_id: string }).owner_id).toBe(buyerB.id);
  });

  it("an offer cannot be handed to a creative", async () => {
    const { error } = await asManager.rpc("reassign_offer_owner", {
      p_offer_id: offerId,
      p_new_owner_id: creative.id,
    });
    expect(error?.code).toBe("P0001");
  });
});

describe("audit log", () => {
  it("is readable by managers, not buyers", async () => {
    const asBuyer = await asBuyerA.from("audit_log").select("id").eq("entity_id", offerId);
    expect(asBuyer.data).toEqual([]);
    const asMgr = await asManager.from("audit_log").select("action").eq("entity_id", v1);
    expect(asMgr.data?.map((r) => r.action)).toContain("offer_version.approve");
  });

  it("cannot be written by clients", async () => {
    const { error } = await asManager
      .from("audit_log")
      .insert({ action: "fake", entity_type: "offers" });
    expect(error?.code).toBe("42501");
  });
});

describe("deactivation", () => {
  it("cuts off a signed-in user's data access on the next request", async () => {
    const user = await createTestUser("leaver", "buyer");
    const asLeaver = await signedInClient(user.email);
    try {
      const before = await asLeaver.from("offers").select("id").eq("id", offerId);
      expect(before.data).toHaveLength(1);

      const { error } = await adminClient()
        .from("profiles")
        .update({ active: false })
        .eq("id", user.id);
      expect(error).toBeNull();

      // Same client, same still-valid JWT.
      const offers = await asLeaver.from("offers").select("id");
      expect(offers.data).toEqual([]);
      const econ = await asLeaver.from("offer_version_economics").select("id");
      expect(econ.data).toEqual([]);
      const save = await asLeaver.rpc("save_offer_draft", {
        p_offer: { name: `Leaver ${tag}` },
        p_version: {},
        p_economics: {},
        p_urls: [],
      });
      expect(save.error?.code).toBe("42501");
    } finally {
      await deleteTestUsers([user.id]);
    }
  });
});
