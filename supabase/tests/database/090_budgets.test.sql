-- Budgets: who can see/set caps, and cap enforcement in begin_ai_call (Decisions log, M2).
begin;
select plan(25);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('admin', 'admin', true);

-- ── seeded workspace cap ───────────────────────────────────────────────────
select is(
  (select monthly_cap_usd from public.budgets where scope = 'workspace'), 20.00::numeric,
  'workspace cap is seeded at $20'
);

-- ── who can write caps ─────────────────────────────────────────────────────
select tests.authenticate_as('manager');
select lives_ok(
  $$ update public.budgets set monthly_cap_usd = 999 where scope = 'workspace' $$,
  'manager update runs without error...'
);
reset role;
select is((select monthly_cap_usd from public.budgets where scope = 'workspace'), 20.00::numeric,
  '...but managers cannot change caps');
select tests.authenticate_as('manager');
select throws_ok(
  $$ insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('user', tests.user_id('buyer_a'), 1) $$,
  '42501', null, 'managers cannot add user caps'
);

reset role;
select tests.authenticate_as('buyer_a');
select throws_ok(
  $$ insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('user', tests.user_id('buyer_a'), 1000) $$,
  '42501', null, 'buyers cannot set their own cap'
);

reset role;
select tests.authenticate_as('admin');
select lives_ok(
  $$ insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('user', tests.user_id('buyer_a'), 1.00) $$,
  'admin sets a user cap'
);
select lives_ok(
  $$ insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('user', tests.user_id('buyer_b'), 5.00) $$,
  'admin sets another user cap'
);
select throws_ok(
  $$ insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('workspace', null, 50) $$,
  '23505', null, 'only one workspace cap'
);
select throws_ok(
  $$ insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('user', null, 5) $$,
  '23514', null, 'user caps need a user'
);
select throws_ok(
  $$ update public.budgets set scope_id = tests.user_id('manager') where scope_id = tests.user_id('buyer_a') $$,
  '42501', null, 'cap owner cannot be changed (no column grant)'
);
reset role;
select is(
  (select count(*)::int from public.audit_log where entity_type = 'budgets' and action = 'budgets.insert'),
  2, 'cap changes are audited'
);

-- ── who can read caps ──────────────────────────────────────────────────────
select tests.authenticate_as('buyer_a');
select results_eq(
  $$ select scope::text from public.budgets order by scope::text desc $$,
  array['workspace', 'user'],
  'buyer sees the workspace cap and their own cap only'
);
reset role;
select tests.authenticate_as('manager');
select is((select count(*)::int from public.budgets), 3, 'manager sees every cap');

-- ── enforcement (service role) ─────────────────────────────────────────────
reset role;
set local role service_role;

-- buyer_a: user cap $1.00. A $0.60 reservation fits, a second does not.
select ok(
  (public.begin_ai_call(tests.user_id('buyer_a'), 'test', 'm', 'p@1', 'p1', 0.60) ->> 'ok')::boolean,
  'call within the user cap is reserved'
);
select is(
  public.begin_ai_call(tests.user_id('buyer_a'), 'test', 'm', 'p@1', 'p1', 0.60) - 'call_id' - 'month_start',
  jsonb_build_object('ok', false, 'reason', 'cap_reached', 'scope', 'user',
    'cap_usd', 1.00, 'spent_usd', 0.60, 'reserve_usd', 0.600000),
  'pending reservations count against the user cap'
);
select is(
  (select error_code || ':' || reserved_usd from public.ai_calls
   where user_id = tests.user_id('buyer_a') and status = 'blocked'),
  'cap_reached:0.000000', 'blocked attempts are logged with their reason and reserve nothing'
);
select is(
  (select count(*)::int from public.ai_calls where user_id = tests.user_id('buyer_a') and status = 'blocked'),
  1, 'exactly one blocked attempt'
);

-- Settling at the real (lower) cost frees headroom.
select ok(
  public.finish_ai_call(
    (select id from public.ai_calls where user_id = tests.user_id('buyer_a') and status = 'pending'),
    'succeeded', 0.10),
  'settle at actual cost'
);
select ok(
  (public.begin_ai_call(tests.user_id('buyer_a'), 'test', 'm', 'p@1', 'p1', 0.60) ->> 'ok')::boolean,
  'after settling, the next call fits'
);

-- Workspace cap applies to users without their own cap, and on top of user caps.
reset role;
update public.budgets set monthly_cap_usd = 2.00 where scope = 'workspace';
set local role service_role;
-- spent so far: 0.10 settled + 0.60 pending = 0.70
select ok(
  (public.begin_ai_call(tests.user_id('manager'), 'test', 'm', 'p@1', 'p1', 1.20) ->> 'ok')::boolean,
  'manager (no user cap) fits under the workspace cap'
);
select is(
  public.begin_ai_call(tests.user_id('buyer_b'), 'test', 'm', 'p@1', 'p1', 0.50) ->> 'scope',
  'workspace',
  'workspace cap blocks a user who is under their own cap'
);

-- Abandoned reservations settle at their reserved cost (never undercount).
reset role;
alter table public.ai_calls disable trigger ai_calls_guard;
update public.ai_calls set started_at = now() - interval '1 hour'
where user_id = tests.user_id('manager') and status = 'pending';
alter table public.ai_calls enable trigger ai_calls_guard;
set local role service_role;
select public.begin_ai_call(tests.user_id('buyer_b'), 'test', 'm', 'p@1', 'p1', 0);
select is(
  (select status::text || ':' || error_code || ':' || cost_usd from public.ai_calls
   where user_id = tests.user_id('manager')),
  'failed:abandoned:1.200000',
  'expired reservation is settled as abandoned at its reserved cost'
);

-- Fail closed: no workspace row = every call blocked.
reset role;
delete from public.budgets where scope = 'workspace';
set local role service_role;
select is(
  public.begin_ai_call(tests.user_id('manager'), 'test', 'm', 'p@1', 'p1', 0) ->> 'reason',
  'no_workspace_budget',
  'no workspace cap = blocked (fail closed)'
);

-- ── ai_budget_status (caller's own view) ───────────────────────────────────
reset role;
insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('workspace', null, 20);
select tests.authenticate_as('buyer_a');
select is(
  public.ai_budget_status() - 'month_start',
  jsonb_build_object('workspace_cap_usd', 20.00, 'workspace_spent_usd', 1.90,
    'user_cap_usd', 1.00, 'user_spent_usd', 0.70),
  'ai_budget_status reports caps and month-to-date spend'
);
reset role;
select tests.clear_authentication();
select throws_ok($$ select public.ai_budget_status() $$, '42501', null, 'anon cannot read budget status');

select * from finish();
rollback;
