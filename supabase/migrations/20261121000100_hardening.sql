-- Hardening from the Gemini audit; every item was verified against the code first
-- (Decisions log, 2026-11-21). Regression tests: supabase/tests/database/130_hardening.test.sql
-- and the hardening integration/unit/e2e tests.

-- BUG-1: how long a page may sit in 'fetching' before it counts as stuck.
create function private.stale_fetch_after()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '3 minutes' $$;

grant execute on function private.stale_fetch_after() to authenticated, service_role;

-- SEC-5: last-admin guard is race-safe.
create or replace function private.profiles_guard()
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

    -- SEC-5: serialise "last admin" checks, so two admins demoting each other at the same
    -- time can't both see two active admins and leave none.
    if old.role = 'admin' and old.active and not (new.role = 'admin' and new.active) then
      perform pg_advisory_xact_lock(hashtext('private.profiles_guard.last_admin'));
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

-- SEC-1: an offer AI check is stored only for a DRAFT version, by someone who can edit the offer
-- (admin/manager, or the buyer who owns it), from their own succeeded AI call. Inserted by the
-- service role, so rights are checked against created_by, not auth.uid().
create or replace function private.offer_ai_checks_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.offer_version_status;
  v_owner  uuid;
  v_role   public.app_role;
  v_active boolean;
begin
  select v.status, o.owner_id into v_status, v_owner
  from public.offer_versions v
  join public.offers o on o.id = v.offer_id
  where v.id = new.offer_version_id;
  if v_status is distinct from 'draft' then
    raise exception 'offer_ai_checks can only be recorded for draft versions' using errcode = '23514';
  end if;

  select p.role, p.active into v_role, v_active from public.profiles p where p.id = new.created_by;
  if not coalesce(v_active, false)
     or not (v_role in ('admin', 'manager') or (v_role = 'buyer' and v_owner = new.created_by)) then
    raise exception 'Only the offer owner, a manager or an admin can check this draft' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.ai_calls c
    where c.id = new.ai_call_id
      and c.status = 'succeeded'
      and c.user_id = new.created_by
      and c.subject_type = 'offer_version'
      and c.subject_id = new.offer_version_id
  ) then
    raise exception 'offer_ai_checks needs a succeeded ai_call by the same user for this version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- BUG-4: an offer's only (never-approved) draft can't be discarded.
create or replace function private.offer_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      raise exception 'Approved offer versions cannot be deleted' using errcode = '42501';
    end if;
    -- BUG-4: an offer with no approved version keeps its only draft (else it has no versions).
    if exists (select 1 from public.offers o where o.id = old.offer_id and o.current_version_id is null) then
      raise exception 'This is the offer''s only version; it can''t be discarded' using errcode = 'P0001';
    end if;
    return old;
  end if;

  if old.status = 'approved' then
    raise exception 'Approved offer versions are immutable; create a new draft instead'
      using errcode = '42501';
  end if;

  if new.offer_id is distinct from old.offer_id or new.version is distinct from old.version then
    raise exception 'offer_id and version cannot change' using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     and coalesce(current_setting('app.approving_version', true), '') is distinct from new.id::text then
    raise exception 'Offer versions are approved only through approve_offer_version'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- BUG-9: approve locks the offer first.
