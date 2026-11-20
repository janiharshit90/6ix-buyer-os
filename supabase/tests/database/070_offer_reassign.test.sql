-- Offer ownership handover: managers/admins only, new owner must be an active
-- buyer/manager/admin, works when the old owner has left (inactive), and is audited.
begin;
select plan(17);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('admin', 'admin', true);
select tests.create_user('creative', 'creative', true);
select tests.create_user('inactive_buyer', 'buyer', false);

select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer R');

-- ── who may reassign ────────────────────────────────────────────────────────
select throws_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('buyer_b')),
  '42501', null,
  'the owning buyer cannot hand the offer to someone else'
);
reset role;
select tests.authenticate_as('buyer_b');
select throws_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('buyer_b')),
  '42501', null,
  'another buyer cannot take the offer'
);
reset role;
select tests.authenticate_as('creative');
select throws_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('buyer_b')),
  '42501', null,
  'a creative cannot reassign'
);
reset role;
select tests.clear_authentication();
select throws_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('buyer_b')),
  '42501', null,
  'anon cannot reassign'
);

-- ── who may receive ─────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('manager');
select throws_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('creative')),
  'P0001', null,
  'an offer cannot go to a creative'
);
select throws_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('inactive_buyer')),
  'P0001', null,
  'an offer cannot go to an inactive user'
);
select throws_ok(
  $$ select public.reassign_offer_owner(tests.offer_id('Offer R'), gen_random_uuid()) $$,
  'P0002', null,
  'unknown new owner fails clearly'
);
select throws_ok(
  format($$ select public.reassign_offer_owner(gen_random_uuid(), %L) $$, tests.user_id('buyer_b')),
  'P0002', null,
  'unknown offer fails clearly'
);

-- ── buyer A leaves; the manager hands the offer to buyer B ──────────────────
reset role;
select tests.authenticate_as('admin');
update public.profiles set active = false where id = tests.user_id('buyer_a');
reset role;
select tests.authenticate_as('manager');
select lives_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('buyer_b')),
  'a manager can reassign an offer whose owner has left'
);
reset role;
select is(
  (select owner_id from public.offers where id = tests.offer_id('Offer R')),
  tests.user_id('buyer_b'),
  'buyer B now owns the offer'
);
select is(
  (select row(actor, before ->> 'owner_id', after ->> 'owner_id')::text from public.audit_log
   where action = 'offer.reassign_owner' and entity_id = tests.offer_id('Offer R')),
  row(tests.user_id('manager'), tests.user_id('buyer_a')::text, tests.user_id('buyer_b')::text)::text,
  'the handover is audited with the manager as actor and old/new owner'
);

-- Reassigning to the current owner is a no-op (no extra audit row).
select tests.authenticate_as('manager');
select public.reassign_offer_owner(tests.offer_id('Offer R'), tests.user_id('buyer_b'));
reset role;
select is(
  (select count(*)::int from public.audit_log where action = 'offer.reassign_owner'),
  1,
  'reassigning to the current owner writes nothing'
);

-- ── edit rights follow ownership ────────────────────────────────────────────
select tests.authenticate_as('buyer_b');
select lives_ok(
  $$ select public.save_offer_draft(tests.offer_id('Offer R'), '{"name": "Offer R"}', '{"cap_amount": 10}', '{}', '[]') $$,
  'the new owner can edit the draft'
);
reset role;
select tests.authenticate_as('admin');
update public.profiles set active = true where id = tests.user_id('buyer_a');
reset role;
select tests.authenticate_as('buyer_a');
select throws_ok(
  $$ select public.save_offer_draft(tests.offer_id('Offer R'), '{"name": "Offer R"}', '{}', '{}', '[]') $$,
  '42501', null,
  'the previous owner (even if reactivated) can no longer edit'
);

-- ── admins can reassign too, back to a manager ──────────────────────────────
reset role;
select tests.authenticate_as('admin');
select lives_ok(
  format($$ select public.reassign_offer_owner(tests.offer_id('Offer R'), %L) $$, tests.user_id('manager')),
  'an admin can reassign, including to a manager'
);
reset role;
select is(
  (select owner_id from public.offers where id = tests.offer_id('Offer R')),
  tests.user_id('manager'),
  'the manager now owns the offer'
);

-- ── still no direct path ────────────────────────────────────────────────────
select tests.authenticate_as('manager');
select throws_ok(
  format($$ update public.offers set owner_id = %L where id = tests.offer_id('Offer R') $$, tests.user_id('buyer_b')),
  '42501', null,
  'even managers cannot write owner_id directly (only through the audited RPC)'
);

select * from finish();
rollback;
