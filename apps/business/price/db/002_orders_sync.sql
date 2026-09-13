ALTER TABLE volt_price.orders
  ADD COLUMN IF NOT EXISTS normalized_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'unmatched',
  ADD COLUMN IF NOT EXISTS match_confidence numeric(5,4),
  ADD COLUMN IF NOT EXISTS match_reason text,
  ADD COLUMN IF NOT EXISTS matched_at timestamptz;

DO $$ BEGIN
  ALTER TABLE volt_price.orders ADD CONSTRAINT vp_orders_reconciliation_status_check
    CHECK (reconciliation_status IN ('matched','unmatched','review'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_vp_orders_reconciliation
  ON volt_price.orders(tenant_id,reconciliation_status,order_date DESC);

CREATE TABLE IF NOT EXISTS volt_price.sync_checkpoints (
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES volt_price.integration_connections(id) ON DELETE CASCADE,
  resource text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,connection_id,resource)
);

CREATE TABLE IF NOT EXISTS volt_price.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES volt_price.integration_connections(id) ON DELETE SET NULL,
  resource text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed')),
  mode text NOT NULL DEFAULT 'incremental' CHECK(mode IN ('historical','incremental','manual')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  pages integer NOT NULL DEFAULT 0,
  records_seen integer NOT NULL DEFAULT 0,
  records_upserted integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_by uuid REFERENCES volt_price.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_sync_runs_active
  ON volt_price.sync_runs(tenant_id,connection_id,resource)
  WHERE status='running';
CREATE INDEX IF NOT EXISTS idx_vp_sync_runs_recent
  ON volt_price.sync_runs(tenant_id,resource,started_at DESC);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['sync_checkpoints','sync_runs']
  LOOP
    EXECUTE format('ALTER TABLE volt_price.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE volt_price.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_price.%I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON volt_price.%I USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())',tbl);
  END LOOP;
END $$;
