-- M0 foundation: shared schema objects every later table builds on.

-- `private` holds helper functions used by RLS policies and triggers.
-- It is NOT listed in config.toml [api].schemas, so the Data API never exposes it.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Functions are executable by PUBLIC by default; make every grant explicit instead.
alter default privileges in schema private revoke execute on functions from public;

-- Application roles (CLAUDE.md §4).
create type public.app_role as enum ('admin', 'manager', 'buyer', 'creative');

-- Keeps updated_at current. Attach to every table with:
--   create trigger <table>_set_updated_at before update on public.<table>
--   for each row execute function private.set_updated_at();
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
