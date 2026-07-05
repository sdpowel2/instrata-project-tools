-- Low-severity hardening from the security audit.
--
-- 1) project_code_counters had no RLS. Enable it with no policy so no client
--    role can read or tamper with the counter directly (worst case was
--    duplicate/again project codes). The only callers are generate_project_code
--    and seed_project_code_counter, which we make SECURITY DEFINER below so they
--    keep working regardless of the caller's role (the two Monday edge functions
--    use the service role, which bypasses RLS anyway).
--
-- 2) Pin search_path on the SECURITY DEFINER functions. A definer function
--    without a pinned search_path is a latent privilege-escalation vector (a
--    malicious same-named object on the caller's search_path could be resolved
--    inside the elevated context). is_project_member was the one definer
--    function missing this hardening; the counter functions get it as part of
--    becoming definer.

-- ── project_code_counters: lock direct access ───────────────────────────────
alter table public.project_code_counters enable row level security;
-- No policy on purpose: only the SECURITY DEFINER functions below may touch it.

-- ── generate_project_code: definer + pinned search_path ──────────────────────
create or replace function public.generate_project_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from now())::int;
  v_next int;
begin
  insert into public.project_code_counters (year, last_seq)
  values (v_year, 1)
  on conflict (year) do update
    set last_seq = public.project_code_counters.last_seq + 1
  returning last_seq into v_next;

  return 'INST-' || v_year || '-' || lpad(v_next::text, 4, '0');
end;
$$;

-- ── seed_project_code_counter: definer + pinned search_path ──────────────────
create or replace function public.seed_project_code_counter(p_year int, p_min_seq int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_code_counters (year, last_seq)
  values (p_year, p_min_seq)
  on conflict (year) do update
    set last_seq = greatest(public.project_code_counters.last_seq, p_min_seq);
end;
$$;

-- ── is_project_member: add the missing search_path pin ───────────────────────
-- Same body as the base schema, only adding `set search_path = public`.
create or replace function public.is_project_member(_project_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  )
  or exists (
    select 1 from public.projects where id = _project_id and created_by = auth.uid()
  )
  or exists (
    select 1 from public.project_members where project_id = _project_id and user_id = auth.uid()
  );
$$;
