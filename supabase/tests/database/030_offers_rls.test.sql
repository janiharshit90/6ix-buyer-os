-- Offers: who can read and write what (Decisions log: buyer data isolation, economics hiding).
--   buyers READ every offer/version/economics/URL but WRITE only their own
--   creatives see approved versions only and NEVER economics (table, view or RPC)
--   anon sees nothing
begin;
select plan(40);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('creative', 'creative', true);

-- Offer A (buyer A): approved v1. Offer B (buyer B): draft v1 only.
select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer A');
reset role;
select tests.authenticate_as('buyer_b');
select tests.create_offer('Offer B');
reset role;
select tests.authenticate_as('manager');
select public.approve_offer_version(tests.version_id('Offer A', 1));

-- ── buyer B reads buyer A's offer ───────────────────────────────────────────
reset role;
select tests.authenticate_as('buyer_b');
select is((select count(*)::int from public.offers), 2, 'buyer sees every offer');
select is((select count(*)::int from public.offer_versions where offer_id = tests.offer_id('Offer A')), 1,
  'buyer sees another buyer''s versions');
select is(
  (select target_cpl from public.offer_version_economics where offer_version_id = tests.version_id('Offer A', 1)),
  42.50::numeric,
  'buyer sees another buyer''s economics'
);
select is(
  (select target_cpl from public.offer_versions_with_economics where id = tests.version_id('Offer A', 1)),
  42.50::numeric,
  'buyer sees economics through the joined view'
);
select is((select count(*)::int from public.offer_urls where offer_version_id = tests.version_id('Offer A', 1)), 1,
  'buyer sees another buyer''s URLs');

-- ── buyer A writes to buyer B's offer: every path blocked ───────────────────
reset role;
select tests.authenticate_as('buyer_a');
select lives_ok(
  $$ update public.offers set name = 'hacked' where id = tests.offer_id('Offer B') $$,
  'buyer update of another buyer''s offer runs without error...'
);
select is((select name from public.offers where id = tests.offer_id('Offer B')), 'Offer B', '...but changes nothing');
select lives_ok(
  $$ update public.offer_versions set cap_amount = 1 where id = tests.version_id('Offer B', 1) $$,
  'buyer update of another buyer''s draft runs without error...'
);
select is((select cap_amount from public.offer_versions where id = tests.version_id('Offer B', 1)), 50,
  '...but the draft is unchanged');
select lives_ok(
  $$ update public.offer_version_economics set target_cpl = 1 where offer_version_id = tests.version_id('Offer B', 1) $$,
  'buyer update of another buyer''s economics runs without error...'
);
select is(
  (select target_cpl from public.offer_version_economics where offer_version_id = tests.version_id('Offer B', 1)),
  42.50::numeric,
  '...but the economics are unchanged'
);
select lives_ok(
  $$ delete from public.offer_urls where offer_version_id = tests.version_id('Offer B', 1) $$,
  'buyer delete of another buyer''s URLs runs without error...'
);
select lives_ok(
  $$ delete from public.offer_versions where id = tests.version_id('Offer B', 1) $$,
  'buyer delete of another buyer''s draft runs without error...'
);
select is(
  (select count(*)::int from public.offer_urls where offer_version_id = tests.version_id('Offer B', 1)),
  1,
  '...but the URLs and the draft are still there'
);
select throws_ok(
  $$ select public.save_offer_draft(tests.offer_id('Offer B'), '{"name": "hacked"}', '{}', '{}', '[]') $$,
  '42501', null,
  'buyer cannot save another buyer''s draft through the RPC'
);
select throws_ok(
  $$ insert into public.offer_versions (offer_id) values (tests.offer_id('Offer B')) $$,
  '42501', null,
  'buyer cannot add a version to another buyer''s offer'
);
select throws_ok(
  $$ insert into public.offer_urls (offer_version_id, url, kind) values (tests.version_id('Offer B', 1), 'https://evil.example', 'other') $$,
  '42501', null,
  'buyer cannot add a URL to another buyer''s draft'
);
select throws_ok(
  $$ select public.create_draft_from_approved(tests.offer_id('Offer B')) $$,
  '42501', null,
  'buyer cannot start a draft on another buyer''s offer'
);
select throws_ok(
  $$ update public.offers set owner_id = tests.user_id('buyer_a') where id = tests.offer_id('Offer B') $$,
  '42501', null,
  'buyer cannot reassign an offer (no grant on owner_id)'
);
select throws_ok(
  format($$ insert into public.offers (name, owner_id) values ('Fake', %L) $$, tests.user_id('buyer_b')),
  '42501', null,
  'buyer cannot create an offer owned by someone else'
);
select throws_ok(
  $$ update public.offers set current_version_id = null where id = tests.offer_id('Offer A') $$,
  '42501', null,
  'buyer cannot set current_version_id directly'
);
select throws_ok(
  $$ delete from public.offers where id = tests.offer_id('Offer A') $$,
  '42501', null,
  'offers cannot be deleted (archive instead)'
);

