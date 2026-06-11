-- DTools pricing parity: per-line labor attribution + authoritative project
-- totals so every sync can verify itself against DTools' root fields.

-- ── project_bom_items ────────────────────────────────────────────────────────
-- labor_type: for item_type='Labor' rows, the DTools labor type this row
--   represents (Install, Cabling, Travel, ...). Empty for products.
-- labor_breakdown: for products, the per-unit labor attribution pulled from
--   DTools ItemLaborTypes: [{ "type": "Install", "hours": 0.25,
--   "costRate": 55.517, "priceRate": 96.305 }, ...]. Hours are the RAW
--   (unadjusted) per-unit hours used for pricing; DTools' displayed hours may
--   include a per-type hour adjustment (e.g. 1.03) baked into the rate instead.
-- included_in_phase: for labor rows DTools rolls into a phase rollup (e.g. a
--   fixed-price Airfare line converted to Travel hours). The row is kept for
--   display parity but must be EXCLUDED from labor totals or it double-counts.
ALTER TABLE public.project_bom_items
  ADD COLUMN IF NOT EXISTS labor_type        text    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS labor_breakdown   jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS included_in_phase boolean NOT NULL DEFAULT false;

-- ── projects ─────────────────────────────────────────────────────────────────
-- Authoritative DTools root fields captured at sync time. Headline numbers
-- display these; the BoM table sums its own lines; dtools_sync_delta records
-- the (expected, sub-dollar) rounding drift between the two so reconciliation
-- is provable rather than assumed.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS dtools_cost              numeric,
  ADD COLUMN IF NOT EXISTS dtools_price_without_tax numeric,
  ADD COLUMN IF NOT EXISTS dtools_tax               numeric,
  ADD COLUMN IF NOT EXISTS dtools_price             numeric,
  ADD COLUMN IF NOT EXISTS dtools_hours             numeric,
  ADD COLUMN IF NOT EXISTS dtools_synced_at         timestamptz,
  -- { "equipmentCost": n, "equipmentPrice": n, "laborCost": n, "laborPrice": n,
  --   "costDelta": n, "priceDelta": n, "verified": bool }
  ADD COLUMN IF NOT EXISTS dtools_sync_delta        jsonb;
