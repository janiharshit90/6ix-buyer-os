-- M2 AI service: call log, budgets, reservation-based cap enforcement.
--
-- Write paths (Decisions log, M2):
--   ai_calls  written ONLY by public.begin_ai_call / public.finish_ai_call, which are
--             service-role only. The server verifies the session first, then calls them.
--             Authenticated users could otherwise post fake costs through PostgREST.
--   budgets   admins write through RLS with their own client (audited).
--
-- Money: caps are numeric(12,2) USD. Per-call cost and reservations are numeric(12,6):
-- a Haiku call costs a fraction of a cent, and rounding each call to cents would record
-- $0.00 and the cap would never fill.

create type public.ai_call_status as enum ('pending', 'succeeded', 'failed', 'blocked');
create type public.budget_scope as enum ('workspace', 'user');

create table public.ai_calls (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles (id) on delete restrict,
  project_id                  uuid, -- FK to research_projects added in M3
  subject_type                text check (subject_type ~ '^[a-z_]{1,50}$'),
  subject_id                  uuid,
  purpose                     text not null check (purpose ~ '^[a-z0-9_.-]{1,100}$'),
  model                       text not null check (char_length(model) between 1 and 100),
  prompt_version              text not null check (char_length(prompt_version) between 1 and 100),
  price_version               text not null check (char_length(price_version) between 1 and 50),
  status                      public.ai_call_status not null default 'pending',
  reserved_usd                numeric(12,6) not null default 0 check (reserved_usd >= 0),
  input_tokens                integer check (input_tokens >= 0),
  output_tokens               integer check (output_tokens >= 0),
  cache_read_input_tokens     integer check (cache_read_input_tokens >= 0),
  cache_creation_input_tokens integer check (cache_creation_input_tokens >= 0),
  cost_usd                    numeric(12,6) check (cost_usd >= 0),
  stop_reason                 text check (char_length(stop_reason) <= 50),
  error_code                  text check (char_length(error_code) <= 100),
  error_message               text check (char_length(error_message) <= 500),
  request_id                  text check (char_length(request_id) <= 200),
  latency_ms                  integer check (latency_ms >= 0),
  started_at                  timestamptz not null default now(),
  finished_at                 timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users (id) on delete set null,
  check ((subject_type is null) = (subject_id is null)),
  check ((status = 'pending') = (finished_at is null)),
  check (status = 'pending' or cost_usd is not null)
);
comment on table public.ai_calls is 'One row per AI call attempt (including budget-blocked ones). No prompt or output text is stored here.';
comment on column public.ai_calls.reserved_usd is 'Worst-case cost reserved before the call; counts against caps while pending.';
comment on column public.ai_calls.cost_usd is 'Actual cost, computed in code from the price table named in price_version.';
create index ai_calls_user_started_idx on public.ai_calls (user_id, started_at desc);
create index ai_calls_started_idx on public.ai_calls (started_at desc);
create index ai_calls_subject_idx on public.ai_calls (subject_type, subject_id) where subject_id is not null;
create index ai_calls_pending_idx on public.ai_calls (started_at) where status = 'pending';
create index ai_calls_created_by_idx on public.ai_calls (created_by);

create table public.budgets (
  id              uuid primary key default gen_random_uuid(),
  scope           public.budget_scope not null,
  scope_id        uuid references public.profiles (id) on delete cascade,
  monthly_cap_usd numeric(12,2) not null check (monthly_cap_usd >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  check ((scope = 'workspace') = (scope_id is null))
);
comment on table public.budgets is 'Monthly AI spend caps (UTC calendar months). The workspace row always applies; no workspace row = every AI call is blocked.';
create unique index budgets_one_workspace on public.budgets (scope) where scope = 'workspace';
create unique index budgets_one_per_user on public.budgets (scope_id) where scope = 'user';
create index budgets_created_by_idx on public.budgets (created_by);

-- Default dev cap (Decisions log). Hosted prod adjusts it in Settings.
insert into public.budgets (scope, scope_id, monthly_cap_usd) values ('workspace', null, 20.00);

create trigger ai_calls_set_updated_at before update on public.ai_calls
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
create trigger budgets_set_updated_at before update on public.budgets
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();

-- Cap changes are access-like decisions: audit them.
create trigger budgets_audit
  after insert or delete on public.budgets
  for each row execute function private.audit_row();
create trigger budgets_audit_update
  after update on public.budgets
  for each row when (old.* is distinct from new.*) execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- ai_calls guard (every role, service role included): a finished call is frozen,
-- and calls are never deleted. Only pending → succeeded/failed is allowed.
-- ---------------------------------------------------------------------------

create function private.ai_calls_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_calls rows cannot be deleted' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'Finished ai_calls rows are immutable' using errcode = '42501';
  end if;
  if new.user_id is distinct from old.user_id
     or new.purpose is distinct from old.purpose
     or new.prompt_version is distinct from old.prompt_version
     or new.price_version is distinct from old.price_version
     or new.reserved_usd is distinct from old.reserved_usd
     or new.started_at is distinct from old.started_at
     or new.project_id is distinct from old.project_id
     or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id then
    raise exception 'Only the outcome of an ai_calls row can change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ai_calls_guard
  before update or delete on public.ai_calls
  for each row execute function private.ai_calls_guard();
create trigger ai_calls_no_truncate
  before truncate on public.ai_calls
  for each statement execute function private.append_only();

-- ---------------------------------------------------------------------------
-- Spend helpers. "Spent" = finished costs + live reservations, this UTC month.
-- ---------------------------------------------------------------------------

create function private.ai_month_start()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
$$;

-- p_user_id NULL = whole workspace.
create function private.ai_month_spend(p_user_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when c.status = 'pending' then c.reserved_usd else c.cost_usd end), 0)
  from public.ai_calls c
  where c.started_at >= private.ai_month_start()
    and (p_user_id is null or c.user_id = p_user_id)