-- ── advertisers ─────────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('buyer_b');
select lives_ok(
  $$ update public.advertisers set name = 'hacked' where name = 'Offer A Advertiser' $$,
  'buyer update of an advertiser they didn''t create runs without error...'
);
select is((select count(*)::int from public.advertisers where name = 'Offer A Advertiser'), 1, '...but changes nothing');

-- ── manager edits any draft ─────────────────────────────────────────────────
reset role;
select tests.authenticate_as('manager');
select lives_ok(
  $$ update public.offer_versions set cap_amount = 75 where id = tests.version_id('Offer B', 1) $$,
  'manager can edit any buyer''s draft'
);
select is((select cap_amount from public.offer_versions where id = tests.version_id('Offer B', 1)), 75,
  'manager edit saved');

-- ── creative ────────────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('creative');
select is((select array_agg(name) from public.offers), array['Offer A'],
  'creative sees only offers with an approved version');
select is((select array_agg(status::text) from public.offer_versions), array['approved'],
  'creative sees approved versions only');
select is((select count(*)::int from public.offer_versions where payout_model = 'ppc'), 1,
  'creative can see payout_model (needed for the CTA)');
select is((select count(*)::int from public.offer_version_economics), 0,
  'creative gets zero economics rows from the table');
select is((select count(*)::int from public.offer_versions_with_economics), 0,
  'creative gets zero rows from the economics view');
select is(
  (select target_cpl from public.offer_version_economics where offer_version_id = tests.version_id('Offer A', 1)),
  null,
  'creative cannot read target_cpl even by id'
);
select is((select count(*)::int from public.offer_urls), 1, 'creative sees only approved versions'' URLs');
select throws_ok(
  $$ select public.save_offer_draft(null, '{"name": "Creative offer"}', '{}', '{}', '[]') $$,
  '42501', null,
  'creative cannot create offers'
);
select throws_ok(
  $$ insert into public.advertisers (name) values ('Creative advertiser') $$,
  '42501', null,
  'creative cannot create advertisers'
);
select throws_ok(
  $$ select public.create_draft_from_approved(tests.offer_id('Offer A')) $$,
  '42501', null,
  'creative cannot start drafts'
);

-- ── anon ────────────────────────────────────────────────────────────────────
reset role;
select tests.clear_authentication();
select throws_ok($$ select * from public.offers $$, '42501', null, 'anon cannot read offers');
select throws_ok($$ select * from public.offer_version_economics $$, '42501', null, 'anon cannot read economics');
select throws_ok($$ select * from public.offer_versions_with_economics $$, '42501', null, 'anon cannot read the view');
select throws_ok(
  $$ select public.save_offer_draft(null, '{"name": "x"}', '{}', '{}', '[]') $$,
  '42501', null,
  'anon cannot call save_offer_draft'
);

select * from finish();
rollback;
