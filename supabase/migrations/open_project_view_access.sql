-- Open VIEW-only access to all project-scoped data for every authenticated user.
--
-- Background: open_project_visibility.sql made every *project* row visible
-- org-wide, but the child tables (BoM, submittals, RFIs, closeout, purchasing,
-- milestones, etc.) still gated SELECT behind is_project_member(). So a user
-- who wasn't on the project team saw an empty project — including the DTools
-- sync items (project_bom_items) once a sync completed. Admins never noticed
-- because is_project_member() short-circuits true for admins.
--
-- Desired model (matches our Monday security parameters): any authenticated
-- user gets read-only access to everything at the project level. Writes stay
-- gated to project-team members. Users self-add to a team via the "Add me"
-- button (allow_self_add_to_project.sql), after which the existing
-- "Members can manage ..." FOR ALL policies let them modify.
--
-- This migration only touches SELECT policies. The "... can manage ..." FOR ALL
-- policies are left untouched, so INSERT/UPDATE/DELETE remain member-gated.
-- (Those FOR ALL policies also grant SELECT to members, but that's now a
-- redundant subset of the open SELECT policies below — harmless.)
--
-- Resilience: each table is guarded with to_regclass() so this runs cleanly no
-- matter which feature migrations have been applied to a given environment
-- (e.g. a DB without add_quick_start_guide.sql simply skips those tables).
-- Both the old and new policy names are dropped first, so the migration is
-- fully idempotent and can be re-run safely.

-- ---------- project child tables (uniform: open SELECT to authenticated) ----------

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('project_bom_items',                'Members can view bom items',              'Authenticated users can view bom items'),
      ('submittals',                       'Members can view submittals',             'Authenticated users can view submittals'),
      ('submittal_items',                  'Members can view submittal items',        'Authenticated users can view submittal items'),
      ('rfis',                             'Members can view rfis',                   'Authenticated users can view rfis'),
      ('closeout_packages',                'Members can view closeout packages',      'Authenticated users can view closeout packages'),
      ('warranties',                       'Members can view warranties',             'Authenticated users can view warranties'),
      ('punch_items',                      'Members can view punch items',            'Authenticated users can view punch items'),
      ('sign_off_sheets',                  'Members can view sign off sheets',        'Authenticated users can view sign off sheets'),
      ('as_built_drawings',                'Members can view as-built drawings',      'Authenticated users can view as-built drawings'),
      ('owner_manuals',                    'Members can view owner manuals',          'Authenticated users can view owner manuals'),
      ('change_orders',                    'Members can view change orders',          'Authenticated users can view change orders'),
      ('project_milestones',               'Members can view milestones',             'Authenticated users can view milestones'),
      ('purchasing_modules',               'Members can view purchasing modules',     'Authenticated users can view purchasing modules'),
      ('purchasing_module_submittals',     'Members can view module submittal links', 'Authenticated users can view module submittal links'),
      ('purchasing_items',                 'Members can view purchasing items',       'Authenticated users can view purchasing items'),
      ('purchasing_freight',               'Members can view purchasing freight',     'Authenticated users can view purchasing freight'),
      ('purchasing_manufacturer_defaults', 'Members can view manufacturer defaults',  'Authenticated users can view manufacturer defaults'),
      ('quick_start_rooms',                'Members can view quick start rooms',      'Authenticated users can view quick start rooms'),
      ('quick_start_steps',                'Members can view quick start steps',      'Authenticated users can view quick start steps')
    ) as v(tbl, oldp, newp)
  loop
    if to_regclass('public.' || t.tbl) is not null then
      execute format('drop policy if exists %I on public.%I', t.oldp, t.tbl);
      execute format('drop policy if exists %I on public.%I', t.newp, t.tbl);
      execute format(
        'create policy %I on public.%I for select using (auth.uid() is not null)',
        t.newp, t.tbl
      );
    end if;
  end loop;
end $$;

-- ---------- storage buckets (cutsheets, as-builts, manuals) ----------
-- storage.objects always exists. Keep the per-bucket filter; only the
-- membership gate is dropped. Upload/delete policies are unchanged, so writes
-- stay restricted. The 'manuals' policy may not exist if add_product_manuals.sql
-- wasn't applied — drop-if-exists handles that, and recreating it is harmless.

do $$
declare
  b record;
begin
  for b in
    select * from (values
      ('cutsheets', 'Project members can read cutsheets', 'Authenticated users can read cutsheets'),
      ('as-builts', 'Project members can read as-builts', 'Authenticated users can read as-builts'),
      ('manuals',   'Project members can read manuals',   'Authenticated users can read manuals')
    ) as v(bucket, oldp, newp)
  loop
    execute format('drop policy if exists %I on storage.objects', b.oldp);
    execute format('drop policy if exists %I on storage.objects', b.newp);
    execute format(
      'create policy %I on storage.objects for select using (bucket_id = %L and auth.uid() is not null)',
      b.newp, b.bucket
    );
  end loop;
end $$;
