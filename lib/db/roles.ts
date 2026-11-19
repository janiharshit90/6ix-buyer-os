import type { Database } from "./types";

export type AppRole = Database["public"]["Enums"]["app_role"];

export const APP_ROLES = [
  "admin",
  "manager",
  "buyer",
  "creative",
] as const satisfies readonly AppRole[];
