ALTER TABLE volt_price.fee_snapshots
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fingerprint text,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS components jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS total_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES volt_price.fee_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

WITH ranked AS (
  SELECT id,row_number() OVER(PARTITION BY tenant_id,channel,external_order_id ORDER BY fetched_at DESC,id DESC) AS position
  FROM volt_price.fee_snapshots
)
UPDATE volt_price.fee_snapshots snapshot
SET is_current=(ranked.position=1)
FROM ranked WHERE ranked.id=snapshot.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_fee_snapshot_version
  ON volt_price.fee_snapshots(tenant_id,channel,external_order_id,version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_fee_snapshot_fingerprint
  ON volt_price.fee_snapshots(tenant_id,channel,external_order_id,fingerprint)
  WHERE fingerprint IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_fee_snapshot_current
  ON volt_price.fee_snapshots(tenant_id,channel,external_order_id)
  WHERE is_current;

ALTER TABLE volt_price.profit_snapshots
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES volt_price.orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fee_snapshot_id uuid REFERENCES volt_price.fee_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS calculation_type text NOT NULL DEFAULT 'expected',
  ADD COLUMN IF NOT EXISTS expected_contribution_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS realized_contribution_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS components jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  ALTER TABLE volt_price.profit_snapshots ADD CONSTRAINT vp_profit_calculation_type_check
    CHECK(calculation_type IN ('expected','realized'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_profit_order_version
  ON volt_price.profit_snapshots(tenant_id,order_id,version)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vp_profit_order_latest
  ON volt_price.profit_snapshots(tenant_id,order_id,calculated_at DESC);

CREATE TABLE IF NOT EXISTS volt_price.profit_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  profit_snapshot_id uuid NOT NULL REFERENCES volt_price.profit_snapshots(id) ON DELETE CASCADE,
  component_type text NOT NULL,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  source_type text NOT NULL CHECK(source_type IN ('API','ERP','MANUAL','CALCULATED')),
  source_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_profit_components_snapshot ON volt_price.profit_components(profit_snapshot_id);

CREATE TABLE IF NOT EXISTS volt_price.profit_snapshot_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  profit_snapshot_id uuid NOT NULL REFERENCES volt_price.profit_snapshots(id) ON DELETE CASCADE,
  product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  sku text,
  title text,
  quantity numeric(18,4) NOT NULL DEFAULT 1,
  gross_amount numeric(18,2) NOT NULL DEFAULT 0,
  cost_amount numeric(18,2) NOT NULL DEFAULT 0,
  contribution_amount numeric(18,2) NOT NULL DEFAULT 0,
  allocation_ratio numeric(9,6) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_vp_profit_items_sku
  ON volt_price.profit_snapshot_items(tenant_id,sku,profit_snapshot_id);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['profit_components','profit_snapshot_items']
  LOOP
    EXECUTE format('ALTER TABLE volt_price.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE volt_price.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_price.%I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON volt_price.%I USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())',tbl);
  END LOOP;
END $$;
