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

| Command                 | What                                                      | Needs                                   |
| ----------------------- | --------------------------------------------------------- | --------------------------------------- |
| `pnpm test`             | Unit tests (Vitest)                                       | nothing                                 |
| `pnpm test:db`          | pgTAP RLS tests in `supabase/tests/database`              | `pnpm db:start`                         |
| `pnpm test:integration` | RLS through the real Data API (Vitest + supabase-js)      | `pnpm db:start`                         |
| `pnpm test:e2e`         | Playwright smoke tests (own dev server on port 3100)      | `pnpm db:start`                         |
| `pnpm test:all`         | All of the above                                          | `pnpm db:start`                         |
| `pnpm test:live`        | Opt-in, billed: real Anthropic calls (2 tiny Haiku calls) | `AI_LIVE_TESTS=1` + `ANTHROPIC_API_KEY` |

First Playwright run: `pnpm exec playwright install chromium`.

No test except `test:live` calls the Anthropic API: unit and integration tests inject a fake client,
and the e2e dev server runs with `AI_FAKE=1`.

## AI service (`lib/ai/`)

- Every model call goes through `runStructured` (`lib/ai/run.ts`): budget reservation → call with a
  JSON-schema output → Zod validation → `ai_calls` row with code-computed cost. Invalid output,
  refusals and truncation are logged failures, never saved.
- Models per tier: `lib/ai/config.ts` (override with `AI_MODEL_GENERATION` / `AI_MODEL_CLASSIFICATION`).
  Prices: `lib/ai/pricing.ts` (bump `PRICE_VERSION` when they change).
- Prompts: `lib/ai/prompts/<name>/vN.ts`. Released versions are frozen by `prompts/hashes.json`;
  to change a prompt add `vN+1` and its hash (the unit test prints it).
- Untrusted text (pages, uploads, free-text fields) only goes through `wrapUntrusted`, in the user turn.
- Local dev without a key: set `AI_FAKE=1` for a canned model (refused in production).
- Budgets: workspace cap (seeded $20) + optional per-user caps, set by admins in Settings.

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
6. Set `ANTHROPIC_API_KEY` (one key per environment, with a Console spend limit) and check the
   workspace AI cap in Settings.
