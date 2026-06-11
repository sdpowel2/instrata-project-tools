-- CO payloads carry a per-item LocationId plus their own Locations map
-- (including rooms the CO itself introduces). Persist the resolved room name
-- so the UI can show where each CO delta lands in the BoM, and so pending-CO
-- ghost rows can render inside the quote's location tree.
alter table public.change_order_items
  add column if not exists location text not null default '';
