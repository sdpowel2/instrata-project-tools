-- Fix: admin RLS policies on profiles caused infinite recursion.
-- The inline EXISTS subquery queried public.profiles from within a profiles policy,
-- causing Supabase to silently fail the check and fall back to only the
-- "Users can view their own profile" policy — so admins saw only themselves.
-- Solution: use a SECURITY DEFINER function (like is_project_member already does)
-- so the admin check runs outside of RLS.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins full access to profiles" ON public.profiles;

CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins full access to profiles"
  ON public.profiles FOR ALL USING (public.is_admin());
