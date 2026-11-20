-- M3 research: projects, fetched pages, fingerprints (Decisions log, M3).
--
-- Who writes what:
--   research_projects  created/archived by public.start_research (definer, checks edit rights);
--                      job progress columns written only by jobs.
--   fetched_pages      written only by jobs (and by the definer RPCs below), never by clients.
--   fingerprints       written only by jobs. Versioned and immutable.
-- "Jobs" = background steps that run AS THE USER (set local role authenticated + JWT claims,
-- lib/db/as-user.ts) and also set app.writer = 'job'. PostgREST clients can't set that GUC,
-- so the same user can't forge page text or fingerprints through the API, while the job's
-- writes still go through that user's RLS.
--
-- Read access (Decisions log, buyer data isolation): admins, managers and buyers read every
-- project; creatives read none (they only see approved briefs, M5+).

create type public.research_project_status as enum ('active', 'archived');
create type public.fingerprint_run_status as enum ('idle', 'running', 'failed', 'done');
create type public.fetch_status as enum (
  'pending',       -- queued
  'fetching',      -- a job is fetching it
  'fetched',       -- text stored
  'failed',        -- network/HTTP/limit error (retryable)
  'blocked',       -- refused by safety rules or a bot challenge (not retried automatically)
  'needs_render',  -- mostly scripts, little text: a renderer would be needed
  'tracking_link', -- known tracker/redirect domain: never fetched (avoids registering clicks)
  'skipped'        -- policy: e.g. offer_page not marked "not a tracking link"
);
create type public.fingerprint_confidence as enum ('high', 'medium', 'low');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.research_projects (
  id                     uuid primary key default gen_random_uuid(),
  offer_id               uuid not null references public.offers (id) on delete restrict,
  offer_version_id       uuid not null,
  owner_id               uuid not null references public.profiles (id) on delete restrict,
  status                 public.research_project_status not null default 'active',
  fingerprint_status     public.fingerprint_run_status not null default 'idle',
  fingerprint_error      text check (char_length(fingerprint_error) <= 500),
  current_fingerprint_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid default auth.uid() references auth.users (id) on delete set null
);
comment on column public.research_projects.offer_version_id is
  'The offer version whose URLs were researched (may be a draft; no FK so discarding a draft keeps the project history).';
create unique index research_projects_one_active_per_offer
  on public.research_projects (offer_id) where status = 'active';
create index research_projects_owner_idx on public.research_projects (owner_id);
create index research_projects_created_by_idx on public.research_projects (created_by);

create table public.fetched_pages (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.research_projects (id) on delete restrict,
  offer_url_id        uuid, -- no FK: draft URLs can be edited away; requested_url keeps the fact
  url_kind            public.offer_url_kind not null,
  not_tracking_link   boolean not null default false,
  requested_url       text not null check (char_length(requested_url) <= 2048),
  final_url           text check (char_length(final_url) <= 2048),
  final_domain        text check (char_length(final_domain) <= 253),
  redirect_chain      jsonb not null default '[]' check (jsonb_typeof(redirect_chain) = 'array'),
  http_status         integer,
  content_type        text check (char_length(content_type) <= 200),
  title               text check (char_length(title) <= 1000),
  site_name           text check (char_length(site_name) <= 300),
  text                text,
  text_chars          integer check (text_chars >= 0),
  truncated           boolean not null default false,
  text_sha256         text check (text_sha256 ~ '^[0-9a-f]{64}$'),
  link_domains        text[] not null default '{}',
  form_domains        text[] not null default '{}',
  tel_numbers         text[] not null default '{}',
  signals             jsonb not null default '{}' check (jsonb_typeof(signals) = 'object'),
  fetch_status        public.fetch_status not null default 'pending',
  error_code          text check (char_length(error_code) <= 100),
  error_message       text check (char_length(error_message) <= 500),
  attempts            integer not null default 0 check (attempts >= 0),
  fetched_at          timestamptz,
  screenshot_path     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  unique (project_id, requested_url)
);
comment on table public.fetched_pages is 'Fetched page text is UNTRUSTED data: only ever passed to models inside the untrusted-content wrapper.';
comment on column public.fetched_pages.signals is 'Code-computed hints, e.g. {"cloak_suspected": true, "script_heavy": true}.';
create index fetched_pages_project_idx on public.fetched_pages (project_id);
create index fetched_pages_created_by_idx on public.fetched_pages (created_by);

