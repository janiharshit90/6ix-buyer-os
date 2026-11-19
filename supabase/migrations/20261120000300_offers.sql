-- M1 offers: advertisers, offers, versioned offer facts, economics and URLs.
--
-- Shape (see CLAUDE.md §5 and the M1 Decisions-log lines):
--   offers 1─* offer_versions 1─1 offer_version_economics   (payout tiers, targets: hidden from creatives)
--                             1─* offer_urls
-- A version is `draft` until a manager/admin approves it (public.approve_offer_version).
-- Approved versions, and their economics and URLs, can't be changed or deleted by anyone.
-- Editing an approved offer = public.create_draft_from_approved → version n+1.
-- Unknown values are NULL (Non-negotiable #1), never a guessed default.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.payout_model as enum ('cpl', 'cpql', 'cpa', 'revshare', 'ppc');
create type public.cap_counts as enum ('submissions', 'qualified', 'billable', 'calls');
create type public.cap_period as enum ('day', 'week', 'month', 'total');
create type public.offer_status as enum ('active', 'paused', 'archived');
create type public.offer_version_status as enum ('draft', 'approved');
create type public.offer_url_kind as enum ('our_lander', 'offer_page', 'preview', 'competitor_lander', 'other');

-- ---------------------------------------------------------------------------
-- Shape checks used by CHECK constraints (pure functions of their input).
-- ---------------------------------------------------------------------------

create function private.us_state_codes()
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array[
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS',
    'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC',
    'ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
  ]::text[]
$$;

-- 50 states + DC, no duplicates.
create function private.valid_states(states text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select states <@ private.us_state_codes()
    and cardinality(states) = (select count(distinct s) from unnest(states) s)
$$;

-- {timezone: text, days: {mon..sun: [{start, end}]}}. Timezone validity is checked by Zod
-- (pg_timezone_names isn't immutable, so it can't back a CHECK constraint).
create function private.valid_call_hours(hours jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_typeof(hours) = 'object'
    and jsonb_typeof(hours -> 'timezone') = 'string'
    and jsonb_typeof(hours -> 'days') = 'object'
    and not exists (
      select 1 from jsonb_object_keys(hours -> 'days') k
      where k not in ('mon','tue','wed','thu','fri','sat','sun')
    )
$$;

-- {banned_claims: text[], banned_words: text[], notes: text|null}
create function private.valid_restrictions(r jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_typeof(r) = 'object'
    and jsonb_typeof(coalesce(r -> 'banned_claims', '[]')) = 'array'
    and jsonb_typeof(coalesce(r -> 'banned_words', '[]')) = 'array'
    and jsonb_typeof(coalesce(r -> 'notes', 'null')) in ('string', 'null')
$$;

-- [{label, amount_usd, condition}]
create function private.valid_payout_tiers(tiers jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_typeof(tiers) = 'array'
    and not exists (
      select 1 from jsonb_array_elements(tiers) t
      where jsonb_typeof(t) <> 'object'
         or jsonb_typeof(t -> 'label') <> 'string'
         or jsonb_typeof(coalesce(t -> 'amount_usd', 'null')) not in ('number', 'null')
         or jsonb_typeof(coalesce(t -> 'condition', 'null')) not in ('string', 'null')
    )
$$;

grant execute on function private.us_state_codes() to authenticated, service_role;
grant execute on function private.valid_states(text[]) to authenticated, service_role;
grant execute on function private.valid_call_hours(jsonb) to authenticated, service_role;
grant execute on function private.valid_restrictions(jsonb) to authenticated, service_role;
grant execute on function private.valid_payout_tiers(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.advertisers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 200),
  network    text check (char_length(network) <= 200),
  notes      text check (char_length(notes) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null
);
create unique index advertisers_name_key on public.advertisers (lower(btrim(name)));
create index advertisers_created_by_idx on public.advertisers (created_by);

create table public.offers (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid() references public.profiles (id) on delete restrict,
  advertiser_id      uuid references public.advertisers (id) on delete restrict,
  name               text not null check (char_length(btrim(name)) between 1 and 200),
  vertical           text check (char_length(vertical) <= 100),
  status             public.offer_status not null default 'active',
  current_version_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid default auth.uid() references auth.users (id) on delete set null
);
comment on column public.offers.current_version_id is 'Latest APPROVED version. Set only by public.approve_offer_version.';
create index offers_owner_id_idx on public.offers (owner_id);
create index offers_advertiser_id_idx on public.offers (advertiser_id);
create index offers_created_by_idx on public.offers (created_by);

create table public.offer_versions (
  id                  uuid primary key default gen_random_uuid(),
  offer_id            uuid not null references public.offers (id) on delete restrict,
  version             integer not null check (version >= 1),
  payout_model        public.payout_model,
  states              text[] check (states is null or private.valid_states(states)),
  cap_amount          integer check (cap_amount >= 0),
  cap_counts          public.cap_counts,
  cap_period          public.cap_period,
  call_hours          jsonb check (call_hours is null or private.valid_call_hours(call_hours)),
  optimisation_event  text check (char_length(optimisation_event) <= 200),
  feedback_delay_days integer check (feedback_delay_days between 0 and 365),
  restrictions        jsonb check (restrictions is null or private.valid_restrictions(restrictions)),
  approval_required   boolean,
  status              public.offer_version_status not null default 'draft',
  approved_by         uuid references public.profiles (id) on delete restrict,
  approved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  unique (offer_id, version),
  unique (offer_id, id),
  check ((status = 'approved') = (approved_by is not null and approved_at is not null))
);
comment on column public.offer_versions.approval_required is 'The network must approve us before we can run the offer. NULL = unknown.';
comment on column public.offer_versions.cap_amount is 'Cap size, counted in cap_counts units per cap_period.';
create unique index offer_versions_one_draft_per_offer on public.offer_versions (offer_id) where status = 'draft';
create index offer_versions_approved_by_idx on public.offer_versions (approved_by);
create index offer_versions_created_by_idx on public.offer_versions (created_by);

-- current_version_id must point at a version of the SAME offer.
alter table public.offers
  add constraint offers_current_version_fkey
  foreign key (id, current_version_id) references public.offer_versions (offer_id, id);
create index offers_current_version_id_idx on public.offers (current_version_id);

create table public.offer_version_economics (
  id               uuid primary key default gen_random_uuid(),
  offer_version_id uuid not null unique references public.offer_versions (id) on delete cascade,
  payout_tiers     jsonb check (payout_tiers is null or private.valid_payout_tiers(payout_tiers)),
  target_cpl       numeric(12,2) check (target_cpl >= 0),
  target_roi       numeric(6,2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null
);
comment on table public.offer_version_economics is 'Economics for one offer version. Creatives can never read this table (RLS).';
comment on column public.offer_version_economics.target_roi is 'Percent, e.g. 30.00 = 30%.';
create index offer_version_economics_created_by_idx on public.offer_version_economics (created_by);

create table public.offer_urls (
  id               uuid primary key default gen_random_uuid(),
  offer_version_id uuid not null references public.offer_versions (id) on delete cascade,
  url              text not null check (url ~* '^https?://[^\s]+$' and char_length(url) <= 2048),
  kind             public.offer_url_kind not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  unique (offer_version_id, url)
);
create index offer_urls_created_by_idx on public.offer_urls (created_by);

-- Only bump updated_at on a real change (saves re-submit unchanged forms).
create trigger advertisers_set_updated_at before update on public.advertisers
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
create trigger offers_set_updated_at before update on public.offers
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
create trigger offer_versions_set_updated_at before update on public.offer_versions
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
create trigger offer_version_economics_set_updated_at before update on public.offer_version_economics
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
create trigger offer_urls_set_updated_at before update on public.offer_urls
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Permission helpers (security definer: read offers without recursing into RLS).
-- ---------------------------------------------------------------------------

-- Admin/manager: any offer. Buyer: offers they own. Everyone else (creative, inactive): none.
create function private.can_edit_offer(target_offer_id uuid)
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
        select 1 from public.offers o
        where o.id = target_offer_id and o.owner_id = (select auth.uid())
      )
    )
$$;

create function private.version_offer_id(target_version_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select offer_id from public.offer_versions where id = target_version_id
$$;

create function private.version_status(target_version_id uuid)
returns public.offer_version_status
language sql
stable
security definer
set search_path = ''
as $$
  select status from public.offer_versions where id = target_version_id
$$;

-- Admin/manager/buyer: every version. Creative: approved versions only.
create function private.can_read_offer_version(target_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_role('admin', 'manager', 'buyer')
    or (private.has_role('creative') and private.version_status(target_version_id) = 'approved')
$$;

create function private.can_edit_offer_version(target_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.version_status(target_version_id) = 'draft'
    and private.can_edit_offer(private.version_offer_id(target_version_id))
$$;

grant execute on function private.can_edit_offer(uuid) to authenticated, service_role;
grant execute on function private.version_offer_id(uuid) to authenticated, service_role;
grant execute on function private.version_status(uuid) to authenticated, service_role;
grant execute on function private.can_read_offer_version(uuid) to authenticated, service_role;
grant execute on function private.can_edit_offer_version(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Versioning + immutability triggers. These apply to EVERY role, service role included.
-- ---------------------------------------------------------------------------

-- New versions: next number for the offer, always a draft. Locks the offer row so two
-- concurrent inserts can't pick the same number (the unique index is the backstop).
create function private.offer_versions_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.offers where id = new.offer_id for update;
  select coalesce(max(v.version), 0) + 1 into new.version
  from public.offer_versions v where v.offer_id = new.offer_id;
  new.status := 'draft';
  new.approved_by := null;
  new.approved_at := null;
  return new;
end;
$$;

create trigger offer_versions_before_insert
  before insert on public.offer_versions
  for each row execute function private.offer_versions_before_insert();

-- Approved = frozen. The only allowed status change is draft → approved, and only from
-- inside public.approve_offer_version (which sets app.approving_version for that row).
create function private.offer_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      raise exception 'Approved offer versions cannot be deleted' using errcode = '42501';
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

grant execute on function private.offer_versions_guard() to authenticated, service_role;

create trigger offer_versions_guard
  before update or delete on public.offer_versions
  for each row execute function private.offer_versions_guard();

-- Economics and URLs follow their version: writable only while it's a draft.
-- (During a cascade delete of a draft version the parent is already gone: status is NULL.)
create function private.offer_version_child_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE')
     and private.version_status(old.offer_version_id) = 'approved' then
    raise exception '% of an approved offer version are immutable', tg_table_name
      using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE')
     and private.version_status(new.offer_version_id) = 'approved' then
    raise exception '% of an approved offer version are immutable', tg_table_name
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger offer_version_economics_guard
  before insert or update or delete on public.offer_version_economics
  for each row execute function private.offer_version_child_guard();
create trigger offer_urls_guard
  before insert or update or delete on public.offer_urls
  for each row execute function private.offer_version_child_guard();

-- offers.current_version_id may only point at an approved version.
create function private.offers_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.current_version_id is not null
     and new.current_version_id is distinct from old.current_version_id
     and private.version_status(new.current_version_id) is distinct from 'approved' then
    raise exception 'current_version_id must be an approved version' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger offers_guard
  before update on public.offers
  for each row execute function private.offers_guard();

-- ---------------------------------------------------------------------------
-- Privileges. Clients never write ids, owners, versions, statuses or approval stamps.
-- ---------------------------------------------------------------------------

revoke all on public.advertisers, public.offers, public.offer_versions,
  public.offer_version_economics, public.offer_urls from anon, authenticated;

grant select on public.advertisers to authenticated;
grant insert (name, network, notes), update (name, network, notes) on public.advertisers to authenticated;

grant select on public.offers to authenticated;
grant insert (advertiser_id, name, vertical, status),
      update (advertiser_id, name, vertical, status) on public.offers to authenticated;

grant select, delete on public.offer_versions to authenticated;
grant insert (offer_id, payout_model, states, cap_amount, cap_counts, cap_period, call_hours,
              optimisation_event, feedback_delay_days, restrictions, approval_required)
  on public.offer_versions to authenticated;
grant update (payout_model, states, cap_amount, cap_counts, cap_period, call_hours,
              optimisation_event, feedback_delay_days, restrictions, approval_required)
  on public.offer_versions to authenticated;

grant select, delete on public.offer_version_economics to authenticated;
grant insert (offer_version_id, payout_tiers, target_cpl, target_roi),
      update (payout_tiers, target_cpl, target_roi) on public.offer_version_economics to authenticated;

grant select, delete on public.offer_urls to authenticated;
grant insert (offer_version_id, url, kind), update (url, kind) on public.offer_urls to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.advertisers enable row level security;
alter table public.offers enable row level security;
alter table public.offer_versions enable row level security;
alter table public.offer_version_economics enable row level security;
alter table public.offer_urls enable row level security;

-- advertisers: no economics; every active user reads. Buyers+ create; creator or manager/admin edits.
create policy "advertisers_select_active" on public.advertisers
  for select to authenticated
  using (private.current_user_role() is not null);
create policy "advertisers_insert_buyers" on public.advertisers
  for insert to authenticated
  with check (private.has_role('admin', 'manager', 'buyer') and created_by = (select auth.uid()));
create policy "advertisers_update_creator_or_manager" on public.advertisers
  for update to authenticated
  using (private.has_role('admin', 'manager') or (private.has_role('buyer') and created_by = (select auth.uid())))
  with check (private.has_role('admin', 'manager') or (private.has_role('buyer') and created_by = (select auth.uid())));

-- offers: buyers+ read all (team learning); creatives read offers that have an approved version.
create policy "offers_select" on public.offers
  for select to authenticated
  using (
    private.has_role('admin', 'manager', 'buyer')
    or (private.has_role('creative') and current_version_id is not null)
  );
create policy "offers_insert_own" on public.offers
  for insert to authenticated
  with check (private.has_role('admin', 'manager', 'buyer') and owner_id = (select auth.uid()));
create policy "offers_update_editors" on public.offers
  for update to authenticated
  using (private.can_edit_offer(id))
  with check (private.can_edit_offer(id));
-- No delete: offers are archived (status), never deleted.

create policy "offer_versions_select" on public.offer_versions
  for select to authenticated
  using (
    private.has_role('admin', 'manager', 'buyer')
    or (private.has_role('creative') and status = 'approved')
  );
create policy "offer_versions_insert_editors" on public.offer_versions
  for insert to authenticated
  with check (private.can_edit_offer(offer_id));
create policy "offer_versions_update_drafts" on public.offer_versions
  for update to authenticated
  using (status = 'draft' and private.can_edit_offer(offer_id))
  with check (status = 'draft' and private.can_edit_offer(offer_id));
create policy "offer_versions_delete_drafts" on public.offer_versions
  for delete to authenticated
  using (status = 'draft' and private.can_edit_offer(offer_id));

-- economics: never creatives.
create policy "offer_version_economics_select" on public.offer_version_economics
  for select to authenticated
  using (private.has_role('admin', 'manager', 'buyer'));
create policy "offer_version_economics_insert" on public.offer_version_economics
  for insert to authenticated
  with check (private.can_edit_offer_version(offer_version_id));
create policy "offer_version_economics_update" on public.offer_version_economics
  for update to authenticated
  using (private.can_edit_offer_version(offer_version_id))
  with check (private.can_edit_offer_version(offer_version_id));
create policy "offer_version_economics_delete" on public.offer_version_economics
  for delete to authenticated
  using (private.can_edit_offer_version(offer_version_id));

create policy "offer_urls_select" on public.offer_urls
  for select to authenticated
  using (private.can_read_offer_version(offer_version_id));
create policy "offer_urls_insert" on public.offer_urls
  for insert to authenticated
  with check (private.can_edit_offer_version(offer_version_id));
create policy "offer_urls_update" on public.offer_urls
  for update to authenticated
  using (private.can_edit_offer_version(offer_version_id))
  with check (private.can_edit_offer_version(offer_version_id));
create policy "offer_urls_delete" on public.offer_urls
  for delete to authenticated
  using (private.can_edit_offer_version(offer_version_id));

-- ---------------------------------------------------------------------------
-- Buyer/manager read model: versions + economics in one row.
-- security_invoker: the caller's RLS applies to both tables. Creatives get zero rows
-- (not rows with NULL economics, which would read as "unknown").
-- ---------------------------------------------------------------------------

create view public.offer_versions_with_economics
with (security_invoker = true)
as
select
  v.*,
  e.payout_tiers,
  e.target_cpl,
  e.target_roi
from public.offer_versions v
left join public.offer_version_economics e on e.offer_version_id = v.id
where private.has_role('admin', 'manager', 'buyer');

revoke all on public.offer_versions_with_economics from anon, authenticated;
grant select on public.offer_versions_with_economics to authenticated;
