-- Offer ownership handover (e.g. when a buyer leaves): manager/admin only, audited.
--
-- owner_id has no client update grant, so this security definer function is the only way
-- to change it. The new owner must be an ACTIVE buyer, manager or admin (creatives can't
-- edit offers). The current owner may be inactive: that's the "someone left" case.
-- The offers audit trigger records the change as 'offer.reassign_owner' with before/after.

create function public.reassign_offer_owner(p_offer_id uuid, p_new_owner_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid;
  new_owner     public.profiles;
begin
  if (select auth.uid()) is null or not private.has_role('admin', 'manager') then
    raise exception 'Only managers and admins can reassign offers' using errcode = '42501';
  end if;

  select o.owner_id into current_owner from public.offers o where o.id = p_offer_id for update;
  if current_owner is null then
    raise exception 'Offer not found' using errcode = 'P0002';
  end if;

  select * into new_owner from public.profiles p where p.id = p_new_owner_id;
  if new_owner.id is null then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  if not new_owner.active or new_owner.role not in ('buyer', 'manager', 'admin') then
    raise exception 'The new owner must be an active buyer, manager or admin' using errcode = 'P0001';
  end if;

  if current_owner = p_new_owner_id then
    return p_offer_id; -- already theirs: nothing to change or audit
  end if;

  perform set_config('app.audit_action', 'offer.reassign_owner', true);
  update public.offers set owner_id = p_new_owner_id where id = p_offer_id;
  perform set_config('app.audit_action', '', true);

  return p_offer_id;
end;
$$;

revoke execute on function public.reassign_offer_owner(uuid, uuid) from public, anon;
grant execute on function public.reassign_offer_owner(uuid, uuid) to authenticated, service_role;