create or replace function public.approve_offer_version(p_version_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  approver uuid := (select auth.uid());
  v        public.offer_versions;
begin
  if approver is null or not private.has_role('admin', 'manager') then
    raise exception 'Only managers and admins can approve offer versions' using errcode = '42501';
  end if;
  if char_length(p_note) > 2000 then
    raise exception 'Note is too long (max 2000 characters)' using errcode = '22001';
  end if;

  -- BUG-9: lock order offers -> offer_versions, the same as save_offer_draft and new versions.
  perform 1 from public.offers o
  where o.id = (select ov.offer_id from public.offer_versions ov where ov.id = p_version_id)
  for update;
  select * into v from public.offer_versions where id = p_version_id for update;
  if v.id is null then
    raise exception 'Offer version not found' using errcode = 'P0002';
  end if;
  if v.status <> 'draft' then
    raise exception 'Only drafts can be approved' using errcode = 'P0001';
  end if;

  perform set_config('app.approving_version', v.id::text, true);
  perform set_config('app.audit_action', 'offer_version.approve', true);
  update public.offer_versions
  set status = 'approved', approved_by = approver, approved_at = now()
  where id = v.id;
  perform set_config('app.approving_version', '', true);

  perform set_config('app.audit_action', 'offer.set_current_version', true);
  update public.offers set current_version_id = v.id where id = v.offer_id;
  perform set_config('app.audit_action', '', true);

  insert into public.approvals (entity_type, entity_id, version, action, by, note)
  values ('offer_version', v.id, v.version, 'approved', approver, nullif(btrim(p_note), ''));

  return v.id;
end;
$$;

-- BUG-9: race-safe advertiser find-or-create; URLs deduped.
create or replace function public.save_offer_draft(
  p_offer_id  uuid  default null,
  p_offer     jsonb default '{}',
  p_version   jsonb default '{}',
  p_economics jsonb default '{}',
  p_urls      jsonb default '[]'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_offer_id   uuid := p_offer_id;
  v_version_id uuid;
  v_adv_id     uuid := nullif(p_offer ->> 'advertiser_id', '')::uuid;
  v_adv_name   text := nullif(btrim(p_offer ->> 'advertiser_name'), '');
  v_name       text := btrim(p_offer ->> 'name');
  v_vertical   text := nullif(btrim(p_offer ->> 'vertical'), '');
  v_status     public.offer_status := coalesce(nullif(p_offer ->> 'status', '')::public.offer_status, 'active');
  r            public.offer_versions := jsonb_populate_record(null::public.offer_versions, coalesce(p_version, '{}'));
  e            public.offer_version_economics := jsonb_populate_record(null::public.offer_version_economics, coalesce(p_economics, '{}'));
  v_urls       jsonb := coalesce(p_urls, '[]');
begin
  if not private.has_role('admin', 'manager', 'buyer') then
    raise exception 'You can''t edit offers' using errcode = '42501';
  end if;
  if jsonb_typeof(v_urls) <> 'array' then
    raise exception 'urls must be an array' using errcode = '22023';
  end if;

  -- Advertiser: pick by id, else find-or-create by name (case-insensitive).
  if v_adv_id is null and v_adv_name is not null then
    -- BUG-9: race-safe find-or-create (two saves creating the same new advertiser).
    insert into public.advertisers (name) values (v_adv_name)
    on conflict ((lower(btrim(name)))) do nothing
    returning id into v_adv_id;
    if v_adv_id is null then
      select a.id into v_adv_id from public.advertisers a where lower(btrim(a.name)) = lower(v_adv_name);
    end if;
  end if;

  if v_offer_id is null then
    insert into public.offers (advertiser_id, name, vertical, status)
    values (v_adv_id, v_name, v_vertical, v_status)
    returning id into v_offer_id;

    insert into public.offer_versions (offer_id) values (v_offer_id) returning id into v_version_id;
  else
    if not private.can_edit_offer(v_offer_id) then
      raise exception 'You can''t edit this offer' using errcode = '42501';
    end if;

    update public.offers
    set advertiser_id = v_adv_id, name = v_name, vertical = v_vertical, status = v_status
    where id = v_offer_id;

    select v.id into v_version_id
    from public.offer_versions v
    where v.offer_id = v_offer_id and v.status = 'draft';
    if v_version_id is null then
      raise exception 'This offer has no open draft. Start a new draft first.' using errcode = 'P0002';
    end if;
  end if;

  update public.offer_versions
  set payout_model        = r.payout_model,
      states              = r.states,
      cap_amount          = r.cap_amount,
      cap_counts          = r.cap_counts,
      cap_period          = r.cap_period,
      call_hours          = r.call_hours,
      optimisation_event  = nullif(btrim(r.optimisation_event), ''),
      feedback_delay_days = r.feedback_delay_days,
      restrictions        = r.restrictions,
      approval_required   = r.approval_required
  where id = v_version_id;

  insert into public.offer_version_economics (offer_version_id, payout_tiers, target_cpl, target_roi)
  values (v_version_id, e.payout_tiers, e.target_cpl, e.target_roi)
  on conflict (offer_version_id) do update
  set payout_tiers = excluded.payout_tiers,
      target_cpl   = excluded.target_cpl,
      target_roi   = excluded.target_roi;

  -- URLs: remove dropped ones, add new ones, update kinds. Unchanged rows aren't touched,
  -- so the audit log shows only real changes.
  delete from public.offer_urls u
  where u.offer_version_id = v_version_id
    and u.url not in (select btrim(x ->> 'url') from jsonb_array_elements(v_urls) x);

  insert into public.offer_urls (offer_version_id, url, kind, not_tracking_link)
  -- BUG-9: one row per trimmed URL (duplicates would hit "cannot affect row a second time").
  select v_version_id, btrim(d.x ->> 'url'), (d.x ->> 'kind')::public.offer_url_kind,
         coalesce((d.x ->> 'not_tracking_link')::boolean, false)
  from (select distinct on (btrim(y ->> 'url')) y as x from jsonb_array_elements(v_urls) y) d
  on conflict (offer_version_id, url) do update
  set kind = excluded.kind, not_tracking_link = excluded.not_tracking_link;

  return jsonb_build_object('offer_id', v_offer_id, 'version_id', v_version_id);
end;
$$;

-- BUG-5: research edit rights follow the OFFER (so reassign_offer_owner moves them too);
-- research_projects.owner_id stays as history.
create or replace function private.can_edit_research_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select private.can_edit_offer(p.offer_id) from public.research_projects p where p.id = target_project_id),
    false
  )
$$;