create table public.fingerprints (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.research_projects (id) on delete restrict,
  version            integer not null check (version >= 1),
  ai_call_id         uuid references public.ai_calls (id) on delete restrict,
  prompt_version     text not null check (char_length(prompt_version) between 1 and 100),
  model              text check (char_length(model) <= 100),
  -- AI-extracted items, each {value, page_id, quote}; quotes verified against page text in code.
  brand              jsonb not null default '[]' check (jsonb_typeof(brand) = 'array'),
  advertiser         jsonb not null default '[]' check (jsonb_typeof(advertiser) = 'array'),
  product            jsonb not null default '[]' check (jsonb_typeof(product) = 'array'),
  claims             jsonb not null default '[]' check (jsonb_typeof(claims) = 'array'),
  phrases            jsonb not null default '[]' check (jsonb_typeof(phrases) = 'array'),
  -- Code-extracted, each {value, page_ids[]}.
  phones             jsonb not null default '[]' check (jsonb_typeof(phones) = 'array'),
  domains            jsonb not null default '[]' check (jsonb_typeof(domains) = 'array'),
  confidence         public.fingerprint_confidence not null,
  open_questions     jsonb not null default '[]' check (jsonb_typeof(open_questions) = 'array'),
  page_ids           uuid[] not null default '{}',
  dropped_items      integer not null default 0 check (dropped_items >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  unique (project_id, version)
);
comment on table public.fingerprints is 'Versioned, immutable. confidence is computed by code, never by the model.';
create index fingerprints_ai_call_idx on public.fingerprints (ai_call_id);
create index fingerprints_created_by_idx on public.fingerprints (created_by);

alter table public.research_projects
  add constraint research_projects_current_fingerprint_fkey
  foreign key (current_fingerprint_id) references public.fingerprints (id);
create index research_projects_current_fingerprint_idx on public.research_projects (current_fingerprint_id);

create trigger research_projects_set_updated_at before update on public.research_projects
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
create trigger fetched_pages_set_updated_at before update on public.fetched_pages
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();

create trigger research_projects_audit
  after insert or delete on public.research_projects
  for each row execute function private.audit_row();
create trigger research_projects_audit_status
  after update of status on public.research_projects
  for each row when (old.status is distinct from new.status) execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- True only inside a background-job transaction (lib/db/as-user.ts sets it).
create function private.is_job_writer()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('app.writer', true), '') = 'job'
$$;

-- Admin/manager: any project. Buyer: projects they own. Creatives/inactive: none.
create function private.can_edit_research_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_role('admin', 'manager')
    or (
      private.has_role('buyer')
      and exists (
        select 1 from public.research_projects p
        where p.id = target_project_id and p.owner_id = (select auth.uid())
      )
    )
$$;

