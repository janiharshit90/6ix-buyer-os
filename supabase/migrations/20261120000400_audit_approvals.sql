-- M1 audit_log + approvals.
--
-- audit_log: append-only, written ONLY by the private.audit_row() trigger and by security
-- definer functions. Clients have no insert grant, so app code can neither forge nor skip it.
-- Readable by managers/admins only (Decisions log: buyer data isolation).
--
-- Labelling: a definer function may set the transaction-local GUCs
--   app.audit_action  e.g. 'offer_version.approve'   (default: '<table>.<insert|update|delete>')
--   app.audit_actor   used only when there is no auth.uid() (e.g. bootstrap via the service role)
-- and must clear them afterwards. PostgREST clients can't call set_config, so they can't set them.

create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor       uuid,
  action      text not null check (char_length(action) between 1 and 100),
  entity_type text not null,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default clock_timestamp(), -- not now(): keeps order within one transaction
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid
);
comment on table public.audit_log is 'Append-only. Written by triggers/definer functions only. NULL actor = system/service role.';
comment on column public.audit_log.actor is 'auth user id; no FK so history survives user deletion.';
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, at desc);
create index audit_log_actor_idx on public.audit_log (actor, at desc);

create type public.approval_entity as enum ('offer_version');
create type public.approval_action as enum ('approved', 'rejected', 'changes_requested');

create table public.approvals (
  id          uuid primary key default gen_random_uuid(),
  entity_type public.approval_entity not null,
  entity_id   uuid not null,
  version     integer not null check (version >= 1),
  action      public.approval_action not null,
  by          uuid not null references public.profiles (id) on delete restrict,
  note        text check (char_length(note) <= 2000),
  at          timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null
);
comment on table public.approvals is 'Append-only approval decisions for any versioned entity.';
create index approvals_entity_idx on public.approvals (entity_type, entity_id, at desc);
create index approvals_by_idx on public.approvals (by);
create index approvals_created_by_idx on public.approvals (created_by);

-- ---------------------------------------------------------------------------
-- Append-only guard (every role, service role included).
-- ---------------------------------------------------------------------------

create function private.append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function private.append_only();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.append_only();
create trigger approvals_append_only
  before update or delete on public.approvals
  for each row execute function private.append_only();
create trigger approvals_no_truncate
  before truncate on public.approvals
  for each statement execute function private.append_only();

-- ---------------------------------------------------------------------------
-- Row audit trigger.
-- ---------------------------------------------------------------------------

create function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  after_row  jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  actor_id   uuid  := coalesce(
    (select auth.uid()),
    nullif(current_setting('app.audit_actor', true), '')::uuid
  );
begin
  insert into public.audit_log (actor, action, entity_type, entity_id, before, after, created_by)
  values (
    actor_id,
    coalesce(nullif(current_setting('app.audit_action', true), ''), tg_table_name || '.' || lower(tg_op)),
    tg_table_name,
    (coalesce(after_row, before_row) ->> 'id')::uuid,
    before_row,
    after_row,
    actor_id
  );
  return null;
end;
$$;

create trigger advertisers_audit
  after insert or delete on public.advertisers
  for each row execute function private.audit_row();
create trigger advertisers_audit_update
  after update on public.advertisers
  for each row when (old.* is distinct from new.*) execute function private.audit_row();

create trigger offers_audit
  after insert or delete on public.offers
  for each row execute function private.audit_row();
create trigger offers_audit_update
  after update on public.offers
  for each row when (old.* is distinct from new.*) execute function private.audit_row();

create trigger offer_versions_audit
  after insert or delete on public.offer_versions
  for each row execute function private.audit_row();
create trigger offer_versions_audit_update
  after update on public.offer_versions
  for each row when (old.* is distinct from new.*) execute function private.audit_row();

create trigger offer_version_economics_audit
  after insert or delete on public.offer_version_economics
  for each row execute function private.audit_row();
create trigger offer_version_economics_audit_update
  after update on public.offer_version_economics
  for each row when (old.* is distinct from new.*) execute function private.audit_row();

create trigger offer_urls_audit
  after insert or delete on public.offer_urls
  for each row execute function private.audit_row();
create trigger offer_urls_audit_update
  after update on public.offer_urls
  for each row when (old.* is distinct from new.*) execute function private.audit_row();

-- profiles: new users, and role/active changes only (display-name edits aren't access changes).
create trigger profiles_audit_insert
  after insert on public.profiles
  for each row execute function private.audit_row();
create trigger profiles_audit_access
  after update of role, active on public.profiles
  for each row
  when (old.role is distinct from new.role or old.active is distinct from new.active)
  execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- bootstrap_admin now writes an audit row (actor = the bootstrapped user).
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_admin(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  promoted boolean;
begin
  -- Serialise concurrent bootstrap attempts.
  perform pg_advisory_xact_lock(hashtext('public.bootstrap_admin'));

  if exists (select 1 from public.profiles where role = 'admin' and active) then
    return false;
  end if;

  perform set_config('app.audit_action', 'auth.bootstrap_admin', true);
  perform set_config('app.audit_actor', target_user_id::text, true);

  update public.profiles
  set role = 'admin', active = true
  where id = target_user_id;
  promoted := found;

  perform set_config('app.audit_action', '', true);
  perform set_config('app.audit_actor', '', true);

  return promoted;
end;
$$;

revoke execute on function public.bootstrap_admin(uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_admin(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------

revoke all on public.audit_log, public.approvals from anon, authenticated;
grant select on public.audit_log, public.approvals to authenticated;

alter table public.audit_log enable row level security;
alter table public.approvals enable row level security;

create policy "audit_log_select_managers" on public.audit_log
  for select to authenticated
  using (private.has_role('admin', 'manager'));

create policy "approvals_select_staff" on public.approvals
  for select to authenticated
  using (private.has_role('admin', 'manager', 'buyer'));
