ALTER TABLE ads_metrics_daily
  ADD COLUMN IF NOT EXISTS reach bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unique_clicks bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frequency numeric(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS link_clicks bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outbound_clicks bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ads_meta_businesses (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES ads_provider_connections(id) ON DELETE CASCADE,
  external_business_id text NOT NULL,
  name text,
  verification_status text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connection_id, external_business_id)
);

CREATE INDEX IF NOT EXISTS ads_meta_businesses_workspace_idx
  ON ads_meta_businesses (tenant_id, workspace_id, name);

CREATE TABLE IF NOT EXISTS ads_meta_creatives (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  external_creative_id text NOT NULL,
  name text,
  title text,
  body text,
  thumbnail_url text,
  image_url text,
  call_to_action_type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id, external_creative_id)
);

CREATE INDEX IF NOT EXISTS ads_meta_creatives_account_idx
  ON ads_meta_creatives (tenant_id, ad_account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ads_meta_action_metrics_daily (
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  metric_date date NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'campaign', 'ad_group', 'ad')),
  entity_external_id text NOT NULL,
  action_type text NOT NULL,
  action_count numeric(20,6) NOT NULL DEFAULT 0,
  action_value numeric(20,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,
    ad_account_id,
    metric_date,
    entity_type,
    entity_external_id,
    action_type
  )
);

CREATE INDEX IF NOT EXISTS ads_meta_action_metrics_account_date_idx
  ON ads_meta_action_metrics_daily (tenant_id, ad_account_id, metric_date DESC, action_type);

ALTER TABLE ads_meta_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_meta_creatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_meta_action_metrics_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY ads_meta_businesses_tenant_policy ON ads_meta_businesses
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY ads_meta_creatives_tenant_policy ON ads_meta_creatives
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY ads_meta_action_metrics_tenant_policy ON ads_meta_action_metrics_daily
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
