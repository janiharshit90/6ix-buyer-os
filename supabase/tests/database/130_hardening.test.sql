-- Regression tests for 20261121000100_hardening.sql (Gemini audit items verified against code).
-- Concurrency items (SEC-5, BUG-9 advertiser race) are covered in tests/integration/hardening.test.ts.
begin;
select plan(31);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);

select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer A');
reset role;

-- ── SEC-1: checks only by editors, only on drafts ──────────────────────────
set local role service_role;
select public.begin_ai_call(tests.user_id('buyer_b'), 'sec1.other', 'm', 'offer-check@1', 'p1', 0.01,
  null, 'offer_version', tests.version_id('Offer A', 1));
select public.finish_ai_call((select id from public.ai_calls where purpose = 'sec1.other'), 'succeeded', 0.0001);
select throws_ok(
  $$ insert into public.offer_ai_checks (offer_version_id, ai_call_id, prompt_version, model, rule_findings, ai_findings, created_by)
     values (tests.version_id('Offer A', 1), (select id from public.ai_calls where purpose = 'sec1.other'),
             'offer-check@1', 'm', '[]', '[]', tests.user_id('buyer_b')) $$,
  '42501', null, 'SEC-1: another buyer''s check on my draft is refused, even with their own call'
);
select public.begin_ai_call(tests.user_id('buyer_a'), 'sec1.own', 'm', 'offer-check@1', 'p1', 0.01,
  null, 'offer_version', tests.version_id('Offer A', 1));
select public.finish_ai_call((select id from public.ai_calls where purpose = 'sec1.own'), 'succeeded', 0.0001);
reset role;
select tests.authenticate_as('manager');
select public.approve_offer_version(tests.version_id('Offer A', 1));
reset role;
set local role service_role;
select throws_ok(
  $$ insert into public.offer_ai_checks (offer_version_id, ai_call_id, prompt_version, model, rule_findings, ai_findings, created_by)
     values (tests.version_id('Offer A', 1), (select id from public.ai_calls where purpose = 'sec1.own'),
             'offer-check@1', 'm', '[]', '[]', tests.user_id('buyer_a')) $$,
  '23514', null, 'SEC-1: a check that finishes after approval is not stored'
);
reset role;

-- ── BUG-4: an offer's only draft can't be discarded ────────────────────────
select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer Solo');
select throws_ok(
  $$ delete from public.offer_versions where id = tests.version_id('Offer Solo', 1) $$,
  'P0001', null, 'BUG-4: deleting the only (never approved) draft is refused'
);
select is((select count(*)::int from public.offer_versions where offer_id = tests.offer_id('Offer Solo')), 1,
  'BUG-4: the offer keeps its version');
-- With an approved version, a later draft can still be discarded.
select public.create_draft_from_approved(tests.offer_id('Offer A'));
select lives_ok(
  $$ delete from public.offer_versions where id = tests.version_id('Offer A', 2) $$,
  'BUG-4: a draft of an approved offer can still be discarded'
);
reset role;

-- ── BUG-9: duplicate URLs in one save are deduped (no 21000 error) ─────────
select tests.authenticate_as('buyer_a');
select lives_ok(
  $$ select public.save_offer_draft(tests.offer_id('Offer Solo'), '{"name": "Offer Solo"}', '{}', '{}',
       '[{"url": "https://dup.example/x", "kind": "our_lander"},
         {"url": " https://dup.example/x ", "kind": "preview"}]') $$,
  'BUG-9: duplicate (trimmed) URLs in p_urls don''t error'
);
select is((select count(*)::int from public.offer_urls where offer_version_id = tests.version_id('Offer Solo', 1)
  and url = 'https://dup.example/x'), 1, 'BUG-9: stored once');
-- Advertiser find-or-create still finds case/space variants.
select public.save_offer_draft(null, '{"name": "Adv One", "advertiser_name": "Acme Co"}', '{}', '{}', '[]');
select public.save_offer_draft(null, '{"name": "Adv Two", "advertiser_name": "  acme co "}', '{}', '{}', '[]');
select is((select count(*)::int from public.advertisers where lower(btrim(name)) = 'acme co'), 1,
  'BUG-9: one advertiser for case/space variants');
select is(
  (select count(distinct advertiser_id)::int from public.offers where name in ('Adv One', 'Adv Two')), 1,
  'BUG-9: both offers point at it');
reset role;

-- ── BUG-5 / BUG-6: research follows the offer; new URLs get queued ─────────
select tests.authenticate_as('buyer_a');
select public.start_research(tests.version_id('Offer Solo', 1));
select is(
  (public.start_research(tests.version_id('Offer Solo', 1)) ->> 'added_urls')::int, 0,
  'BUG-6: nothing new, nothing added'
);
select public.save_offer_draft(tests.offer_id('Offer Solo'), '{"name": "Offer Solo"}', '{}', '{}',
  '[{"url": "https://dup.example/x", "kind": "our_lander"},
    {"url": "https://solo.example/lp", "kind": "our_lander"},
    {"url": "https://money.example/direct", "kind": "competitor_lander"}]');
select is(
  public.start_research(tests.version_id('Offer Solo', 1)) - 'project_id',
  '{"created": false, "added_urls": 2}'::jsonb,
  'BUG-6: re-starting on the same draft queues the two newly added URLs'
);
reset role;
select is(
  (select fetch_status::text from public.fetched_pages where requested_url = 'https://money.example/direct'),
  'pending', 'BUG-6: the new URL is pending'
);

