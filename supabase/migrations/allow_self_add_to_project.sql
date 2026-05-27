-- Allow authenticated users to add themselves to any project.
-- The existing "Project access users can manage members" policy gates INSERT
-- through is_project_member(project_id), which is a chicken-and-egg block:
-- you can't become a member because you're not already a member. This broke
-- the "Add me" button on the Projects page after open_project_visibility.sql
-- made every project visible org-wide.
--
-- The WITH CHECK restricts self-insert to rows where the user is adding
-- themselves — nobody can be added to a project by someone else through this
-- policy. UPDATE and DELETE remain gated by the existing membership check.

CREATE POLICY "Users can add themselves to projects"
  ON public.project_members FOR INSERT
  WITH CHECK (user_id = auth.uid());
