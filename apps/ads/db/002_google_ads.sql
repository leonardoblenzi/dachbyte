ALTER TABLE ads_workspaces
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS ads_workspaces_default_tenant_uidx
  ON ads_workspaces (tenant_id)
  WHERE is_default;

ALTER TABLE ads_ad_accounts
  ADD COLUMN IF NOT EXISTS manager boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS test_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS account_level integer,
  ADD COLUMN IF NOT EXISTS login_customer_id text,
  ADD COLUMN IF NOT EXISTS sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_status text,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ads_ad_accounts_provider_external_account_id_key'
      AND conrelid = 'ads_ad_accounts'::regclass
  ) THEN
    ALTER TABLE ads_ad_accounts
      DROP CONSTRAINT ads_ad_accounts_provider_external_account_id_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ads_ad_accounts_tenant_provider_external_uidx
  ON ads_ad_accounts (tenant_id, provider, external_account_id);

CREATE TABLE IF NOT EXISTS ads_provider_credentials (
  connection_id uuid PRIMARY KEY REFERENCES ads_provider_connections(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  token_type text,
  scope text,
  encryption_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ads_provider_credentials_tenant_idx
  ON ads_provider_credentials (tenant_id, provider);

CREATE UNIQUE INDEX IF NOT EXISTS ads_provider_connections_google_subject_uidx
  ON ads_provider_connections (tenant_id, workspace_id, provider, external_subject)
  WHERE external_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS ads_campaigns (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  external_campaign_id text NOT NULL,
  name text,
  status text,
  channel_type text,
  bidding_strategy_type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id, external_campaign_id)
);

CREATE INDEX IF NOT EXISTS ads_campaigns_account_idx
  ON ads_campaigns (tenant_id, ad_account_id, status);

CREATE TABLE IF NOT EXISTS ads_ad_groups (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES ads_campaigns(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  external_ad_group_id text NOT NULL,
  external_campaign_id text NOT NULL,
  name text,
  status text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id, external_ad_group_id)
);

CREATE INDEX IF NOT EXISTS ads_ad_groups_account_idx
  ON ads_ad_groups (tenant_id, ad_account_id, external_campaign_id);

CREATE TABLE IF NOT EXISTS ads_ads (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES ads_campaigns(id) ON DELETE CASCADE,
  ad_group_id uuid REFERENCES ads_ad_groups(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  external_ad_id text NOT NULL,
  external_campaign_id text NOT NULL,
  external_ad_group_id text NOT NULL,
  name text,
  status text,
  ad_type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id, external_ad_id)
);

CREATE INDEX IF NOT EXISTS ads_ads_account_idx
  ON ads_ads (tenant_id, ad_account_id, external_ad_group_id);

CREATE TABLE IF NOT EXISTS ads_google_keywords (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES ads_campaigns(id) ON DELETE CASCADE,
  ad_group_id uuid REFERENCES ads_ad_groups(id) ON DELETE CASCADE,
  external_criterion_id text NOT NULL,
  external_campaign_id text NOT NULL,
  external_ad_group_id text NOT NULL,
  keyword_text text NOT NULL,
  match_type text,
  status text,
  negative boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id, external_criterion_id)
);

CREATE INDEX IF NOT EXISTS ads_google_keywords_account_idx
  ON ads_google_keywords (tenant_id, ad_account_id, external_campaign_id, external_ad_group_id);

CREATE TABLE IF NOT EXISTS ads_conversion_actions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  external_conversion_action_id text NOT NULL,
  name text,
  status text,
  action_type text,
  category text,
  primary_for_goal boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id, external_conversion_action_id)
);

CREATE TABLE IF NOT EXISTS ads_metrics_daily (
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  metric_date date NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'campaign', 'ad_group', 'ad', 'keyword')),
  entity_external_id text NOT NULL,
  campaign_external_id text,
  ad_group_external_id text,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  conversions numeric(20,6) NOT NULL DEFAULT 0,
  conversion_value numeric(20,6) NOT NULL DEFAULT 0,
  all_conversions numeric(20,6) NOT NULL DEFAULT 0,
  all_conversion_value numeric(20,6) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ad_account_id, metric_date, entity_type, entity_external_id)
);

CREATE INDEX IF NOT EXISTS ads_metrics_daily_workspace_date_idx
  ON ads_metrics_daily (tenant_id, workspace_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS ads_metrics_daily_campaign_date_idx
  ON ads_metrics_daily (tenant_id, ad_account_id, campaign_external_id, metric_date DESC);

CREATE TABLE IF NOT EXISTS ads_google_search_terms_daily (
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  metric_date date NOT NULL,
  external_campaign_id text NOT NULL,
  external_ad_group_id text NOT NULL,
  search_term text NOT NULL,
  search_term_status text,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  conversions numeric(20,6) NOT NULL DEFAULT 0,
  conversion_value numeric(20,6) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,
    ad_account_id,
    metric_date,
    external_campaign_id,
    external_ad_group_id,
    search_term
  )
);

CREATE INDEX IF NOT EXISTS ads_google_search_terms_account_date_idx
  ON ads_google_search_terms_daily (tenant_id, ad_account_id, metric_date DESC);

CREATE TABLE IF NOT EXISTS ads_sync_cursors (
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  ad_account_id uuid NOT NULL REFERENCES ads_ad_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  dataset text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ad_account_id, provider, dataset)
);

-- Control-plane queue: deliberately does not hold credentials or metrics and is
-- intentionally not protected by tenant RLS so the worker can claim jobs across
-- tenants. Runtime grants restrict the web role to INSERT only.
CREATE TABLE IF NOT EXISTS ads_sync_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL,
  ad_account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  reason text NOT NULL DEFAULT 'scheduled',
  run_after timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, ad_account_id)
);

CREATE INDEX IF NOT EXISTS ads_sync_jobs_due_idx
  ON ads_sync_jobs (provider, run_after)
  WHERE locked_at IS NULL;

ALTER TABLE ads_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_ad_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_google_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_conversion_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_google_search_terms_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_sync_cursors ENABLE ROW LEVEL SECURITY;

CREATE POLICY ads_provider_credentials_tenant_policy ON ads_provider_credentials
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_campaigns_tenant_policy ON ads_campaigns
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_ad_groups_tenant_policy ON ads_ad_groups
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_ads_tenant_policy ON ads_ads
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_google_keywords_tenant_policy ON ads_google_keywords
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_conversion_actions_tenant_policy ON ads_conversion_actions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_metrics_daily_tenant_policy ON ads_metrics_daily
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_google_search_terms_daily_tenant_policy ON ads_google_search_terms_daily
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ads_sync_cursors_tenant_policy ON ads_sync_cursors
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
