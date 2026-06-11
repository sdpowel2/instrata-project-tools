-- CO line items are pre-tax (they reconcile against the CO payload's
-- PriceWithoutTax); the CO's amount is the tax-inclusive root Price. Store
-- the tax split so the UI can show lines → subtotal → tax → total without
-- the lines appearing to under-count the CO.
alter table public.change_orders
  add column if not exists tax numeric;
