-- Owner-furnished flag on submittal line items.
--
-- project_bom_items already carries owner_furnished (DTools IsOfe), and the
-- DTools sync splits one part into separate BoM rows when it is OFE in some
-- rooms and Instrata-supplied in others (the rows differ by unit cost). The
-- submittal populate used to merge those into a single line item, losing
-- which rooms' gear the owner supplies. Populate now keeps OFE and non-OFE
-- copies as separate submittal_items rows, and this column carries the flag
-- through to the SubmittalDetail table, the printed BoM-by-Room, and the MCP
-- list_submittals / populate_submittal_from_bom tools.
--
-- Run manually in the Supabase SQL Editor BEFORE deploying the app build that
-- writes this column (PostgREST rejects inserts naming an unknown column).

alter table public.submittal_items
  add column if not exists owner_furnished boolean not null default false;
