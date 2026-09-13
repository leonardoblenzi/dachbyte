CREATE TABLE IF NOT EXISTS volt_price.decision_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  product_id uuid REFERENCES volt_price.products(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Politica economica padrao',
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  min_contribution_margin numeric(8,6) NOT NULL DEFAULT 0.10 CHECK(min_contribution_margin>=0 AND min_contribution_margin<1),
  min_contribution_amount numeric(18,2) NOT NULL DEFAULT 0,
  max_price_change_percent numeric(8,6) NOT NULL DEFAULT 0.10 CHECK(max_price_change_percent>0 AND max_price_change_percent<=1),
  cautious_test_percent numeric(8,6) NOT NULL DEFAULT 0.05 CHECK(cautious_test_percent>0 AND cautious_test_percent<=1),
  min_confidence numeric(8,6) NOT NULL DEFAULT 0.60 CHECK(min_confidence>=0 AND min_confidence<=1),
  min_elasticity_samples integer NOT NULL DEFAULT 4 CHECK(min_elasticity_samples>=3),
  min_elasticity_r2 numeric(8,6) NOT NULL DEFAULT 0.50 CHECK(min_elasticity_r2>=0 AND min_elasticity_r2<=1),
  excess_stock_units numeric(18,4) NOT NULL DEFAULT 180,
  require_human_approval boolean NOT NULL DEFAULT true,
  risk_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES volt_price.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_decision_policy_global ON volt_price.decision_policies(tenant_id) WHERE product_id IS NULL AND status='active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_decision_policy_product ON volt_price.decision_policies(tenant_id,product_id) WHERE product_id IS NOT NULL AND status='active';

CREATE TABLE IF NOT EXISTS volt_price.price_performance_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES volt_price.products(id) ON DELETE CASCADE,
  observed_date date NOT NULL,
  price numeric(18,2) NOT NULL CHECK(price>0),
  units numeric(18,4) NOT NULL CHECK(units>=0),
  revenue numeric(18,2),
  contribution numeric(18,2),
  ad_spend numeric(18,2),
  impressions bigint,
  clicks bigint,
  conversions numeric(18,4),
  source_type text NOT NULL DEFAULT 'MANUAL' CHECK(source_type IN ('MANUAL','IMPORT','API','DERIVED')),
  source_ref text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,product_id,source_ref)
);
CREATE INDEX IF NOT EXISTS idx_vp_price_performance_product ON volt_price.price_performance_samples(tenant_id,product_id,observed_date DESC);

CREATE TABLE IF NOT EXISTS volt_price.decision_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  engine_version text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
  period_start date,
  period_end date,
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_by uuid REFERENCES volt_price.users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_decision_runs_recent ON volt_price.decision_runs(tenant_id,started_at DESC);

CREATE TABLE IF NOT EXISTS volt_price.decision_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES volt_price.decision_runs(id) ON DELETE CASCADE,
  product_id uuid REFERENCES volt_price.products(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  numeric_value numeric(18,6),
  text_value text,
  confidence numeric(8,6) CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)),
  source_type text NOT NULL,
  source_ref text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_decision_signals_product ON volt_price.decision_signals(tenant_id,product_id,created_at DESC);

ALTER TABLE volt_price.pricing_decisions
  ADD COLUMN IF NOT EXISTS decision_run_id uuid REFERENCES volt_price.decision_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS engine_version text,
  ADD COLUMN IF NOT EXISTS strategic_state text,
  ADD COLUMN IF NOT EXISTS decision_type text,
  ADD COLUMN IF NOT EXISTS confidence_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS elasticity jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS guardrails jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS scenarios jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS interpretation text,
  ADD COLUMN IF NOT EXISTS impact jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES volt_price.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_vp_pricing_decision_review ON volt_price.pricing_decisions(tenant_id,status,created_at DESC);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['decision_policies','price_performance_samples','decision_runs','decision_signals'] LOOP
    EXECUTE format('ALTER TABLE volt_price.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE volt_price.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_price.%I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON volt_price.%I USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())',tbl);
  END LOOP;
END $$;