-- BUG-6: re-starting research on the same version queues newly added URLs.
create or replace function public.start_research(p_offer_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer_id   uuid := private.version_offer_id(p_offer_version_id);
  v_owner      uuid;
  v_project    public.research_projects;
  v_url_count  integer;
begin
  if v_offer_id is null or not private.can_edit_offer(v_offer_id) then
    raise exception 'You can''t start research on this offer' using errcode = '42501';
  end if;

  select count(*) into v_url_count from public.offer_urls where offer_version_id = p_offer_version_id;
  if v_url_count = 0 then
    raise exception 'This offer version has no URLs to research' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.start_research:' || v_offer_id::text));
  perform set_config('app.writer', 'job', true);

  select * into v_project from public.research_projects
  where offer_id = v_offer_id and status = 'active';

  if found and v_project.offer_version_id = p_offer_version_id then
    -- BUG-6: URLs added to the (draft) version since the project started are queued too.
    with added as (
      insert into public.fetched_pages (project_id, offer_url_id, url_kind, not_tracking_link, requested_url, created_by)
      select v_project.id, u.id, u.kind, u.not_tracking_link, u.url, (select auth.uid())
      from public.offer_urls u
      where u.offer_version_id = p_offer_version_id
      on conflict (project_id, requested_url) do nothing
      returning 1
    )
    select count(*) into v_url_count from added;
    perform set_config('app.writer', '', true);
    return jsonb_build_object('project_id', v_project.id, 'created', false, 'added_urls', v_url_count);
  end if;
  if found then
    update public.research_projects set status = 'archived' where id = v_project.id;
  end if;

  select owner_id into v_owner from public.offers where id = v_offer_id;
  insert into public.research_projects (offer_id, offer_version_id, owner_id, created_by)
  values (v_offer_id, p_offer_version_id, v_owner, (select auth.uid()))
  returning * into v_project;

  insert into public.fetched_pages (project_id, offer_url_id, url_kind, not_tracking_link, requested_url, created_by)
  select v_project.id, u.id, u.kind, u.not_tracking_link, u.url, (select auth.uid())
  from public.offer_urls u
  where u.offer_version_id = p_offer_version_id;

  perform set_config('app.writer', '', true);
  return jsonb_build_object('project_id', v_project.id, 'created', true, 'added_urls', v_url_count);
end;
$$;

-- BUG-1: stuck pages can be retried.
create or replace function public.retry_fetched_page(p_page_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select project_id into v_project from public.fetched_pages where id = p_page_id;
  if v_project is null or not private.can_edit_research_project(v_project) then
    raise exception 'You can''t retry this page' using errcode = '42501';
  end if;
  if not exists (select 1 from public.research_projects where id = v_project and status = 'active') then
    raise exception 'This research project is archived' using errcode = 'P0001';
  end if;
  perform set_config('app.writer', 'job', true);
  -- Picks up a "not a tracking link" tick added on the (draft) offer since the project started.
  update public.fetched_pages p
  set fetch_status = 'pending', error_code = null, error_message = null,
      not_tracking_link = coalesce(
        (select u.not_tracking_link from public.offer_urls u where u.id = p.offer_url_id),
        p.not_tracking_link)
  -- BUG-1: a page stuck in 'fetching' (crashed step) can be retried after a few minutes.
  where p.id = p_page_id
    and (p.fetch_status not in ('fetching', 'pending')
         or (p.fetch_status = 'fetching' and p.updated_at < now() - private.stale_fetch_after()));
  perform set_config('app.writer', '', true);
  return v_project;
end;
$$;

-- BUG-2 (+BUG-1): narrow recovery for a research run that can't finish, e.g. its user was
-- deactivated mid-run so nothing can be written AS them. Service role only; it can ONLY move
-- running -> failed and pending/fetching -> failed, with a reason. Decisions log, 2026-11-21.
create function public.abort_stalled_research_run(p_project_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'The research job stopped. Use Retry or Run again.'), 500);
begin
  perform set_config('app.writer', 'job', true);
  update public.fetched_pages
  set fetch_status = 'failed', error_code = 'job_aborted', error_message = v_reason
  where project_id = p_project_id and fetch_status in ('pending', 'fetching');
  update public.research_projects
  set fingerprint_status = 'failed', fingerprint_error = v_reason
  where id = p_project_id and fingerprint_status = 'running';
  perform set_config('app.writer', '', true);
end;
$$;

revoke execute on function public.abort_stalled_research_run(uuid, text) from public, anon, authenticated;
grant execute on function public.abort_stalled_research_run(uuid, text) to service_role;

-- P2: the FK on ai_calls.project_id promised in M2, plus its index.
alter table public.ai_calls
  add constraint ai_calls_project_id_fkey
  foreign key (project_id) references public.research_projects (id) on delete restrict;
create index ai_calls_project_idx on public.ai_calls (project_id) where project_id is not null;

-- Least-privilege role for background jobs (DATABASE_URL). NOINHERIT: no privileges of its own;
-- it can only `set role authenticated` (lib/db/as-user.ts), so every job query runs under RLS.
-- Created NOLOGIN: its password is set once by hand per hosted project (Decisions log,
-- 2026-11-21), never in a migration.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'job_runner') then
    -- NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS are the defaults
    -- (asserted in 130_hardening.test.sql); only a superuser may restate some of them.
    create role job_runner nologin noinherit;
  end if;
end;
$$;
grant authenticated to job_runner;
grant connect on database postgres to job_runner;
