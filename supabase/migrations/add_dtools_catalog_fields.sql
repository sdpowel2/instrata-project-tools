-- Migration: Extend product_catalog to match full D-Tools SI catalog schema
-- Preserves all existing columns and constraints.

ALTER TABLE product_catalog
  -- Identity / Classification
  ADD COLUMN IF NOT EXISTS subcategory          text,
  ADD COLUMN IF NOT EXISTS phase                text,
  ADD COLUMN IF NOT EXISTS part_number          text,
  ADD COLUMN IF NOT EXISTS system_name          text,
  ADD COLUMN IF NOT EXISTS product_url          text,

  -- Descriptions
  ADD COLUMN IF NOT EXISTS short_description    text,
  ADD COLUMN IF NOT EXISTS long_description     text,
  ADD COLUMN IF NOT EXISTS tags                 text,
  ADD COLUMN IF NOT EXISTS accounting_item_name text,

  -- Labor
  ADD COLUMN IF NOT EXISTS labor_types          text,
  ADD COLUMN IF NOT EXISTS unit_labor_hours     numeric,

  -- Pricing
  ADD COLUMN IF NOT EXISTS unit_price           numeric,
  ADD COLUMN IF NOT EXISTS margin               numeric,
  ADD COLUMN IF NOT EXISTS markup               numeric,
  ADD COLUMN IF NOT EXISTS map_price            numeric,
  ADD COLUMN IF NOT EXISTS purchase_cost        numeric,
  ADD COLUMN IF NOT EXISTS partner_set_cost     boolean,
  ADD COLUMN IF NOT EXISTS uom_for_partner_cost text,
  ADD COLUMN IF NOT EXISTS preferred_vendor     text,
  ADD COLUMN IF NOT EXISTS alternate_vendors    text,
  ADD COLUMN IF NOT EXISTS priced_from          text,
  ADD COLUMN IF NOT EXISTS partner_updated_on   timestamptz,

  -- Physical Specs
  ADD COLUMN IF NOT EXISTS height_inches        numeric,
  ADD COLUMN IF NOT EXISTS width_inches         numeric,
  ADD COLUMN IF NOT EXISTS depth_inches         numeric,
  ADD COLUMN IF NOT EXISTS weight_lbs           numeric,
  ADD COLUMN IF NOT EXISTS rack_mounted         boolean,
  ADD COLUMN IF NOT EXISTS rack_units           integer,
  ADD COLUMN IF NOT EXISTS amps                 numeric,
  ADD COLUMN IF NOT EXISTS volts                numeric,
  ADD COLUMN IF NOT EXISTS watts                numeric,
  ADD COLUMN IF NOT EXISTS btu                  numeric,
  ADD COLUMN IF NOT EXISTS poe                  boolean,
  ADD COLUMN IF NOT EXISTS poe_class            text,

  -- Ordering
  ADD COLUMN IF NOT EXISTS order_uom            text,
  ADD COLUMN IF NOT EXISTS do_not_order         boolean,

  -- Flags
  ADD COLUMN IF NOT EXISTS bulk_item            boolean,
  ADD COLUMN IF NOT EXISTS include_in_submittal boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS include_in_service_plan boolean,
  ADD COLUMN IF NOT EXISTS owner_furnished      boolean,
  ADD COLUMN IF NOT EXISTS taxable              boolean,
  ADD COLUMN IF NOT EXISTS discontinued         boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved             boolean,
  ADD COLUMN IF NOT EXISTS taa_compliant        boolean,
  ADD COLUMN IF NOT EXISTS bulk_wire            boolean,
  ADD COLUMN IF NOT EXISTS has_thumbnail        boolean,
  ADD COLUMN IF NOT EXISTS has_files            boolean,

  -- D-Tools Audit / Sync
  ADD COLUMN IF NOT EXISTS dtools_created_on    timestamptz,
  ADD COLUMN IF NOT EXISTS dtools_created_by    text,
  ADD COLUMN IF NOT EXISTS dtools_updated_on    timestamptz,
  ADD COLUMN IF NOT EXISTS dtools_updated_by    text,
  ADD COLUMN IF NOT EXISTS last_synced_at       timestamptz;

-- Index for efficient sync queries (find records updated since last sync)
CREATE INDEX IF NOT EXISTS idx_product_catalog_dtools_updated_on
  ON product_catalog (dtools_updated_on);

-- Index for filtering active (non-discontinued) products
CREATE INDEX IF NOT EXISTS idx_product_catalog_discontinued
  ON product_catalog (discontinued);
