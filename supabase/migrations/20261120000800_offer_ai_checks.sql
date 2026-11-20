-- M2 offer AI check results.
--
-- One row per successful check of a SAVED offer version: code rule findings + AI suggestions.
-- Suggestions only: nothing here ever edits the offer.
-- Written only by the server (service role) right after the AI call it came from succeeds,
-- so clients can't forge findings. Append-only. Creatives can't read it: findings may
-- mention payout and targets (economics).

create table public.offer_ai_checks (
  id               uuid primary key default gen_random_uuid(),
  offer_version_id uuid not null references public.offer_versions (id) on delete cascade,
  ai_call_id       uuid not null unique references public.ai_calls (id) on delete restrict,
  prompt_version   text not null check (char_length(prompt_version) between 1 and 100),
  model            text not null check (char_length(model) between 1 and 100),
  rule_findings    jsonb not null check (jsonb_typeof(rule_findings) = 'array'),
  ai_findings      jsonb not null check (jsonb_typeof(ai_findings) = 'array'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid not null references public.profiles (id) on delete restrict
);
comment on table public.offer_ai_checks is 'Offer intake check results (code rules + AI suggestions). Append-only; never edits the offer.';
create index offer_ai_checks_version_idx on public.offer_ai_checks (offer_version_id, created_at desc);
create index offer_ai_checks_created_by_idx on public.offer_ai_checks (created_by);

-- Append-only, except the cascade when a draft version is discarded.
create function private.offer_ai_checks_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'offer_ai_checks rows are immutable' using errcode = '42501';
  end if;
  -- DELETE: allowed only as part of deleting the (draft) version itself.
  if exists (select 1 from public.offer_versions where id = old.offer_version_id) then
    raise exception 'offer_ai_checks rows are deleted only with their draft version'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

create trigger offer_ai_checks_guard
  before update or delete on public.offer_ai_checks
  for each row execute function private.offer_ai_checks_guard();
create trigger offer_ai_checks_no_truncate
  before truncate on public.offer_ai_checks
  for each statement execute function private.append_only();

-- The server inserts with the service role; this keeps it honest anyway:
-- the call must be a succeeded call by the same user, about this version.
create function private.offer_ai_checks_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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

create trigger offer_ai_checks_before_insert
  before insert on public.offer_ai_checks
  for each row execute function private.offer_ai_checks_before_insert();

revoke all on public.offer_ai_checks from anon, authenticated;
grant select on public.offer_ai_checks to authenticated;

alter table public.offer_ai_checks enable row level security;

create policy "offer_ai_checks_select_staff" on public.offer_ai_checks
  for select to authenticated
  using (
    private.has_role('admin', 'manager', 'buyer')
    and private.can_read_offer_version(offer_version_id)
  );
