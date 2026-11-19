-- profiles: creation on invite/sign-up, and the BOOTSTRAP_ADMIN_EMAIL path.
begin;
select plan(12);

-- ── profile auto-creation ───────────────────────────────────────────────────
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
        'jane.doe@test.local', '', '{}', '{}', now(), now());

select is(
  (select row(role::text, active, display_name, created_by)::text from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  row('buyer', false, 'jane.doe', '11111111-1111-1111-1111-111111111111'::uuid)::text,
  'new user gets an inactive buyer profile named after their email'
);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
        'invitee@test.local', '', '{}',
        '{"full_name": "Invited Person", "invited_by": "11111111-1111-1111-1111-111111111111"}', now(), now());

select is(
  (select row(display_name, created_by)::text from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  row('Invited Person', '11111111-1111-1111-1111-111111111111'::uuid)::text,
  'invited user gets their full name and created_by = inviting admin'
);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated',
        'junk@test.local', '', '{}', '{"invited_by": "not-a-uuid"}', now(), now());

select is(
  (select created_by from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'malformed invited_by falls back to the user themself'
);

-- ── bootstrap_admin (no admin exists yet) ───────────────────────────────────
select tests.create_user('boss', 'buyer', false);
select tests.create_user('other', 'buyer', false);

set local role service_role;
select is(
  public.bootstrap_admin(tests.user_id('boss')),
  true,
  'bootstrap_admin promotes the user when no active admin exists'
);
reset role;
select is(
  (select row(role::text, active)::text from public.profiles where id = tests.user_id('boss')),
  row('admin', true)::text,
  'bootstrapped user is an active admin'
);

select is(
  (select row(actor, entity_id, before ->> 'role', after ->> 'role', after ->> 'active')::text
   from public.audit_log where action = 'auth.bootstrap_admin'),
  row(tests.user_id('boss'), tests.user_id('boss'), 'buyer', 'admin', 'true')::text,
  'bootstrap is audit-logged with the bootstrapped user as actor'
);

set local role service_role;
select is(
  public.bootstrap_admin(tests.user_id('other')),
  false,
  'bootstrap_admin refuses once an active admin exists'
);
reset role;
select is(
  (select row(role::text, active)::text from public.profiles where id = tests.user_id('other')),
  row('buyer', false)::text,
  'second user stays an inactive buyer'
);

-- ── service role can manage profiles server-side ────────────────────────────
set local role service_role;
select lives_ok(
  $$ update public.profiles set active = true where id = tests.user_id('other') $$,
  'service role can change active status (server-side admin tooling)'
);
reset role;
select is(
  (select count(*)::int from public.audit_log where action = 'auth.bootstrap_admin'),
  1,
  'a refused bootstrap writes no bootstrap audit row'
);
select is(
  (select row(action, actor)::text from public.audit_log
   where entity_id = tests.user_id('other') and after ->> 'active' = 'true'),
  row('profiles.update', null::uuid)::text,
  'later service-role changes are logged normally (bootstrap label cleared), actor NULL = system'
);

select tests.authenticate_as('boss');
select throws_ok(
  $$ select public.bootstrap_admin(tests.user_id('boss')) $$,
  '42501', null,
  'even an admin cannot call bootstrap_admin from the client'
);

select * from finish();
rollback;
