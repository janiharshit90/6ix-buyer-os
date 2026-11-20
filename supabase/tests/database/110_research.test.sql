-- Research projects, fetched pages, fingerprints (Decisions log, M3):
--   staff read every project; creatives read none
--   only the offer's editors start research and retry pages
--   pages/fingerprints are written only in job context (app.writer = 'job'), under the user's RLS
--   fingerprints are versioned and immutable; one active project per offer
begin;
select plan(30);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('creative', 'creative', true);

-- "Job context" as lib/db/as-user.ts sets it up: the user's identity + app.writer.
create or replace function pg_temp.as_job(identifier text) returns void language plpgsql as $$
begin
  perform tests.authenticate_as(identifier);
  perform set_config('app.writer', 'job', true);
end;
$$;

select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer A');

-- ── start_research ─────────────────────────────────────────────────────────
select is(
  (public.start_research(tests.version_id('Offer A', 1)) ->> 'created')::boolean, true,
  'owner starts research on a DRAFT version'
);
select is(
  (public.start_research(tests.version_id('Offer A', 1)) ->> 'created')::boolean, false,
  'starting again on the same version returns the active project'
);
reset role;
select is((select count(*)::int from public.research_projects), 1, 'one project');
select is(
  (select owner_id from public.research_projects), tests.user_id('buyer_a'),
  'project owner = offer owner'
);
select is(
  (select fetch_status::text || ':' || url_kind::text from public.fetched_pages), 'pending:our_lander',
  'a pending page per offer URL'
);

select tests.authenticate_as('buyer_b');
select throws_ok(
  $$ select public.start_research(tests.version_id('Offer A', 1)) $$,
  '42501', null, 'another buyer cannot start research on someone else''s offer'
);
select is((select count(*)::int from public.research_projects), 1, 'other buyers READ projects (team learning)');
select is((select count(*)::int from public.fetched_pages), 1, '...and pages');
select throws_ok(
  $$ select public.retry_fetched_page((select id from public.fetched_pages limit 1)) $$,
  '42501', null, 'another buyer cannot retry pages'
);

reset role;
select tests.authenticate_as('creative');
select is((select count(*)::int from public.research_projects), 0, 'creatives see no projects');
select is((select count(*)::int from public.fetched_pages), 0, 'creatives see no pages');
select is((select count(*)::int from public.fingerprints), 0, 'creatives see no fingerprints');

-- ── no forging through the API (no job context) ────────────────────────────
reset role;
select tests.authenticate_as('buyer_a');
select lives_ok(
  $$ update public.fetched_pages set text = 'forged', fetch_status = 'fetched' $$,
  'owner page update outside a job runs...'
);
select is((select fetch_status::text from public.fetched_pages), 'pending', '...but changes nothing');
select throws_ok(
  $$ insert into public.fingerprints (project_id, prompt_version, confidence, created_by)
     values ((select id from public.research_projects), 'x@1', 'high', auth.uid()) $$,
  '42501', null, 'owner cannot insert fingerprints outside a job'
);
select lives_ok(
  $$ update public.research_projects set fingerprint_status = 'done' $$,
  'owner project update outside a job runs...'
);
select is((select fingerprint_status::text from public.research_projects), 'idle', '...but changes nothing');
select throws_ok(
  $$ insert into public.fetched_pages (project_id, url_kind, requested_url)
     values ((select id from public.research_projects), 'other', 'https://forged.example') $$,
  '42501', null, 'nobody inserts pages directly'
);

-- ── job context ────────────────────────────────────────────────────────────
reset role;
select pg_temp.as_job('buyer_a');
select lives_ok(
  $$ update public.fetched_pages set fetch_status = 'fetched', text = 'Acme Insurance', text_chars = 14 $$,
  'the job (as the owner) writes page results'
);
select lives_ok(
  $$ insert into public.fingerprints (project_id, prompt_version, confidence, created_by)
     values ((select id from public.research_projects), 'fingerprint@1', 'low', auth.uid()) $$,
  'the job inserts a fingerprint'
);
select lives_ok(
  $$ insert into public.fingerprints (project_id, prompt_version, confidence, created_by)
     values ((select id from public.research_projects), 'fingerprint@1', 'medium', auth.uid()) $$,
  'and a second one'
);
select results_eq(
  $$ select version from public.fingerprints order by version $$, array[1, 2],
  'fingerprints are versioned'
);
select throws_ok(
  $$ update public.fingerprints set confidence = 'high' $$,
  '42501', null, 'fingerprints are immutable'
);
select throws_ok(
  $$ insert into public.fingerprints (project_id, ai_call_id, prompt_version, confidence, created_by)
     values ((select id from public.research_projects), gen_random_uuid(), 'fingerprint@1', 'low', auth.uid()) $$,
  '23514', null, 'a fingerprint''s ai_call must be a real succeeded call by the same user'
);

reset role;
select pg_temp.as_job('buyer_b');
select lives_ok(
  $$ update public.fetched_pages set text = 'hijacked' $$,
  'another buyer''s job can''t write this project...'
);
reset role;
select is((select text from public.fetched_pages), 'Acme Insurance', '...nothing changed');

-- Deactivated mid-job: the same transaction setup now has no rights.
update public.profiles set active = false where id = tests.user_id('buyer_a');
select pg_temp.as_job('buyer_a');
select lives_ok($$ update public.fetched_pages set text = 'after deactivation' $$, 'inactive user''s job runs...');
reset role;
select is((select text from public.fetched_pages), 'Acme Insurance', '...but writes nothing');
update public.profiles set active = true where id = tests.user_id('buyer_a');

-- ── one active project per offer; a new version archives the old one ───────
select tests.authenticate_as('manager');
select public.approve_offer_version(tests.version_id('Offer A', 1));
reset role;
select tests.authenticate_as('buyer_a');
select public.create_draft_from_approved(tests.offer_id('Offer A'));
select is(
  (public.start_research(tests.version_id('Offer A', 2)) ->> 'created')::boolean, true,
  'research on v2 creates a new project'
);
reset role;
select results_eq(
  $$ select status::text from public.research_projects order by created_at, status desc $$,
  array['archived', 'active'],
  'the v1 project is archived; one active project per offer'
);

select * from finish();
rollback;
