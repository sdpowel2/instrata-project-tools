-- Prevent privilege escalation via self-service role changes.
--
-- The base "Users can update their own profile" policy (migration.sql) is
-- `for update using (id = auth.uid())` with NO with-check, and Postgres RLS
-- cannot compare the OLD row to the NEW row — so a normal member could run
--   update profiles set role = 'admin' where id = auth.uid()
-- straight through PostgREST and inherit is_admin() everywhere.
--
-- We close it with a BEFORE UPDATE trigger that freezes the `role` column for
-- ordinary end-user sessions. Admins keep the ability to change roles (the
-- Team Members UI depends on it), and trusted backend contexts — service role
-- and the dashboard SQL editor, where auth.uid() is null — are left alone so
-- the first admin can still be provisioned.

create or replace function public.enforce_profile_role_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null       -- real end-user session, not service role / SQL editor
     and not public.is_admin() then
    raise exception 'Only admins can change a profile role'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_profile_role_immutable on public.profiles;
create trigger enforce_profile_role_immutable
  before update on public.profiles
  for each row
  execute function public.enforce_profile_role_immutable();
