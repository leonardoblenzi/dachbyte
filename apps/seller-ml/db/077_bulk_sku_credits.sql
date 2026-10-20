ALTER TABLE ml.bulk_sku_jobs
  ADD COLUMN IF NOT EXISTS credit_reservation jsonb,
  ADD COLUMN IF NOT EXISTS credit_settlement jsonb;