select tests.authenticate_as('manager');
select public.reassign_offer_owner(tests.offer_id('Offer Solo'), tests.user_id('buyer_b'));
reset role;
select tests.authenticate_as('buyer_b');
select ok(
  public.can_edit_research_project((select id from public.research_projects where offer_id = tests.offer_id('Offer Solo'))),
  'BUG-5: the new offer owner can act on its research'
);
reset role;
select tests.authenticate_as('buyer_a');
select ok(
  not public.can_edit_research_project((select id from public.research_projects where offer_id = tests.offer_id('Offer Solo'))),
  'BUG-5: the previous owner can''t'
);
reset role;

-- ── BUG-1: a page stuck in 'fetching' can be retried after a few minutes ───
alter table public.fetched_pages disable trigger fetched_pages_set_updated_at;
select set_config('app.writer', 'job', true);
update public.fetched_pages set fetch_status = 'fetching', updated_at = now() - interval '1 minute'
where requested_url = 'https://money.example/direct';
select set_config('app.writer', '', true);
select tests.authenticate_as('buyer_b');
select public.retry_fetched_page((select id from public.fetched_pages where requested_url = 'https://money.example/direct'));
reset role;
select is(
  (select fetch_status::text from public.fetched_pages where requested_url = 'https://money.example/direct'),
  'fetching', 'BUG-1: a page that is still being fetched isn''t reset'
);
select set_config('app.writer', 'job', true);
update public.fetched_pages set updated_at = now() - interval '10 minutes'
where requested_url = 'https://money.example/direct';
select set_config('app.writer', '', true);
alter table public.fetched_pages enable trigger fetched_pages_set_updated_at;
select tests.authenticate_as('buyer_b');
select public.retry_fetched_page((select id from public.fetched_pages where requested_url = 'https://money.example/direct'));
reset role;
select is(
  (select fetch_status::text from public.fetched_pages where requested_url = 'https://money.example/direct'),
  'pending', 'BUG-1: a stuck page is re-queued by Retry'
);

-- ── BUG-2: abort_stalled_research_run (service role only, status-only) ─────
select tests.authenticate_as('buyer_b');
select throws_ok(
  $$ select public.abort_stalled_research_run(gen_random_uuid(), 'x') $$,
  '42501', null, 'BUG-2: clients can''t call the abort RPC'
);
reset role;
select set_config('app.writer', 'job', true);
update public.research_projects set fingerprint_status = 'running' where offer_id = tests.offer_id('Offer Solo');
select set_config('app.writer', '', true);
set local role service_role;
select public.abort_stalled_research_run(
  (select id from public.research_projects where offer_id = tests.offer_id('Offer Solo')), 'user deactivated');
reset role;
select is(
  (select fingerprint_status::text || ':' || fingerprint_error from public.research_projects where offer_id = tests.offer_id('Offer Solo')),
  'failed:user deactivated', 'BUG-2: running project is marked failed with the reason'
);
select is(
  (select count(*)::int from public.fetched_pages p join public.research_projects r on r.id = p.project_id
   where r.offer_id = tests.offer_id('Offer Solo') and p.fetch_status in ('pending', 'fetching')),
  0, 'BUG-2: no page is left pending or fetching'
);
select is(
  (select count(*)::int from public.fetched_pages p join public.research_projects r on r.id = p.project_id
   where r.offer_id = tests.offer_id('Offer Solo') and p.error_code = 'job_aborted'),
  3, 'BUG-2: aborted pages say why'
);

-- ── SEC-5: the last-admin guard still works (concurrency: integration test) ─
select tests.create_user('only_admin', 'admin', true);
-- other admins from earlier test files don't exist here (each file rolls back)
select tests.authenticate_as('only_admin');
select throws_ok(
  $$ update public.profiles set role = 'buyer' where id = tests.user_id('only_admin') $$,
  'P0001', null, 'SEC-5: the last active admin can''t be demoted'
);
reset role;

-- ── P2: ai_calls.project_id FK + index ─────────────────────────────────────
select fk_ok('public', 'ai_calls', 'project_id', 'public', 'research_projects', 'id',
  'P2: ai_calls.project_id references research_projects');
select has_index('public', 'ai_calls', 'ai_calls_project_idx', 'P2: ai_calls.project_id is indexed');
set local role service_role;
select throws_ok(
  $$ select public.begin_ai_call(tests.user_id('buyer_a'), 'x', 'm', 'p@1', 'p1', 0, gen_random_uuid()) $$,
  '23503', null, 'P2: an ai_call can''t point at a project that doesn''t exist'
);
reset role;

-- ── job_runner: least privilege for background jobs ────────────────────────
select is(
  (select row(rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication)::text
   from pg_roles where rolname = 'job_runner'),
  '(f,f,f,f,f,f)', 'job_runner: NOINHERIT, not superuser, can''t bypass RLS or create roles/dbs'
);
select ok(pg_has_role('job_runner', 'authenticated', 'member'), 'job_runner: may SET ROLE authenticated');
select ok(not pg_has_role('job_runner', 'service_role', 'member'), 'job_runner: not a member of service_role');
select ok(not pg_has_role('job_runner', 'postgres', 'member'), 'job_runner: not a member of postgres');
-- A real login as job_runner is exercised in tests/integration/hardening.test.ts.
select ok(
  not pg_has_role('job_runner', 'authenticated', 'usage'),
  'job_runner: authenticated''s privileges are NOT usable without SET ROLE (NOINHERIT)'
);
select ok(
  not has_table_privilege('job_runner', 'public.offers', 'select'),
  'job_runner: no table access of its own'
);
select ok(
  has_table_privilege('authenticated', 'public.offers', 'select'),
  '...while authenticated (what jobs switch to) has it, under RLS'
);

select * from finish();
rollback;
