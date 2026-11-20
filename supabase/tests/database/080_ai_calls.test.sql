-- ai_calls: who can read, who can write, and immutability (Decisions log, M2).
--   buyers see only their own calls; managers/admins see everyone's; creatives their own
--   no client (authenticated/anon) can insert, update, delete or call begin/finish_ai_call
--   a finished call is frozen for every role, service role included
begin;
select plan(24);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('admin', 'admin', true);
select tests.create_user('creative', 'creative', true);
select tests.create_user('inactive', 'buyer', false);

-- Setup as the service role (the server's path).
set local role service_role;
select public.begin_ai_call(tests.user_id('buyer_a'), 'test.a', 'claude-haiku-5-5', 'test@1', 'p1', 0.01);
select public.begin_ai_call(tests.user_id('buyer_b'), 'test.b', 'claude-haiku-5-5', 'test@1', 'p1', 0.01);
select public.begin_ai_call(tests.user_id('creative'), 'test.c', 'claude-haiku-5-5', 'test@1', 'p1', 0.01);
reset role;

-- ── reads ──────────────────────────────────────────────────────────────────
select tests.authenticate_as('buyer_a');
select is((select count(*)::int from public.ai_calls), 1, 'buyer sees only their own calls');
select is((select purpose from public.ai_calls), 'test.a', '...and it is theirs');
select is((select count(*)::int from public.ai_usage_monthly), 1, 'usage view is RLS-scoped for buyers');

reset role;
select tests.authenticate_as('creative');
select is((select count(*)::int from public.ai_calls), 1, 'creative sees only their own calls');

reset role;
select tests.authenticate_as('manager');
select is((select count(*)::int from public.ai_calls), 3, 'manager sees every call');
select is((select count(distinct user_id)::int from public.ai_usage_monthly), 3, 'manager sees everyone''s usage');

reset role;
select tests.authenticate_as('admin');
select is((select count(*)::int from public.ai_calls), 3, 'admin sees every call');

reset role;
select tests.authenticate_as('inactive');
select is((select count(*)::int from public.ai_calls), 0, 'inactive user sees nothing');

reset role;
select tests.clear_authentication();
select throws_ok($$ select count(*) from public.ai_calls $$, '42501', null, 'anon cannot read ai_calls');

-- ── writes: blocked for every client role ──────────────────────────────────
reset role;
select tests.authenticate_as('admin');
select throws_ok(
  $$ insert into public.ai_calls (user_id, purpose, model, prompt_version, price_version)
     values (tests.user_id('admin'), 'forged', 'm', 'p@1', 'p1') $$,
  '42501', null, 'even an admin cannot insert ai_calls directly'
);
select throws_ok(
  $$ update public.ai_calls set cost_usd = 0 $$,
  '42501', null, 'clients cannot update ai_calls'
);
select throws_ok(
  $$ delete from public.ai_calls $$,
  '42501', null, 'clients cannot delete ai_calls'
);
select throws_ok(
  $$ select public.begin_ai_call(tests.user_id('admin'), 'x', 'm', 'p@1', 'p1', 0) $$,
  '42501', null, 'clients cannot call begin_ai_call'
);
select throws_ok(
  $$ select public.finish_ai_call(gen_random_uuid(), 'succeeded', 0) $$,
  '42501', null, 'clients cannot call finish_ai_call'
);

-- ── begin/finish lifecycle (service role) ──────────────────────────────────
reset role;
set local role service_role;
select throws_ok(
  $$ select public.begin_ai_call(tests.user_id('inactive'), 'x', 'm', 'p@1', 'p1', 0) $$,
  '42501', null, 'inactive users cannot start AI calls'
);
select throws_ok(
  $$ select public.begin_ai_call(tests.user_id('buyer_a'), 'x', 'm', 'p@1', 'p1', -1) $$,
  '22023', null, 'negative reservations are rejected'
);

select ok(
  public.finish_ai_call(
    (select id from public.ai_calls where purpose = 'test.a'), 'succeeded', 0.000123,
    'claude-haiku-5-5', 100, 20, 0, 0, 'end_turn', null, null, 'req_1', 42
  ),
  'finish_ai_call settles a pending call'
);
select is(
  (select cost_usd from public.ai_calls where purpose = 'test.a'), 0.000123::numeric,
  'sub-cent cost is kept (numeric 12,6)'
);
select ok(
  not public.finish_ai_call((select id from public.ai_calls where purpose = 'test.a'), 'failed', 9),
  'a settled call cannot be settled again'
);
select throws_ok(
  $$ update public.ai_calls set cost_usd = 0 where purpose = 'test.a' $$,
  '42501', null, 'finished calls are frozen even for the service role'
);
select throws_ok(
  $$ update public.ai_calls set purpose = 'renamed' where purpose = 'test.b' $$,
  '42501', null, 'pending calls can only change their outcome'
);
select throws_ok(
  $$ delete from public.ai_calls where purpose = 'test.b' $$,
  '42501', null, 'ai_calls rows are never deleted, even by the service role'
);
select throws_ok(
  $$ select public.finish_ai_call((select id from public.ai_calls where purpose = 'test.b'), 'blocked', 0) $$,
  '22023', null, 'a call finishes only as succeeded or failed'
);

-- No prompt or output text columns exist (no content in logs).
reset role;
select is_empty(
  $$ select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_calls'
       and column_name ~ '(prompt|output|response|content|text)$'
       and column_name not in ('prompt_version') $$,
  'ai_calls stores no prompt/output text'
);

select * from finish();
rollback;
