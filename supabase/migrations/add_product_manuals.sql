-- Add product manual fields to closeout_packages
ALTER TABLE public.closeout_packages
  ADD COLUMN IF NOT EXISTS product_manual_url  text,
  ADD COLUMN IF NOT EXISTS product_manual_name text;

-- Create private manuals storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('manuals', 'manuals', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for manuals bucket
CREATE POLICY "Authenticated users can upload manuals"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'manuals' AND auth.uid() IS NOT NULL);

CREATE POLICY "Project members can read manuals"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'manuals'
    AND public.is_project_member((string_to_array(name, '/'))[1]::uuid)
  );

CREATE POLICY "Project members can delete manuals"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'manuals'
    AND public.is_project_member((string_to_array(name, '/'))[1]::uuid)
  );
