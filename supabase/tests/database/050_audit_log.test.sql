-- audit_log: written by the DB for every offer write, approval and access change;
-- append-only for every role; readable by managers/admins only.
begin;
select plan(19);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('creative', 'creative', true);
select tests.create_user('admin', 'admin', true);

select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer L');
reset role;

-- ── offer writes ────────────────────────────────────────────────────────────
select is(
  (select array_agg(action order by action collate "C") from public.audit_log
   where actor = tests.user_id('buyer_a') and action not like 'advertisers.%'),
  array['offer_urls.insert', 'offer_version_economics.insert', 'offer_versions.insert', 'offer_versions.update', 'offers.insert'],
  'creating an offer logs each row, with the buyer as actor'
);
select is(
  (select count(*)::int from public.audit_log where action = 'advertisers.insert' and actor = tests.user_id('buyer_a')),
  1,
  'the new advertiser is logged'
);

-- Re-saving identical values adds nothing.
select set_config('test.audit_count', (select count(*)::text from public.audit_log), true);
select tests.authenticate_as('buyer_a');
select public.save_offer_draft(
  tests.offer_id('Offer L'),
  jsonb_build_object('name', 'Offer L', 'advertiser_name', 'Offer L Advertiser', 'vertical', 'insurance'),
  '{"payout_model": "ppc", "states": ["CA", "DC"], "cap_amount": 50, "cap_counts": "calls", "cap_period": "day"}',
  '{"target_cpl": 42.50, "target_roi": 30, "payout_tiers": [{"label": "base", "amount_usd": 30, "condition": null}]}',
  '[{"url": "https://offer-l.example/lp", "kind": "our_lander"}]'
);
reset role;
select is(
  (select count(*)::text from public.audit_log),
  current_setting('test.audit_count'),
  're-saving an unchanged draft writes no audit rows'
);

-- A real change logs before/after.
select tests.authenticate_as('buyer_a');
select public.save_offer_draft(
  tests.offer_id('Offer L'), '{"name": "Offer L"}', '{"cap_amount": 60}', '{"target_cpl": 40}', '[]'
);
reset role;
select is(
  (select row(before ->> 'cap_amount', after ->> 'cap_amount')::text from public.audit_log
   where action = 'offer_versions.update' and entity_id = tests.version_id('Offer L', 1)
   order by at desc limit 1),
  row('50', '60')::text,
  'an edit logs before and after values'
);
select is(
  (select count(*)::int from public.audit_log where action = 'offer_urls.delete' and entity_type = 'offer_urls'),
  1,
  'removing a URL is logged'
);

-- ── approval ────────────────────────────────────────────────────────────────
select tests.authenticate_as('manager');
select public.approve_offer_version(tests.version_id('Offer L', 1));
reset role;
select is(
  (select row(actor, before ->> 'status', after ->> 'status')::text from public.audit_log
   where action = 'offer_version.approve' and entity_id = tests.version_id('Offer L', 1)),
  row(tests.user_id('manager'), 'draft', 'approved')::text,
  'approval is logged with the manager as actor'
);
select is(
  (select after ->> 'current_version_id' from public.audit_log
   where action = 'offer.set_current_version' and entity_id = tests.offer_id('Offer L')),
  tests.version_id('Offer L', 1)::text,
  'the current-version switch is logged'
);
select is(
  (select count(*)::int from public.audit_log where action = 'approvals.insert'),
  0,
  'approvals rows are their own record (not double-logged)'
);

-- ── role / active changes ───────────────────────────────────────────────────
select tests.authenticate_as('admin');
update public.profiles set role = 'manager' where id = tests.user_id('buyer_b');
update public.profiles set active = false where id = tests.user_id('creative');
update public.profiles set display_name = 'Admin Renamed' where id = tests.user_id('admin');
reset role;
select is(
  (select row(actor, before ->> 'role', after ->> 'role')::text from public.audit_log
   where action = 'profiles.update' and entity_id = tests.user_id('buyer_b') and actor = tests.user_id('admin')),
  row(tests.user_id('admin'), 'buyer', 'manager')::text,
  'a role change is logged with the admin as actor'
);
select is(
  (select row(before ->> 'active', after ->> 'active')::text from public.audit_log
   where action = 'profiles.update' and entity_id = tests.user_id('creative') and actor = tests.user_id('admin')),
  row('true', 'false')::text,
  'a deactivation is logged'
);
select is(
  (select count(*)::int from public.audit_log where action = 'profiles.update' and entity_id = tests.user_id('admin') and actor = tests.user_id('admin')),
  0,
  'display-name edits are not access changes and are not logged'
);
select is(
  (select count(*)::int from public.audit_log where action = 'profiles.insert' and entity_id = tests.user_id('buyer_a')),
  1,
  'new users are logged'
);

-- ── who can read it ─────────────────────────────────────────────────────────
select tests.authenticate_as('buyer_a');
select is((select count(*)::int from public.audit_log), 0, 'buyers cannot read the audit log');
reset role;
select tests.authenticate_as('buyer_b'); -- now a manager
select ok((select count(*) from public.audit_log) > 0, 'managers can read the audit log');

-- ── nobody can write or rewrite it ──────────────────────────────────────────
reset role;
select tests.authenticate_as('admin');
select throws_ok(
  $$ insert into public.audit_log (action, entity_type) values ('fake', 'offers') $$,
  '42501', null,
  'even admins cannot insert audit rows directly'
);
select throws_ok(
  $$ insert into public.approvals (entity_type, entity_id, version, action, by)
     values ('offer_version', gen_random_uuid(), 1, 'approved', tests.user_id('admin')) $$,
  '42501', null,
  'approvals cannot be inserted directly (only through approve_offer_version)'
);
reset role;
set local role service_role;
select throws_ok($$ update public.audit_log set action = 'x' $$, '42501', null, 'service role cannot rewrite the audit log');
select throws_ok($$ delete from public.audit_log $$, '42501', null, 'service role cannot delete audit rows');
reset role;
select throws_ok($$ truncate public.audit_log $$, '42501', null, 'even the superuser cannot truncate the audit log');

select * from finish();
rollback;
