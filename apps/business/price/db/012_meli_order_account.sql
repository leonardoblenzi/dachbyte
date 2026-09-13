ALTER TABLE volt_price.orders
  ADD COLUMN IF NOT EXISTS marketplace_account_id text,
  ADD COLUMN IF NOT EXISTS marketplace_account_source text;

CREATE INDEX IF NOT EXISTS idx_vp_orders_marketplace_account
  ON volt_price.orders(tenant_id, marketplace, marketplace_account_id)
  WHERE marketplace_account_id IS NOT NULL;
