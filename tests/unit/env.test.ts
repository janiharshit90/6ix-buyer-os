import { describe, expect, it } from "vitest";

import { formatEnvError } from "@/lib/env/format";
import { publicEnvSchema } from "@/lib/env/public";
import { serverEnvSchema } from "@/lib/env/server";

describe("env validation", () => {
  it("accepts a complete public env", () => {
    const result = publicEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    });
    expect(result.success).toBe(true);
  });

  it("names missing vars without echoing any values", () => {
    const secret = "sb_secret_DO_NOT_LEAK";
    const result = serverEnvSchema.safeParse({
      SUPABASE_SECRET_KEY: undefined,
      BOOTSTRAP_ADMIN_EMAIL: secret,
    });
    expect(result.success).toBe(false);
    const message = formatEnvError(result.error!);
    expect(message).toContain("SUPABASE_SECRET_KEY");
    expect(message).toContain("BOOTSTRAP_ADMIN_EMAIL");
    expect(message).not.toContain(secret);
  });

  it("treats a blank BOOTSTRAP_ADMIN_EMAIL as unset", () => {
    const result = serverEnvSchema.safeParse({
      SUPABASE_SECRET_KEY: "x",
      BOOTSTRAP_ADMIN_EMAIL: "  ",
    });
    expect(result.success).toBe(true);
    expect(result.data?.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
  });
});
