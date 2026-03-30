-- Add business_unit column for geographic filtering
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS business_unit text NOT NULL DEFAULT '';

-- Add monday_item_id for webhook idempotency (prevents duplicate project creation)
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS monday_item_id bigint UNIQUE;
