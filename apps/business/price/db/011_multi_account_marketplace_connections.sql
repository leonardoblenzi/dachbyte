CREATE TABLE IF NOT EXISTS volt_price.integration_authorization_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('meli','shopee')),
  token_hash text NOT NULL UNIQUE,
  created_by_user_id uuid NOT NULL REFERENCES volt_price.users(id) ON DELETE CASCADE,
  support_reason text,
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  used_at timestamptz,
  cancelled_at timestamptz,
  connection_id uuid REFERENCES volt_price.integration_connections(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE volt_price.orders
  ADD COLUMN IF NOT EXISTS marketplace_connection_id uuid
  REFERENCES volt_price.integration_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vp_authorization_links_pending
  ON volt_price.integration_authorization_links(tenant_id,channel,expires_at DESC)
  WHERE used_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vp_orders_marketplace_connection
  ON volt_price.orders(tenant_id,marketplace_connection_id);

ALTER TABLE volt_price.integration_authorization_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE volt_price.integration_authorization_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON volt_price.integration_authorization_links;
CREATE POLICY tenant_isolation ON volt_price.integration_authorization_links
  USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())
  WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id());
