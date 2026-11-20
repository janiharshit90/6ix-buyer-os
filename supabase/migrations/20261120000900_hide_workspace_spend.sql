-- PR #12 review: buyers (and creatives) don't see the workspace's total spend amount.
-- ai_budget_status returns workspace_spent_usd only to managers/admins; everyone else gets
-- NULL plus a boolean saying whether the team budget still has room. Enforced here, not
-- just hidden in the UI.

create or replace function public.ai_budget_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_team    boolean := private.has_role('admin', 'manager');
  v_ws_cap  numeric;
  v_ws_used numeric;
begin
  if private.current_user_role() is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select monthly_cap_usd into v_ws_cap from public.budgets where scope = 'workspace';
  v_ws_used := private.ai_month_spend(null);

  return jsonb_build_object(
    'month_start', private.ai_month_start(),
    'workspace_cap_usd', case when v_team then v_ws_cap end,
    'workspace_spent_usd', case when v_team then round(v_ws_used, 2) end,
    'workspace_budget_available', v_ws_cap is not null and v_ws_used < v_ws_cap,
    'user_cap_usd', (select monthly_cap_usd from public.budgets where scope = 'user' and scope_id = v_uid),
    'user_spent_usd', round(private.ai_month_spend(v_uid), 2)
  );
end;
$$;

revoke execute on function public.ai_budget_status() from public, anon;
grant execute on function public.ai_budget_status() to authenticated;
