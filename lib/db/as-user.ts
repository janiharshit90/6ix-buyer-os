import "server-only";

import postgres from "postgres";

import { getDatabaseUrl } from "@/lib/env/server";

// Background jobs act AS THE USER inside Postgres (Decisions log, option c):
//   set local role authenticated + request.jwt.claims {sub: userId}
// so every read and write in the job goes through the same RLS policies as the app, and a
// user deactivated mid-job loses access immediately (current_user_role() is NULL for them).
// app.writer = 'job' additionally unlocks the job-only writes (fetched_pages, fingerprints);
// PostgREST clients can't set it.
//
// One short transaction per job step. Never hold a transaction open across an AI call.
// The connection string is a secret: it is never logged, and errors from here never include it.

export type JobTx = postgres.TransactionSql;

export class UserInactiveError extends Error {
  constructor() {
    super("The user who started this job is no longer active.");
    this.name = "UserInactiveError";
  }
}

let shared: postgres.Sql | undefined;

function sql(): postgres.Sql {
  shared ??= postgres(getDatabaseUrl(), {
    // Supabase's transaction pooler can't keep prepared statements across transactions.
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return shared;
}

/** For tests: use a specific connection (e.g. the local stack). */
export function setJobSqlForTests(instance: postgres.Sql | undefined) {
  shared = instance;
}

export async function withUserTx<T>(userId: string, fn: (tx: JobTx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" });
  return (await sql().begin(async (tx) => {
    await tx`select
      set_config('role', 'authenticated', true),
      set_config('request.jwt.claims', ${claims}, true),
      set_config('app.writer', 'job', true)`;
    const [row] = await tx<
      { active: boolean }[]
    >`select private.current_user_role() is not null as active`;
    if (!row?.active) throw new UserInactiveError();
    return fn(tx);
  })) as T;
}
