import { describe, expect, it } from "vitest";

import { isBootstrapAdminEmail } from "@/lib/auth/bootstrap";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/lib/auth/redirect";

describe("isBootstrapAdminEmail", () => {
  it("matches exactly, ignoring case and surrounding whitespace", () => {
    expect(isBootstrapAdminEmail("Boss@Gmail.com ", " boss@gmail.com")).toBe(true);
  });

  it("rejects different emails, including look-alikes", () => {
    expect(isBootstrapAdminEmail("boss@gmail.com.evil.com", "boss@gmail.com")).toBe(false);
    expect(isBootstrapAdminEmail("xboss@gmail.com", "boss@gmail.com")).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(isBootstrapAdminEmail(undefined, "boss@gmail.com")).toBe(false);
    expect(isBootstrapAdminEmail("boss@gmail.com", undefined)).toBe(false);
    expect(isBootstrapAdminEmail("", "")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNextPath("/settings")).toBe("/settings");
    expect(safeNextPath("/offers?tab=draft")).toBe("/offers?tab=draft");
  });

  it.each([
    null,
    "",
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "evil.com",
    "/login",
    "/auth/callback",
  ])("falls back to the default for %j", (input) => {
    expect(safeNextPath(input)).toBe(DEFAULT_AFTER_LOGIN);
  });
});
