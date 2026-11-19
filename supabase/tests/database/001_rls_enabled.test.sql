-- Guard for "RLS on every table" (CLAUDE.md §2.4). Fails the moment someone adds a
-- table to `public` without enabling RLS or without any policy.
begin;
select plan(2);

select is_empty(
  $$ select c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity $$,
  'every table in public has row level security enabled'
);

select is_empty(
  $$ select c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) $$,
  'every table in public has at least one RLS policy'
);

select * from finish();
rollback;
