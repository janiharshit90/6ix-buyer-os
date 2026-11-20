-- offer_urls.not_tracking_link is saved by save_offer_draft, copied into new drafts,
-- and frozen with the approved version (Decisions log, M3 fetch policy).
begin;
select plan(4);

select tests.create_user('buyer_a', 'buyer', true);
select tests.create_user('manager', 'manager', true);

select tests.authenticate_as('buyer_a');
select public.save_offer_draft(
  null,
  '{"name": "Flag Offer"}',
  '{}',
  '{}',
  '[{"url": "https://offer.example/direct", "kind": "offer_page", "not_tracking_link": true},
    {"url": "https://offer.example/lp", "kind": "our_lander"}]'
);
select results_eq(
  $$ select url || ':' || not_tracking_link from public.offer_urls
     where offer_version_id = tests.version_id('Flag Offer', 1) order by url $$,
  array['https://offer.example/direct:true', 'https://offer.example/lp:false'],
  'the flag is saved (default false)'
);

reset role;
select tests.authenticate_as('manager');
select public.approve_offer_version(tests.version_id('Flag Offer', 1));
update public.offer_urls set not_tracking_link = false
where offer_version_id = tests.version_id('Flag Offer', 1);
reset role;
select is(
  (select not_tracking_link from public.offer_urls
   where offer_version_id = tests.version_id('Flag Offer', 1) and url = 'https://offer.example/direct'),
  true, 'the flag is frozen on approved versions'
);

reset role;
select tests.authenticate_as('buyer_a');
select public.create_draft_from_approved(tests.offer_id('Flag Offer'));
select is(
  (select not_tracking_link from public.offer_urls
   where offer_version_id = tests.version_id('Flag Offer', 2) and url = 'https://offer.example/direct'),
  true, 'new drafts copy the flag'
);
select lives_ok(
  $$ select public.save_offer_draft(tests.offer_id('Flag Offer'), '{"name": "Flag Offer"}', '{}', '{}',
       '[{"url": "https://offer.example/direct", "kind": "offer_page", "not_tracking_link": false}]') $$,
  'the flag can be changed on a draft'
);

select * from finish();
rollback;
