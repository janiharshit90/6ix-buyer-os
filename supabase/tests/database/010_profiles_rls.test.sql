-- profiles: who can read and change what.
-- Core M0 isolation proof: a buyer cannot change another buyer's profile, cannot
-- escalate their own role, and inactive / anonymous users see nothing else.
begin;
select plan(29);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('creative', 'creative', true);
select tests.create_user('admin', 'admin', true);
select tests.create_user('pending', 'buyer', false);

-- ── anon ────────────────────────────────────────────────────────────────────
select tests.clear_authentication();
select throws_ok(
  $$ select * from public.profiles $$,
  '42501', null,
  'anon cannot read profiles at all'
);

-- ── inactive user ───────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('pending');
select is(
  (select array_agg(id) from public.profiles),
  array[tests.user_id('pending')],
  'inactive user sees only their own profile'
);
select lives_ok(
  $$ update public.profiles set display_name = 'sneaky' where id = tests.user_id('pending') $$,
  'inactive user update runs without error...'
);
select is(
  (select display_name from public.profiles where id = tests.user_id('pending')),
  'pending',
  '...but changes nothing'
);

-- ── buyer A: reads ──────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('buyer_a');
select is(
  (select count(*)::int from public.profiles),
  6,
  'active buyer can read all profiles (names shown across the app)'
);

-- ── buyer A: own row ────────────────────────────────────────────────────────
select lives_ok(
  $$ update public.profiles set display_name = 'Buyer A renamed' where id = tests.user_id('buyer_a') $$,
  'buyer can update their own display_name'
);
select is(
  (select display_name from public.profiles where id = tests.user_id('buyer_a')),
  'Buyer A renamed',
  'own display_name was updated'
);

-- ── buyer A: buyer B's row ──────────────────────────────────────────────────
select lives_ok(
  $$ update public.profiles set display_name = 'hacked' where id = tests.user_id('buyer_b') $$,
  'buyer update of another buyer''s profile runs without error...'
);
select is(
  (select display_name from public.profiles where id = tests.user_id('buyer_b')),
  'buyer_b',
  '...but buyer B''s display_name is unchanged'
);
select lives_ok(
  $$ update public.profiles set role = 'admin' where id = tests.user_id('buyer_b') $$,
  'buyer update of another buyer''s role runs without error...'
);
select is(
  (select role::text from public.profiles where id = tests.user_id('buyer_b')),
  'buyer',
  '...but buyer B''s role is unchanged'
);

-- ── buyer A: escalation attempts ────────────────────────────────────────────
select throws_ok(
  $$ update public.profiles set role = 'admin' where id = tests.user_id('buyer_a') $$,
  '42501', null,
  'buyer cannot make themselves admin'
);
select throws_ok(
  $$ update public.profiles set active = false where id = tests.user_id('buyer_a') $$,
  '42501', null,
  'buyer cannot change their own active flag'
);
select throws_ok(
  $$ update public.profiles set id = gen_random_uuid() where id = tests.user_id('buyer_a') $$,
  '42501', null,
  'buyer cannot change a profile id (no column grant)'
);
select throws_ok(
  $$ update public.profiles set created_by = tests.user_id('buyer_b') where id = tests.user_id('buyer_a') $$,
  '42501', null,
  'buyer cannot change created_by (no column grant)'
);
select throws_ok(
  $$ insert into public.profiles (id, display_name) values (gen_random_uuid(), 'fake') $$,
  '42501', null,
  'buyer cannot insert profiles'
);
select throws_ok(
  $$ delete from public.profiles where id = tests.user_id('buyer_b') $$,
  '42501', null,
  'buyer cannot delete profiles'
);
select throws_ok(
  $$ select public.bootstrap_admin(tests.user_id('buyer_a')) $$,
  '42501', null,
  'buyer cannot call bootstrap_admin'
);

-- ── manager ─────────────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('manager');
select lives_ok(
  $$ update public.profiles set role = 'manager' where id = tests.user_id('buyer_b') $$,
  'manager update of another user''s role runs without error...'
);
select is(
  (select role::text from public.profiles where id = tests.user_id('buyer_b')),
  'buyer',
  '...but managers cannot change roles'
);
select throws_ok(
  $$ update public.profiles set role = 'admin' where id = tests.user_id('manager') $$,
  '42501', null,
  'manager cannot make themselves admin'
);

-- ── admin ───────────────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('admin');
select lives_ok(
  $$ update public.profiles set role = 'manager' where id = tests.user_id('buyer_b') $$,
  'admin can change another user''s role'
);
select is(
  (select role::text from public.profiles where id = tests.user_id('buyer_b')),
  'manager',
  'buyer B is now a manager'
);
select lives_ok(
  $$ update public.profiles set active = true where id = tests.user_id('pending') $$,
  'admin can activate a pending user'
);
select is(
  (select active from public.profiles where id = tests.user_id('pending')),
  true,
  'pending user is now active'
);
select throws_ok(
  $$ update public.profiles set role = 'buyer' where id = tests.user_id('admin') $$,
  'P0001', null,
  'the last active admin cannot demote themselves'
);
select throws_ok(
  $$ update public.profiles set active = false where id = tests.user_id('admin') $$,
  'P0001', null,
  'the last active admin cannot deactivate themselves'
);

-- With a second admin, the first may step down.
reset role;
select tests.create_user('admin_2', 'admin', true);
select tests.authenticate_as('admin');
select lives_ok(
  $$ update public.profiles set role = 'manager' where id = tests.user_id('admin') $$,
  'an admin can step down when another active admin exists'
);
select is(
  (select role::text from public.profiles where id = tests.user_id('admin')),
  'manager',
  'former admin is now a manager'
);

select * from finish();
rollback;
