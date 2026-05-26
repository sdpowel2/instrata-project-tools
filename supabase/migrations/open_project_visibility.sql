-- Allow all authenticated users to see all projects.
-- Previously gated to project members/admins only, which meant Monday-created
-- projects were invisible to anyone not explicitly added as a member.
-- UPDATE, DELETE, INSERT, and all child-table policies are unchanged.

DROP POLICY IF EXISTS "Members can view their projects" ON public.projects;

CREATE POLICY "Authenticated users can view all projects"
  ON public.projects FOR SELECT USING (auth.uid() IS NOT NULL);
