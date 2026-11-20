-- M3: buyers mark an offer_page URL as "not a tracking link" before it may be fetched
-- (Decisions log: fetch policy). Versioned with the offer like every other URL fact:
-- approved URLs stay immutable (offer_version_child_guard), and new drafts copy the flag.

alter table public.offer_urls
  add column not_tracking_link boolean not null default false;
comment on column public.offer_urls.not_tracking_link is
  'Buyer confirmed this URL is a direct page, not an affiliate tracking link. Only offer_page URLs need it to be fetched.';

grant insert (not_tracking_link), update (not_tracking_link) on public.offer_urls to authenticated;

-- Same functions as 20261120000500, now reading/copying not_tracking_link.
-- p_urls: [{url, kind, not_tracking_link}]

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
    select a.id into v_adv_id from public.advertisers a where lower(btrim(a.name)) = lower(v_adv_name);
    if v_adv_id is null then
      insert into public.advertisers (name) values (v_adv_name) returning id into v_adv_id;
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
  select v_version_id, btrim(x ->> 'url'), (x ->> 'kind')::public.offer_url_kind,
         coalesce((x ->> 'not_tracking_link')::boolean, false)
  from jsonb_array_elements(v_urls) x
  on conflict (offer_version_id, url) do update
  set kind = excluded.kind, not_tracking_link = excluded.not_tracking_link;

  return jsonb_build_object('offer_id', v_offer_id, 'version_id', v_version_id);
end;
$$;

create or replace function public.create_draft_from_approved(p_offer_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_draft_id uuid;
  src        public.offer_versions;
begin
  if not private.can_edit_offer(p_offer_id) then
    raise exception 'You can''t edit this offer' using errcode = '42501';
  end if;

  select v.id into v_draft_id
  from public.offer_versions v
  where v.offer_id = p_offer_id and v.status = 'draft';
  if v_draft_id is not null then
    return v_draft_id;
  end if;

  select v.* into src
  from public.offer_versions v
  where v.offer_id = p_offer_id and v.status = 'approved'
  order by v.version desc
  limit 1;
  if src.id is null then
    raise exception 'This offer has no approved version to copy' using errcode = 'P0002';
  end if;

  insert into public.offer_versions (
    offer_id, payout_model, states, cap_amount, cap_counts, cap_period, call_hours,
    optimisation_event, feedback_delay_days, restrictions, approval_required
  ) values (
    src.offer_id, src.payout_model, src.states, src.cap_amount, src.cap_counts, src.cap_period,
    src.call_hours, src.optimisation_event, src.feedback_delay_days, src.restrictions,
    src.approval_required
  )
  returning id into v_draft_id;

  insert into public.offer_version_economics (offer_version_id, payout_tiers, target_cpl, target_roi)
  select v_draft_id, e.payout_tiers, e.target_cpl, e.target_roi
  from public.offer_version_economics e
  where e.offer_version_id = src.id;

  insert into public.offer_urls (offer_version_id, url, kind, not_tracking_link)
  select v_draft_id, u.url, u.kind, u.not_tracking_link
  from public.offer_urls u
  where u.offer_version_id = src.id;

  return v_draft_id;
end;
$$;

revoke execute on function public.save_offer_draft(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon;
revoke execute on function public.create_draft_from_approved(uuid) from public, anon;
grant execute on function public.save_offer_draft(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.create_draft_from_approved(uuid) to authenticated, service_role;
