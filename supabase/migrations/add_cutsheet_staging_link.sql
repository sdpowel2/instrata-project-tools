-- Phase 2: link submittal items to their pending staging records.
--
-- When a user uploads a cutsheet that doesn't exist in the repository yet,
-- the file lands in SharePoint /Staging/ and a cutsheet_staging row is
-- created. This column gives us a durable pointer from the submittal item
-- to that staging record so the UI can render a "Pending review" badge
-- and the PDF export can fetch the file by staging-row metadata.
--
-- An item with cutsheet_staging_id set will get its cutsheet_repository_id
-- populated (and staging cleared) once an admin approves the staged file.

alter table public.submittal_items
  add column if not exists cutsheet_staging_id
  uuid references public.cutsheet_staging(id) on delete set null;

create index if not exists submittal_items_cutsheet_staging_idx
  on public.submittal_items (cutsheet_staging_id);

notify pgrst, 'reload schema';
