-- offer_ai_checks: written only by the server, tied to a real succeeded call, append-only,
-- hidden from creatives (findings may mention economics).
begin;
select plan(11);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('buyer_b', 'buyer', true);
select tests.create_user('manager', 'manager', true);
select tests.create_user('creative', 'creative', true);

select tests.authenticate_as('buyer_a');
select tests.create_offer('Offer A');
reset role;

-- A succeeded call by buyer_a about Offer A v1, recorded the way the server does it.
set local role service_role;
select public.begin_ai_call(tests.user_id('buyer_a'), 'offer.ai_check', 'claude-haiku-5-5',
  'offer-check@1', 'p1', 0.01, null, 'offer_version', tests.version_id('Offer A', 1));
select public.finish_ai_call((select id from public.ai_calls where purpose = 'offer.ai_check'),
  'succeeded', 0.0004, 'claude-haiku-5-5', 900, 120);

select lives_ok(
  $$ insert into public.offer_ai_checks (offer_version_id, ai_call_id, prompt_version, model, rule_findings, ai_findings, created_by)
     values (tests.version_id('Offer A', 1), (select id from public.ai_calls where purpose = 'offer.ai_check'),
             'offer-check@1', 'claude-haiku-5-5', '[]', '[{"field":"vertical","kind":"suspicious","message":"x"}]',
             tests.user_id('buyer_a')) $$,
  'server records a check for a succeeded call'
);
select throws_ok(
  $$ insert into public.offer_ai_checks (offer_version_id, ai_call_id, prompt_version, model, rule_findings, ai_findings, created_by)
     values (tests.version_id('Offer A', 1), (select id from public.ai_calls where purpose = 'offer.ai_check'),
             'offer-check@1', 'm', '[]', '[]', tests.user_id('buyer_b')) $$,
  '23514', null, 'a check must come from the same user''s call'
);

-- A failed call can't back a check.
select public.begin_ai_call(tests.user_id('buyer_a'), 'offer.ai_check_failed', 'claude-haiku-5-5',
  'offer-check@1', 'p1', 0.01, null, 'offer_version', tests.version_id('Offer A', 1));
select public.finish_ai_call((select id from public.ai_calls where purpose = 'offer.ai_check_failed'),
  'failed', 0.0001, null, null, null, null, null, 'refusal', 'refusal');
select throws_ok(
  $$ insert into public.offer_ai_checks (offer_version_id, ai_call_id, prompt_version, model, rule_findings, ai_findings, created_by)
     values (tests.version_id('Offer A', 1), (select id from public.ai_calls where purpose = 'offer.ai_check_failed'),
             'offer-check@1', 'm', '[]', '[]', tests.user_id('buyer_a')) $$,
  '23514', null, 'a failed call cannot back a check'
);

select throws_ok(
  $$ update public.offer_ai_checks set ai_findings = '[]' $$,
  '42501', null, 'checks are immutable, even for the service role'
);
select throws_ok(
  $$ delete from public.offer_ai_checks $$,
  '42501', null, 'checks are not deleted on their own'
);

-- ── reads ──────────────────────────────────────────────────────────────────
reset role;
select tests.authenticate_as('buyer_b');
select is((select count(*)::int from public.offer_ai_checks), 1, 'other buyers can read checks (team learning)');
select throws_ok(
  $$ insert into public.offer_ai_checks (offer_version_id, ai_call_id, prompt_version, model, rule_findings, ai_findings, created_by)
     values (tests.version_id('Offer A', 1), gen_random_uuid(), 'x@1', 'm', '[]', '[]', tests.user_id('buyer_b')) $$,
  '42501', null, 'clients cannot insert checks'
);

reset role;
select tests.authenticate_as('manager');
select is((select count(*)::int from public.offer_ai_checks), 1, 'manager reads checks');

reset role;
select tests.authenticate_as('creative');
select is((select count(*)::int from public.offer_ai_checks), 0, 'creatives never see checks (economics)');

-- ── discarding the draft removes its checks ────────────────────────────────
reset role;
select tests.authenticate_as('buyer_a');
select lives_ok(
  $$ delete from public.offer_versions where id = tests.version_id('Offer A', 1) $$,
  'owner discards the draft'
);
reset role;
select is((select count(*)::int from public.offer_ai_checks), 0, 'its checks go with it');

select * from finish();
rollback;
