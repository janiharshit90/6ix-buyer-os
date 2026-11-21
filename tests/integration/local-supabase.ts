import { execSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/db/types";

type LocalStack = { url: string; publishableKey: string; secretKey: string; dbUrl: string };

let stack: LocalStack | undefined;

/** Reads URL + keys from the running local stack (`supabase start`), never from .env files. */
export function localStack(): LocalStack {
  if (stack) return stack;
  let out: string;
  try {
    // Fixed command string, no interpolated input.
    out = execSync("npx supabase status --output json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Local Supabase isn't running. Start it with `pnpm db:start`.");
  }
  const status = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  const url = status.API_URL;
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  if (!url || !publishableKey || !secretKey) {
    throw new Error("`supabase status` didn't return API_URL and keys.");
  }
  const dbUrl = status.DB_URL;
  if (!dbUrl) throw new Error("`supabase status` didn't return DB_URL.");
  stack = { url, publishableKey, secretKey, dbUrl };
  return stack;
}

export function adminClient(): SupabaseClient<Database> {
  const { url, secretKey } = localStack();
  return createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function anonClient(): SupabaseClient<Database> {
  const { url, publishableKey } = localStack();
  return createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Creates an auth user (→ profile via trigger) and sets role/active with the service role. */
export async function createTestUser(
  label: string,
  role: Database["public"]["Enums"]["app_role"],
  active = true,
) {
  const admin = adminClient();
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: label },
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  const { error: profileError } = await admin
    .from("profiles")
    .update({ role, active })
    .eq("id", data.user.id);
  if (profileError) throw new Error(`profile setup failed: ${profileError.message}`);
  return { id: data.user.id, email };
}

/** token_hash of a fresh magic link for `email`, generated with the admin API (no inbox needed). */
export async function magicLinkTokenHash(email: string): Promise<string> {
  const { data, error } = await adminClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token)
    throw new Error(`generateLink failed: ${error?.message}`);
  return data.properties.hashed_token;
}

/** A client signed in as `email`. */
export async function signedInClient(email: string): Promise<SupabaseClient<Database>> {
  const client = anonClient();
  const { error: verifyError } = await client.auth.verifyOtp({
    token_hash: await magicLinkTokenHash(email),
    type: "email",
  });
  if (verifyError) throw new Error(`verifyOtp failed: ${verifyError.message}`);
  return client;
}

export async function deleteTestUsers(ids: string[]) {
  const admin = adminClient();
  await Promise.all(ids.map((id) => admin.auth.admin.deleteUser(id)));
}

/**
 * A Postgres connection as the least-privilege job_runner role, as production jobs use.
 * The role is created NOLOGIN by the migrations; here, in the throwaway LOCAL database only, it
 * gets a fixed local password so tests can log in. Hosted projects set their own (README).
 */
export const LOCAL_JOB_RUNNER_PASSWORD = "local-test-only-job-runner";

export async function jobRunnerDbUrl(): Promise<string> {
  const { default: postgres } = await import("postgres");
  const admin = postgres(localStack().dbUrl, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`alter role job_runner with login password '${LOCAL_JOB_RUNNER_PASSWORD}'`);
  } finally {
    await admin.end();
  }
  const url = new URL(localStack().dbUrl);
  url.username = "job_runner";
  url.password = LOCAL_JOB_RUNNER_PASSWORD;
  return url.toString();
}
