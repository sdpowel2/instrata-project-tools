-- Located labor items (SI "send labor items as individual" integration
-- setting) and phase-residual labor lines need to render in the Labor column
-- of the CO items table even though DTools carries their dollars as
-- qty x unit_price. Tag the row type so the UI can tell them from products.
alter table public.change_order_items
  add column if not exists item_type text not null default 'Product'
  check (item_type in ('Product','Labor'));
