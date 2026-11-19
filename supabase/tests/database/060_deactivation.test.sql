-- Deactivating a user cuts off data access on their very next query, even though their
-- JWT is still valid: every policy goes through private.current_user_role(), which reads
-- profiles.active live instead of trusting claims in the token.
begin;
select plan(13);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('admin', 'admin', true);

select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer D');
select is((select count(*)::int from public.offers), 1, 'active buyer can read offers');

-- Admin deactivates buyer A (buyer A's session/JWT is unchanged).
reset role;
select tests.authenticate_as('admin');
update public.profiles set active = false where id = tests.user_id('buyer_a');
update public.profiles set active = false where id = tests.user_id('manager');

reset role;
select tests.authenticate_as('buyer_a');
select is((select count(*)::int from public.offers), 0, 'deactivated: offers gone immediately');
select is((select count(*)::int from public.offer_versions), 0, 'deactivated: versions gone');
select is((select count(*)::int from public.offer_version_economics), 0, 'deactivated: economics gone');
select is((select count(*)::int from public.offer_urls), 0, 'deactivated: URLs gone');
select is((select count(*)::int from public.advertisers), 0, 'deactivated: advertisers gone');
select is((select array_agg(id) from public.profiles), array[tests.user_id('buyer_a')],
  'deactivated: only their own profile remains (for the /pending page)');
select throws_ok(
  $$ select public.save_offer_draft(tests.offer_id('Offer D'), '{"name": "x"}', '{}', '{}', '[]') $$,
  '42501', null,
  'deactivated: cannot save drafts'
);
select lives_ok(
  $$ update public.offers set name = 'x' where id = tests.offer_id('Offer D') $$,
  'deactivated: direct update runs without error...'
);
reset role;
select is((select name from public.offers where id = tests.offer_id('Offer D')), 'Offer D', '...but changes nothing');

select tests.authenticate_as('manager');
select throws_ok(
  $$ select public.approve_offer_version(tests.version_id('Offer D', 1)) $$,
  '42501', null,
  'a deactivated manager cannot approve'
);

-- Reactivation restores access just as fast.
reset role;
select tests.authenticate_as('admin');
update public.profiles set active = true where id = tests.user_id('buyer_a');
reset role;
select tests.authenticate_as('buyer_a');
select is((select count(*)::int from public.offers), 1, 'reactivated: offers visible again');
select is((select count(*)::int from public.offer_version_economics), 1, 'reactivated: economics visible again');

select * from finish();
rollback;
