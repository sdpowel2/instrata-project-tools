-- priced_from on project BoM items — pulled from DTools custom field
-- "Custom Field 1" (formatted "VENDOR MM/DD/YY"). Surfaces in the
-- Purchasing module as the Vendor column. Hidden from the project overview
-- BoM table — purchasing-only.

alter table public.project_bom_items
  add column if not exists priced_from text;
