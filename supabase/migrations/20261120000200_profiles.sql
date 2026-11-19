-- M0 profiles + roles.
-- One row per auth user. Created automatically when an admin invites someone.
-- New users are `buyer` and inactive until an admin activates them (invite-only, see Decisions log).

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         public.app_role not null default 'buyer',
  display_name text not null check (char_length(display_name) between 1 and 100),
  active       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users (id) on delete set null
);

comment on table public.profiles is 'App user profile: role and activation. Email lives in auth.users only.';
comment on column public.profiles.active is 'Inactive users can read only their own profile and nothing else.';

create index profiles_role_active_idx on public.profiles (role) where active;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Role helpers (used by RLS policies on every table).
-- security definer so policies on profiles don't recurse into profiles' own RLS.
-- Inactive or unknown users get NULL, i.e. no role, i.e. no access.
-- ---------------------------------------------------------------------------

create function private.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.active
$$;

create function private.has_role(variadic roles public.app_role[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(private.current_user_role() = any (roles), false)
$$;

create function private.active_admin_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.profiles where role = 'admin' and active
$$;

grant execute on function private.current_user_role() to authenticated, service_role;
grant execute on function private.has_role(public.app_role[]) to authenticated, service_role;
grant execute on function private.active_admin_count() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Escalation guard.
-- Column grants (below) already stop clients touching id/created_at/created_by.
-- This trigger stops non-admin API callers changing role/active (including their own),
-- and stops anyone removing the last active admin.
-- Runs as the invoker on purpose: current_user is `authenticated` for API callers,
-- and something else (postgres, service_role) for migrations and server-side admin paths.
-- ---------------------------------------------------------------------------

create function private.profiles_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    if current_user in ('authenticated', 'anon') and not private.has_role('admin') then
      raise exception 'Only admins can change a user''s role or active status'
        using errcode = '42501';
    end if;

    if old.role = 'admin' and old.active
       and not (new.role = 'admin' and new.active)
       and private.active_admin_count() <= 1 then
      raise exception 'Cannot remove the last active admin'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

grant execute on function private.profiles_guard() to authenticated, service_role;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function private.profiles_guard();

-- ---------------------------------------------------------------------------
-- Create a profile for every new auth user.
-- display_name: Google full name, else the email's local part.
-- created_by: the inviting admin (set server-side in invite metadata), else the user.
-- ---------------------------------------------------------------------------

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inviter uuid;
begin
  if new.raw_user_meta_data ->> 'invited_by' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select u.id into inviter from auth.users u where u.id = (new.raw_user_meta_data ->> 'invited_by')::uuid;
  end if;

  insert into public.profiles (id, display_name, created_by)
  values (
    new.id,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(split_part(new.email, '@', 1), ''),
      'New user'
    ), 100),
    coalesce(inviter, new.id)
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- First-admin bootstrap. Called by the server (service role) in the auth callback
-- when the signed-in email equals BOOTSTRAP_ADMIN_EMAIL. Only ever succeeds while
-- there is NO active admin, so it can't re-promote someone an admin later demoted.
-- TODO(M1): write an audit_log row when this returns true.
-- ---------------------------------------------------------------------------

create function public.bootstrap_admin(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Serialise concurrent bootstrap attempts.
  perform pg_advisory_xact_lock(hashtext('public.bootstrap_admin'));

  if exists (select 1 from public.profiles where role = 'admin' and active) then
    return false;
  end if;

  update public.profiles
  set role = 'admin', active = true
  where id = target_user_id;

  return found;
end;
$$;

revoke execute on function public.bootstrap_admin(uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_admin(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges + RLS.
-- ---------------------------------------------------------------------------

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, role, active) on public.profiles to authenticated;
-- No insert/delete for clients: profiles come from the auth trigger and are deactivated, not deleted.

alter table public.profiles enable row level security;

-- Every active user can read every profile (owner names show across the app).
-- Inactive users can read only their own row (so the app can show "awaiting activation").
create policy "profiles_select_active_users_or_self"
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or private.current_user_role() is not null
  );

-- Active users can update their own row; admins can update any row.
-- Which columns, and who may change role/active, is enforced by grants + profiles_guard.
create policy "profiles_update_self_or_admin"
  on public.profiles
  for update
  to authenticated
  using (
    private.current_user_role() is not null
    and (id = (select auth.uid()) or private.has_role('admin'))
  )
  with check (
    private.current_user_role() is not null
    and (id = (select auth.uid()) or private.has_role('admin'))
  );
