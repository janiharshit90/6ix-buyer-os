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
and e2e points the real SDK at a local stub (`tests/e2e/anthropic-stub.mjs`) via `ANTHROPIC_BASE_URL`.
CI runs e2e against a production build (`next build` + `next start`); locally it uses `next dev`
unless you set `E2E_PROD=1`.

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

## Research: fetcher + background jobs (M3)

- **Jobs** run on Inngest (`lib/jobs/`, served at `/api/inngest`). Every step acts **as the user** inside
  Postgres (`lib/db/as-user.ts`: `set local role authenticated` + JWT claims), so RLS applies to the job too.
  Job payloads carry ids only. `fetched_pages` and `fingerprints` are writable only inside a job.
- **Keys:** the app reads `APP_INNGEST_EVENT_KEY` / `APP_INNGEST_SIGNING_KEY` (+ optional
  `APP_INNGEST_SIGNING_KEY_FALLBACK`) when set, otherwise the standard `INNGEST_EVENT_KEY` /
  `INNGEST_SIGNING_KEY`. On Vercel only the `APP_` names are set, by hand, from the HJ Inngest account (Production);
  the Marketplace integrations aren't used (`lib/jobs/keys.ts`). With an `APP_` signing key set, the standard fallback
  key is ignored. All server-only; mark them Sensitive.
- **Locally:** set `DATABASE_URL` (the `DB_URL` from `pnpm exec supabase status`) and `INNGEST_DEV=1` in
  `.env.local`, run `pnpm dev`, and in a second terminal `pnpm inngest:dev` (dashboard at http://localhost:8288).
- **Fetcher** (`lib/fetcher/`): plain HTTP only, no browser. SSRF rules on every hop (no internal/metadata
  addresses, http(s) on 80/443 only, ≤5 redirects incl. meta refresh, 15 s, 3 MB, HTML/text only), GET with an
  honest user agent, forms never submitted, nothing executed. Known tracker domains
  (`lib/fetcher/trackers.ts`) are never fetched; `offer_page` URLs only when marked "not a tracking link".
- **Fingerprint** (`fingerprint@1`, Sonnet): every item quotes its page and code drops items whose quote isn't on
  that page; phones, domains and confidence come from code.
- **Tests** never touch the network: the fetcher's unit tests use a local server reached through an explicit
  test-host mapping, and e2e uses `FETCHER_TEST_HOSTS` (`.test` names → loopback, refused on Vercel) plus the
  Inngest dev server and the Anthropic stub.

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

## Deploying to Vercel

Each Vercel project points at one hosted Supabase project (dev or prod). Never put hosted keys in
`.env.local`, and never print them.

### 1. Supabase first

- Check every migration is applied: `pnpm exec supabase migration list --remote` (local and remote
  columns must match).
- Run the hosted checklist above. Email links use `{{ .SiteURL }}`, so the **Site URL must be the
  Vercel production URL**, e.g. `https://<project>.vercel.app` (no trailing slash). Add
  `https://<project>.vercel.app/auth/callback` to Redirect URLs.
- Preview deployments: email links always land on the Site URL, so sign-in via email doesn't work
  on previews. To use previews (e.g. with Google sign-in), add a wildcard redirect URL like
  `https://<project>-*-<team>.vercel.app/**` and set the env vars on the Preview environment too.

### 2. Vercel project settings

- Build → Node.js Version: **24.x**.
- Environment variables (Production):

| Name                                   | Visibility                  | Notes                                                        |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`             | public (inlined at build)   |                                                              |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public (inlined at build)   | publishable key, not the secret key                          |
| `NEXT_PUBLIC_SITE_URL`                 | public (inlined at build)   | the Vercel production URL, no trailing slash                 |
| `SUPABASE_SECRET_KEY`                  | server-only, mark Sensitive |                                                              |
| `BOOTSTRAP_ADMIN_EMAIL`                | server-only                 | needed until the first admin signs in (`/auth/callback`)     |
| `ANTHROPIC_API_KEY`                    | server-only, mark Sensitive | unset = AI features show "AI is not configured"              |
| `ENABLE_EXPERIMENTAL_COREPACK` = `1`   | build setting               | uses the pnpm version pinned in `packageManager`, as CI does |

- **Never set** on Vercel: `AI_FAKE`, `ANTHROPIC_BASE_URL`, `AI_LIVE_TESTS`, `E2E_PROD`,
  `ANTHROPIC_STUB_PORT`. Leave `AI_MODEL_GENERATION` / `AI_MODEL_CLASSIFICATION` unset unless you
  mean to override `lib/ai/config.ts`.
- Changing a `NEXT_PUBLIC_*` value needs a redeploy (it's baked into the build).

### 3. First admin (no hosted keys on your machine)

1. Deploy with `BOOTSTRAP_ADMIN_EMAIL` set, and set the Supabase Site URL (step 1).
2. Supabase dashboard → Authentication → Users → **Invite user** with that same email.
3. Open the invite link: `/auth/callback` on Vercel makes you the active admin (only while no
   active admin exists).
4. Optional: remove `BOOTSTRAP_ADMIN_EMAIL` from Vercel and redeploy.

Alternative: `node scripts/invite-bootstrap-admin.mts` with the four variables it needs entered in a
single PowerShell session (`Read-Host -MaskInput` for the secret key, then `Remove-Item Env:...`),
so nothing is written to disk or shell history.

### 4. Verify after deploy

- [ ] The Vercel URL redirects to `/login`. The invite email arrives and links to the Vercel domain,
      not localhost.
- [ ] The admin lands on `/offers`; Settings shows Users and AI usage ($0.00 of the workspace cap).
- [ ] An uninvited email gets "not invited", not an account.
- [ ] An invited user lands on `/pending` until an admin activates them.
- [ ] Buyer vs creative: a buyer's draft is invisible to a creative; after approval the creative sees
      the offer without payout tiers, Target CPL or ROI, and has no "New offer" button. A buyer has
      no Approve button, even on their own offer.
- [ ] Offer flow: create → admin/manager approves v1 → "Edit (creates draft v2)" → save; v1 stays
      approved and read-only.
- [ ] AI check (needs `ANTHROPIC_API_KEY` with credits): "AI check v1" on a draft shows "Rule
      check" and "AI suggestions"; failures show an error with Retry and change nothing.
- [ ] Settings: the buyer sees only their own spend; admins and managers see team usage.
