-- Tighten INSERT-side RLS gaps found in the security audit.
--
-- 1) review_runs / review_flags had `for insert with check (true)`, letting
--    ANY authenticated user fabricate review runs and flags against any
--    project. Nothing in the app inserts these client-side (the UI only reads
--    and resolves/waives them); the auto-reviewer writes via the service role,
--    which bypasses RLS entirely. So restrict the authenticated INSERT path to
--    admins and the fabrication vector closes with no functional impact.
--
-- 2) ms_graph_tokens / personal_ops_email_flags use `for all using (...)` with
--    no explicit `with check`. Postgres reuses the USING expression as the
--    WITH CHECK when it's omitted, so these were almost certainly already
--    constrained — but we make the check explicit so the write-side guard
--    doesn't depend on that implicit behavior. These tables hold plaintext
--    Microsoft Graph tokens, so an unconstrained write would be serious.

-- ── 1) review_runs / review_flags: admin-only INSERT ─────────────────────────
drop policy if exists "runs_insert" on public.review_runs;
create policy "runs_insert" on public.review_runs for insert
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop policy if exists "flags_insert" on public.review_flags;
create policy "flags_insert" on public.review_flags for insert
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ── 2) ms_graph_tokens / personal_ops_email_flags: explicit WITH CHECK ───────
drop policy if exists "tokens_admin_own" on public.ms_graph_tokens;
create policy "tokens_admin_own" on public.ms_graph_tokens for all
  using (
    auth.uid() = user_id
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "email_flags_admin_own" on public.personal_ops_email_flags;
create policy "email_flags_admin_own" on public.personal_ops_email_flags for all
  using (
    auth.uid() = user_id
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );
