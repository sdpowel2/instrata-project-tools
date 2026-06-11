-- Persisted per-project labor knowledge from DTools "priced" payloads
-- (pre-approval publishes carry $/hr rates on phase rollup rows; post-approval
-- publishes zero them out). The sync stores this whenever it sees a priced
-- payload and reads it back to price zero-priced ones.
-- Shape: { "rates": { "Install": { "cost": 55.517, "price": 96.305 }, ... },
--          "factors": { "Install": 1.03, ... },
--          "phaseRaw": { "Install": 643.6578, ... } }
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS dtools_labor_meta jsonb;