$$;

grant execute on function private.ai_month_start() to authenticated, service_role;
grant execute on function private.ai_month_spend(uuid) to service_role;

-- How long a reservation may stay pending before it is settled as abandoned.
create function private.ai_reservation_ttl()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '15 minutes' $$;

grant execute on function private.ai_reservation_ttl() to service_role;

-- ---------------------------------------------------------------------------
-- begin_ai_call: check caps and reserve, atomically. Service role only.
-- Returns {ok: true, call_id} or {ok: false, call_id, reason, scope, cap_usd, spent_usd,
-- reserve_usd, month_start}. A blocked attempt is still logged (status 'blocked').
-- ---------------------------------------------------------------------------

create function public.begin_ai_call(
  p_user_id        uuid,
  p_purpose        text,
  p_model          text,
  p_prompt_version text,
  p_price_version  text,
  p_reserve_usd    numeric,
  p_project_id     uuid default null,
  p_subject_type   text default null,
  p_subject_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month     timestamptz := private.ai_month_start();
  v_ws_cap    numeric;
  v_user_cap  numeric;
  v_spent     numeric;
  v_call_id   uuid;
  v_block     jsonb;
begin
  if p_reserve_usd is null or p_reserve_usd < 0 then
    raise exception 'reserve must be a non-negative amount' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and active) then
    raise exception 'AI calls need an active user' using errcode = '42501';
  end if;

  -- One workspace: one lock serialises every reservation, so concurrent calls can't
  -- all see the same headroom. Calls are seconds apart at most; contention is negligible.
  perform pg_advisory_xact_lock(hashtext('public.begin_ai_call'));

  -- Settle abandoned reservations (crash, timeout) conservatively at their reserved cost:
  -- we can't know what the provider billed, so never undercount.
  update public.ai_calls
  set status = 'failed', cost_usd = reserved_usd, finished_at = now(),
      error_code = 'abandoned', error_message = 'Reservation expired before the call finished.'
  where status = 'pending' and started_at < now() - private.ai_reservation_ttl();

  select monthly_cap_usd into v_ws_cap from public.budgets where scope = 'workspace';
  select monthly_cap_usd into v_user_cap from public.budgets where scope = 'user' and scope_id = p_user_id;

  if v_ws_cap is null then
    v_block := jsonb_build_object('reason', 'no_workspace_budget', 'scope', 'workspace');
  else
    v_spent := private.ai_month_spend(null);
    if v_spent + p_reserve_usd > v_ws_cap then
      v_block := jsonb_build_object('reason', 'cap_reached', 'scope', 'workspace',
        'cap_usd', v_ws_cap, 'spent_usd', round(v_spent, 2));
    elsif v_user_cap is not null then
      v_spent := private.ai_month_spend(p_user_id);
      if v_spent + p_reserve_usd > v_user_cap then
        v_block := jsonb_build_object('reason', 'cap_reached', 'scope', 'user',
          'cap_usd', v_user_cap, 'spent_usd', round(v_spent, 2));
      end if;
    end if;
  end if;

  insert into public.ai_calls (
    user_id, project_id, subject_type, subject_id, purpose, model, prompt_version,
    price_version, status, reserved_usd, cost_usd, finished_at, error_code, created_by
  ) values (
    p_user_id, p_project_id, p_subject_type, p_subject_id, p_purpose, p_model, p_prompt_version,
    p_price_version,
    case when v_block is null then 'pending' else 'blocked' end::public.ai_call_status,
    case when v_block is null then round(p_reserve_usd, 6) else 0 end,
    case when v_block is null then null else 0 end,
    case when v_block is null then null else now() end,
    v_block ->> 'reason',
    p_user_id
  )
  returning id into v_call_id;

  if v_block is null then
    return jsonb_build_object('ok', true, 'call_id', v_call_id);
  end if;
  return v_block || jsonb_build_object(
    'ok', false, 'call_id', v_call_id,
    'reserve_usd', round(p_reserve_usd, 6), 'month_start', v_month
  );
end;
$$;

