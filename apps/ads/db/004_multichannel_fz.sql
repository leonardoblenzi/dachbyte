CREATE TABLE IF NOT EXISTS ads_business_targets (
  workspace_id uuid PRIMARY KEY REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  currency_code text NOT NULL DEFAULT 'BRL',
  monthly_budget numeric(20,6),
  target_cpa numeric(20,6),
  target_roas numeric(20,6),
  average_ticket numeric(20,6),
  gross_margin_percent numeric(7,4),
  notes text,
  updated_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (monthly_budget IS NULL OR monthly_budget >= 0),
  CHECK (target_cpa IS NULL OR target_cpa > 0),
  CHECK (target_roas IS NULL OR target_roas > 0),
  CHECK (average_ticket IS NULL OR average_ticket >= 0),
  CHECK (gross_margin_percent IS NULL OR (gross_margin_percent >= 0 AND gross_margin_percent <= 100))
);

CREATE TABLE IF NOT EXISTS ads_conversion_mappings (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  source_key text NOT NULL,
  label text,
  semantic_type text NOT NULL DEFAULT 'custom'
    CHECK (semantic_type IN ('lead', 'purchase', 'message', 'appointment', 'call', 'custom')),
  is_primary boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ads_conversion_mappings_primary_uidx
  ON ads_conversion_mappings (tenant_id, ad_account_id)
  WHERE is_primary AND is_active;

CREATE INDEX IF NOT EXISTS ads_conversion_mappings_workspace_idx
  ON ads_conversion_mappings (tenant_id, workspace_id, provider, ad_account_id);

CREATE TABLE IF NOT EXISTS ads_fz_rule_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  range_days integer NOT NULL CHECK (range_days IN (7, 14, 30)),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  rules_version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  finding_count integer NOT NULL DEFAULT 0,
  error_message text
);

CREATE INDEX IF NOT EXISTS ads_fz_rule_runs_workspace_idx
  ON ads_fz_rule_runs (tenant_id, workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ads_fz_findings (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  rule_run_id uuid REFERENCES ads_fz_rule_runs(id) ON DELETE SET NULL,
  rule_id text NOT NULL,
  rule_version integer NOT NULL,
  fingerprint text NOT NULL,
  provider text CHECK (provider IN ('google_ads', 'meta_ads', 'multichannel')),
  ad_account_id uuid REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  category text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'dismissed', 'resolved')),
  title text NOT NULL,
  diagnosis text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_action text,
  do_not_change text,
  observation text,
  next_decision text,
  period_start date,
  period_end date,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS ads_fz_findings_workspace_idx
  ON ads_fz_findings (tenant_id, workspace_id, status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS ads_fz_findings_account_idx
  ON ads_fz_findings (tenant_id, ad_account_id, status, last_seen_at DESC);

ALTER TABLE ads_business_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_conversion_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_fz_rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_fz_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY ads_business_targets_tenant_policy ON ads_business_targets
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_conversion_mappings_tenant_policy ON ads_conversion_mappings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_fz_rule_runs_tenant_policy ON ads_fz_rule_runs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_fz_findings_tenant_policy ON ads_fz_findings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