grant execute on function private.is_job_writer() to authenticated, service_role;
grant execute on function private.can_edit_research_project(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Guards (every role)
-- ---------------------------------------------------------------------------

-- Fingerprints: version = next number for the project; then frozen forever.
create function private.fingerprints_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The AI part must come from a real, succeeded call by the same user about this project.
  if new.ai_call_id is not null and not exists (
    select 1 from public.ai_calls c
    where c.id = new.ai_call_id
      and c.status = 'succeeded'
      and c.user_id = new.created_by
      and c.subject_type = 'research_project'
      and c.subject_id = new.project_id
  ) then
    raise exception 'fingerprint needs a succeeded ai_call by the same user for this project'
      using errcode = '23514';
  end if;
  perform 1 from public.research_projects where id = new.project_id for update;
  select coalesce(max(f.version), 0) + 1 into new.version
  from public.fingerprints f where f.project_id = new.project_id;
  return new;
end;
$$;

create trigger fingerprints_before_insert
  before insert on public.fingerprints
  for each row execute function private.fingerprints_before_insert();
create trigger fingerprints_immutable
  before update or delete on public.fingerprints
  for each row execute function private.append_only();
create trigger fingerprints_no_truncate
  before truncate on public.fingerprints
  for each statement execute function private.append_only();

-- Job progress columns on projects change only inside jobs or definer RPCs.
create function private.research_projects_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and not private.is_job_writer() then
    raise exception 'Research projects change only through research actions' using errcode = '42501';
  end if;
  if new.offer_id is distinct from old.offer_id
     or new.offer_version_id is distinct from old.offer_version_id
     or new.owner_id is distinct from old.owner_id then
    raise exception 'A research project''s offer, version and owner never change' using errcode = '42501';
  end if;
  if new.current_fingerprint_id is not null
     and new.current_fingerprint_id is distinct from old.current_fingerprint_id
     and not exists (
       select 1 from public.fingerprints f
       where f.id = new.current_fingerprint_id and f.project_id = new.id
     ) then
    raise exception 'current_fingerprint_id must belong to this project' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger research_projects_guard
  before update on public.research_projects
  for each row execute function private.research_projects_guard();

-- Pages: requested URL and project never change; never deleted.
create function private.fetched_pages_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'fetched_pages rows are never deleted' using errcode = '42501';
  end if;
  if new.project_id is distinct from old.project_id
     or new.requested_url is distinct from old.requested_url
     or new.url_kind is distinct from old.url_kind then
    raise exception 'A fetched page''s project and requested URL never change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger fetched_pages_guard
  before update or delete on public.fetched_pages
  for each row execute function private.fetched_pages_guard();

-- ---------------------------------------------------------------------------
-- RPCs (definer: they check edit rights themselves, then write as "job" for one statement)
-- ---------------------------------------------------------------------------

-- Starts (or returns) the active research project for an offer version and queues a
-- fetched_pages row per URL. Owner = the offer's owner. Returns {project_id, created}.
-- If the offer's active project is pinned to another version, it is archived first.
create function public.start_research(p_offer_version_id uuid)
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
    perform set_config('app.writer', '', true);
    return jsonb_build_object('project_id', v_project.id, 'created', false);
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
  return jsonb_build_object('project_id', v_project.id, 'created', true);
end;
$$;

revoke execute on function public.start_research(uuid) from public, anon;
grant execute on function public.start_research(uuid) to authenticated, service_role;

-- Re-queues one page (Retry button). Returns the project id for the job event.
create function public.retry_fetched_page(p_page_id uuid)
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
  where p.id = p_page_id and p.fetch_status not in ('fetching', 'pending');
  perform set_config('app.writer', '', true);
  return v_project;
end;
$$;

revoke execute on function public.retry_fetched_page(uuid) from public, anon;
grant execute on function public.retry_fetched_page(uuid) to authenticated, service_role;

-- Whether the caller may run actions (retry, re-run fingerprint) on a project.
create function public.can_edit_research_project(p_project_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.can_edit_research_project(p_project_id)
    and exists (select 1 from public.research_projects where id = p_project_id and status = 'active')
$$;

revoke execute on function public.can_edit_research_project(uuid) from public, anon;
grant execute on function public.can_edit_research_project(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------

revoke all on public.research_projects, public.fetched_pages, public.fingerprints from anon, authenticated;

grant select on public.research_projects, public.fetched_pages, public.fingerprints to authenticated;
-- Job writes (as the user). RLS below also requires app.writer = 'job'.
grant update (status, fingerprint_status, fingerprint_error, current_fingerprint_id)
  on public.research_projects to authenticated;
grant update (final_url, final_domain, redirect_chain, http_status, content_type, title, site_name,
              text, text_chars, truncated, text_sha256, link_domains, form_domains, tel_numbers,
              signals, fetch_status, error_code, error_message, attempts, fetched_at)
  on public.fetched_pages to authenticated;
grant insert (project_id, ai_call_id, prompt_version, model, brand, advertiser, product, claims,
              phrases, phones, domains, confidence, open_questions, page_ids, dropped_items, created_by)
  on public.fingerprints to authenticated;

alter table public.research_projects enable row level security;
alter table public.fetched_pages enable row level security;
alter table public.fingerprints enable row level security;

create policy "research_projects_select_staff" on public.research_projects
  for select to authenticated
  using (private.has_role('admin', 'manager', 'buyer'));
create policy "research_projects_update_job" on public.research_projects
  for update to authenticated
  using (private.is_job_writer() and private.can_edit_research_project(id))
  with check (private.is_job_writer() and private.can_edit_research_project(id));

create policy "fetched_pages_select_staff" on public.fetched_pages
  for select to authenticated
  using (private.has_role('admin', 'manager', 'buyer'));
create policy "fetched_pages_update_job" on public.fetched_pages
  for update to authenticated
  using (private.is_job_writer() and private.can_edit_research_project(project_id))
  with check (private.is_job_writer() and private.can_edit_research_project(project_id));

create policy "fingerprints_select_staff" on public.fingerprints
  for select to authenticated
  using (private.has_role('admin', 'manager', 'buyer'));
create policy "fingerprints_insert_job" on public.fingerprints
  for insert to authenticated
  with check (
    private.is_job_writer()
    and private.can_edit_research_project(project_id)
    and created_by = (select auth.uid())
  );