revoke execute on function public.begin_ai_call(uuid, text, text, text, text, numeric, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_ai_call(uuid, text, text, text, text, numeric, uuid, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- finish_ai_call: settle a pending call with its outcome. Service role only.
-- Returns false if the call isn't pending (already settled or expired).
-- ---------------------------------------------------------------------------

create function public.finish_ai_call(
  p_call_id         uuid,
  p_status          public.ai_call_status,
  p_cost_usd        numeric,
  p_model           text default null,
  p_input_tokens    integer default null,
  p_output_tokens   integer default null,
  p_cache_read      integer default null,
  p_cache_creation  integer default null,
  p_stop_reason     text default null,
  p_error_code      text default null,
  p_error_message   text default null,
  p_request_id      text default null,
  p_latency_ms      integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'A call finishes as succeeded or failed' using errcode = '22023';
  end if;
  if p_cost_usd is null or p_cost_usd < 0 then
    raise exception 'cost must be a non-negative amount' using errcode = '22023';
  end if;

  update public.ai_calls
  set status = p_status,
      cost_usd = round(p_cost_usd, 6),
      model = coalesce(nullif(p_model, ''), model),
      input_tokens = p_input_tokens,
      output_tokens = p_output_tokens,
      cache_read_input_tokens = p_cache_read,
      cache_creation_input_tokens = p_cache_creation,
      stop_reason = left(p_stop_reason, 50),
      error_code = left(p_error_code, 100),
      error_message = left(p_error_message, 500),
      request_id = left(p_request_id, 200),
      latency_ms = p_latency_ms,
      finished_at = now()
  where id = p_call_id and status = 'pending';
  return found;
end;
$$;

revoke execute on function public.finish_ai_call(uuid, public.ai_call_status, numeric, text, integer, integer, integer, integer, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.finish_ai_call(uuid, public.ai_call_status, numeric, text, integer, integer, integer, integer, text, text, text, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- ai_budget_status: the caller's view of this month. Any active user.
-- Workspace total is an aggregate (no per-user detail); per-user detail stays behind RLS.
-- ---------------------------------------------------------------------------

create function public.ai_budget_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if private.current_user_role() is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'month_start', private.ai_month_start(),
    'workspace_cap_usd', (select monthly_cap_usd from public.budgets where scope = 'workspace'),
    'workspace_spent_usd', round(private.ai_month_spend(null), 2),
    'user_cap_usd', (select monthly_cap_usd from public.budgets where scope = 'user' and scope_id = v_uid),
    'user_spent_usd', round(private.ai_month_spend(v_uid), 2)
  );
end;
$$;

revoke execute on function public.ai_budget_status() from public, anon;
grant execute on function public.ai_budget_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Usage view for Settings (security_invoker: ai_calls RLS applies, so buyers see
-- only their own rows and managers/admins see everyone's).
-- ---------------------------------------------------------------------------

create view public.ai_usage_monthly
with (security_invoker = true)
as
select
  date_trunc('month', c.started_at at time zone 'UTC') at time zone 'UTC' as month_start,
  c.user_id,
  c.purpose,
  c.model,
  count(*)::integer                                         as calls,
  count(*) filter (where c.status = 'succeeded')::integer   as succeeded,
  count(*) filter (where c.status = 'failed')::integer      as failed,
  count(*) filter (where c.status = 'blocked')::integer     as blocked,
  count(*) filter (where c.status = 'pending')::integer     as pending,
  coalesce(sum(c.cost_usd), 0)::numeric(12,6)               as cost_usd,
  coalesce(sum(c.reserved_usd) filter (where c.status = 'pending'), 0)::numeric(12,6) as reserved_usd,
  coalesce(sum(c.input_tokens), 0)::bigint                  as input_tokens,
  coalesce(sum(c.output_tokens), 0)::bigint                 as output_tokens
from public.ai_calls c
group by 1, 2, 3, 4;

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------

revoke all on public.ai_calls, public.budgets, public.ai_usage_monthly from anon, authenticated;
grant select on public.ai_calls to authenticated;
grant select on public.ai_usage_monthly to authenticated;
grant select, delete on public.budgets to authenticated;
grant insert (scope, scope_id, monthly_cap_usd), update (monthly_cap_usd) on public.budgets to authenticated;

alter table public.ai_calls enable row level security;
alter table public.budgets enable row level security;

-- Own calls (active users), or everyone's for managers/admins.
create policy "ai_calls_select_own_or_managers" on public.ai_calls
  for select to authenticated
  using (
    private.current_user_role() is not null
    and (user_id = (select auth.uid()) or private.has_role('admin', 'manager'))
  );

-- Workspace cap: every active user. User caps: the user themself, managers, admins.
create policy "budgets_select" on public.budgets
  for select to authenticated
  using (
    private.current_user_role() is not null
    and (scope = 'workspace' or scope_id = (select auth.uid()) or private.has_role('admin', 'manager'))
  );

create policy "budgets_insert_admin" on public.budgets
  for insert to authenticated
  with check (private.has_role('admin'));

create policy "budgets_update_admin" on public.budgets
  for update to authenticated
  using (private.has_role('admin'))
  with check (private.has_role('admin'));

create policy "budgets_delete_admin" on public.budgets
  for delete to authenticated
  using (private.has_role('admin'));
