CREATE TABLE ads_workspaces (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  workspace_type text NOT NULL DEFAULT 'company'
    CHECK (workspace_type IN ('company', 'client')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ads_workspaces_tenant_idx
  ON ads_workspaces (tenant_id, status);

CREATE TABLE ads_workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  user_global_id text NOT NULL,
  role text NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('owner', 'admin', 'analyst', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_global_id)
);

CREATE TABLE ads_provider_connections (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  external_subject text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'expired', 'revoked', 'error')),
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ads_provider_connections_workspace_idx
  ON ads_provider_connections (tenant_id, workspace_id, provider, status);

CREATE TABLE ads_ad_accounts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES ads_provider_connections(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  external_account_id text NOT NULL,
  name text,
  currency_code text,
  timezone text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_account_id)
);

CREATE INDEX ads_ad_accounts_workspace_idx
  ON ads_ad_accounts (tenant_id, workspace_id, provider);

CREATE TABLE ads_sync_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES ads_workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  sync_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  cursor jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ads_sync_runs_workspace_idx
  ON ads_sync_runs (tenant_id, workspace_id, provider, created_at DESC);

ALTER TABLE ads_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_ad_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ads_workspaces_tenant_policy ON ads_workspaces
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY ads_workspace_memberships_tenant_policy ON ads_workspace_memberships
  USING (
    EXISTS (
      SELECT 1 FROM ads_workspaces w
      WHERE w.id = workspace_id
        AND w.tenant_id = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ads_workspaces w
      WHERE w.id = workspace_id
        AND w.tenant_id = current_setting('app.tenant_id', true)
    )
  );

CREATE POLICY ads_provider_connections_tenant_policy ON ads_provider_connections
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY ads_ad_accounts_tenant_policy ON ads_ad_accounts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY ads_sync_runs_tenant_policy ON ads_sync_runs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
