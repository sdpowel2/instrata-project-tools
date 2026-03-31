-- Add cost, unit_of_measure, and price_date columns to product_catalog
alter table public.product_catalog
  add column if not exists cost numeric,
  add column if not exists unit_of_measure text not null default '',
  add column if not exists price_date date;
