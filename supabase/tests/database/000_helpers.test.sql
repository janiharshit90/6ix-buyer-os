-- Test helpers shared by every pgTAP file. Runs first (alphabetical order) and is
-- committed so later files can use it. Lives only in the local test database:
-- it is NOT a migration and never reaches hosted projects.
--
--   tests.create_user('buyer_a', 'buyer', true)  -> uuid   (auth user + profile)
--   tests.user_id('buyer_a')                      -> uuid
--   tests.authenticate_as('buyer_a')                        (switch to `authenticated` with that JWT)
--   tests.clear_authentication()                            (switch to `anon`)
-- Use `reset role;` to go back to the superuser for setup/verification.

create extension if not exists pgtap with schema extensions;

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

create or replace function tests.create_user(
  identifier text,
  user_role public.app_role default 'buyer',
  is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', new_id, 'authenticated', 'authenticated',
    identifier || '@test.local', '',
    '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', identifier),
    now(), now()
  );

  -- Runs as the function owner, so profiles_guard lets setup change role/active.
  update public.profiles set role = user_role, active = is_active where id = new_id;

  return new_id;
end;
$$;

create or replace function tests.user_id(identifier text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where email = identifier || '@test.local'
$$;

create or replace function tests.authenticate_as(identifier text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := tests.user_id(identifier);
begin
  if uid is null then
    raise exception 'tests.authenticate_as: unknown test user %', identifier;
  end if;
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated', 'email', identifier || '@test.local')::text,
    true
  );
end;
$$;

create or replace function tests.clear_authentication()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', null, true);
end;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

begin;
select plan(1);
select has_function('tests', 'authenticate_as', array['text'], 'test helpers are installed');
select * from finish();
rollback;
