-- Offer versioning (Non-negotiable #3): approved = immutable for EVERY role, edits create
-- version n+1, one draft at a time, only managers/admins approve.
begin;
select plan(41);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('admin', 'admin', true);
select tests.create_user('creative', 'creative', true);

select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer V');

-- ── approve ─────────────────────────────────────────────────────────────────
select throws_ok(
  $$ select public.approve_offer_version(tests.version_id('Offer V', 1)) $$,
  '42501', null,
  'a buyer cannot approve their own offer'
);
select throws_ok(
  $$ update public.offer_versions set status = 'approved' where id = tests.version_id('Offer V', 1) $$,
  '42501', null,
  'a buyer cannot set status directly (no grant)'
);
reset role;
select tests.authenticate_as('creative');
select throws_ok(
  $$ select public.approve_offer_version(tests.version_id('Offer V', 1)) $$,
  '42501', null,
  'a creative cannot approve'
);
reset role;
select tests.authenticate_as('manager');
select lives_ok(
  $$ select public.approve_offer_version(tests.version_id('Offer V', 1), '  Looks right  ') $$,
  'a manager can approve a draft'
);
reset role;
select is(
  (select row(status::text, approved_by)::text from public.offer_versions where id = tests.version_id('Offer V', 1)),
  row('approved', tests.user_id('manager'))::text,
  'v1 is approved by the manager'
);
select is(
  (select current_version_id from public.offers where id = tests.offer_id('Offer V')),
  tests.version_id('Offer V', 1),
  'offer points at v1 as its current version'
);
select is(
  (select row(entity_type::text, version, action::text, by, note)::text from public.approvals
   where entity_id = tests.version_id('Offer V', 1)),
  row('offer_version', 1, 'approved', tests.user_id('manager'), 'Looks right')::text,
  'the approval is recorded in approvals (note trimmed)'
);
select tests.authenticate_as('manager');
select throws_ok(
  $$ select public.approve_offer_version(tests.version_id('Offer V', 1)) $$,
  'P0001', null,
  'an approved version cannot be approved again'
);
select throws_ok(
  $$ select public.approve_offer_version(gen_random_uuid()) $$,
  'P0002', null,
  'approving an unknown version fails clearly'
);

-- ── approved v1 is frozen, via the API roles... ─────────────────────────────
reset role;
select tests.authenticate_as('buyer_a');
select lives_ok(
  $$ update public.offer_versions set cap_amount = 1 where id = tests.version_id('Offer V', 1) $$,
  'owner update of an approved version runs without error...'
);
select lives_ok(
  $$ update public.offer_version_economics set target_cpl = 1 where offer_version_id = tests.version_id('Offer V', 1) $$,
  'owner update of approved economics runs without error...'
);
select throws_ok(
  $$ insert into public.offer_urls (offer_version_id, url, kind) values (tests.version_id('Offer V', 1), 'https://new.example', 'other') $$,
  '42501', null,
  'owner cannot add a URL to an approved version'
);
select throws_ok(
  $$ select public.save_offer_draft(tests.offer_id('Offer V'), '{"name": "Offer V"}', '{}', '{}', '[]') $$,
  'P0002', null,
  'saving with no open draft fails clearly (no silent edit of the approved version)'
);
reset role;
select tests.authenticate_as('manager');
select lives_ok(
  $$ update public.offer_versions set cap_amount = 1 where id = tests.version_id('Offer V', 1) $$,
  'manager update of an approved version runs without error...'
);
reset role;
select tests.authenticate_as('admin');
select lives_ok(
  $$ delete from public.offer_versions where id = tests.version_id('Offer V', 1) $$,
  'admin delete of an approved version runs without error...'
);
reset role;
select is(
  (select row(cap_amount, (select target_cpl from public.offer_version_economics where offer_version_id = v.id))::text
   from public.offer_versions v where v.id = tests.version_id('Offer V', 1)),
  row(50, 42.50::numeric)::text,
  '...but v1 and its economics are unchanged and still exist'
);

-- ── ...and for the service role and the superuser (trigger, not just RLS) ───
set local role service_role;
select throws_ok(
  $$ update public.offer_versions set cap_amount = 1 where id = tests.version_id('Offer V', 1) $$,
  '42501', null,
  'service role cannot update an approved version'
);
select throws_ok(
  $$ update public.offer_versions set status = 'draft' where id = tests.version_id('Offer V', 1) $$,
  '42501', null,
  'service role cannot un-approve a version'
);
select throws_ok(
  $$ delete from public.offer_versions where id = tests.version_id('Offer V', 1) $$,
  '42501', null,
  'service role cannot delete an approved version'
);
select throws_ok(
  $$ update public.offer_version_economics set target_cpl = 1 where offer_version_id = tests.version_id('Offer V', 1) $$,
  '42501', null,
  'service role cannot change approved economics'
);
select throws_ok(
  $$ delete from public.offer_urls where offer_version_id = tests.version_id('Offer V', 1) $$,
  '42501', null,
  'service role cannot delete approved URLs'
);
select throws_ok(
  $$ insert into public.offer_urls (offer_version_id, url, kind) values (tests.version_id('Offer V', 1), 'https://new.example', 'other') $$,
  '42501', null,
  'service role cannot add URLs to an approved version'
);
reset role;
select throws_ok(
  $$ update public.offer_versions set optimisation_event = 'x' where id = tests.version_id('Offer V', 1) $$,
  '42501', null,
  'even the superuser cannot edit an approved version'
);

-- ── edit = new draft (v2) copied from v1 ────────────────────────────────────
select tests.authenticate_as('buyer_a');
select isnt(
  public.create_draft_from_approved(tests.offer_id('Offer V')),
  null,
  'editing an approved offer creates a draft...'
);
select is(
  (select version from public.offer_versions where offer_id = tests.offer_id('Offer V') and status = 'draft'),
  2,
  '...numbered v2'
);
select is(
  public.create_draft_from_approved(tests.offer_id('Offer V')),
  tests.version_id('Offer V', 2),
  'asking again returns the same open draft'
);
select is(
  (select row(status::text, payout_model::text, states, cap_amount)::text from public.offer_versions where id = tests.version_id('Offer V', 2)),
  row('draft', 'ppc', array['CA','DC'], 50)::text,
  'v2 is a draft with v1''s facts'
);
select is(
  (select target_cpl from public.offer_version_economics where offer_version_id = tests.version_id('Offer V', 2)),
  42.50::numeric,
  'v2 copied v1''s economics'
);
select is(
  (select array_agg(url) from public.offer_urls where offer_version_id = tests.version_id('Offer V', 2)),
  array['https://offer-v.example/lp'],
  'v2 copied v1''s URLs'
);
select lives_ok(
  $$ select public.save_offer_draft(
       tests.offer_id('Offer V'), '{"name": "Offer V"}',
       '{"payout_model": "cpl", "cap_amount": 99}', '{"target_cpl": 10}',
       '[{"url": "https://offer-v.example/lp2", "kind": "our_lander"}]') $$,
  'owner can save the v2 draft'
);
select is(
  (select row(v2.cap_amount, v1.cap_amount)::text
   from public.offer_versions v1, public.offer_versions v2
   where v1.id = tests.version_id('Offer V', 1) and v2.id = tests.version_id('Offer V', 2)),
  row(99, 50)::text,
  'v2 changed, v1 did not'
);
select is(
  (select array_agg(url) from public.offer_urls where offer_version_id = tests.version_id('Offer V', 1)),
  array['https://offer-v.example/lp'],
  'v1''s URLs are untouched by v2''s edit'
);
reset role;
select tests.authenticate_as('manager');
select throws_ok(
  $$ insert into public.offer_versions (offer_id) values (tests.offer_id('Offer V')) $$,
  '23505', null,
  'only one open draft per offer'
);

-- ── status / current_version can't be forged, even by the service role ─────
reset role;
set local role service_role;
select throws_ok(
  $$ update public.offer_versions set status = 'approved', approved_by = tests.user_id('manager'), approved_at = now()
     where id = tests.version_id('Offer V', 2) $$,
  '42501', null,
  'service role cannot approve by writing status directly'
);
select throws_ok(
  $$ update public.offers set current_version_id = tests.version_id('Offer V', 2) where id = tests.offer_id('Offer V') $$,
  '42501', null,
  'current_version_id cannot point at a draft'
);
select throws_ok(
  $$ insert into public.offer_versions (offer_id, version, status) values (tests.offer_id('Offer V'), 9, 'approved') $$,
  '23505', null,
  'inserted versions are always drafts with the next number (here: blocked by the open draft)'
);

-- ── approve v2 → current version moves, v1 stays approved ───────────────────
reset role;
select tests.authenticate_as('admin');
select lives_ok(
  $$ select public.approve_offer_version(tests.version_id('Offer V', 2)) $$,
  'an admin can approve'
);
reset role;
select is(
  (select current_version_id from public.offers where id = tests.offer_id('Offer V')),
  tests.version_id('Offer V', 2),
  'offer now points at v2'
);
select is(
  (select array_agg(status::text order by version) from public.offer_versions where offer_id = tests.offer_id('Offer V')),
  array['approved', 'approved'],
  'v1 stays approved (history is kept)'
);

-- ── drafts can be discarded; their economics and URLs go with them ──────────
select tests.authenticate_as('buyer_a');
select public.create_draft_from_approved(tests.offer_id('Offer V'));
select lives_ok(
  $$ delete from public.offer_versions where id = tests.version_id('Offer V', 3) $$,
  'owner can discard a draft'
);
reset role;
select is(
  (select count(*)::int from public.offer_versions where offer_id = tests.offer_id('Offer V')),
  2,
  'the discarded draft is gone (economics and URLs cascade)'
);

select * from finish();
rollback;
