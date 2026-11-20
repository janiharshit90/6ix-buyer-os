-- M1 offer write paths, as RPCs so each is one transaction.
--
--   save_offer_draft           security INVOKER: the caller's RLS + grants apply to every write.
--   create_draft_from_approved security INVOKER: copies the latest approved version (+ economics, URLs).
--   approve_offer_version      security DEFINER: the status change has no client grant, so this
--                              re-checks the role itself (manager/admin only).

-- p_offer:     {name, vertical, status, advertiser_id, advertiser_name}
-- p_version:   editable offer_versions columns
-- p_economics: {payout_tiers, target_cpl, target_roi}
-- p_urls:      [{url, kind}]
-- p_offer_id NULL = new offer (+ version 1 draft). Otherwise saves the offer's open draft.
-- Every parameter has a default so API callers can omit p_offer_id for a new offer
-- (PostgREST matches functions by the argument names it is sent).
create function public.save_offer_draft(
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

  insert into public.offer_urls (offer_version_id, url, kind)
  select v_version_id, btrim(x ->> 'url'), (x ->> 'kind')::public.offer_url_kind
  from jsonb_array_elements(v_urls) x
  on conflict (offer_version_id, url) do update
  set kind = excluded.kind;

  return jsonb_build_object('offer_id', v_offer_id, 'version_id', v_version_id);
end;
$$;

-- Returns the offer's open draft, creating it (version n+1, copied from the latest approved
-- version with its economics and URLs) if there isn't one.
create function public.create_draft_from_approved(p_offer_id uuid)
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

  insert into public.offer_urls (offer_version_id, url, kind)
  select v_draft_id, u.url, u.kind
  from public.offer_urls u
  where u.offer_version_id = src.id;

  return v_draft_id;
end;
$$;

-- Manager/admin approves a draft: freezes it, makes it the offer's current version, and
-- records the decision in approvals + audit_log, all in one transaction.
create function public.approve_offer_version(p_version_id uuid, p_note text default null)
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

revoke execute on function public.save_offer_draft(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon;
revoke execute on function public.create_draft_from_approved(uuid) from public, anon;
revoke execute on function public.approve_offer_version(uuid, text) from public, anon;
grant execute on function public.save_offer_draft(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.create_draft_from_approved(uuid) to authenticated, service_role;
grant execute on function public.approve_offer_version(uuid, text) to authenticated, service_role;
