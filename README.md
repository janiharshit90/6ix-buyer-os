# 6ix Buyer OS

Internal research workspace for The 6ix Media's Meta buyers and creatives.
**Read [CLAUDE.md](CLAUDE.md) first**: it holds the scope, rules and decisions.

## Prerequisites

- Node 24+, pnpm (`corepack pnpm …` works if pnpm isn't on your PATH)
- Docker Desktop (WSL2 backend) for the local Supabase stack

## Local setup

```bash
pnpm install
pnpm db:start                 # local Supabase in Docker; prints local URL + keys
cp .env.example .env.local    # fill in (local values from `pnpm exec supabase status`)
pnpm dev                      # http://localhost:3000
```

Sign-ups are disabled (invite-only). Locally, sign-in emails land in Mailpit at
http://127.0.0.1:54324. To create the first admin, set `BOOTSTRAP_ADMIN_EMAIL`,
then run `pnpm admin:bootstrap` and open the invite link: your first sign-in makes you admin.

## Tests

| Command                 | What                                                    | Needs                 |
| ----------------------- | ------------------------------------------------------- | --------------------- |
| `pnpm test`             | Unit tests (Vitest)                                     | nothing               |
| `pnpm test:db`          | pgTAP RLS tests in `supabase/tests/database`            | `pnpm db:start`       |
| `pnpm test:integration` | RLS through the real Data API (Vitest + supabase-js)    | `pnpm db:start`       |
| `pnpm test:e2e`         | Playwright smoke tests (own dev server on port 3100)    | `pnpm db:start`       |
| `pnpm test:all`         | All of the above                                        | `pnpm db:start`       |

First Playwright run: `pnpm exec playwright install chromium`.

## Database

- Change the schema only through migrations in `supabase/migrations/` (`pnpm exec supabase migration new <name>`).
- `pnpm db:reset` rebuilds the local DB from migrations; `pnpm db:types` regenerates `lib/db/types.ts`.
- Every new table needs RLS + policies (`001_rls_enabled.test.sql` fails otherwise) and a test
  proving a buyer can't read another buyer's restricted rows.

## Hosted Supabase project (dev / prod) checklist

1. Authentication → Sign In / Providers: **disable "Allow new users to sign up"**; enable Email and Google.
2. Authentication → URL Configuration: Site URL = the app URL; add `<app URL>/auth/callback` to Redirect URLs.
3. Authentication → Email Templates: paste `supabase/templates/invite.html` (Invite user) and
   `supabase/templates/magic_link.html` (Magic link).
4. Link and push migrations: `pnpm exec supabase link --project-ref <ref>` then `pnpm exec supabase db push`.
5. Before team rollout: custom SMTP (see Decisions log).
